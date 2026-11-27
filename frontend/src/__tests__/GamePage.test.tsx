/**
 * @jest-environment jsdom
 *
 * Tests for /game/[room-id] — *
 * • Renders loading state immediately on mount.
 * • Renders "Invalid Room Code" error for malformed room IDs (e.g. "ABC").
 * • Renders "Room Not Found" error when GET /api/rooms/:code returns 404.
 * • Keeps retrying the room load behind the loading view on any other failure.
 * • Redirects to /room/<CODE> when room status is 'waiting'.
 * • Redirects to /room/<CODE> when room status is 'starting'.
 * • Renders game view (data-testid="game-view") for 'in_progress' rooms.
 * • Renders "Game Cancelled" state for cancelled rooms.
 * • Renders "Game Over" state for completed rooms.
 * • Shows the player-relative score and connection state in the game header and menu.
 * • Turn indicator is NOT rendered when gameState is null.
 * • Player hand area is rendered in the game view footer.
 */

import React from 'react';
import { render, screen, waitFor, act, fireEvent, within, cleanup } from '@testing-library/react';
import type { useGameSocket, UseGameSocketReturn } from '@/hooks/useGameSocket';
import type { ReconnectResult } from '@/hooks/useReconnect';
import type { CardId, GamePlayer, PublicGameState } from '@/types/game';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPush = jest.fn();
const mockReplace = jest.fn();
// The real router is stable across renders; a new object each render would refetch the room.
const mockRouter = { push: mockPush, replace: mockReplace };
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => ({ get: () => null }),
}));

type GameSocketOptions = Parameters<typeof useGameSocket>[0];

// Null runs the real hook over MockWebSocket; a test sets it before render to fake the hook.
let mockGameSocket: ((options: GameSocketOptions) => UseGameSocketReturn) | null = null;
jest.mock('@/hooks/useGameSocket', () => {
  const actual = jest.requireActual('@/hooks/useGameSocket');
  return {
    ...actual,
    useGameSocket: (options: GameSocketOptions) =>
      mockGameSocket ? mockGameSocket(options) : actual.useGameSocket(options),
  };
});

// Null runs the real hook; a test sets it before render to fake the session check.
let mockReconnect: ReconnectResult | null = null;
jest.mock('@/hooks/useReconnect', () => {
  const actual = jest.requireActual('@/hooks/useReconnect');
  return {
    ...actual,
    useReconnect: () => mockReconnect ?? actual.useReconnect(),
  };
});

// Mock the API module
const mockGetRoomByCode = jest.fn();
const mockGetGameSummary = jest.fn();
jest.mock('@/lib/api', () => ({
  getRoomByCode: (...args: unknown[]) => mockGetRoomByCode(...args),
  getGameSummary: (...args: unknown[]) => mockGetGameSummary(...args),
  getGuestBearerToken: jest.fn().mockResolvedValue('mock-bearer-token'),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      message: string,
      public readonly body?: unknown
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
  API_URL: 'http://localhost:3001',
}));

// Mock backendSession
jest.mock('@/lib/backendSession', () => ({
  getCachedToken: jest.fn().mockReturnValue('cached-token'),
}));

// Mock kickedRooms
jest.mock('@/lib/kickedRooms', () => ({
  isKickedFromRoom: jest.fn().mockReturnValue(false),
}));

// Mock GuestContext
const mockGuestSession = { displayName: 'TestPlayer', sessionId: 'guest-123' };
jest.mock('@/contexts/GuestContext', () => ({
  useGuest: () => ({ guestSession: mockGuestSession }),
}));

// Mock WebSocket globally — tracks the most recently created instance so tests
// can simulate incoming messages (game_init, etc.) by calling onmessage.
let lastMockWsInstance: MockWebSocket | null = null;

class MockWebSocket {
  // Mirror the standard WebSocket ready-state constants so hooks that check
  // `ws.readyState !== WebSocket.OPEN` work correctly in tests.
  static CONNECTING = 0;
  static OPEN       = 1;
  static CLOSING    = 2;
  static CLOSED     = 3;

  onopen: (() => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  readyState = 0; // CONNECTING
  close() { this.readyState = 3; }
  send() {}
  constructor(public url: string) {
    MockWebSocket.latestInstance = this;
    lastMockWsInstance = MockWebSocket.latestInstance;
  }

  static latestInstance: MockWebSocket | null = null;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).WebSocket = MockWebSocket;

/** Open the WS connection and advance readyState to OPEN (1). */
function openWs() {
  if (lastMockWsInstance) {
    lastMockWsInstance.readyState = 1;
    lastMockWsInstance.onopen?.();
  }
}

/** Push a raw message object through the mock WS onmessage handler. */
function sendWsMessage(msg: Record<string, unknown>) {
  lastMockWsInstance?.onmessage?.({
    data: JSON.stringify(msg),
  } as MessageEvent);
}

// ---------------------------------------------------------------------------
// Import the page AFTER all mocks are set up
// ---------------------------------------------------------------------------

// Dynamic import to allow mock hoisting to work properly
let GamePage: React.ComponentType<{ params: Promise<{ 'room-id': string }> }>;

beforeAll(async () => {
  const mod = await import('@/app/game/[room-id]/page');
  GamePage = mod.default;
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build a minimal Room object for a given status. */
function buildRoom(
  status: string,
  overrides: Partial<{
    code: string;
    player_count: 6 | 8;
    card_removal_variant: string;
  }> = {}
) {
  return {
    id: 'room-uuid-1',
    code: overrides.code ?? 'ABC123',
    invite_code: 'invite-hex-1234567890abcdef',
    host_user_id: 'host-uuid',
    player_count: overrides.player_count ?? 6,
    card_removal_variant: overrides.card_removal_variant ?? 'remove_7s',
    status,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

/** Helper to build resolved params promise. */
function makeParams(roomId: string): Promise<{ 'room-id': string }> {
  return Promise.resolve({ 'room-id': roomId });
}

// The room load starts in the render this flushes, so call it once after render before timing anything.
async function _advanceTime(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  lastMockWsInstance = null;
  mockGameSocket = null;
  mockReconnect = null;
  mockGetGameSummary.mockResolvedValue({
    roomCode: 'ABC123',
    winner: 1,
    tiebreakerWinner: null,
    scores: { team1: 5, team2: 3 },
    variant: 'remove_7s',
    declaredSuits: [
      { halfSuitId: 'low_s', teamId: 1, declaredBy: 'p1' },
      { halfSuitId: 'high_s', teamId: 2, declaredBy: 'p2' },
    ],
    mvpPlayerId: 'p1',
    playerSummaries: [
      {
        playerId: 'p1',
        displayName: 'Alice',
        avatarId: null,
        teamId: 1,
        isBot: false,
        isGuest: false,
        declarationAttempts: 1,
        declarationSuccesses: 1,
        declarationFailures: 0,
        askAttempts: 2,
        askSuccesses: 2,
        askFailures: 0,
        repeatedAskAttempts: 0,
        cardsWonFromOpponents: 2,
        mostTargetedOpponentId: 'p2',
        mostTargetedOpponentAskCount: 2,
        averageMoveTimeMs: 5900,
      },
      {
        playerId: 'p2',
        displayName: 'Bob',
        avatarId: null,
        teamId: 2,
        isBot: false,
        isGuest: false,
        declarationAttempts: 0,
        declarationSuccesses: 0,
        declarationFailures: 0,
        askAttempts: 1,
        askSuccesses: 0,
        askFailures: 1,
        repeatedAskAttempts: 1,
        cardsWonFromOpponents: 0,
        mostTargetedOpponentId: 'p1',
        mostTargetedOpponentAskCount: 1,
        averageMoveTimeMs: 4200,
      },
    ],
  });
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

describe('GamePage — loading state', () => {
  it('renders the loading spinner before the API resolves', async () => {
    // Keep the API pending indefinitely.
    mockGetRoomByCode.mockReturnValue(new Promise(() => {}));

    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('game-loading')).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// Invalid format
// ---------------------------------------------------------------------------

describe('GamePage — invalid format', () => {
  it('shows "Invalid Room Code" for a 3-char code', async () => {
    render(<GamePage params={makeParams('ABC')} />);

    await waitFor(() => {
      expect(screen.getByTestId('invalid-format-view')).toBeTruthy();
    });
    expect(screen.getByText('Invalid Room Code')).toBeTruthy();
    // API should not be called for invalid formats
    expect(mockGetRoomByCode).not.toHaveBeenCalled();
  });

  it('shows "Invalid Room Code" for an empty string', async () => {
    render(<GamePage params={makeParams('')} />);

    await waitFor(() => {
      expect(screen.getByTestId('invalid-format-view')).toBeTruthy();
    });
  });

  it('shows "Invalid Room Code" for a code with special characters', async () => {
    render(<GamePage params={makeParams('AB!@#$')} />);

    await waitFor(() => {
      expect(screen.getByTestId('invalid-format-view')).toBeTruthy();
    });
    expect(mockGetRoomByCode).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Room not found
// ---------------------------------------------------------------------------

describe('GamePage — room not found', () => {
  it('shows "Room Not Found" when API returns 404', async () => {
    const { ApiError } = await import('@/lib/api');
    mockGetRoomByCode.mockRejectedValue(new ApiError(404, 'Room not found'));

    render(<GamePage params={makeParams('XYZ999')} />);

    await waitFor(() => {
      expect(screen.getByTestId('not-found-view')).toBeTruthy();
    });
    expect(screen.getByText('Room Not Found')).toBeTruthy();
  });

  it('keeps loading and retries after an HTTP 500 instead of "Something Went Wrong"', async () => {
    const { ApiError } = await import('@/lib/api');
    mockGetRoomByCode.mockRejectedValue(new ApiError(500, 'Internal server error'));

    jest.useFakeTimers();
    try {
      render(<GamePage params={makeParams('ABC123')} />);
      await _advanceTime(0);
      await _advanceTime(1000);

      expect(mockGetRoomByCode).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('game-loading')).toBeTruthy();
      expect(screen.queryByTestId('generic-error-view')).toBeNull();
    } finally {
      cleanup();
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// While the backend is down (fake timers)
// ---------------------------------------------------------------------------

describe('GamePage — while the backend is down', () => {
  const WAKING_LINE = 'Waking up the table… this can take up to a minute.';

  beforeEach(() => {
    // clearAllMocks keeps queued once-values, so an unconsumed one would leak into the next test.
    mockGetRoomByCode.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  it('loads the game once the room fetch succeeds, never showing "Something Went Wrong"', async () => {
    mockGetRoomByCode
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ room: buildRoom('in_progress') });

    render(<GamePage params={makeParams('ABC123')} />);
    await _advanceTime(0);
    expect(mockGetRoomByCode).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('generic-error-view')).toBeNull();

    await _advanceTime(1000);
    expect(mockGetRoomByCode).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('generic-error-view')).toBeNull();

    await _advanceTime(2000);
    expect(mockGetRoomByCode).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId('generic-error-view')).toBeNull();
    expect(screen.getByTestId('game-view')).toBeTruthy();
  });

  it('shows "Room Not Found" on a 404 and stops retrying', async () => {
    const { ApiError } = await import('@/lib/api');
    mockGetRoomByCode.mockRejectedValue(new ApiError(404, 'Room not found'));

    render(<GamePage params={makeParams('XYZ999')} />);
    await _advanceTime(0);
    expect(screen.getByTestId('not-found-view')).toBeTruthy();

    await _advanceTime(60_000);
    expect(mockGetRoomByCode).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('not-found-view')).toBeTruthy();
  });

  it('shows the waking line while it retries, then the unreachable view at 60 s, and keeps retrying', async () => {
    mockGetRoomByCode.mockRejectedValue(new TypeError('Failed to fetch'));

    render(<GamePage params={makeParams('ABC123')} />);
    await _advanceTime(0);
    await _advanceTime(2000);
    expect(screen.getByTestId('game-loading')).toBeTruthy();
    expect(screen.getByText(WAKING_LINE)).toBeTruthy();

    await _advanceTime(57_999);
    expect(screen.queryByTestId('server-unreachable-view')).toBeNull();

    await _advanceTime(1);
    const view = screen.getByTestId('server-unreachable-view');
    fireEvent.click(within(view).getByRole('button', { name: 'Back to Home' }));
    expect(mockPush).toHaveBeenCalledWith('/');

    const callsAt60s = mockGetRoomByCode.mock.calls.length;
    await _advanceTime(10_000);
    expect(mockGetRoomByCode.mock.calls.length).toBeGreaterThan(callsAt60s);
  });

  it.each<ReconnectResult['status']>(['reconnecting', 'no_session'])(
    'never retries the session check while it reports %s',
    async (status) => {
      const retry = jest.fn();
      mockReconnect = {
        status,
        sessionId: null,
        bearerToken: null,
        isGuest: false,
        displayName: null,
        errorMessage: null,
        retry,
      };
      mockGetRoomByCode.mockReturnValue(new Promise(() => {}));

      render(<GamePage params={makeParams('ABC123')} />);
      await _advanceTime(0);
      await _advanceTime(60_000);

      expect(retry).not.toHaveBeenCalled();
    },
  );

  it('retries the session check from error on the backoff schedule, and restarts the schedule after ready', async () => {
    const retry = jest.fn();
    mockReconnect = {
      status: 'error',
      sessionId: null,
      bearerToken: null,
      isGuest: false,
      displayName: null,
      errorMessage: 'Could not connect to the server.',
      retry,
    };
    mockGetRoomByCode.mockReturnValue(new Promise(() => {}));
    const params = makeParams('ABC123');
    const { rerender } = render(<GamePage params={params} />);
    // One render per status, as the real hook reports them, so the retry effect sees every step.
    const goThrough = (...statuses: ReconnectResult['status'][]) => {
      for (const status of statuses) {
        mockReconnect = { ...mockReconnect!, status };
        rerender(<GamePage params={params} />);
      }
    };

    await _advanceTime(999);
    expect(retry).not.toHaveBeenCalled();
    await _advanceTime(1);
    expect(retry).toHaveBeenCalledTimes(1);

    goThrough('loading', 'reconnecting', 'error');
    await _advanceTime(1999);
    expect(retry).toHaveBeenCalledTimes(1);
    await _advanceTime(1);
    expect(retry).toHaveBeenCalledTimes(2);

    goThrough('loading', 'reconnecting', 'ready');
    await _advanceTime(60_000);
    expect(retry).toHaveBeenCalledTimes(2);

    goThrough('reconnecting', 'error');
    await _advanceTime(999);
    expect(retry).toHaveBeenCalledTimes(2);
    await _advanceTime(1);
    expect(retry).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Status-based redirects
// ---------------------------------------------------------------------------

describe('GamePage — lobby redirect for waiting/starting rooms', () => {
  it('redirects to /room/<CODE> when room.status is "waiting"', async () => {
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('waiting') });

    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/room/ABC123');
    });
  });

  it('redirects to /room/<CODE> when room.status is "starting"', async () => {
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('starting') });

    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/room/ABC123');
    });
  });
});

// ---------------------------------------------------------------------------
// Cancelled room
// ---------------------------------------------------------------------------

describe('GamePage — cancelled room', () => {
  it('shows "Game Cancelled" state for cancelled rooms', async () => {
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('cancelled') });

    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('cancelled-view')).toBeTruthy();
    });
    expect(screen.getByText('Game Cancelled')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Abandoned room
// ---------------------------------------------------------------------------

describe('GamePage — abandoned room', () => {
  it('shows "Game Abandoned" state for abandoned rooms', async () => {
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('abandoned') });

    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('abandoned-view')).toBeTruthy();
    });
    expect(screen.getByText('Game Abandoned')).toBeTruthy();
  });

  it('switches to the abandoned state when the server dissolves an all-bot game', async () => {
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('in_progress') });

    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('game-view')).toBeTruthy();
    });

    act(() => openWs());

    act(() => sendWsMessage({ type: 'room_dissolved', reason: 'all_bots' }));

    await waitFor(() => {
      expect(screen.getByTestId('abandoned-view')).toBeTruthy();
    });
    expect(screen.getByText(/bot-only game was ended automatically/i)).toBeTruthy();
  });

  it('switches to the abandoned state when the server rejects the socket with GAME_ABANDONED', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('in_progress') });

    render(<GamePage params={makeParams('ABC123')} />);
    await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

    act(() => openWs());
    act(() => sendWsMessage({ type: 'error', code: 'GAME_ABANDONED', message: 'Game was abandoned' }));
    act(() => sendWsMessage({ type: 'closing', code: 4005, reason: 'Game abandoned' }));

    await waitFor(() => expect(screen.getByTestId('abandoned-view')).toBeTruthy());
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Completed room
// ---------------------------------------------------------------------------

describe('GamePage — completed room', () => {
  it('shows "Game Over" state for completed rooms', async () => {
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('completed') });

    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('game-completed-view')).toBeTruthy();
    });
    expect(await screen.findByRole('heading', {name: /team 1 wins/i})).toBeTruthy();
    await waitFor(() => {
      expect(mockGetGameSummary).toHaveBeenCalledWith('ABC123');
    });
  });

  it('waits for the final score before announcing a result', async () => {
    mockGetGameSummary.mockReturnValue(new Promise(() => {}));
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('completed') });

    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('game-completed-view')).toBeTruthy();
    });
    expect(screen.getByText('Waiting for the final score…')).toBeTruthy();
    expect(screen.queryByTestId('final-score')).toBeNull();
    expect(screen.queryByTestId('result-tie')).toBeNull();
  });

  it('falls back to game summary data for final score and half-suit tally', async () => {
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('completed') });

    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('score-team1').textContent).toBe('5');
    });
    expect(screen.getByTestId('score-team2').textContent).toBe('3');
    expect(screen.getByLabelText('Low Spades: Team 1')).toBeTruthy();
    expect(screen.getByLabelText('High Spades: Team 2')).toBeTruthy();
  });

  it('renders the ask stats table once the completed-game summary loads', async () => {
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('completed') });

    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('ask-stats-table')).toBeTruthy();
    });
    expect(screen.getByTestId('match-mvp-card')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Active game view (in_progress)
// ---------------------------------------------------------------------------

describe('GamePage — in_progress game view', () => {
  beforeEach(() => {
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('in_progress') });
  });

  it('renders the game view container', async () => {
    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('game-view')).toBeTruthy();
    });
  });

  it.each([1, 2] as const)('shows team %i first for a player on that team', async (teamId) => {
    render(<GamePage params={makeParams('ABC123')} />);
    await screen.findByTestId('game-view');
    act(() => openWs());
    const init = makeGameInit('me', [makePlayer('me', 'Me', teamId, 0)]);
    init.gameState.scores = { team1: 2, team2: 1 };
    act(() => sendWsMessage(init));

    const score = screen.getByTestId('game-score');
    expect([...score.querySelectorAll('strong')].map((el) => el.textContent)).toEqual(
      teamId === 1 ? ['2', '1'] : ['1', '2'],
    );
  });

  it('opens game controls from the header and closes them with Escape', async () => {
    render(<GamePage params={makeParams('ABC123')} />);
    const button = await screen.findByTestId('game-menu-toggle');
    expect(screen.queryByTestId('bot-speed-slider')).toBeNull();
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('ws-status-indicator')).toBeVisible();
    expect(screen.getByTestId('bot-speed-slider')).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('ws-status-indicator')).toBeNull();
    expect(button).toHaveFocus();
  });

  it('does NOT render the turn indicator when no game state is available', async () => {
    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('game-view')).toBeTruthy();
    });
    expect(screen.queryByTestId('turn-indicator')).toBeNull();
  });

  it('renders the game table center', async () => {
    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('game-table-center')).toBeTruthy();
    });
  });

  it('renders declared books in the correct half of the center table', async () => {
    render(<GamePage params={makeParams('ABC123')} />);
    await waitFor(() => {
      expect(screen.getByTestId('game-view')).toBeTruthy();
    });

    act(() => openWs());
    act(() => sendWsMessage({
      ...makeGameInit('player-me', [
        makePlayer('player-me', 'Me', 1, 0),
        makePlayer('p2', 'Alice', 1, 2),
        makePlayer('p3', 'Bob', 1, 4),
        makePlayer('p4', 'Carol', 2, 1),
        makePlayer('p5', 'Dave', 2, 3),
        makePlayer('p6', 'Eve', 2, 5),
      ]),
      gameState: {
        status: 'active',
        currentTurnPlayerId: 'player-me',
        scores: { team1: 1, team2: 1 },
        lastMove: null,
        winner: null,
        tiebreakerWinner: null,
        declaredSuits: [
          { halfSuitId: 'low_s', teamId: 1, declaredBy: 'player-me' },
          { halfSuitId: 'high_h', teamId: 2, declaredBy: 'p4' },
        ],
      },
    }));

    await waitFor(() => {
      expect(screen.getByTestId('declared-books-table')).toBeTruthy();
    });

    expect(within(screen.getByTestId('table-books-team1')).getByTestId('table-book-low_s')).toBeTruthy();
    expect(within(screen.getByTestId('table-books-team2')).getByTestId('table-book-high_h')).toBeTruthy();
    expect(within(screen.getByTestId('table-book-low_s')).getByLabelText('A of Spades')).toBeTruthy();
    expect(within(screen.getByTestId('table-book-high_h')).getByLabelText('K of Hearts')).toBeTruthy();
    expect(within(screen.getByTestId('table-books-team1')).queryByTestId('table-book-high_h')).toBeNull();
    expect(within(screen.getByTestId('table-books-team2')).queryByTestId('table-book-low_s')).toBeNull();
  });

  it('renders the player hand area footer', async () => {
    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('player-hand-area')).toBeTruthy();
    });
  });

  it('renders the circular game table with all players', async () => {
    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('circular-game-table')).toBeTruthy();
    });
  });

  it('clears a visible turn timer as soon as ask_result arrives', async () => {
    render(<GamePage params={makeParams('ABC123')} />);
    await waitFor(() => {
      expect(screen.getByTestId('game-view')).toBeTruthy();
    });

    act(() => openWs());
    act(() => sendWsMessage({
      ...makeGameInit('player-me', [
        makePlayer('player-me', 'Me', 1, 0),
        makePlayer('p2', 'Alice', 1, 2),
        makePlayer('p3', 'Bob', 1, 4),
        makePlayer('p4', 'Carol', 2, 1),
        makePlayer('p5', 'Dave', 2, 3),
        makePlayer('p6', 'Eve', 2, 5),
      ]),
      gameState: {
        status: 'active',
        currentTurnPlayerId: 'player-me',
        scores: { team1: 0, team2: 0 },
        lastMove: null,
        winner: null,
        tiebreakerWinner: null,
        declaredSuits: [],
      },
    }));

    const futureExpiry = Date.now() + 30_000;
    act(() => sendWsMessage({
      type: 'turn_timer',
      playerId: 'player-me',
      durationMs: 30_000,
      expiresAt: futureExpiry,
    }));

    await waitFor(() => {
      expect(screen.getByTestId('countdown-timer')).toBeTruthy();
      expect(screen.getByTestId('countdown-timer-label').textContent).toBe('Your turn');
    });

    act(() => sendWsMessage({
      type: 'ask_result',
      askerId: 'player-me',
      targetId: 'p4',
      cardId: '5_h',
      success: false,
      newTurnPlayerId: 'p4',
      lastMove: 'Me asked Carol for 5♥ — did not get it',
    }));

    await waitFor(() => {
      expect(screen.queryByTestId('countdown-timer')).toBeNull();
    });
  });

  it('shows a denied ask overlay over the asked player and clears it shortly after', async () => {
    render(<GamePage params={makeParams('ABC123')} />);
    await waitFor(() => {
      expect(screen.getByTestId('game-view')).toBeTruthy();
    });

    act(() => openWs());
    const roster = [
      makePlayer('player-me', 'Me', 1, 0),
      makePlayer('p2', 'Alice', 1, 2),
      makePlayer('p3', 'Bob', 1, 4),
      makePlayer('p4', 'Carol', 2, 1),
      makePlayer('p5', 'Dave', 2, 3),
      makePlayer('p6', 'Eve', 2, 5),
    ];
    act(() => sendWsMessage(makeGameInit('player-me', roster)));

    await waitFor(() => {
      expect(screen.getAllByTestId('game-player-seat').length).toBeGreaterThan(0);
    });

    jest.useFakeTimers();
    try {
      act(() => sendWsMessage({
        type: 'ask_result',
        askerId: 'player-me',
        targetId: 'p4',
        cardId: '5_h',
        success: false,
        newTurnPlayerId: 'p4',
        lastMove: 'Me asked Carol for 5♥ — denied',
      }));

      act(() => {
        jest.advanceTimersByTime(20);
      });

      expect(screen.getByTestId('ask-speech-bubble-overlay')).toBeTruthy();
      expect(screen.getByTestId('ask-speech-bubble-text').textContent).toBe(
        'Carol, can I have the 5♥?',
      );
      expect(screen.getByTestId('ask-denied-animation')).toBeTruthy();
      expect(screen.getByTestId('ask-denied-card')).toBeTruthy();
      expect(screen.getByTestId('ask-denied-x')).toBeTruthy();
      expect(screen.queryByTestId('denied-speech-bubble-overlay')).toBeNull();

      act(() => {
        jest.advanceTimersByTime(1400);
      });

      expect(screen.getByTestId('denied-speech-bubble-text').textContent).toMatch(/\S/);
      expect(screen.queryByTestId('ask-speech-bubble-overlay')).toBeNull();
      expect(screen.queryByTestId('ask-denied-animation')).toBeNull();

      act(() => { jest.advanceTimersByTime(1200); });
      expect(screen.queryByTestId('denied-speech-bubble-overlay')).toBeNull();
      expect(screen.queryByTestId('ask-speech-bubble-overlay')).toBeNull();

      act(() => sendWsMessage({ type: 'game_players', players: [...roster] }));
      act(() => { jest.advanceTimersByTime(20); });
      expect(screen.queryByTestId('ask-denied-animation')).toBeNull();

      act(() => sendWsMessage({
        type: 'ask_result', askerId: 'player-me', targetId: 'p4', cardId: '9_h',
        success: false, newTurnPlayerId: 'p4', lastMove: 'Me asked Carol for 9♥',
      }));
      act(() => { jest.advanceTimersByTime(20); });
      expect(screen.getByTestId('ask-denied-card').querySelector('[aria-label="9 of Hearts"] [data-rank]')).toHaveAttribute('data-rank', '9');
      act(() => sendWsMessage(makeGameInit('player-me', roster)));
      expect(screen.queryByTestId('ask-denied-animation')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Deep-link: room ID is uppercased from URL
// ---------------------------------------------------------------------------

describe('GamePage — room code normalisation (deep-link)', () => {
  it('uppercases a lowercase room code from the URL parameter', async () => {
    mockGetRoomByCode.mockImplementation(async (code: string) => {
      // Verify that the code is uppercased before hitting the API
      expect(code).toBe('ABC123');
      return { room: buildRoom('in_progress', { code: 'ABC123' }) };
    });

    render(<GamePage params={makeParams('abc123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('game-view')).toBeTruthy();
    });
  });

  it('passes the normalised room code to getRoomByCode', async () => {
    mockGetRoomByCode.mockResolvedValue({
      room: buildRoom('in_progress', { code: 'DEF456' }),
    });

    render(<GamePage params={makeParams('def456')} />);

    await waitFor(() => {
      expect(mockGetRoomByCode).toHaveBeenCalledWith('DEF456', expect.any(AbortSignal));
    });
  });
});

// ---------------------------------------------------------------------------
// 8-player variant
// ---------------------------------------------------------------------------

describe('GamePage — 8-player in_progress game', () => {
  it('labels the table for an 8-player room', async () => {
    mockGetRoomByCode.mockResolvedValue({
      room: buildRoom('in_progress', { player_count: 8 }),
    });

    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('game-view')).toBeTruthy();
    });
    expect(screen.getByLabelText('Declared books table for a 4v4 game')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Game action availability
//
// These tests verify that the game controls (Declare button, card hand,
// AskCardModal, DeclareModal) are:
// • Available immediately after game_init is received
// • Available when the current player is on their turn, regardless of
// whether teammates/opponents are bots or humans
// • Available for both 6-player and 8-player game configurations
//
// The controls are gated exclusively on `isMyTurn`, derived from
// gameState.currentTurnPlayerId === myPlayerId.
// ---------------------------------------------------------------------------

/** Minimal GamePlayer for use in game_init payloads. */
function makePlayer(
  playerId: string,
  displayName: string,
  teamId: 1 | 2,
  seatIndex: number,
  opts: { isBot?: boolean; cardCount?: number } = {}
) {
  return {
    playerId,
    displayName,
    avatarId: null,
    teamId,
    seatIndex,
    cardCount: opts.cardCount ?? 5,
    isBot: opts.isBot ?? false,
    isGuest: true,
    isCurrentTurn: false,
  };
}

/** Build a game_init payload where myPlayerId is the current turn player. */
function makeGameInit(
  myPlayerId: string,
  players: ReturnType<typeof makePlayer>[],
  opts: { playerCount?: 6 | 8; variant?: string } = {}
) {
  return {
    type: 'game_init',
    myPlayerId,
    myHand: ['1_s', '3_h', '5_d', '6_c', '9_s'],
    players,
    gameState: {
      status: 'active',
      currentTurnPlayerId: myPlayerId, // it's MY turn
      scores: { team1: 0, team2: 0 },
      lastMove: null,
      winner: null,
      tiebreakerWinner: null,
      declaredSuits: [],
    },
    variant: opts.variant ?? 'remove_7s',
    playerCount: opts.playerCount ?? players.length,
  };
}

describe('queued ask animations', () => {
  it.each(['player', 'spectator'])('plays each received bot ask in order for a %s while the turn advances', async viewer => {
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('in_progress') });
    render(<GamePage params={makeParams('ABC123')} />);
    await screen.findByTestId('game-view');
    const me = 'player-me';
    const bot = 'p4';
    const roster = [
      makePlayer(me, 'Me', 1, 0), makePlayer(bot, 'Carol', 2, 1, { isBot: true }),
      makePlayer('p2', 'Alice', 1, 2), makePlayer('p5', 'Dave', 2, 3),
      makePlayer('p3', 'Bob', 1, 4), makePlayer('p6', 'Eve', 2, 5),
    ];
    const init = makeGameInit(me, roster);
    const state = { ...init.gameState, currentTurnPlayerId: bot };
    act(() => {
      openWs();
      sendWsMessage({ ...init, type: viewer === 'player' ? 'game_init' : 'spectator_init',
        myHand: ['3_h', '4_h', '6_h'], hands: {}, gameState: state });
    });
    await screen.findByTestId(viewer === 'player' ? 'game-view' : 'spectator-view');
    jest.useFakeTimers();
    try {
      act(() => {
        const batchCardIds = ['3_h', '4_h', '5_h'];
        for (const cardId of batchCardIds) {
          const success = cardId !== '5_h';
          sendWsMessage({ type: 'ask_result', askerId: bot, targetId: me, cardId, batchCardIds,
            success, newTurnPlayerId: success ? bot : me, lastMove: cardId });
        }
        sendWsMessage({ type: 'hand_update', hand: ['6_h'] });
        sendWsMessage({ type: 'game_state', state: { ...state, currentTurnPlayerId: me } });
      });
      const seat = document.querySelector(`[data-player-id="${me}"][data-active-turn]`);
      expect(seat).toBeInTheDocument();
      if (viewer === 'player') {
        expect(screen.getByTestId('card-wrapper-6_h')).toBeInTheDocument();
        expect(screen.queryByTestId('card-wrapper-3_h')).toBeNull();
      }
      const expectRank = (overlay: string, rank: string) =>
        expect(screen.getByTestId(overlay).querySelector('[data-rank]')).toHaveAttribute('data-rank', rank);
      await _advanceTime(20);
      expectRank('card-flight-card', '3');
      await _advanceTime(2000);
      await _advanceTime(20);
      expectRank('card-flight-card', '4');
      await _advanceTime(2000);
      await _advanceTime(20);
      expectRank('ask-denied-card', '5');
      expect(screen.queryByTestId('card-flight-card')).toBeNull();
      await _advanceTime(1300);
      expect(screen.queryByTestId('ask-denied-card')).toBeNull();
      expect(screen.queryByTestId('card-flight-card')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('GamePage — game controls always available', () => {
  describe('6-player game — all human players', () => {
    const MY_PLAYER_ID = 'player-me';
    const players6 = [
      makePlayer(MY_PLAYER_ID, 'Me',    1, 0),
      makePlayer('p2',          'Alice', 1, 2),
      makePlayer('p3',          'Bob',   1, 4),
      makePlayer('p4',          'Carol', 2, 1),
      makePlayer('p5',          'Dave',  2, 3),
      makePlayer('p6',          'Eve',   2, 5),
    ];

    beforeEach(() => {
      mockGetRoomByCode.mockResolvedValue({ room: buildRoom('in_progress') });
    });

    it('shows Ask/Declare toggle when it is the player\'s turn', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

      // Connect WS and receive game_init
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players6)));

      await waitFor(() => {
        expect(screen.getByTestId('ask-declare-toggle')).toBeTruthy();
        expect(screen.getByTestId('toggle-declare')).toBeTruthy();
      });
    });

    it('does not show the turn indicator banner on a normal turn (seat highlight conveys this)', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players6)));

      await waitFor(() => {
        expect(screen.getByTestId('ask-prompt')).toBeTruthy();
      });
      expect(screen.queryByTestId('turn-indicator')).toBeNull();
    });

    it('shows the ask-prompt hint when it is the player\'s turn with cards', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players6)));

      await waitFor(() => {
        expect(screen.getByTestId('ask-prompt')).toBeTruthy();
      });
    });

    it('does not show an elimination chooser when the server sends a turn-recipient prompt', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players6)));

      act(() => sendWsMessage({
        type: 'choose_turn_recipient_prompt',
        eliminatedPlayerId: MY_PLAYER_ID,
        eligibleTeammates: [
          { playerId: 'p2', displayName: 'Alice' },
          { playerId: 'p3', displayName: 'Bob' },
        ],
      }));

      expect(screen.queryByRole('heading', { name: /you've been eliminated/i })).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('disables the self seat during inline declare because self cards are auto-assigned', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players6)));

      await waitFor(() => {
        expect(screen.getByTestId('ask-declare-toggle')).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId('toggle-declare'));

      const spadeCardWrapper = document.querySelector('[data-testid="card-wrapper-1_s"]') as HTMLElement;
      expect(spadeCardWrapper).toBeTruthy();
      const spadeCard = spadeCardWrapper.querySelector('[role="button"]') as HTMLElement;
      expect(spadeCard).toBeTruthy();
      fireEvent.click(spadeCard);

      const tray = await screen.findByTestId('inline-declare-tray');
      expect(within(tray).getByText(/1\/6 assigned/)).toBeTruthy();

      const mySeat = screen.getAllByTestId('declare-drop-seat')
        .find((seat) => seat.getAttribute('data-player-id') === MY_PLAYER_ID);
      expect(mySeat).toBeTruthy();
      expect(mySeat).toHaveAttribute('aria-disabled', 'true');
      expect(within(mySeat!).getByRole('img', { name: 'A of Spades' })).toBeInTheDocument();
      expect(within(mySeat!).queryByTestId('declare-draggable-card')).toBeNull();
      expect(within(tray).queryByRole('img', { name: 'A of Spades' })).toBeNull();

      const cards = within(tray).getAllByTestId('declare-draggable-card');
      fireEvent.click(cards[0]);
      fireEvent.click(mySeat!);

      expect(within(tray).getByText(/1\/6 assigned/)).toBeTruthy();
    });

    it('keeps the declare tray open when assigning a card to a teammate seat', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players6)));

      await waitFor(() => {
        expect(screen.getByTestId('ask-declare-toggle')).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId('toggle-declare'));

      const spadeCardWrapper = document.querySelector('[data-testid="card-wrapper-1_s"]') as HTMLElement;
      expect(spadeCardWrapper).toBeTruthy();
      const spadeCard = spadeCardWrapper.querySelector('[role="button"]') as HTMLElement;
      expect(spadeCard).toBeTruthy();
      fireEvent.click(spadeCard);

      const tray = await screen.findByTestId('inline-declare-tray');
      const cards = within(tray).getAllByTestId('declare-draggable-card');
      fireEvent.click(cards[0]);

      const teammateSeat = screen.getAllByTestId('declare-drop-seat')
        .find((seat) => seat.getAttribute('data-player-id') === 'p2');
      expect(teammateSeat).toBeTruthy();
      fireEvent.click(teammateSeat!);

      expect(screen.getByTestId('inline-declare-tray')).toBeTruthy();
      expect(screen.getByText(/2\/6 assigned/)).toBeTruthy();
      const assigned = within(teammateSeat!).getByRole('button', { name: /Unassign 2♠/ });
      expect(within(tray).queryByRole('img', { name: '2 of Spades' })).toBeNull();
      fireEvent.click(assigned);
      expect(within(tray).getByRole('img', { name: '2 of Spades' })).toBeInTheDocument();
      expect(within(tray).getByText(/1\/6 assigned/)).toBeInTheDocument();
    });

    it('dismisses the declare tray when the player clicks outside it', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players6)));

      await waitFor(() => {
        expect(screen.getByTestId('ask-declare-toggle')).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId('toggle-declare'));

      const spadeCardWrapper = document.querySelector('[data-testid="card-wrapper-1_s"]') as HTMLElement;
      expect(spadeCardWrapper).toBeTruthy();
      const spadeCard = spadeCardWrapper.querySelector('[role="button"]') as HTMLElement;
      expect(spadeCard).toBeTruthy();
      fireEvent.click(spadeCard);

      expect(await screen.findByTestId('inline-declare-tray')).toBeTruthy();

      fireEvent.click(document.body);

      await waitFor(() => {
        expect(screen.queryByTestId('inline-declare-tray')).toBeNull();
      });

      const askBtn = screen.getByTestId('toggle-ask') as HTMLButtonElement;
      expect(askBtn.getAttribute('aria-checked')).toBe('true');
    });

    it('submits an ask when the player picks an inline ask card and taps an opponent seat', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      const sendSpy = jest.spyOn(lastMockWsInstance as MockWebSocket, 'send');
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players6)));

      await waitFor(() => {
        expect(screen.getByTestId('ask-declare-toggle')).toBeTruthy();
      });

      // In ask mode (default), click a card in hand to open ask tray with half-suit pre-selected
      const heartCardWrapper = document.querySelector('[data-testid="card-wrapper-3_h"]') as HTMLElement;
      expect(heartCardWrapper).toBeTruthy();
      const heartCard = heartCardWrapper.querySelector('[role="button"]') as HTMLElement;
      expect(heartCard).toBeTruthy();
      fireEvent.click(heartCard);
      expect(screen.getByTestId('ask-prompt')).toHaveTextContent(
        'Pick one or more missing cards from Low Hearts. Click anywhere outside to cancel.',
      );
      fireEvent.click(screen.getByTestId('inline-ask-card-1_h'));

      const carolSeat = document.querySelector('[data-player-id="p4"]') as HTMLElement;
      expect(carolSeat).toBeTruthy();
      fireEvent.click(carolSeat);

      expect(sendSpy).toHaveBeenCalledWith(
        JSON.stringify({ type: 'ask_card', targetPlayerId: 'p4', cardId: '1_h' }),
      );
    });

    it('dismisses the ask tray when the player clicks outside it', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players6)));

      await waitFor(() => {
        expect(screen.getByTestId('ask-declare-toggle')).toBeTruthy();
      });

      const heartCardWrapper = document.querySelector('[data-testid="card-wrapper-3_h"]') as HTMLElement;
      expect(heartCardWrapper).toBeTruthy();
      const heartCard = heartCardWrapper.querySelector('[role="button"]') as HTMLElement;
      expect(heartCard).toBeTruthy();
      fireEvent.click(heartCard);

      expect(screen.getByTestId('inline-ask-tray')).toBeTruthy();

      expect(screen.queryByTestId('ask-declare-toggle')).toBeNull();

      fireEvent.click(document.body);

      await waitFor(() => {
        expect(screen.queryByTestId('inline-ask-tray')).toBeNull();
        expect(screen.getByTestId('ask-declare-toggle')).toBeVisible();
      });
    });

    it('queues multiple asks for the same opponent and continues only after a successful result', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      const sendSpy = jest.spyOn(lastMockWsInstance as MockWebSocket, 'send');
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players6)));

      await waitFor(() => {
        expect(screen.getByTestId('ask-declare-toggle')).toBeTruthy();
      });

      // Click a heart card in hand to open ask tray for low_h
      const heartCardWrapper = document.querySelector('[data-testid="card-wrapper-3_h"]') as HTMLElement;
      expect(heartCardWrapper).toBeTruthy();
      const heartCard = heartCardWrapper.querySelector('[role="button"]') as HTMLElement;
      expect(heartCard).toBeTruthy();
      fireEvent.click(heartCard);
      fireEvent.click(screen.getByTestId('inline-ask-card-1_h'));
      fireEvent.click(screen.getByTestId('inline-ask-card-2_h'));

      const carolSeat = document.querySelector('[data-player-id="p4"]') as HTMLElement;
      expect(carolSeat).toBeTruthy();
      fireEvent.click(carolSeat);

      expect(sendSpy).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'ask_card',
          targetPlayerId: 'p4',
          cardId: '1_h',
          batchCardIds: ['1_h', '2_h'],
        }),
      );

      act(() => sendWsMessage({
        type: 'ask_result',
        askerId: MY_PLAYER_ID,
        targetId: 'p4',
        cardId: '1_h',
        success: true,
        newTurnPlayerId: MY_PLAYER_ID,
        lastMove: 'Me asked Carol for A♥ — got it',
      }));

      act(() => sendWsMessage({
        type: 'game_players',
        players: [
          makePlayer(MY_PLAYER_ID, 'Me', 1, 0),
          makePlayer('p2', 'Alice', 1, 2),
          makePlayer('p3', 'Bob', 1, 4),
          makePlayer('p4', 'Carol', 2, 1, { cardCount: 4 }),
          makePlayer('p5', 'Dave', 2, 3),
          makePlayer('p6', 'Eve', 2, 5),
        ],
      }));

      await waitFor(() => {
        expect(sendSpy).toHaveBeenCalledWith(
          JSON.stringify({
            type: 'ask_card',
            targetPlayerId: 'p4',
            cardId: '2_h',
            batchCardIds: ['1_h', '2_h'],
          }),
        );
      });

      act(() => sendWsMessage({
        type: 'ask_result',
        askerId: MY_PLAYER_ID,
        targetId: 'p4',
        cardId: '2_h',
        success: true,
        newTurnPlayerId: MY_PLAYER_ID,
        lastMove: 'Me asked Carol for 2♥ — got it',
      }));

      await waitFor(() => {
        expect(screen.getByTestId('last-move-display').textContent).toContain(
          'Me asked Carol for A♥ and 2♥ — got them',
        );
      });
    });

    it('shows the full multi-card request in the ask bubble during a queued ask batch', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players6)));

      await waitFor(() => {
        expect(screen.getByTestId('ask-declare-toggle')).toBeTruthy();
      });

      // Click a heart card in hand to open ask tray for low_h
      const heartCardWrapper = document.querySelector('[data-testid="card-wrapper-3_h"]') as HTMLElement;
      expect(heartCardWrapper).toBeTruthy();
      const heartCard = heartCardWrapper.querySelector('[role="button"]') as HTMLElement;
      expect(heartCard).toBeTruthy();
      fireEvent.click(heartCard);
      fireEvent.click(screen.getByTestId('inline-ask-card-1_h'));
      fireEvent.click(screen.getByTestId('inline-ask-card-2_h'));

      const carolSeat = document.querySelector('[data-player-id="p4"]') as HTMLElement;
      expect(carolSeat).toBeTruthy();
      fireEvent.click(carolSeat);

      jest.useFakeTimers();
      try {
        act(() => sendWsMessage({
          type: 'ask_result',
          askerId: MY_PLAYER_ID,
          targetId: 'p4',
          cardId: '1_h',
          success: true,
          newTurnPlayerId: MY_PLAYER_ID,
          lastMove: 'Me asked Carol for A♥ — got it',
        }));

        act(() => {
          jest.advanceTimersByTime(20);
        });

        expect(screen.getByTestId('ask-speech-bubble-text').textContent).toBe(
          'Carol, can I have the A♥ and 2♥?',
        );
        const table = screen.getByTestId('ask-speech-bubble-overlay').parentElement;
        expect(table).toHaveClass('game-table-space');
        expect(screen.getByTestId('card-flight-animation').parentElement).toBe(table);

        act(() => { jest.advanceTimersByTime(1100); });
        act(() => sendWsMessage({
          type: 'ask_result', askerId: MY_PLAYER_ID, targetId: 'p4', cardId: '2_h',
          batchCardIds: ['1_h', '2_h'], success: true, newTurnPlayerId: MY_PLAYER_ID,
          lastMove: 'Me asked Carol for 2♥ — got it',
        }));
        act(() => { jest.advanceTimersByTime(20); });
        expect(screen.getByTestId('ask-speech-bubble-text')).toHaveTextContent('A♥ and 2♥');
        act(() => { jest.advanceTimersByTime(1300); });
        expect(screen.queryByTestId('ask-speech-bubble-overlay')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('shows narrated reasoning copy for bot asks while keeping the actual ask at the end', async () => {
      const playersWithBot = [
        makePlayer(MY_PLAYER_ID, 'Me', 1, 0),
        makePlayer('p2', 'Alice', 1, 2),
        makePlayer('p3', 'Bob', 1, 4),
        makePlayer('p4', 'CarolBot', 2, 1, { isBot: true }),
        makePlayer('p5', 'Dave', 2, 3),
        makePlayer('p6', 'Eve', 2, 5),
      ];

      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, playersWithBot)));

      jest.useFakeTimers();
      try {
        act(() => sendWsMessage({
          type: 'ask_result',
          askerId: 'p4',
          targetId: MY_PLAYER_ID,
          cardId: '1_h',
          botAskNarration: {
            reason: 'known_holder',
          },
          success: true,
          newTurnPlayerId: 'p4',
          lastMove: 'CarolBot asked Me for A♥ — got it',
        }));

        act(() => {
          jest.advanceTimersByTime(20);
        });

        const bubbleText = screen.getByTestId('ask-speech-bubble-text').textContent ?? '';
        expect(bubbleText).toMatch(
          /^(Locking in|Pretty sure)\. Me, can I have the A♥\?$/,
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('aggregates consecutive ask results into one top-banner message for all clients', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players6)));

      act(() => sendWsMessage({
        type: 'ask_result',
        askerId: 'p4',
        targetId: 'player-me',
        cardId: '10_c',
        success: true,
        newTurnPlayerId: 'p4',
        lastMove: 'Carol asked Me for 10♣ — got it',
      }));

      await waitFor(() => {
        expect(screen.getByTestId('last-move-display').textContent).toContain(
          'Carol asked Me for 10♣ — got it',
        );
      });

      act(() => sendWsMessage({
        type: 'ask_result',
        askerId: 'p4',
        targetId: 'player-me',
        cardId: '11_c',
        success: false,
        newTurnPlayerId: 'player-me',
        lastMove: 'Carol asked Me for J♣ — denied',
      }));

      await waitFor(() => {
        expect(screen.getByTestId('last-move-display').textContent).toContain(
          'Carol asked Me for 10♣ and J♣ — got 10♣; denied J♣',
        );
      });
    });

    it('shows the full multi-card request in the top banner as soon as the first batched result arrives', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players6)));

      act(() => sendWsMessage({
        type: 'ask_result',
        askerId: 'p4',
        targetId: 'player-me',
        cardId: '10_c',
        batchCardIds: ['10_c', '11_c', '12_c'],
        success: true,
        newTurnPlayerId: 'p4',
        lastMove: 'Carol asked Me for 10♣ — got it',
      }));

      await waitFor(() => {
        expect(screen.getByTestId('last-move-display').textContent).toContain(
          'Carol asked Me for 10♣, J♣, and Q♣',
        );
      });
    });

    it('does NOT show Declare button when it is NOT the player\'s turn', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      // Send game_init where Carol (p4) is on turn, not me
      act(() => sendWsMessage({
        ...makeGameInit(MY_PLAYER_ID, players6),
        gameState: {
          status: 'active',
          currentTurnPlayerId: 'p4', // not my turn
          scores: { team1: 0, team2: 0 },
          lastMove: null,
          winner: null,
          tiebreakerWinner: null,
          declaredSuits: [],
        },
      }));

      await waitFor(() => {
        // game-controls div is shown (player is in the game)
        expect(screen.getByTestId('game-controls')).toBeTruthy();
      });
      // But Ask/Declare toggle must not appear (not my turn)
      expect(screen.queryByTestId('ask-declare-toggle')).toBeNull();
    });

    it('game controls are never disabled due to matchmaking state', async () => {
      // This verifies that no matchmaking-related import/state is gating the
      // controls. The game page should not import useMatchmakingSocket or
      // reference any matchmaking status.
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players6)));

      await waitFor(() => {
        // Toggle is shown and Declare side is enabled (not disabled)
        const declareBtn = screen.getByTestId('toggle-declare') as HTMLButtonElement;
        expect(declareBtn.disabled).toBe(false);
      });
    });
  });

  describe('6-player game — all-bot opponent team', () => {
    const MY_PLAYER_ID = 'player-me';
    const allBotOpponents = [
      makePlayer(MY_PLAYER_ID,  'Me',         1, 0),
      makePlayer('t1b',          'Alice',      1, 2),
      makePlayer('t1c',          'Bob',        1, 4),
      makePlayer('bot1',         'silly_penguin',   2, 1, { isBot: true }),
      makePlayer('bot2',         'clever_dolphin',  2, 3, { isBot: true }),
      makePlayer('bot3',         'curious_maxwell', 2, 5, { isBot: true }),
    ];

    beforeEach(() => {
      mockGetRoomByCode.mockResolvedValue({ room: buildRoom('in_progress') });
    });

    it('shows Ask/Declare toggle when opponents are all bots', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, allBotOpponents)));

      await waitFor(() => {
        expect(screen.getByTestId('ask-declare-toggle')).toBeTruthy();
      });
    });

    it('shows the player\'s hand even when all opponents are bots', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, allBotOpponents)));

      await waitFor(() => {
        // Card hand area is shown (player has 5 cards from makeGameInit)
        expect(screen.getByTestId('game-controls')).toBeTruthy();
        expect(screen.getByTestId('card-hand')).toHaveAttribute('aria-label', expect.stringMatching(/^Your hand:/));
      });
    });
  });

  describe('8-player game — mixed human/bot opponents', () => {
    const MY_PLAYER_ID = 'player-me';
    const players8 = [
      makePlayer(MY_PLAYER_ID, 'Me',     1, 0),
      makePlayer('t1b',         'T1B',   1, 2),
      makePlayer('t1c',         'T1C',   1, 4),
      makePlayer('t1d',         'T1D',   1, 6),
      makePlayer('bot1',        'bot_a', 2, 1, { isBot: true }),
      makePlayer('p6',          'T2B',   2, 3),
      makePlayer('bot2',        'bot_b', 2, 5, { isBot: true }),
      makePlayer('p8',          'T2D',   2, 7),
    ];

    beforeEach(() => {
      mockGetRoomByCode.mockResolvedValue({
        room: buildRoom('in_progress', { player_count: 8 }),
      });
    });

    it('shows Ask/Declare toggle in an 8-player game on the player\'s turn', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players8, { playerCount: 8 })));

      await waitFor(() => {
        expect(screen.getByTestId('ask-declare-toggle')).toBeTruthy();
      });
    });

    it('shows game controls immediately after game_init (no matchmaking delay)', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

      // Before WS open: player-hand-area shows connecting status
      expect(screen.getByTestId('spectator-status')).toBeTruthy();

      // After WS open but before game_init: still connecting
      act(() => openWs());
      // Still no game-controls yet (game_init not received)
      expect(screen.queryByTestId('game-controls')).toBeNull();

      // After game_init: controls immediately visible
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players8, { playerCount: 8 })));

      await waitFor(() => {
        expect(screen.getByTestId('game-controls')).toBeTruthy();
      });
    });
  });

  describe('connecting/spectator state distinction', () => {
    beforeEach(() => {
      mockGetRoomByCode.mockResolvedValue({ room: buildRoom('in_progress') });
    });

    it('shows "Connecting to game…" when WS is open but game_init not yet received', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

      // Open the WS but do NOT send game_init
      act(() => openWs());

      await waitFor(() => {
        // Should show "Connecting to game…" not "Watching as spectator"
        expect(screen.getByTestId('spectator-status').textContent).toContain('Connecting to game');
      });
      expect(screen.queryByText('Watching as spectator')).toBeNull();
    });

    it('shows SpectatorView with spectator banner once spectator_init is received', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());

      // Send spectator_init (no myPlayerId set)
      act(() => sendWsMessage({
        type: 'spectator_init',
        players: [
          makePlayer('p1', 'Player1', 1, 0),
          makePlayer('p2', 'Player2', 1, 2),
          makePlayer('p3', 'Player3', 1, 4),
          makePlayer('p4', 'Player4', 2, 1),
          makePlayer('p5', 'Player5', 2, 3),
          makePlayer('p6', 'Player6', 2, 5),
        ],
        gameState: {
          status: 'active',
          currentTurnPlayerId: 'p1',
          scores: { team1: 0, team2: 0 },
          lastMove: null,
          winner: null,
          tiebreakerWinner: null,
          declaredSuits: [],
        },
        variant: 'remove_7s',
        playerCount: 6,
      }));

      // After spectator_init, the page switches from game-view to spectator-view
      await waitFor(() => {
        expect(screen.getByTestId('spectator-view')).toBeTruthy();
        expect(screen.getByTestId('spectator-banner')).toBeTruthy();
      });
      // The regular game view should no longer be shown
      expect(screen.queryByTestId('game-view')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Declaration outcome broadcast
//
// Verifies that:
// 1. lastMove text is displayed after a declaration_result arrives
// 2. declaration_result.correct and.winningTeam are reflected in lastMove
// ---------------------------------------------------------------------------

describe('GamePage — declaration outcome broadcast', () => {
  const MY_PLAYER_ID = 'player-me';

  const players6 = [
    makePlayer(MY_PLAYER_ID, 'Me',    1, 0),
    makePlayer('p2',          'Alice', 1, 2),
    makePlayer('p3',          'Bob',   1, 4),
    makePlayer('p4',          'Carol', 2, 1),
    makePlayer('p5',          'Dave',  2, 3),
    makePlayer('p6',          'Eve',   2, 5),
  ];

  function makeGameState(overrides: Partial<{
    scores: { team1: number; team2: number };
    lastMove: string | null;
    currentTurnPlayerId: string;
  }> = {}) {
    return {
      status: 'active',
      currentTurnPlayerId: overrides.currentTurnPlayerId ?? MY_PLAYER_ID,
      scores: overrides.scores ?? { team1: 0, team2: 0 },
      lastMove: overrides.lastMove ?? null,
      winner: null,
      tiebreakerWinner: null,
      declaredSuits: [],
    };
  }

  beforeEach(() => {
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('in_progress') });
  });

  it('1. declaration_result triggers lastMove display (correct declaration)', async () => {
    render(<GamePage params={makeParams('ABC123')} />);
    await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

    act(() => openWs());
    act(() => sendWsMessage({
      ...makeGameInit(MY_PLAYER_ID, players6),
      gameState: makeGameState(),
    }));

    await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

    // Simulate receiving a declaration_result (correct declaration by Team 1)
    act(() => sendWsMessage({
      type: 'declaration_result',
      declarerId: MY_PLAYER_ID,
      halfSuitId: 'low_s',
      correct: true,
      winningTeam: 1,
      newTurnPlayerId: MY_PLAYER_ID,
      assignment: {
        '1_s': MY_PLAYER_ID, '2_s': MY_PLAYER_ID,
        '3_s': 'p2', '4_s': 'p2',
        '5_s': 'p3', '6_s': 'p3',
      },
      lastMove: 'Me declared Low ♠ — correct! Team 1 scores',
    }));

    // The lastMove message should appear in the UI
    await waitFor(() => {
      const lastMoveEl = screen.queryByTestId('last-move-display') ?? document.body;
      // The message text is rendered by LastMoveDisplay
      expect(lastMoveEl.textContent).toContain('Team 1 scores');
    });

    expect(screen.queryByTestId('declaration-result-overlay')).toBeNull();
  });

  it('2. declaration_result triggers lastMove display (incorrect declaration)', async () => {
    render(<GamePage params={makeParams('ABC123')} />);
    await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

    act(() => openWs());
    act(() => sendWsMessage({
      ...makeGameInit(MY_PLAYER_ID, players6),
      gameState: makeGameState(),
    }));

    await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

    // Simulate receiving a declaration_result (incorrect — opponent team scores)
    act(() => sendWsMessage({
      type: 'declaration_result',
      declarerId: MY_PLAYER_ID,
      halfSuitId: 'low_s',
      correct: false,
      winningTeam: 2,
      newTurnPlayerId: 'p4',
      assignment: {
        '1_s': MY_PLAYER_ID, '2_s': MY_PLAYER_ID,
        '3_s': 'p3', '4_s': 'p3',
        '5_s': 'p2', '6_s': 'p2',
      },
      lastMove: 'Me declared Low ♠ — incorrect! Team 2 scores',
    }));

    await waitFor(() => {
      const lastMoveEl = screen.queryByTestId('last-move-display') ?? document.body;
      expect(lastMoveEl.textContent).toContain('Team 2 scores');
    });

    expect(screen.queryByTestId('declaration-result-overlay')).toBeNull();
  });

  it.each([
    ['player', true], ['player', false], ['spectator', true], ['spectator', false],
  ] as const)('shows the final declaration to a %s for seven seconds (correct=%s)', async (viewer, correct) => {
    render(<GamePage params={makeParams('ABC123')} />);
    await screen.findByTestId('game-view');
    act(() => {
      openWs();
      const init = makeGameInit(MY_PLAYER_ID, players6);
      sendWsMessage(viewer === 'player' ? init : { ...init, type: 'spectator_init', hands: {} });
    });

    const holders = { '1_c': MY_PLAYER_ID, '2_c': MY_PLAYER_ID, '3_c': 'p2', '4_c': 'p2', '5_c': 'p3', '6_c': 'p3' };
    const result = {
      declarerId: 'p2', halfSuitId: 'low_c', correct, winningTeam: correct ? 1 : 2,
      assignment: correct ? holders : { ...holders, '1_c': 'p2' },
      lastMove: `Alice declared Low Clubs — ${correct ? 'correct' : 'incorrect'}! Team ${correct ? 1 : 2} scores`,
    };
    const scores = correct ? { team1: 5, team2: 3 } : { team1: 3, team2: 5 };
    jest.useFakeTimers();
    try {
      act(() => {
        sendWsMessage({ type: 'declaration_result', ...result });
        if (!correct) {
          sendWsMessage({
            type: 'declarationFailed', ...result, actualHolders: holders,
            wrongAssignmentDiffs: [{ card: '1_c', claimedPlayerId: 'p2', actualPlayerId: MY_PLAYER_ID }],
          });
        }
        sendWsMessage({ type: 'game_state', state: {
          ...makeGameState(), status: 'completed', scores, winner: result.winningTeam, lastMove: result.lastMove,
        } });
      });
      const reveal = screen.getByRole('region', { name: 'Declared cards by actual holder' });
      expect(within(reveal).getAllByRole('figure')).toHaveLength(6);
      expect(screen.getByText(correct ? 'correct!' : 'incorrect!')).toBeInTheDocument();
      if (!correct) expect(reveal.querySelector('s')).toHaveTextContent('Alice');
      expect(screen.queryByTestId('game-completed-view')).toBeNull();
      expect(screen.queryByTestId('ask-declare-toggle')).toBeNull();

      await _advanceTime(1000);
      act(() => sendWsMessage({ type: 'game_over', winner: result.winningTeam, scores }));
      await _advanceTime(5999);
      expect(reveal).toBeInTheDocument();
      expect(screen.queryByTestId('game-completed-view')).toBeNull();
      await _advanceTime(1);
      expect(reveal).not.toBeInTheDocument();
      expect(screen.getByTestId('game-completed-view')).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears a failed declaration reveal after seven seconds', async () => {
    render(<GamePage params={makeParams('ABC123')} />);
    await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

    act(() => openWs());
    act(() => sendWsMessage({
      ...makeGameInit(MY_PLAYER_ID, players6),
      gameState: makeGameState(),
    }));

    await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

    jest.useFakeTimers();
    try {
      act(() => sendWsMessage({
        type: 'declarationFailed',
        declarerId: MY_PLAYER_ID,
        halfSuitId: 'low_c',
        winningTeam: 2,
        assignment: {
          '1_c': MY_PLAYER_ID,
          '2_c': 'p2',
          '3_c': 'p3',
          '4_c': 'p4',
          '5_c': 'p5',
          '6_c': 'p6',
        },
        wrongAssignmentDiffs: [
          { card: '1_c', claimedPlayerId: MY_PLAYER_ID, actualPlayerId: 'p4' },
          { card: '4_c', claimedPlayerId: 'p4', actualPlayerId: MY_PLAYER_ID },
        ],
        actualHolders: {
          '1_c': 'p4',
          '2_c': 'p2',
          '3_c': 'p3',
          '4_c': MY_PLAYER_ID,
          '5_c': 'p5',
          '6_c': 'p6',
        },
        lastMove: 'Me declared Low Clubs — incorrect! Team 2 scores',
      }));

      expect(screen.getByRole('region', { name: 'Declared cards by actual holder' })).toBeInTheDocument();

      act(() => {
        jest.advanceTimersByTime(7_000);
      });

      expect(screen.queryByRole('region', { name: 'Declared cards by actual holder' })).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('3. declare modal is closed after declaration_result is received', async () => {
    render(<GamePage params={makeParams('ABC123')} />);
    await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

    act(() => openWs());
    act(() => sendWsMessage({
      ...makeGameInit(MY_PLAYER_ID, players6),
      gameState: makeGameState(),
    }));

    await waitFor(() => expect(screen.getByTestId('ask-declare-toggle')).toBeTruthy());

    // Enter declare mode via toggle
    act(() => {
      screen.getByTestId('toggle-declare').click();
    });

    // Send declaration_result — declare mode should reset
    act(() => sendWsMessage({
      type: 'declaration_result',
      declarerId: MY_PLAYER_ID,
      halfSuitId: 'low_s',
      correct: true,
      winningTeam: 1,
      newTurnPlayerId: MY_PLAYER_ID,
      assignment: {},
      lastMove: 'Me declared Low ♠ — correct! Team 1 scores',
    }));

    await waitFor(() => {
      // Declare mode should be reset (toggle back to Ask)
      const askBtn = screen.getByTestId('toggle-ask') as HTMLButtonElement;
      expect(askBtn.getAttribute('aria-checked')).toBe('true');
    });
  });
});

// ---------------------------------------------------------------------------
// Rematch vote UI — vote panel, rematch-starting overlay,
// and room-dissolved dissolution notice.
//
// Tests:
// 1. After game_over + rematch_vote_update, RematchVotePanel is shown
// 2. Clicking Yes sends rematch_vote message to server
// 3. Clicking No sends rematch_vote message to server
// 4. rematch_start shows "Rematch starting…" overlay and triggers redirect
// 5. room_dissolved (timeout) shows dissolution notice instead of vote panel
// 6. room_dissolved (majority_no) shows dissolution notice with correct text
// 7. rematch_declined alone shows RematchVotePanel in declined state
// 8. room_dissolved replaces the vote panel in the UI
// ---------------------------------------------------------------------------

describe('GamePage — rematch vote UI and room_dissolved', () => {
  const MY_PLAYER_ID = 'player-me';

  const players6 = [
    makePlayer(MY_PLAYER_ID, 'Me',    1, 0),
    makePlayer('p2',          'Alice', 1, 2),
    makePlayer('p3',          'Bob',   1, 4),
    makePlayer('p4',          'Carol', 2, 1),
    makePlayer('p5',          'Dave',  2, 3),
    makePlayer('p6',          'Eve',   2, 5),
  ];

  /** Minimal rematch_vote_update payload for a 6-player game */
  function makeVoteUpdate(overrides: Record<string, unknown> = {}) {
    return {
      type: 'rematch_vote_update',
      yesCount: 0,
      noCount: 0,
      totalCount: 6,
      humanCount: 6,
      majority: 4,
      majorityReached: false,
      majorityDeclined: false,
      votes: {},
      playerVotes: [
        { playerId: MY_PLAYER_ID, displayName: 'Me',    isBot: false, vote: null },
        { playerId: 'p2',          displayName: 'Alice', isBot: false, vote: null },
        { playerId: 'p3',          displayName: 'Bob',   isBot: false, vote: null },
        { playerId: 'p4',          displayName: 'Carol', isBot: false, vote: null },
        { playerId: 'p5',          displayName: 'Dave',  isBot: false, vote: null },
        { playerId: 'p6',          displayName: 'Eve',   isBot: false, vote: null },
      ],
      ...overrides,
    };
  }

  function makeGameOver() {
    return {
      type: 'game_over',
      winner: 1,
      tiebreakerWinner: null,
      scores: { team1: 5, team2: 3 },
    };
  }

  /**
   * game_init establishes myPlayerId so the players-only vote panel guard
   * passes (`myPlayerId && (rematchVote || rematchDeclined)`).
   */
  function makeCompletedGameInit() {
    return {
      type: 'game_init',
      myPlayerId: MY_PLAYER_ID,
      myHand: [],
      players: players6.map((p) => ({ ...p, cardCount: 0, isCurrentTurn: false })),
      gameState: {
        status: 'completed',
        currentTurnPlayerId: null,
        scores: { team1: 5, team2: 3 },
        lastMove: null,
        winner: 1,
        tiebreakerWinner: null,
        declaredSuits: [],
      },
      variant: 'remove_7s',
      playerCount: 6,
    };
  }

  /** Advance to game-over state with WS messages already sent. */
  async function setupCompletedGame() {
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('completed') });
    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('game-completed-view')).toBeTruthy();
    });

    act(() => openWs());
    // Establish myPlayerId so the player-only vote guard passes
    act(() => sendWsMessage(makeCompletedGameInit()));
    act(() => sendWsMessage(makeGameOver()));
    act(() => sendWsMessage(makeVoteUpdate()));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    lastMockWsInstance = null;
  });

  it('1. shows RematchVotePanel after game_over + rematch_vote_update', async () => {
    await setupCompletedGame();

    await waitFor(() => {
      expect(screen.getByTestId('rematch-vote-panel')).toBeTruthy();
    });
  });

  it('2. Yes button sends rematch_vote with vote: true', async () => {
    const sentMessages: unknown[] = [];
    await setupCompletedGame();

    if (lastMockWsInstance) {
      lastMockWsInstance.send = (data: string) => sentMessages.push(JSON.parse(data));
    }

    await waitFor(() => expect(screen.getByTestId('rematch-yes-btn')).toBeTruthy());
    act(() => { screen.getByTestId('rematch-yes-btn').click(); });

    expect(sentMessages).toContainEqual({ type: 'rematch_vote', vote: true });
  });

  it('3. No button sends rematch_vote with vote: false', async () => {
    const sentMessages: unknown[] = [];
    await setupCompletedGame();

    if (lastMockWsInstance) {
      lastMockWsInstance.send = (data: string) => sentMessages.push(JSON.parse(data));
    }

    await waitFor(() => expect(screen.getByTestId('rematch-no-btn')).toBeTruthy());
    act(() => { screen.getByTestId('rematch-no-btn').click(); });

    expect(sentMessages).toContainEqual({ type: 'rematch_vote', vote: false });
  });

  it('4. rematch_start shows "Rematch starting…" overlay and redirects', async () => {
    await setupCompletedGame();

    act(() => sendWsMessage({ type: 'rematch_start', roomCode: 'ABC123' }));

    await waitFor(() => {
      expect(screen.getByTestId('rematch-starting-view')).toBeTruthy();
    });
    expect(screen.getByText(/Rematch starting/i)).toBeTruthy();

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/room/ABC123');
    });
  });

  it('5. room_dissolved (timeout) shows dissolution notice', async () => {
    await setupCompletedGame();

    act(() => sendWsMessage({ type: 'rematch_declined', reason: 'timeout' }));
    act(() => sendWsMessage({ type: 'room_dissolved',   reason: 'timeout' }));

    await waitFor(() => {
      expect(screen.getByTestId('room-dissolved-notice')).toBeTruthy();
    });
    expect(screen.getByText(/Room dissolved/i)).toBeTruthy();
    expect(screen.getByText(/timed out/i)).toBeTruthy();
  });

  it('6. room_dissolved (majority_no) shows dissolution notice with correct text', async () => {
    await setupCompletedGame();

    act(() => sendWsMessage({ type: 'rematch_declined', reason: 'majority_no' }));
    act(() => sendWsMessage({ type: 'room_dissolved',   reason: 'majority_no' }));

    await waitFor(() => {
      expect(screen.getByTestId('room-dissolved-notice')).toBeTruthy();
    });
    expect(screen.getByText(/majority voted no/i)).toBeTruthy();
  });

  it('7. rematch_declined alone shows RematchVotePanel in declined state', async () => {
    await setupCompletedGame();

    act(() => sendWsMessage({ type: 'rematch_declined', reason: 'majority_no' }));

    await waitFor(() => {
      expect(screen.getByTestId('rematch-declined-panel')).toBeTruthy();
    });
    // Vote buttons gone after decline
    expect(screen.queryByTestId('rematch-vote-buttons')).toBeNull();
  });

  it('8. room_dissolved replaces the vote panel', async () => {
    await setupCompletedGame();

    // Vote panel is shown first
    await waitFor(() => expect(screen.getByTestId('rematch-vote-panel')).toBeTruthy());

    // Dissolution arrives
    act(() => sendWsMessage({ type: 'rematch_declined', reason: 'timeout' }));
    act(() => sendWsMessage({ type: 'room_dissolved',   reason: 'timeout' }));

    await waitFor(() => {
      expect(screen.getByTestId('room-dissolved-notice')).toBeTruthy();
    });
    // Vote panel and decline panel must no longer be shown
    expect(screen.queryByTestId('rematch-vote-panel')).toBeNull();
    expect(screen.queryByTestId('rematch-declined-panel')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// While the game socket reconnects (fake hook)
// ---------------------------------------------------------------------------

describe('GamePage — while the game socket reconnects', () => {
  const MY_PLAYER_ID = 'player-me';
  const HAND: CardId[] = ['1_s', '3_h', '5_d', '6_c', '9_s'];
  const players6: GamePlayer[] = [
    makePlayer(MY_PLAYER_ID, 'Me',    1, 0),
    makePlayer('p2',          'Alice', 1, 2),
    makePlayer('p3',          'Bob',   1, 4),
    makePlayer('p4',          'Carol', 2, 1),
    makePlayer('p5',          'Dave',  2, 3),
    makePlayer('p6',          'Eve',   2, 5),
  ];
  const GAME_OVER = {
    type: 'game_over' as const,
    winner: 1 as const,
    tiebreakerWinner: null,
    scores: { team1: 5, team2: 3 },
  };

  interface FakeSocket {
    state: UseGameSocketReturn;
    options: GameSocketOptions | null;
  }

  function activeState(currentTurnPlayerId: string | null, overrides: Partial<PublicGameState> = {}): PublicGameState {
    return {
      status: 'active',
      currentTurnPlayerId,
      scores: { team1: 0, team2: 0 },
      lastMove: null,
      winner: null,
      tiebreakerWinner: null,
      declaredSuits: [],
      ...overrides,
    };
  }

  function fakeGameSocket(overrides: Partial<UseGameSocketReturn> = {}): FakeSocket {
    const fake: FakeSocket = {
      options: null,
      state: {
        wsStatus: 'connected',
        myPlayerId: MY_PLAYER_ID,
        myHand: HAND,
        spectatorHands: {},
        spectatorMoveHistory: [],
        askHistory: [],
        players: players6,
        gameState: activeState(MY_PLAYER_ID),
        variant: 'remove_7s',
        playerCount: 6,
        lastAskResult: null,
        nextAskAnimation: null,
        lastVisibleAskResult: null,
        finishAskAnimation: jest.fn(),
        lastDeclareResult: null,
        declarationReveal: null,
        turnTimer: null,
        declarationTimer: null,
        rematchVote: null,
        rematchDeclined: null,
        roomDissolved: null,
        botTakeover: null,
        reclaimQueued: false,
        reconnectWindows: {},
        declareProgress: null,
        eligibleNextTurnPlayerIds: [],
        postDeclarationHighlight: null,
        postDeclarationTimer: null,
        pendingTurnPassAck: false,
        error: null,
        sendAsk: jest.fn(),
        sendDeclare: jest.fn(),
        sendDeclareProgress: jest.fn(),
        sendRematchVote: jest.fn(),
        sendRematchInitiate: jest.fn(),
        sendPartialSelection: jest.fn(),
        sendDeclareSelecting: jest.fn(),
        sendGameAdvance: jest.fn(),
        sendBotSpeed: jest.fn(),
        sendChooseNextTurn: jest.fn(),
        retryNow: jest.fn(),
        ...overrides,
      },
    };
    mockGameSocket = (options) => {
      fake.options = options;
      return fake.state;
    };
    return fake;
  }

  /** Renders the page over the fake hook. The returned function applies one hook update in one render. */
  async function renderWithFake(fake: FakeSocket, readyTestId: string) {
    const params = makeParams('ABC123');
    const { rerender } = render(<GamePage params={params} />);
    await waitFor(() => expect(screen.getByTestId(readyTestId)).toBeTruthy());
    return (patch: Partial<UseGameSocketReturn>) => {
      fake.state = { ...fake.state, ...patch };
      rerender(<GamePage params={params} />);
    };
  }

  function clickHandCard(cardId: CardId) {
    const wrapper = document.querySelector(`[data-testid="card-wrapper-${cardId}"]`) as HTMLElement;
    fireEvent.click(wrapper.querySelector('[role="button"]') as HTMLElement);
  }

  function clickSeat(playerId: string) {
    fireEvent.click(document.querySelector(`[data-player-id="${playerId}"]`) as HTMLElement);
  }

  function openAskTray(cardIds: CardId[]) {
    clickHandCard('3_h');
    for (const cardId of cardIds) fireEvent.click(screen.getByTestId(`inline-ask-card-${cardId}`));
  }

  function openDeclareTray() {
    fireEvent.click(screen.getByTestId('toggle-declare'));
    clickHandCard('1_s');
    return screen.getByTestId('inline-declare-tray');
  }

  function teammateDropSeat(playerId: string) {
    return screen.getAllByTestId('declare-drop-seat').find((s) => s.getAttribute('data-player-id') === playerId)!;
  }

  function pressBar() {
    const text = within(screen.getByTestId('ws-reconnecting-banner')).getByText('Reconnecting…');
    fireEvent.mouseDown(text);
    fireEvent.click(text);
  }

  beforeEach(() => {
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('in_progress') });
  });

  it('shows the reconnect bar and keeps the hand on screen', async () => {
    const fake = fakeGameSocket({ wsStatus: 'reconnecting' });
    await renderWithFake(fake, 'game-view');

    expect(screen.getByTestId('ws-reconnecting-banner')).toBeTruthy();
    expect(document.querySelector('[data-testid="card-wrapper-1_s"]')).toBeTruthy();
  });

  it('does not send an ask when the opponent seat is clicked after the drop', async () => {
    const fake = fakeGameSocket();
    const update = await renderWithFake(fake, 'game-view');
    openAskTray(['1_h']);

    update({ wsStatus: 'reconnecting' });
    clickSeat('p4');

    expect(fake.state.sendAsk).not.toHaveBeenCalled();
  });

  it('disables the confirm button of a completed declare tray after the drop', async () => {
    const fake = fakeGameSocket();
    const update = await renderWithFake(fake, 'game-view');
    const tray = openDeclareTray();
    for (let i = 0; i < 5; i++) {
      fireEvent.click(within(tray).getAllByTestId('declare-draggable-card')[0]);
      fireEvent.click(
        screen.getAllByTestId('declare-drop-seat').find((s) => s.getAttribute('data-player-id') === 'p2')!,
      );
    }
    expect(screen.getByTestId('inline-declare-confirm')).toBeEnabled();

    update({ wsStatus: 'reconnecting' });
    const confirm = screen.getByTestId('inline-declare-confirm');
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);

    expect(fake.state.sendDeclare).not.toHaveBeenCalled();
  });

  it('drops a pending ask batch on a drop and frees the controls after the reconnect', async () => {
    const fake = fakeGameSocket();
    const update = await renderWithFake(fake, 'game-view');
    openAskTray(['1_h', '2_h']);
    clickSeat('p4');
    expect(fake.state.sendAsk).toHaveBeenCalledWith('p4', '1_h', ['1_h', '2_h']);

    // Card 1 lands, so the page waits for Carol's count to drop before it asks for card 2.
    update({
      myHand: [...HAND, '1_h'],
      lastAskResult: {
        type: 'ask_result',
        askerId: MY_PLAYER_ID,
        targetId: 'p4',
        cardId: '1_h',
        success: true,
        newTurnPlayerId: MY_PLAYER_ID,
        lastMove: 'Me asked Carol for A♥ and got it',
      },
    });
    expect(screen.getByTestId('toggle-ask')).toBeDisabled();

    update({ wsStatus: 'reconnecting' });
    update({
      wsStatus: 'connected',
      lastAskResult: null,
      players: players6.map((p) => (p.playerId === 'p4' ? { ...p, cardCount: 4 } : p)),
      gameState: activeState(MY_PLAYER_ID),
    });

    expect(fake.state.sendAsk).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('toggle-ask')).toBeEnabled();
    clickHandCard('5_d');
    expect(screen.getByTestId('inline-ask-tray')).toBeTruthy();
  });

  it('frees the controls after an ask result identical to the last one before the drop', async () => {
    const fake = fakeGameSocket();
    const update = await renderWithFake(fake, 'game-view');
    const gotAceOfHearts = () => ({
      type: 'ask_result' as const,
      askerId: MY_PLAYER_ID,
      targetId: 'p4',
      cardId: '1_h' as CardId,
      success: true,
      newTurnPlayerId: MY_PLAYER_ID,
      lastMove: 'Me asked Carol for A♥ — got it',
    });
    openAskTray(['1_h']);
    clickSeat('p4');
    update({ myHand: [...HAND, '1_h'], lastAskResult: gotAceOfHearts() });
    expect(screen.getByTestId('toggle-ask')).toBeEnabled();

    // Carol took the card back while the player was away, so asking for it again is the natural move.
    update({ wsStatus: 'reconnecting' });
    update({ wsStatus: 'connected', lastAskResult: null, myHand: [...HAND], gameState: activeState(MY_PLAYER_ID) });
    openAskTray(['1_h']);
    clickSeat('p4');
    expect(fake.state.sendAsk).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('toggle-ask')).toBeDisabled();

    update({ myHand: [...HAND, '1_h'], lastAskResult: gotAceOfHearts() });

    expect(screen.getByTestId('toggle-ask')).toBeEnabled();
  });

  it('keeps an open ask tray when the reconnect bar is pressed', async () => {
    const fake = fakeGameSocket();
    const update = await renderWithFake(fake, 'game-view');
    openAskTray(['1_h']);

    update({ wsStatus: 'reconnecting' });
    pressBar();

    expect(screen.getByTestId('inline-ask-tray')).toBeTruthy();
    expect(screen.getByTestId('inline-ask-card-1_h')).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps an open declare tray when the reconnect bar is pressed', async () => {
    const fake = fakeGameSocket();
    const update = await renderWithFake(fake, 'game-view');
    openDeclareTray();

    update({ wsStatus: 'reconnecting' });
    pressBar();

    expect(screen.getByTestId('inline-declare-tray')).toBeTruthy();
  });

  describe('trays after the reconnect', () => {
    async function dropWithAskTrayOpen() {
      const fake = fakeGameSocket();
      const update = await renderWithFake(fake, 'game-view');
      openAskTray(['1_h']);
      update({ wsStatus: 'reconnecting' });
      return update;
    }

    it('keeps the tray and its selection on the same turn with the same hand and declared suits', async () => {
      const update = await dropWithAskTrayOpen();

      update({ wsStatus: 'connected', myHand: [...HAND].reverse(), gameState: activeState(MY_PLAYER_ID) });

      expect(screen.getByTestId('inline-ask-tray')).toBeTruthy();
      expect(screen.getByTestId('inline-ask-card-1_h')).toHaveAttribute('aria-pressed', 'true');
    });

    it('resets the tray when the hand changed', async () => {
      const update = await dropWithAskTrayOpen();

      update({ wsStatus: 'connected', myHand: [...HAND, '2_h'], gameState: activeState(MY_PLAYER_ID) });

      expect(screen.queryByTestId('inline-ask-tray')).toBeNull();
    });

    it('resets the tray when the declared suits changed', async () => {
      const update = await dropWithAskTrayOpen();

      update({
        wsStatus: 'connected',
        myHand: [...HAND],
        gameState: activeState(MY_PLAYER_ID, {
          declaredSuits: [{ halfSuitId: 'high_c', teamId: 2, declaredBy: 'p4' }],
        }),
      });

      expect(screen.queryByTestId('inline-ask-tray')).toBeNull();
    });

    it('resets the tray when it is no longer the player\'s turn', async () => {
      const update = await dropWithAskTrayOpen();

      update({ wsStatus: 'connected', myHand: [...HAND], gameState: activeState('p4') });
      // The tray hides on another player's turn anyway; it must stay closed when the turn comes back.
      update({ gameState: activeState(MY_PLAYER_ID) });

      expect(screen.queryByTestId('inline-ask-tray')).toBeNull();
    });
  });

  describe('the turn deadline during a drop', () => {
    const turnTimerIn = (ms: number) => ({
      type: 'turn_timer' as const,
      playerId: MY_PLAYER_ID,
      durationMs: 60_000,
      expiresAt: Date.now() + ms,
    });

    async function dropPastTheDeadlineWithAskTrayOpen() {
      const fake = fakeGameSocket();
      const update = await renderWithFake(fake, 'game-view');
      openAskTray(['1_h']);
      // The reset runs on a timer, so fake timers must be in place before it arms.
      jest.useFakeTimers();
      update({ turnTimer: turnTimerIn(1000) });
      update({ wsStatus: 'reconnecting' });
      act(() => jest.advanceTimersByTime(1000));
      return update;
    }

    afterEach(() => {
      cleanup();
      jest.useRealTimers();
    });

    it('keeps the ask tray open when the old deadline passes during the drop', async () => {
      await dropPastTheDeadlineWithAskTrayOpen();

      expect(screen.getByTestId('inline-ask-tray')).toBeTruthy();
      expect(screen.getByTestId('inline-ask-card-1_h')).toHaveAttribute('aria-pressed', 'true');
    });

    it('keeps the ask tray after a reconnect with a fresh deadline, and resets it when that deadline passes', async () => {
      const update = await dropPastTheDeadlineWithAskTrayOpen();
      update({ wsStatus: 'connected', turnTimer: null, myHand: [...HAND], gameState: activeState(MY_PLAYER_ID) });
      update({ turnTimer: turnTimerIn(60_000) });

      act(() => jest.advanceTimersByTime(59_999));
      expect(screen.getByTestId('inline-ask-tray')).toBeTruthy();
      act(() => jest.advanceTimersByTime(1));
      expect(screen.queryByTestId('inline-ask-tray')).toBeNull();
    });
  });

  describe('tray edits during the drop', () => {
    it('keeps an open declare tray on an outside click and sends nothing', async () => {
      const fake = fakeGameSocket();
      const update = await renderWithFake(fake, 'game-view');
      openDeclareTray();
      update({ wsStatus: 'reconnecting' });
      jest.mocked(fake.state.sendDeclareSelecting).mockClear();
      jest.mocked(fake.state.sendDeclareProgress).mockClear();

      fireEvent.click(document.body);

      expect(screen.getByTestId('inline-declare-tray')).toBeTruthy();
      expect(fake.state.sendDeclareSelecting).not.toHaveBeenCalled();
      expect(fake.state.sendDeclareProgress).not.toHaveBeenCalled();
    });

    it('ignores a card toggle in an open ask tray and sends nothing', async () => {
      const fake = fakeGameSocket();
      const update = await renderWithFake(fake, 'game-view');
      openAskTray(['1_h']);
      update({ wsStatus: 'reconnecting' });
      jest.mocked(fake.state.sendPartialSelection).mockClear();

      fireEvent.click(screen.getByTestId('inline-ask-card-2_h'));

      expect(screen.getByTestId('inline-ask-card-1_h')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('inline-ask-card-2_h')).toHaveAttribute('aria-pressed', 'false');
      expect(fake.state.sendPartialSelection).not.toHaveBeenCalled();
    });

    it('ignores a card assignment in an open declare tray and sends nothing', async () => {
      const fake = fakeGameSocket();
      const update = await renderWithFake(fake, 'game-view');
      const tray = openDeclareTray();
      update({ wsStatus: 'reconnecting' });
      jest.mocked(fake.state.sendDeclareProgress).mockClear();

      fireEvent.click(within(tray).getAllByTestId('declare-draggable-card')[0]);
      fireEvent.click(teammateDropSeat('p2'));

      expect(within(tray).getByText(/1\/6 assigned/)).toBeTruthy();
      expect(fake.state.sendDeclareProgress).not.toHaveBeenCalled();
    });

    it('sends nothing and leaves the controls free when the declaration countdown runs out during the drop', async () => {
      const fake = fakeGameSocket();
      const update = await renderWithFake(fake, 'game-view');
      openDeclareTray();
      // The countdown runs on requestAnimationFrame, so fake timers must be in place before it mounts.
      jest.useFakeTimers();
      try {
        update({
          declarationTimer: { type: 'declaration_timer', playerId: MY_PLAYER_ID, durationMs: 60_000, expiresAt: Date.now() + 1000 },
        });
        update({ wsStatus: 'reconnecting' });
        act(() => jest.advanceTimersByTime(1100));

        update({ wsStatus: 'connected', declarationTimer: null, myHand: [...HAND], gameState: activeState(MY_PLAYER_ID) });

        expect(screen.getByTestId('toggle-declare')).toBeEnabled();
        expect(fake.state.sendDeclare).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps the highlight on its card when another card in the declare tray is tapped', async () => {
      const fake = fakeGameSocket();
      const update = await renderWithFake(fake, 'game-view');
      const tray = openDeclareTray();
      const cardLabels = () => within(tray).getAllByTestId('declare-draggable-card').map((c) => c.getAttribute('aria-label'));
      fireEvent.click(within(tray).getAllByTestId('declare-draggable-card')[0]);
      const selectedBefore = cardLabels();
      expect(selectedBefore[0]).toMatch(/, selected/);
      update({ wsStatus: 'reconnecting' });

      fireEvent.click(within(tray).getAllByTestId('declare-draggable-card')[1]);

      expect(cardLabels()).toEqual(selectedBefore);
    });
  });

  describe('kept trays after the reconnect', () => {
    it('resends the declare tray\'s suit and assignment', async () => {
      const fake = fakeGameSocket();
      const update = await renderWithFake(fake, 'game-view');
      const tray = openDeclareTray();
      fireEvent.click(within(tray).getAllByTestId('declare-draggable-card')[0]);
      fireEvent.click(teammateDropSeat('p2'));
      const [, assignment] = jest.mocked(fake.state.sendDeclareProgress).mock.lastCall!;
      update({ wsStatus: 'reconnecting' });
      jest.mocked(fake.state.sendDeclareSelecting).mockClear();
      jest.mocked(fake.state.sendDeclareProgress).mockClear();

      update({ wsStatus: 'connected', myHand: [...HAND], gameState: activeState(MY_PLAYER_ID) });

      expect(screen.getByTestId('inline-declare-tray')).toBeTruthy();
      expect(fake.state.sendDeclareSelecting).toHaveBeenCalledWith('low_s');
      expect(fake.state.sendDeclareProgress).toHaveBeenCalledWith('low_s', assignment);
    });

    it('resends the ask tray\'s partial selection', async () => {
      const fake = fakeGameSocket();
      const update = await renderWithFake(fake, 'game-view');
      openAskTray(['1_h', '2_h']);
      update({ wsStatus: 'reconnecting' });
      jest.mocked(fake.state.sendPartialSelection).mockClear();

      update({ wsStatus: 'connected', myHand: [...HAND], gameState: activeState(MY_PLAYER_ID) });

      expect(fake.state.sendPartialSelection).toHaveBeenCalledWith({ flow: 'ask', halfSuitId: 'low_h', cardId: '2_h' });
    });
  });

  it('keeps the spectator view mounted, with its God mode still on, when the socket drops', async () => {
    const fake = fakeGameSocket({ myPlayerId: null, myHand: [] });
    const update = await renderWithFake(fake, 'spectator-view');
    fireEvent.click(screen.getByTestId('spectator-god-mode-toggle'));
    const view = screen.getByTestId('spectator-view');

    update({ wsStatus: 'reconnecting' });

    expect(screen.getByTestId('ws-reconnecting-banner')).toBeTruthy();
    expect(screen.getByTestId('spectator-view')).toBe(view);
    expect(screen.getByTestId('spectator-god-mode-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  const viewers: Array<[string, string | null, string]> = [
    ['a player', MY_PLAYER_ID, 'game-view'],
    ['a spectator', null, 'spectator-view'],
  ];

  describe.each(viewers)('a rematch that started during the drop, for %s', (_viewer, myPlayerId, liveView) => {
    async function renderUntilGameOver() {
      const fake = fakeGameSocket({ myPlayerId, myHand: myPlayerId ? HAND : [] });
      await renderWithFake(fake, liveView);

      act(() => fake.options!.onGameInit!('active'));
      expect(screen.getByTestId(liveView)).toBeTruthy();

      act(() => fake.options!.onGameOver!(GAME_OVER));
      await waitFor(() => expect(screen.getByTestId('ask-stats-table')).toBeTruthy());
      return fake;
    }

    it('clears the results screen when the next init reports an active game', async () => {
      const fake = await renderUntilGameOver();

      act(() => fake.options!.onGameInit!('active'));

      expect(screen.queryByTestId('game-completed-view')).toBeNull();
      expect(screen.getByTestId(liveView)).toBeTruthy();
    });

    it('keeps the results screen when the next init reports a completed game', async () => {
      const fake = await renderUntilGameOver();

      act(() => fake.options!.onGameInit!('completed'));

      expect(screen.getByTestId('game-completed-view')).toBeTruthy();
    });
  });

  describe.each(viewers)('the last move after a reconnect, for %s', (_viewer, myPlayerId, liveView) => {
    const lastMoveTestId = myPlayerId ? 'last-move-display' : 'spectator-last-move';

    function carolAsksAlice(cardId: CardId, lastMove: string, batchCardIds?: CardId[]) {
      return {
        type: 'ask_result' as const,
        askerId: 'p4',
        targetId: 'p2',
        cardId,
        batchCardIds,
        success: true,
        newTurnPlayerId: 'p4',
        lastMove,
      };
    }

    async function renderOnCarolsTurn() {
      const fake = fakeGameSocket({ myPlayerId, myHand: myPlayerId ? HAND : [], gameState: activeState('p4') });
      return renderWithFake(fake, liveView);
    }

    it('shows the server\'s last move, not the summary of an ask batch from before the drop', async () => {
      const update = await renderOnCarolsTurn();
      // The batch summary shows only once the 5 s flash of the latest result has gone.
      jest.useFakeTimers();
      try {
        update({ lastAskResult: carolAsksAlice('10_c', 'Carol asked Alice for 10♣ — got it', ['10_c', '11_c']) });
        act(() => jest.advanceTimersByTime(5000));
        expect(screen.getByTestId(lastMoveTestId).textContent).toBe('Carol asked Alice for 10♣ and J♣');

        update({ wsStatus: 'reconnecting' });
        update({
          wsStatus: 'connected',
          lastAskResult: null,
          gameState: activeState('p4', { lastMove: 'Carol asked Alice for J♣ — got it' }),
        });

        expect(screen.getByTestId(lastMoveTestId).textContent).toBe('Carol asked Alice for J♣ — got it');
      } finally {
        jest.useRealTimers();
      }
    });

    it('shows an ask result identical to the last one before the drop', async () => {
      const update = await renderOnCarolsTurn();
      // The flash of the first result must be gone, or it would hide whether the repeat was shown.
      jest.useFakeTimers();
      try {
        update({ lastAskResult: carolAsksAlice('10_c', 'Carol asked Alice for 10♣ — got it') });
        act(() => jest.advanceTimersByTime(5000));
        update({ wsStatus: 'reconnecting' });
        update({
          wsStatus: 'connected',
          lastAskResult: null,
          gameState: activeState('p4', { lastMove: 'Bob asked Carol for 2♠ — denied' }),
        });
        expect(screen.getByTestId(lastMoveTestId).textContent).toBe('Bob asked Carol for 2♠ — denied');

        update({ lastAskResult: carolAsksAlice('10_c', 'Carol asked Alice for 10♣ — got it') });

        expect(screen.getByTestId(lastMoveTestId).textContent).toBe('Carol asked Alice for 10♣ — got it');
      } finally {
        jest.useRealTimers();
      }
    });

    it('starts a new ask summary after the reconnect instead of extending one from before the drop', async () => {
      const update = await renderOnCarolsTurn();
      update({ lastAskResult: carolAsksAlice('10_c', 'Carol asked Alice for 10♣ — got it') });
      update({ wsStatus: 'reconnecting' });
      update({ wsStatus: 'connected', lastAskResult: null });

      update({ lastAskResult: carolAsksAlice('11_c', 'Carol asked Alice for J♣ — got it') });

      expect(screen.getByTestId(lastMoveTestId).textContent).toBe('Carol asked Alice for J♣ — got it');
    });
  });

  it('clears a completed room status when an init reports an active game', async () => {
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('completed') });
    const fake = fakeGameSocket();
    await renderWithFake(fake, 'game-completed-view');
    await waitFor(() => expect(screen.getByTestId('ask-stats-table')).toBeTruthy());

    act(() => fake.options!.onGameInit!('active'));

    expect(screen.getByTestId('game-view')).toBeTruthy();
  });

  describe('the results screen', () => {
    const OPEN_VOTE = {
      type: 'rematch_vote_update' as const,
      yesCount: 0,
      noCount: 0,
      totalCount: 6,
      humanCount: 6,
      majority: 4,
      majorityReached: false,
      majorityDeclined: false,
      votes: {},
      playerVotes: players6.map((p) => ({ playerId: p.playerId, displayName: p.displayName, isBot: false, vote: null })),
    };
    const COMPLETED = activeState(null, { status: 'completed', winner: 1, scores: { team1: 5, team2: 3 } });

    async function renderResults(overrides: Partial<UseGameSocketReturn>) {
      mockGetRoomByCode.mockResolvedValue({ room: buildRoom('completed') });
      const fake = fakeGameSocket({ gameState: COMPLETED, rematchVote: OPEN_VOTE, ...overrides });
      await renderWithFake(fake, 'game-completed-view');
      await waitFor(() => expect(screen.getByTestId('ask-stats-table')).toBeTruthy());
      return fake;
    }

    it('shows the bar and disables the rematch vote while reconnecting', async () => {
      const fake = await renderResults({ wsStatus: 'reconnecting' });

      expect(screen.getByTestId('ws-reconnecting-banner')).toBeTruthy();
      expect(screen.getByTestId('rematch-yes-btn')).toBeDisabled();
      expect(screen.getByTestId('rematch-no-btn')).toBeDisabled();
      fireEvent.click(screen.getByTestId('rematch-yes-btn'));
      expect(fake.state.sendRematchVote).not.toHaveBeenCalled();
    });

    it('says why the rematch vote is disabled after the socket stops for good', async () => {
      await renderResults({ wsStatus: 'error', error: 'This game was opened in another tab or window.' });

      expect(screen.getByTestId('ws-error-banner').textContent).toBe('⚠️This game was opened in another tab or window.');
      expect(screen.getByTestId('rematch-yes-btn')).toBeDisabled();
    });

    it('shows no error to a visitor who never had a seat', async () => {
      await renderResults({ wsStatus: 'error', error: 'Player not in game', myPlayerId: null, myHand: [] });

      expect(screen.queryByTestId('ws-error-banner')).toBeNull();
    });
  });

  it('reads "Reconnecting…" in the footer before the first init, with no "refresh"', async () => {
    const fake = fakeGameSocket({
      wsStatus: 'reconnecting',
      myPlayerId: null,
      myHand: [],
      players: [],
      gameState: null,
      variant: null,
      playerCount: null,
    });
    await renderWithFake(fake, 'game-view');

    const footer = screen.getByTestId('spectator-status');
    expect(footer.textContent).toBe('Reconnecting…');
    expect(footer.textContent).not.toMatch(/refresh/i);
  });
});
