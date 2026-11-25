import {
  createReconnectingSocket,
  HEARTBEAT_DEAD_MS,
  type ReconnectingSocket,
  type ReconnectingSocketOptions,
} from '@/lib/reconnectingSocket';

interface MockWsInstance {
  onopen: (() => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  close: jest.Mock;
  send: jest.Mock;
  readyState: number;
  url: string;
}

const wsInstances: MockWsInstance[] = [];

class MockWebSocket {
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  close = jest.fn((code?: number, reason?: string) => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  });
  send = jest.fn();
  readyState = MockWebSocket.CONNECTING;
  url: string;

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  constructor(url: string) {
    this.url = url;
    wsInstances.push(this as unknown as MockWsInstance);
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'WebSocket', {
    value: MockWebSocket,
    writable: true,
  });
});

const WS_URL = 'ws://localhost:3012/ws/game/ABC123?token=t';

let sockets: ReconnectingSocket[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  wsInstances.length = 0;
  sockets = [];
});

afterEach(() => {
  sockets.forEach((socket) => socket.close());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function _start(overrides: Partial<ReconnectingSocketOptions> = {}) {
  const onMessage = jest.fn();
  const onStatus = jest.fn();
  const onDrop = jest.fn();
  const socket = createReconnectingSocket({
    getUrl: () => WS_URL,
    onMessage,
    onStatus,
    onDrop,
    ...overrides,
  });
  sockets.push(socket);
  return { socket, onMessage, onStatus, onDrop };
}

function _latest(): MockWsInstance {
  return wsInstances[wsInstances.length - 1];
}

function _open(ws: MockWsInstance) {
  ws.readyState = MockWebSocket.OPEN;
  ws.onopen?.();
}

function _receive(ws: MockWsInstance, msg: Record<string, unknown> | string) {
  ws.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
}

function _serverClose(ws: MockWsInstance, code: number, reason = '') {
  ws.readyState = MockWebSocket.CLOSED;
  ws.onclose?.({ code, reason });
}

function _confirmLatest(socket: ReconnectingSocket): MockWsInstance {
  const ws = _latest();
  _open(ws);
  socket.confirm();
  return ws;
}

function _statuses(onStatus: jest.Mock): string[] {
  return onStatus.mock.calls.map(([status]) => status as string);
}

function _fireVisibility(state: DocumentVisibilityState) {
  jest.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  document.dispatchEvent(new Event('visibilitychange'));
}

function _fireOnline() {
  window.dispatchEvent(new Event('online'));
}

type Trigger = 'visible' | 'online' | 'retryNow';

function _trigger(trigger: Trigger, socket: ReconnectingSocket) {
  if (trigger === 'visible') _fireVisibility('visible');
  else if (trigger === 'online') _fireOnline();
  else socket.retryNow();
}

describe('createReconnectingSocket', () => {
  it('reports connecting first; open alone is not connected, confirm is', () => {
    const { socket, onStatus } = _start({
      onMessage: (msg) => {
        if (msg.type === 'game_init') socket.confirm();
      },
    });
    expect(wsInstances).toHaveLength(1);
    expect(_latest().url).toBe(WS_URL);
    expect(_statuses(onStatus)).toEqual(['connecting']);

    _open(_latest());
    expect(_statuses(onStatus)).toEqual(['connecting']);

    _receive(_latest(), { type: 'game_init' });
    expect(_statuses(onStatus)).toEqual(['connecting', 'connected']);
  });

  it('send returns false before confirm and true after, with the JSON string on the socket', () => {
    const { socket } = _start();
    const ws = _latest();
    expect(socket.send({ type: 'ask_card' })).toBe(false);

    _open(ws);
    expect(socket.send({ type: 'ask_card' })).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();

    socket.confirm();
    const payload = { type: 'ask_card', card: '3_h', targetPlayerId: 'p2' };
    expect(socket.send(payload)).toBe(true);
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(payload));
  });

  it('an unexpected 1006 close of a confirmed socket drops once, reports reconnecting, retries after 1000 ms', () => {
    const { socket, onStatus, onDrop } = _start();
    _serverClose(_confirmLatest(socket), 1006);

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith({ closeCode: 1006, detectedBy: 'close' });
    expect(_statuses(onStatus)).toEqual(['connecting', 'connected', 'reconnecting']);

    jest.advanceTimersByTime(999);
    expect(wsInstances).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(wsInstances).toHaveLength(2);
  });

  it('failed attempts wait 1000, 2000, 4000, 8000, 10000, 10000 ms and fire no further onDrop', () => {
    const { socket, onStatus, onDrop } = _start();
    _serverClose(_confirmLatest(socket), 1006);

    for (const delay of [1000, 2000, 4000, 8000, 10_000, 10_000]) {
      const count = wsInstances.length;
      jest.advanceTimersByTime(delay - 1);
      expect(wsInstances).toHaveLength(count);
      jest.advanceTimersByTime(1);
      expect(wsInstances).toHaveLength(count + 1);
      _serverClose(_latest(), 1006);
    }

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(_statuses(onStatus)).toEqual(['connecting', 'connected', 'reconnecting']);
  });

  it('a socket that opens and closes unconfirmed is a failed attempt; a confirm resets the delay to 1000 ms', () => {
    const { socket, onStatus, onDrop } = _start();
    _serverClose(_confirmLatest(socket), 1006);
    jest.advanceTimersByTime(1000);

    const unconfirmed = _latest();
    _open(unconfirmed);
    _serverClose(unconfirmed, 1006);
    expect(onDrop).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1999);
    expect(wsInstances).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(wsInstances).toHaveLength(3);

    _serverClose(_confirmLatest(socket), 1006);
    expect(onDrop).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(999);
    expect(wsInstances).toHaveLength(3);
    jest.advanceTimersByTime(1);
    expect(wsInstances).toHaveLength(4);

    expect(_statuses(onStatus)).toEqual([
      'connecting',
      'connected',
      'reconnecting',
      'connected',
      'reconnecting',
    ]);
  });

  it.each<Trigger>(['visible', 'online', 'retryNow'])(
    'during a backoff wait, %s creates the next socket at once',
    (trigger) => {
      const { socket } = _start();
      _serverClose(_confirmLatest(socket), 1006);
      jest.advanceTimersByTime(500);

      _fireVisibility('hidden');
      expect(wsInstances).toHaveLength(1);

      _trigger(trigger, socket);
      expect(wsInstances).toHaveLength(2);

      jest.advanceTimersByTime(60_000);
      expect(wsInstances).toHaveLength(2);
    },
  );

  it.each<Trigger>(['visible', 'online', 'retryNow'])(
    'while an attempt is in flight, %s creates no second socket',
    (trigger) => {
      const { socket } = _start();
      _trigger(trigger, socket);
      expect(wsInstances).toHaveLength(1);

      _serverClose(_confirmLatest(socket), 1006);
      jest.advanceTimersByTime(1000);
      expect(wsInstances).toHaveLength(2);

      _trigger(trigger, socket);
      _open(_latest());
      _trigger(trigger, socket);
      expect(wsInstances).toHaveLength(2);
    },
  );

  it('close code 4006 stops for good: error with the code, no retry, no onDrop', () => {
    const { socket, onStatus, onDrop } = _start();
    const reason = 'This game was opened in another tab or window';
    _serverClose(_confirmLatest(socket), 4006, reason);

    expect(onStatus).toHaveBeenLastCalledWith('error', { code: 4006, reason });
    expect(_statuses(onStatus)).toEqual(['connecting', 'connected', 'error']);

    _fireOnline();
    _fireVisibility('visible');
    socket.retryNow();
    jest.advanceTimersByTime(60_000);
    expect(wsInstances).toHaveLength(1);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('a closing message with 4003 stops for good and closes the socket with 1000', () => {
    const { socket, onStatus, onDrop, onMessage } = _start();
    const ws = _latest();
    _open(ws);
    _receive(ws, { type: 'closing', code: 4003, reason: 'Player not in game' });

    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledWith(1000);
    expect(onStatus).toHaveBeenLastCalledWith('error', { code: 4003, reason: 'Player not in game' });
    expect(_statuses(onStatus)).toEqual(['connecting', 'error']);
    expect(onMessage).not.toHaveBeenCalled();

    socket.retryNow();
    jest.advanceTimersByTime(60_000);
    expect(wsInstances).toHaveLength(1);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it.each<[string, (ws: MockWsInstance) => void]>([
    ['a close with 4500', (ws) => _serverClose(ws, 4500, 'Server error')],
    [
      'a closing message with 4500',
      (ws) => _receive(ws, { type: 'closing', code: 4500, reason: 'Server error' }),
    ],
  ])('%s is retried like 1006', (_label, deliver) => {
    const { socket, onStatus, onDrop, onMessage } = _start();
    deliver(_confirmLatest(socket));

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith({ closeCode: 4500, detectedBy: 'close' });
    expect(_statuses(onStatus)).toEqual(['connecting', 'connected', 'reconnecting']);
    expect(onMessage).not.toHaveBeenCalled();

    jest.advanceTimersByTime(999);
    expect(wsInstances).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(wsInstances).toHaveLength(2);
  });

  it('without a heartbeat the silence check stays unarmed: 60 000 ms of silence leaves the socket alone', () => {
    const { socket, onStatus, onDrop } = _start();
    const ws = _confirmLatest(socket);
    _receive(ws, { type: 'game_init' });

    jest.advanceTimersByTime(60_000);
    _fireVisibility('visible');
    _fireOnline();

    expect(wsInstances).toHaveLength(1);
    expect(ws.close).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
    expect(_statuses(onStatus)).toEqual(['connecting', 'connected']);
  });

  it('after one heartbeat, 35 000 ms of silence drops the socket, closes it with 1000 and reconnects at once', () => {
    const { socket, onStatus, onDrop, onMessage } = _start();
    const ws = _confirmLatest(socket);
    _receive(ws, { type: 'heartbeat' });
    expect(onMessage).not.toHaveBeenCalled();

    jest.advanceTimersByTime(HEARTBEAT_DEAD_MS - 1);
    expect(wsInstances).toHaveLength(1);
    jest.advanceTimersByTime(1);

    expect(ws.close).toHaveBeenCalledWith(1000);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith({ closeCode: null, detectedBy: 'heartbeat' });
    expect(wsInstances).toHaveLength(2);
    expect(_statuses(onStatus)).toEqual(['connecting', 'connected', 'reconnecting']);
  });

  it('any message inside the 35 000 ms resets the silence clock, an unparseable frame too', () => {
    const { socket, onDrop, onMessage } = _start();
    const ws = _confirmLatest(socket);
    _receive(ws, { type: 'heartbeat' });

    jest.advanceTimersByTime(30_000);
    _receive(ws, { type: 'game_state', currentTurnPlayerId: 'p1' });
    jest.advanceTimersByTime(30_000);
    _receive(ws, 'not json');
    jest.advanceTimersByTime(30_000);
    _receive(ws, { type: 'heartbeat' });

    jest.advanceTimersByTime(HEARTBEAT_DEAD_MS - 1);
    expect(wsInstances).toHaveLength(1);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ type: 'game_state', currentTurnPlayerId: 'p1' });

    jest.advanceTimersByTime(1);
    expect(wsInstances).toHaveLength(2);
  });

  it.each<Trigger>(['visible', 'online'])(
    'on %s, an armed socket silent for 21 000 ms is dropped and replaced at once; at 19 000 ms nothing happens',
    (trigger) => {
      const { socket, onDrop } = _start();
      const ws = _confirmLatest(socket);
      _receive(ws, { type: 'heartbeat' });

      jest.advanceTimersByTime(19_000);
      _trigger(trigger, socket);
      expect(wsInstances).toHaveLength(1);
      expect(ws.close).not.toHaveBeenCalled();

      jest.advanceTimersByTime(2_000);
      _trigger(trigger, socket);
      expect(ws.close).toHaveBeenCalledWith(1000);
      expect(onDrop).toHaveBeenCalledWith({ closeCode: null, detectedBy: 'heartbeat' });
      expect(wsInstances).toHaveLength(2);
    },
  );

  it('after the silence path replaced socket A with B, a closing 4006 on A does nothing and B stays current', () => {
    const { socket, onStatus } = _start();
    const a = _confirmLatest(socket);
    _receive(a, { type: 'heartbeat' });
    jest.advanceTimersByTime(HEARTBEAT_DEAD_MS);
    const b = _latest();
    expect(b).not.toBe(a);

    _receive(a, { type: 'closing', code: 4006, reason: 'This game was opened in another tab or window' });
    _serverClose(a, 4006);

    expect(_statuses(onStatus)).not.toContain('error');
    expect(b.close).not.toHaveBeenCalled();

    _open(b);
    socket.confirm();
    expect(socket.send({ type: 'ask_card' })).toBe(true);
    expect(b.send).toHaveBeenCalledTimes(1);
    expect(a.send).not.toHaveBeenCalled();
    expect(_statuses(onStatus)).toEqual(['connecting', 'connected', 'reconnecting', 'connected']);
  });

  it('close() closes the socket with 1000, leaves no timers or listeners, and later events do nothing', () => {
    const spies = [
      { type: 'visibilitychange', add: jest.spyOn(document, 'addEventListener'), remove: jest.spyOn(document, 'removeEventListener') },
      { type: 'online', add: jest.spyOn(window, 'addEventListener'), remove: jest.spyOn(window, 'removeEventListener') },
    ];
    const { socket, onStatus, onDrop, onMessage } = _start();
    const ws = _confirmLatest(socket);
    _receive(ws, { type: 'heartbeat' });

    socket.close();
    expect(ws.close).toHaveBeenCalledWith(1000);
    expect(jest.getTimerCount()).toBe(0);
    for (const { type, add, remove } of spies) {
      const handler = add.mock.calls.find(([added]) => added === type)?.[1];
      expect(handler).toBeDefined();
      expect(remove).toHaveBeenCalledWith(type, handler);
    }

    _receive(ws, { type: 'game_state' });
    _receive(ws, { type: 'closing', code: 4006, reason: 'x' });
    _serverClose(ws, 1006);
    _fireOnline();
    _fireVisibility('visible');
    socket.retryNow();
    socket.confirm();
    jest.advanceTimersByTime(60_000);

    expect(wsInstances).toHaveLength(1);
    expect(socket.send({ type: 'ask_card' })).toBe(false);
    expect(onMessage).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
    expect(_statuses(onStatus)).toEqual(['connecting', 'connected']);
  });

  it('close() from inside onDrop leaves no retry behind', () => {
    const { socket } = _start({ onDrop: () => socket.close() });
    _serverClose(_confirmLatest(socket), 1006);

    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(60_000);
    expect(wsInstances).toHaveLength(1);
  });

  it('a URL or WebSocket constructor that throws reports error and stops', () => {
    const { onStatus } = _start({
      getUrl: () => {
        throw new SyntaxError('bad url');
      },
    });

    expect(_statuses(onStatus)).toEqual(['connecting', 'error']);
    expect(jest.getTimerCount()).toBe(0);
    _fireOnline();
    expect(wsInstances).toHaveLength(0);
  });
});
