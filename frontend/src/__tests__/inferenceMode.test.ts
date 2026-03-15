/**
 * @jest-environment jsdom
 *
 * Tests for shared global inference-mode state (Sub-AC 37b).
 *
 * Coverage:
 *   useGameSocket — inferenceMode state:
 *     1. inferenceMode is false by default
 *     2. game_init syncs inferenceMode from gameState.inferenceMode (true)
 *     3. game_init syncs inferenceMode from gameState.inferenceMode (false)
 *     4. spectator_init syncs inferenceMode from gameState.inferenceMode
 *     5. inference_mode_changed message sets inferenceMode to true
 *     6. inference_mode_changed message sets inferenceMode to false
 *     7. game_state broadcast updates inferenceMode
 *   useGameSocket — sendToggleInference:
 *     8. sendToggleInference sends { type: 'toggle_inference' } when OPEN
 *     9. sendToggleInference is a no-op when socket is not OPEN
 */

import { renderHook, act } from '@testing-library/react';
import { useGameSocket } from '@/hooks/useGameSocket';

// ── Mock WebSocket ─────────────────────────────────────────────────────────

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
  readyState: number = MockWebSocket.CONNECTING;
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

// ── Jest setup ─────────────────────────────────────────────────────────────

beforeAll(() => {
  Object.defineProperty(globalThis, 'WebSocket', {
    writable: true,
    value: MockWebSocket,
  });
  (MockWebSocket as unknown as Record<string, number>).OPEN = 1;
});

beforeEach(() => {
  wsInstances.length = 0;
  jest.clearAllMocks();
});

// ── Mock @/lib/api ─────────────────────────────────────────────────────────

jest.mock('@/lib/api', () => ({
  API_URL: 'http://localhost:3001',
}));

// ── Helper ─────────────────────────────────────────────────────────────────

function getLastWs(): MockWsInstance {
  return wsInstances[wsInstances.length - 1];
}

function openWs(ws: MockWsInstance) {
  act(() => {
    ws.readyState = MockWebSocket.OPEN;
    ws.onopen?.();
  });
}

function sendMsg(ws: MockWsInstance, data: unknown) {
  act(() => {
    ws.onmessage?.({ data: JSON.stringify(data) });
  });
}

const BASE_OPTIONS = {
  roomCode: 'INFER1',
  bearerToken: 'tok-abc',
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('useGameSocket — inferenceMode default', () => {
  it('inferenceMode is false by default', () => {
    const { result } = renderHook(() => useGameSocket(BASE_OPTIONS));
    expect(result.current.inferenceMode).toBe(false);
  });
});

describe('useGameSocket — game_init syncs inferenceMode', () => {
  it('sets inferenceMode to true from game_init when server has it enabled', () => {
    const { result } = renderHook(() => useGameSocket(BASE_OPTIONS));
    const ws = getLastWs();
    openWs(ws);

    sendMsg(ws, {
      type:        'game_init',
      myPlayerId:  'p1',
      myHand:      [],
      players:     [],
      variant:     'remove_7s',
      playerCount: 6,
      gameState:   {
        status: 'active',
        currentTurnPlayerId: 'p1',
        scores: { team1: 0, team2: 0 },
        lastMove: null,
        winner: null,
        tiebreakerWinner: null,
        declaredSuits: [],
        inferenceMode: true,
      },
    });

    expect(result.current.inferenceMode).toBe(true);
  });

  it('sets inferenceMode to false from game_init when server has it disabled', () => {
    const { result } = renderHook(() => useGameSocket(BASE_OPTIONS));
    const ws = getLastWs();
    openWs(ws);

    // First send a toggle to get to true
    sendMsg(ws, {
      type:    'inference_mode_changed',
      enabled: true,
      toggledBy: 'p2',
    });
    expect(result.current.inferenceMode).toBe(true);

    // Now receive game_init with inferenceMode: false (e.g., reconnect)
    sendMsg(ws, {
      type:        'game_init',
      myPlayerId:  'p1',
      myHand:      [],
      players:     [],
      variant:     'remove_7s',
      playerCount: 6,
      gameState:   {
        status: 'active',
        currentTurnPlayerId: 'p1',
        scores: { team1: 0, team2: 0 },
        lastMove: null,
        winner: null,
        tiebreakerWinner: null,
        declaredSuits: [],
        inferenceMode: false,
      },
    });

    expect(result.current.inferenceMode).toBe(false);
  });
});

describe('useGameSocket — spectator_init syncs inferenceMode', () => {
  it('sets inferenceMode from spectator_init gameState', () => {
    const { result } = renderHook(() => useGameSocket(BASE_OPTIONS));
    const ws = getLastWs();
    openWs(ws);

    sendMsg(ws, {
      type:        'spectator_init',
      players:     [],
      variant:     'remove_7s',
      playerCount: 6,
      gameState:   {
        status: 'active',
        currentTurnPlayerId: 'p1',
        scores: { team1: 0, team2: 0 },
        lastMove: null,
        winner: null,
        tiebreakerWinner: null,
        declaredSuits: [],
        inferenceMode: true,
      },
    });

    expect(result.current.inferenceMode).toBe(true);
  });
});

describe('useGameSocket — inference_mode_changed handler', () => {
  it('sets inferenceMode to true when inference_mode_changed with enabled=true', () => {
    const { result } = renderHook(() => useGameSocket(BASE_OPTIONS));
    const ws = getLastWs();
    openWs(ws);

    sendMsg(ws, { type: 'inference_mode_changed', enabled: true, toggledBy: 'p1' });

    expect(result.current.inferenceMode).toBe(true);
  });

  it('sets inferenceMode to false when inference_mode_changed with enabled=false', () => {
    const { result } = renderHook(() => useGameSocket(BASE_OPTIONS));
    const ws = getLastWs();
    openWs(ws);

    // Turn on first
    sendMsg(ws, { type: 'inference_mode_changed', enabled: true, toggledBy: 'p1' });
    expect(result.current.inferenceMode).toBe(true);

    // Now turn off
    sendMsg(ws, { type: 'inference_mode_changed', enabled: false, toggledBy: 'p2' });
    expect(result.current.inferenceMode).toBe(false);
  });
});

describe('useGameSocket — game_state updates inferenceMode', () => {
  it('updates inferenceMode from game_state broadcast', () => {
    const { result } = renderHook(() => useGameSocket(BASE_OPTIONS));
    const ws = getLastWs();
    openWs(ws);

    sendMsg(ws, {
      type:  'game_state',
      state: {
        status: 'active',
        currentTurnPlayerId: 'p1',
        scores: { team1: 0, team2: 0 },
        lastMove: null,
        winner: null,
        tiebreakerWinner: null,
        declaredSuits: [],
        inferenceMode: true,
      },
    });

    expect(result.current.inferenceMode).toBe(true);
  });

  it('sets inferenceMode to false when game_state has inferenceMode=false', () => {
    const { result } = renderHook(() => useGameSocket(BASE_OPTIONS));
    const ws = getLastWs();
    openWs(ws);

    // First turn on via direct event
    sendMsg(ws, { type: 'inference_mode_changed', enabled: true, toggledBy: 'p1' });

    // Then get game_state with false
    sendMsg(ws, {
      type:  'game_state',
      state: {
        status: 'active',
        currentTurnPlayerId: 'p2',
        scores: { team1: 1, team2: 0 },
        lastMove: 'p1 declared low_s',
        winner: null,
        tiebreakerWinner: null,
        declaredSuits: [],
        inferenceMode: false,
      },
    });

    expect(result.current.inferenceMode).toBe(false);
  });
});

describe('useGameSocket — sendToggleInference', () => {
  it('sends { type: "toggle_inference" } when socket is OPEN', () => {
    const { result } = renderHook(() => useGameSocket(BASE_OPTIONS));
    const ws = getLastWs();
    openWs(ws);

    act(() => {
      result.current.sendToggleInference();
    });

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({ type: 'toggle_inference' });
  });

  it('is a no-op when socket is not OPEN', () => {
    const { result } = renderHook(() => useGameSocket(BASE_OPTIONS));
    const ws = getLastWs();
    // Do NOT call openWs — socket stays in CONNECTING state

    act(() => {
      result.current.sendToggleInference();
    });

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('sendToggleInference is present in hook return value', () => {
    const { result } = renderHook(() => useGameSocket(BASE_OPTIONS));
    expect(typeof result.current.sendToggleInference).toBe('function');
  });
});
