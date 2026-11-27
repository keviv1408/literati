import { renderHook, act } from '@testing-library/react';
import posthog from 'posthog-js';
import { useGameSocket } from '@/hooks/useGameSocket';
import { useAskResultAnimations } from '@/hooks/useAskResultAnimations';
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
  it('drops active and pending ask visuals while hidden and keeps receiving game updates', () => {
    const hidden = jest.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const table = document.createElement('div');
    table.className = 'game-table-space';
    table.innerHTML = '<div data-player-id="p1"></div><div data-player-id="p2"></div>';
    document.body.append(table);
    const ask = { type: 'ask_result', askerId: 'p1', targetId: 'p2', success: true, newTurnPlayerId: 'p1', lastMove: 'Ask' };
    try {
      const { result } = renderHook(() => {
        const socket = useGameSocket({ roomCode: 'ABCDEF', bearerToken: 't' });
        const animation = useAskResultAnimations(socket.lastVisibleAskResult, {
          nextAskAnimation: socket.nextAskAnimation, finishAskAnimation: socket.finishAskAnimation,
        });
        return { socket, animation };
      });
      const ws = _latestWs();
      _confirm(ws);
      _message(ws, { ...ask, cardId: '2_h' });
      _message(ws, { ...ask, cardId: '3_h' });
      _advance(20);
      expect(result.current.animation.cardFlight?.cardId).toBe('2_h');
      const staleComplete = result.current.animation.clearCardFlight;
      hidden.mockReturnValue(true);
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      expect(result.current.socket.lastAskResult?.cardId).toBe('3_h');
      expect(result.current.socket.nextAskAnimation).toBeNull();
      expect(result.current.animation.askSpeechBubble).toBeNull();

      _message(ws, { ...ask, cardId: '4_h' });
      _message(ws, { ...ask, cardId: '5_h', success: false, newTurnPlayerId: 'p2' });
      _message(ws, { type: 'hand_update', hand: ['4_h'] });
      _message(ws, { type: 'game_state', state: { status: 'active', currentTurnPlayerId: 'p2' } });
      hidden.mockReturnValue(false);
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      _advance(3200);
      expect(result.current.socket.wsStatus).toBe('connected');
      expect(result.current.socket.askHistory).toHaveLength(4);
      expect(result.current.socket.lastAskResult?.cardId).toBe('5_h');
      expect(result.current.socket.myHand).toEqual(['4_h']);
      expect(result.current.socket.gameState?.currentTurnPlayerId).toBe('p2');
      expect(result.current.animation).toMatchObject({
        cardFlight: null, askDeniedCue: null, speechResult: null, askSpeechBubble: null,
      });
      _message(ws, { ...ask, cardId: '6_h' });
      _advance(20);
      act(staleComplete);
      expect(result.current.animation.cardFlight?.cardId).toBe('6_h');
      expect(result.current.animation.askSpeechBubble).toMatchObject({ variant: 'ask', cards: ['6_h'] });
    } finally {
      hidden.mockRestore();
      table.remove();
    }
  });

  it('skips missing seats and ignores a completed flight from an earlier connection', () => {
    const table = document.createElement('div');
    table.className = 'game-table-space';
    table.innerHTML = '<div data-player-id="p1"></div><div data-player-id="p2"></div>';
    document.body.append(table);
    const ask = { type: 'ask_result', askerId: 'p1', targetId: 'p2', cardId: '3_h',
      success: true, newTurnPlayerId: 'p1', lastMove: 'p1 received 3 of hearts' };
    try {
      const { result } = renderHook(() => {
        const socket = useGameSocket({ roomCode: 'ABCDEF', bearerToken: 't' });
        return useAskResultAnimations(socket.lastVisibleAskResult, {
          nextAskAnimation: socket.nextAskAnimation, finishAskAnimation: socket.finishAskAnimation,
        });
      });
      _confirm(_latestWs());
      _message(_latestWs(), { ...ask, targetId: 'missing' });
      _message(_latestWs(), ask);
      _advance(20);
      _advance(20);
      expect(result.current.cardFlight?.cardId).toBe('3_h');
      const completeOldFlight = result.current.clearCardFlight;
      _serverClose(_latestWs(), 1006);
      expect(result.current.cardFlight).toBeNull();
      _advance(1000);
      _confirm(_latestWs(), { ...GAME_INIT, askHistory: [ask] });
      _advance(20);
      expect(result.current.cardFlight).toBeNull();
      _message(_latestWs(), ask);
      _advance(20);
      const newFlight = result.current.cardFlight;
      expect(newFlight?.cardId).toBe('3_h');
      act(completeOldFlight);
      expect(result.current.cardFlight).toBe(newFlight);
      _message(_latestWs(), { ...ask, cardId: '4_h' });
      _message(_latestWs(), { type: 'game_over' });
      _advance(20);
      expect(result.current.cardFlight).toBeNull();
      expect(result.current.speechResult).toBeNull();
    } finally {
      table.remove();
    }
  });

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
    // First, because a declaration result clears the declaration timer.
    _message(first, {
      type: 'declaration_result',
      declarerId: 'p1',
      halfSuitId: 'low_s',
      correct: false,
      winningTeam: 2,
      newTurnPlayerId: 'p2',
      assignment: {},
      eligibleNextTurnPlayerIds: ['p2', 'p3'],
    });
    _message(first, { type: 'declaration_timer', playerId: 'p1', durationMs: 60000, expiresAt: 1 });
    _message(first, { type: 'player_disconnected', playerId: 'p2', expiresAt: 1, reconnectWindowMs: 60000 });
    expect(result.current.reconnectWindows).toEqual({ p2: { expiresAt: 1, reconnectWindowMs: 60000 } });
    _serverClose(first, 1006);
    expect(result.current.declarationTimer).not.toBeNull();
    expect(result.current.eligibleNextTurnPlayerIds).toEqual(['p2', 'p3']);
    _advance(1000);
    _confirm(_latestWs());
    expect(result.current.declarationTimer).toBeNull();
    expect(result.current.reconnectWindows).toEqual({});
    expect(result.current.eligibleNextTurnPlayerIds).toEqual([]);
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

  it('shows the new vote if the host retries after an uncertain reset', () => {
    const { result } = _renderPlayer();
    const ws = _latestWs();
    _confirm(ws);
    _message(ws, { type: 'rematch_declined', reason: 'room_unavailable' });
    expect(result.current.rematchDeclined?.reason).toBe('room_unavailable');
    _message(ws, { type: 'rematch_vote_update', roundId: 'retry', yesCount: 0 });
    expect(result.current.rematchDeclined).toBeNull();
    expect(result.current.rematchVote?.roundId).toBe('retry');
  });

  it('marks the room abandoned when a reconnect finds the game abandoned, and keeps it after the 4005 close', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = _renderPlayer();
    _confirm(_latestWs());
    _serverClose(_latestWs(), 1006);
    _advance(1000);
    const second = _latestWs();
    _open(second);
    _message(second, { type: 'error', code: 'GAME_ABANDONED', message: 'Game was abandoned' });
    _message(second, { type: 'closing', code: 4005, reason: 'Game abandoned' });
    expect(result.current.wsStatus).toBe('error');
    expect(result.current.roomDissolved).toEqual({ type: 'room_dissolved', reason: 'all_bots' });
    expect(warn).toHaveBeenCalledWith('[game-ws] Server error:', 'GAME_ABANDONED', 'Game was abandoned');
    warn.mockRestore();
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
