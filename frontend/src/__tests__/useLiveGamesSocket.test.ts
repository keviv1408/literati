/**
 * @jest-environment jsdom
 *
 * Unit tests for useLiveGamesSocket hook.
 *
 * Scenarios covered:
 *   - Opens WebSocket to /ws/live-games on mount
 *   - Sets isConnected=true on open
 *   - Sets games on 'live_games_init' message
 *   - Inserts game on 'live_game_added'
 *   - Updates game on 'live_game_updated'
 *   - Removes game on 'live_game_removed'
 *   - Deduplicates game_added (same roomCode)
 *   - Schedules reconnect on close
 *   - Falls back to REST polling after 3+ failures
 *   - Closes socket and clears timers on unmount
 */

import { renderHook, act } from '@testing-library/react';
import { useLiveGamesSocket } from '@/hooks/useLiveGamesSocket';

// ── Mock fetch (REST fallback) ─────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockFetchGames(games: unknown[] = []) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ games, total: games.length }),
  } as Response);
}

// ── Mock WebSocket ─────────────────────────────────────────────────────────

interface MockWsInstance {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  close: jest.Mock;
  send: jest.Mock;
  readyState: number;
  url: string;
}

const wsInstances: MockWsInstance[] = [];

const WS_OPEN = 1;
const WS_CLOSED = 3;

class MockWebSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  readyState: number = WS_OPEN;
  url: string;

  close = jest.fn((_code?: number) => {
    this.readyState = WS_CLOSED;
    if (this.onclose) this.onclose();
  });

  send = jest.fn();

  static readonly OPEN = WS_OPEN;
  static readonly CLOSED = WS_CLOSED;

  constructor(url: string) {
    this.url = url;
    wsInstances.push(this as unknown as MockWsInstance);
  }
}

Object.defineProperty(global, 'WebSocket', {
  value: MockWebSocket,
  writable: true,
});

// ── Helpers ────────────────────────────────────────────────────────────────

function latestWs(): MockWsInstance {
  return wsInstances[wsInstances.length - 1];
}

function send(ws: MockWsInstance, data: unknown) {
  if (ws.onmessage) {
    ws.onmessage({ data: JSON.stringify(data) });
  }
}

const SAMPLE_GAME = {
  roomCode: 'ABC123',
  playerCount: 6,
  currentPlayers: 6,
  cardVariant: 'remove_7s',
  scores: { team1: 2, team2: 1 },
  status: 'in_progress',
  createdAt: Date.now() - 60_000,
  startedAt: Date.now() - 30_000,
  elapsedMs: 30_000,
};

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  wsInstances.length = 0;
  mockFetch.mockReset();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.runAllTimers();
  jest.useRealTimers();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('useLiveGamesSocket', () => {
  it('opens a WebSocket to /ws/live-games on mount', () => {
    renderHook(() => useLiveGamesSocket());
    expect(wsInstances).toHaveLength(1);
    expect(wsInstances[0].url).toContain('/ws/live-games');
  });

  it('sets isConnected=true when socket opens', () => {
    const { result } = renderHook(() => useLiveGamesSocket());
    act(() => {
      latestWs().onopen?.();
    });
    expect(result.current.isConnected).toBe(true);
  });

  it('populates games on live_games_init', () => {
    const { result } = renderHook(() => useLiveGamesSocket());
    act(() => {
      latestWs().onopen?.();
      send(latestWs(), { type: 'live_games_init', games: [SAMPLE_GAME] });
    });
    expect(result.current.games).toHaveLength(1);
    expect(result.current.games[0].roomCode).toBe('ABC123');
  });

  it('inserts a game on live_game_added', () => {
    const { result } = renderHook(() => useLiveGamesSocket());
    act(() => {
      latestWs().onopen?.();
      send(latestWs(), { type: 'live_games_init', games: [] });
      send(latestWs(), { type: 'live_game_added', game: SAMPLE_GAME });
    });
    expect(result.current.games).toHaveLength(1);
    expect(result.current.games[0].roomCode).toBe('ABC123');
  });

  it('does not insert duplicate on live_game_added (same roomCode)', () => {
    const { result } = renderHook(() => useLiveGamesSocket());
    act(() => {
      latestWs().onopen?.();
      send(latestWs(), { type: 'live_games_init', games: [SAMPLE_GAME] });
      send(latestWs(), { type: 'live_game_added', game: SAMPLE_GAME });
    });
    expect(result.current.games).toHaveLength(1);
  });

  it('updates game data on live_game_updated', () => {
    const { result } = renderHook(() => useLiveGamesSocket());
    act(() => {
      latestWs().onopen?.();
      send(latestWs(), { type: 'live_games_init', games: [SAMPLE_GAME] });
    });

    const updatedGame = {
      ...SAMPLE_GAME,
      scores: { team1: 3, team2: 2 },
    };

    act(() => {
      send(latestWs(), { type: 'live_game_updated', game: updatedGame });
    });

    expect(result.current.games[0].scores).toEqual({ team1: 3, team2: 2 });
  });

  it('removes game on live_game_removed', () => {
    const { result } = renderHook(() => useLiveGamesSocket());
    act(() => {
      latestWs().onopen?.();
      send(latestWs(), { type: 'live_games_init', games: [SAMPLE_GAME] });
      send(latestWs(), { type: 'live_game_removed', roomCode: 'ABC123' });
    });
    expect(result.current.games).toHaveLength(0);
  });

  it('does not remove games with a different roomCode', () => {
    const secondGame = { ...SAMPLE_GAME, roomCode: 'XYZ789' };
    const { result } = renderHook(() => useLiveGamesSocket());
    act(() => {
      latestWs().onopen?.();
      send(latestWs(), { type: 'live_games_init', games: [SAMPLE_GAME, secondGame] });
      send(latestWs(), { type: 'live_game_removed', roomCode: 'ABC123' });
    });
    expect(result.current.games).toHaveLength(1);
    expect(result.current.games[0].roomCode).toBe('XYZ789');
  });

  it('sets isConnected=false on socket close', () => {
    const { result } = renderHook(() => useLiveGamesSocket());
    act(() => {
      latestWs().onopen?.();
    });
    expect(result.current.isConnected).toBe(true);

    act(() => {
      latestWs().onclose?.();
    });
    expect(result.current.isConnected).toBe(false);
  });

  it('schedules reconnect after socket close', () => {
    const countBefore = wsInstances.length;
    renderHook(() => useLiveGamesSocket());
    act(() => {
      latestWs().onopen?.();
      latestWs().onclose?.();
    });

    // Advance past the RECONNECT_DELAY_MS (3 s)
    act(() => {
      jest.advanceTimersByTime(4_000);
    });

    expect(wsInstances.length).toBeGreaterThan(countBefore + 1);
  });

  it('clears socket and timers on unmount', () => {
    const { unmount } = renderHook(() => useLiveGamesSocket());
    const ws = latestWs();
    act(() => {
      ws.onopen?.();
    });

    unmount();

    expect(ws.close).toHaveBeenCalled();
  });

  it('ignores malformed JSON messages without throwing', () => {
    const { result } = renderHook(() => useLiveGamesSocket());
    act(() => {
      latestWs().onopen?.();
      // Send garbage data
      latestWs().onmessage?.({ data: 'not json' });
    });
    expect(result.current.games).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });

  it('starts REST fallback polling after 3 consecutive failures', () => {
    mockFetchGames([SAMPLE_GAME]);
    mockFetchGames([SAMPLE_GAME]);

    const { result } = renderHook(() => useLiveGamesSocket());

    // Simulate 3 successive close events without opens (consecutive failures)
    act(() => {
      latestWs().onclose?.();
    });
    act(() => {
      jest.advanceTimersByTime(4_000);
      latestWs().onclose?.();
    });
    act(() => {
      jest.advanceTimersByTime(4_000);
      latestWs().onclose?.();
    });

    expect(result.current.isFallback).toBe(true);
  });
});
