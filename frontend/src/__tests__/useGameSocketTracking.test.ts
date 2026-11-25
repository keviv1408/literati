import { renderHook, act } from '@testing-library/react';
import { useGameSocket } from '@/hooks/useGameSocket';
import { trackEvent, trackGameInit, trackGameOver, trackSocketDropped } from '@/lib/analytics';

jest.mock('@/lib/analytics', () => ({
  trackEvent: jest.fn(),
  trackGameInit: jest.fn(),
  trackGameOver: jest.fn(),
  trackSocketDropped: jest.fn(),
  reportPendingSocketDrop: jest.fn(),
  trackSocketRecovered: jest.fn(),
}));

jest.mock('@/lib/api', () => ({
  API_URL: 'http://localhost:3001',
}));

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

beforeEach(() => {
  jest.useFakeTimers();
  wsInstances.length = 0;
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

function _latestWs(): MockWsInstance {
  return wsInstances[wsInstances.length - 1];
}

function _renderPlayer() {
  return renderHook(() => useGameSocket({ roomCode: 'ABCDEF', bearerToken: 't' }));
}

function _renderSpectator() {
  return renderHook(() =>
    useGameSocket({ roomCode: 'ABCDEF', bearerToken: null, spectatorToken: 's' }),
  );
}

function _open(ws: MockWsInstance) {
  act(() => {
    ws.readyState = MockWebSocket.OPEN;
    ws.onopen?.();
  });
}

function _message(ws: MockWsInstance, data: object) {
  act(() => {
    ws.onmessage?.({ data: JSON.stringify(data) });
  });
}

function _serverClose(ws: MockWsInstance, code: number) {
  act(() => {
    ws.readyState = MockWebSocket.CLOSED;
    ws.onclose?.({ code, reason: '' });
  });
}

function _outliveDrop() {
  act(() => {
    jest.advanceTimersByTime(2000);
  });
}

const GAME_INIT = {
  type: 'game_init',
  myPlayerId: 'p1',
  myHand: [],
  players: [],
  gameState: { status: 'active' },
  variant: 'remove_7s',
  playerCount: 6,
};

const SPECTATOR_INIT = {
  type: 'spectator_init',
  players: [],
  hands: {},
  moveHistory: [],
  gameState: { status: 'active' },
  variant: 'remove_7s',
  playerCount: 6,
};

const GAME_OVER = {
  type: 'game_over',
  winner: 1,
  tiebreakerWinner: null,
  scores: { team1: 5, team2: 3 },
};

describe('useGameSocket tracking', () => {
  it('reports game_init with room code, status, and player count', () => {
    _renderPlayer();
    const ws = _latestWs();
    _open(ws);
    _message(ws, {
      type: 'game_init',
      myPlayerId: 'p1',
      myHand: [],
      players: [],
      gameState: { status: 'active' },
      variant: 'remove_7s',
      playerCount: 6,
    });
    expect(trackGameInit).toHaveBeenCalledWith('ABCDEF', 'active', 6);
  });

  it('reports game_over with the room code', () => {
    _renderPlayer();
    const ws = _latestWs();
    _open(ws);
    _message(ws, GAME_OVER);
    expect(trackGameOver).toHaveBeenCalledWith('ABCDEF');
  });

  it('reports a drop when a confirmed socket closes and the page outlives it', () => {
    _renderPlayer();
    const ws = _latestWs();
    _open(ws);
    _message(ws, GAME_INIT);
    _serverClose(ws, 1006);
    _outliveDrop();
    expect(trackSocketDropped).toHaveBeenCalledTimes(1);
    expect(trackSocketDropped).toHaveBeenCalledWith({ closeCode: 1006, detectedBy: 'close' });
  });

  it('ignores a drop when the page goes away within 2 seconds', () => {
    const { unmount } = _renderPlayer();
    const ws = _latestWs();
    _open(ws);
    _message(ws, GAME_INIT);
    _serverClose(ws, 1006);
    unmount();
    _outliveDrop();
    expect(trackSocketDropped).not.toHaveBeenCalled();
  });

  it('ignores a socket that was never confirmed', () => {
    _renderPlayer();
    const ws = _latestWs();
    _open(ws);
    _serverClose(ws, 1006);
    _outliveDrop();
    expect(trackSocketDropped).not.toHaveBeenCalled();
  });

  it('ignores the hook closing its own socket', () => {
    const { unmount } = _renderPlayer();
    const ws = _latestWs();
    _open(ws);
    _message(ws, GAME_INIT);
    unmount();
    _outliveDrop();
    expect(ws.close).toHaveBeenCalledWith(1000);
    expect(trackSocketDropped).not.toHaveBeenCalled();
  });

  it('ignores a deliberate server close', () => {
    _renderPlayer();
    const ws = _latestWs();
    _open(ws);
    _message(ws, GAME_INIT);
    _serverClose(ws, 4001);
    _outliveDrop();
    expect(trackSocketDropped).not.toHaveBeenCalled();
  });

  it('ignores a spectator socket drop', () => {
    _renderSpectator();
    const ws = _latestWs();
    _open(ws);
    _message(ws, SPECTATOR_INIT);
    _serverClose(ws, 1006);
    _outliveDrop();
    expect(trackSocketDropped).not.toHaveBeenCalled();
  });

  it('reports an ask, a declaration, and a rematch vote once each is sent', () => {
    const { result } = _renderPlayer();
    const ws = _latestWs();
    _open(ws);
    _message(ws, GAME_INIT);
    act(() => {
      result.current.sendAsk('p2', '5_s', ['5_s', '6_s']);
      result.current.sendDeclare('low_s', { '5_s': 'p1' });
      result.current.sendRematchVote(true);
    });
    expect(trackEvent).toHaveBeenCalledTimes(3);
    expect(trackEvent).toHaveBeenCalledWith('game_ask_submitted', { batch_size: 2 });
    expect(trackEvent).toHaveBeenCalledWith('game_declaration_submitted');
    expect(trackEvent).toHaveBeenCalledWith('rematch_vote_submitted', { vote: 'yes' });
  });

  it('reports nothing for an action taken before game_init', () => {
    const { result } = _renderPlayer();
    _open(_latestWs());
    act(() => {
      result.current.sendAsk('p2', '5_s', ['5_s', '6_s']);
      result.current.sendDeclare('low_s', { '5_s': 'p1' });
      result.current.sendRematchVote(true);
    });
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('reports nothing for an action taken after the socket dropped', () => {
    const { result } = _renderPlayer();
    const ws = _latestWs();
    _open(ws);
    _message(ws, GAME_INIT);
    _serverClose(ws, 1006);
    act(() => {
      result.current.sendAsk('p2', '5_s');
      result.current.sendDeclare('low_s', { '5_s': 'p1' });
      result.current.sendRematchVote(false);
    });
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('ignores game_over for a spectator', () => {
    _renderSpectator();
    const ws = _latestWs();
    _open(ws);
    _message(ws, GAME_OVER);
    expect(trackGameOver).not.toHaveBeenCalled();
  });
});
