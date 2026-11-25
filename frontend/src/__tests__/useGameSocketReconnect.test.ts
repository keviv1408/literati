import { renderHook, act } from '@testing-library/react';
import posthog from 'posthog-js';
import { useGameSocket } from '@/hooks/useGameSocket';
import {
  reportPendingSocketDrop,
  trackEvent,
  trackSocketDropped,
  trackSocketRecovered,
} from '@/lib/analytics';

jest.mock('posthog-js', () => ({
  __esModule: true,
  default: { capture: jest.fn(), captureException: jest.fn() },
}));

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
  // Reset, not clear: one test routes the analytics mocks to the real module.
  jest.resetAllMocks();
  localStorage.clear();
});

afterEach(() => {
  jest.useRealTimers();
});

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

function _confirm(ws: MockWsInstance, init: object = GAME_INIT) {
  _open(ws);
  _message(ws, init);
}

function _serverClose(ws: MockWsInstance, code: number) {
  act(() => {
    ws.readyState = MockWebSocket.CLOSED;
    ws.onclose?.({ code, reason: '' });
  });
}

function _advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

function _callOrder(...fns: unknown[]): number[] {
  return fns.map((fn) => (fn as jest.Mock).mock.invocationCallOrder[0]);
}

describe('useGameSocket reconnect', () => {
  it('reconnects in place after an unexpected close', () => {
    const { result } = _renderPlayer();
    _confirm(_latestWs());
    _serverClose(_latestWs(), 1006);
    expect(result.current.wsStatus).toBe('reconnecting');
    expect(wsInstances).toHaveLength(1);
    _advance(1000);
    expect(wsInstances).toHaveLength(2);
  });

  it('calls the onGameInit passed on the latest render', () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = renderHook(
      ({ onGameInit }) => useGameSocket({ roomCode: 'ABCDEF', bearerToken: 't', onGameInit }),
      { initialProps: { onGameInit: first } },
    );
    const ws = _latestWs();
    _open(ws);
    rerender({ onGameInit: second });
    _message(ws, GAME_INIT);
    expect(wsInstances).toHaveLength(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('active');
  });

  it('calls onGameInit on spectator_init', () => {
    const onGameInit = jest.fn();
    renderHook(() =>
      useGameSocket({ roomCode: 'ABCDEF', bearerToken: null, spectatorToken: 's', onGameInit }),
    );
    _confirm(_latestWs(), SPECTATOR_INIT);
    expect(onGameInit).toHaveBeenCalledWith('active');
  });

  describe('with the real analytics module', () => {
    beforeEach(() => {
      const actual = jest.requireActual<typeof import('@/lib/analytics')>('@/lib/analytics');
      jest.mocked(trackSocketDropped).mockImplementation(actual.trackSocketDropped);
      jest.mocked(reportPendingSocketDrop).mockImplementation(actual.reportPendingSocketDrop);
      jest.mocked(trackSocketRecovered).mockImplementation(actual.trackSocketRecovered);
      process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    });

    afterEach(() => {
      delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    });

    it('sends a counted drop once when the player reloads before it heals', () => {
      const { unmount } = _renderPlayer();
      _confirm(_latestWs());
      _serverClose(_latestWs(), 1006);
      _advance(2000);
      unmount();
      // What the next page load does.
      jest.requireActual<typeof import('@/lib/analytics')>('@/lib/analytics').reportPendingSocketDrop();
      const events = jest.mocked(posthog.capture).mock.calls.map(([event]) => event);
      expect(events).toEqual(['game_socket_dropped']);
    });
  });

  it('reports connecting after open and connected only after game_init', () => {
    const { result } = _renderPlayer();
    const ws = _latestWs();
    _open(ws);
    expect(result.current.wsStatus).toBe('connecting');
    _message(ws, GAME_INIT);
    expect(result.current.wsStatus).toBe('connected');
  });

  it('resets turn and seat state once the new socket is confirmed', () => {
    const { result } = _renderPlayer();
    const first = _latestWs();
    _confirm(first);
    _message(first, { type: 'declaration_timer', playerId: 'p1', durationMs: 60000, expiresAt: 1 });
    _message(first, { type: 'player_disconnected', playerId: 'p2', expiresAt: 1, reconnectWindowMs: 60000 });
    _serverClose(first, 1006);
    expect(result.current.declarationTimer).not.toBeNull();
    _advance(1000);
    _confirm(_latestWs());
    expect(result.current.declarationTimer).toBeNull();
    expect(result.current.reconnectWindows).toEqual({});
  });

  it('counts a drop that heals in 1 second once, then reports the recovery', () => {
    _renderPlayer();
    _confirm(_latestWs());
    _serverClose(_latestWs(), 1006);
    _advance(1000);
    _confirm(_latestWs());
    _advance(5000);
    expect(trackSocketDropped).toHaveBeenCalledTimes(1);
    expect(trackSocketDropped).toHaveBeenCalledWith({ closeCode: 1006, detectedBy: 'close' });
    expect(reportPendingSocketDrop).toHaveBeenCalledTimes(1);
    expect(trackSocketRecovered).toHaveBeenCalledTimes(1);
    expect(trackSocketRecovered).toHaveBeenCalledWith(1, 'close');
    const [dropped, flushed, recovered] = _callOrder(trackSocketDropped, reportPendingSocketDrop, trackSocketRecovered);
    expect(dropped).toBeLessThan(flushed);
    expect(flushed).toBeLessThan(recovered);
  });

  it('counts a drop that lasts 5 seconds at 2 seconds, before it heals', () => {
    _renderPlayer();
    _confirm(_latestWs());
    _serverClose(_latestWs(), 1006);
    _advance(1999);
    expect(trackSocketDropped).not.toHaveBeenCalled();
    _advance(1);
    expect(trackSocketDropped).toHaveBeenCalledTimes(1);
    expect(trackSocketDropped).toHaveBeenCalledWith({ closeCode: 1006, detectedBy: 'close' });
    expect(reportPendingSocketDrop).not.toHaveBeenCalled();
    const second = _latestWs();
    _open(second);
    _advance(3000);
    _message(second, GAME_INIT);
    expect(trackSocketDropped).toHaveBeenCalledTimes(1);
    expect(reportPendingSocketDrop).toHaveBeenCalledTimes(1);
    expect(trackSocketRecovered).toHaveBeenCalledWith(5, 'close');
    const [flushed, recovered] = _callOrder(reportPendingSocketDrop, trackSocketRecovered);
    expect(flushed).toBeLessThan(recovered);
  });

  it('never counts a drop when the page unmounts 1 second after it', () => {
    const { unmount } = _renderPlayer();
    _confirm(_latestWs());
    _serverClose(_latestWs(), 1006);
    _advance(1000);
    unmount();
    _advance(5000);
    expect(trackSocketDropped).not.toHaveBeenCalled();
  });

  it('tracks nothing for a spectator drop and recovery', () => {
    const { result } = _renderSpectator();
    _confirm(_latestWs(), SPECTATOR_INIT);
    _serverClose(_latestWs(), 1006);
    _advance(2000);
    _confirm(_latestWs(), SPECTATOR_INIT);
    expect(result.current.wsStatus).toBe('connected');
    expect(trackSocketDropped).not.toHaveBeenCalled();
    expect(reportPendingSocketDrop).not.toHaveBeenCalled();
    expect(trackSocketRecovered).not.toHaveBeenCalled();
  });

  it('stops on a closing 4006 notice', () => {
    const { result } = _renderPlayer();
    _confirm(_latestWs());
    _message(_latestWs(), { type: 'closing', code: 4006, reason: 'Replaced by a newer connection' });
    expect(result.current.wsStatus).toBe('error');
    expect(result.current.error).toBe('This game was opened in another tab or window.');
    _advance(60000);
    expect(wsInstances).toHaveLength(1);
  });

  it('sends nothing while reconnecting', () => {
    const { result } = _renderPlayer();
    const first = _latestWs();
    _confirm(first);
    _serverClose(first, 1006);
    _advance(1000);
    const second = _latestWs();
    _open(second);
    expect(result.current.wsStatus).toBe('reconnecting');
    act(() => {
      result.current.sendAsk('p2', '5_s');
      result.current.sendDeclare('low_s', { '5_s': 'p1' });
      result.current.sendChooseNextTurn('p3');
    });
    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
    expect(result.current.pendingTurnPassAck).toBe(false);
  });

  it('calls onGameInit with the game status on each game_init', () => {
    const onGameInit = jest.fn();
    renderHook(() => useGameSocket({ roomCode: 'ABCDEF', bearerToken: 't', onGameInit }));
    _confirm(_latestWs());
    _serverClose(_latestWs(), 1006);
    _advance(1000);
    _confirm(_latestWs());
    expect(onGameInit.mock.calls).toEqual([['active'], ['active']]);
  });
});
