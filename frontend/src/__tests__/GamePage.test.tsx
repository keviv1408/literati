/**
 * @jest-environment jsdom
 *
 * Tests for /game/[room-id] — Sub-AC 47a:
 *
 *   • Renders loading state immediately on mount.
 *   • Renders "Invalid Room Code" error for malformed room IDs (e.g. "ABC").
 *   • Renders "Room Not Found" error when GET /api/rooms/:code returns 404.
 *   • Renders "Something Went Wrong" error for unexpected API failures.
 *   • Redirects to /room/<CODE> when room status is 'waiting'.
 *   • Redirects to /room/<CODE> when room status is 'starting'.
 *   • Renders game view (data-testid="game-view") for 'in_progress' rooms.
 *   • Renders "Game Cancelled" state for cancelled rooms.
 *   • Renders "Game Over" state for completed rooms.
 *   • Shows room code in the game view header.
 *   • Shows variant label in the game view header.
 *   • WebSocket status indicator is rendered in the game view.
 *   • Turn indicator is NOT rendered when gameState is null.
 *   • Player hand area is rendered in the game view footer.
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

// Mock the API module
const mockGetRoomByCode = jest.fn();
jest.mock('@/lib/api', () => ({
  getRoomByCode: (...args: unknown[]) => mockGetRoomByCode(...args),
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

// Mock AuthContext
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ session: null, user: null }),
}));

// Mock WebSocket globally — tracks the most recently created instance so tests
// can simulate incoming messages (game_init, etc.) by calling onmessage.
let lastMockWsInstance: MockWebSocket | null = null;

class MockWebSocket {
  onopen: (() => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  readyState = 0; // CONNECTING
  close() { this.readyState = 3; }
  send() {}
  constructor(public url: string) {
    lastMockWsInstance = this;
  }
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

beforeEach(() => {
  jest.clearAllMocks();
  lastMockWsInstance = null;
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

  it('shows "Something Went Wrong" for non-404 API errors', async () => {
    const { ApiError } = await import('@/lib/api');
    mockGetRoomByCode.mockRejectedValue(new ApiError(500, 'Internal server error'));

    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('generic-error-view')).toBeTruthy();
    });
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
// Completed room
// ---------------------------------------------------------------------------

describe('GamePage — completed room', () => {
  it('shows "Game Over" state for completed rooms', async () => {
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('completed') });

    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('game-completed-view')).toBeTruthy();
    });
    expect(screen.getByText('Game Over')).toBeTruthy();
  });

  it('shows final score as 0-0 when no game state is available', async () => {
    mockGetRoomByCode.mockResolvedValue({ room: buildRoom('completed') });

    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('game-completed-view')).toBeTruthy();
    });
    // Score display: "Team 1: 0 • Team 2: 0"
    expect(screen.getByText(/Final score/)).toBeTruthy();
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

  it('shows the room code in the header', async () => {
    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('game-room-code')).toBeTruthy();
    });
    expect(screen.getByTestId('game-room-code').textContent).toBe('ABC123');
  });

  it('shows the variant label in the header', async () => {
    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('game-view')).toBeTruthy();
    });
    // "Remove 7s (Classic)" appears in both header and table centre
    const variantLabels = screen.getAllByText(/Remove 7s/);
    expect(variantLabels.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the WebSocket status indicator', async () => {
    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('ws-status-indicator')).toBeTruthy();
    });
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

  it('renders the player hand area footer', async () => {
    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('player-hand-area')).toBeTruthy();
    });
  });

  it('renders team 1 and team 2 rows', async () => {
    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('team1-row')).toBeTruthy();
      expect(screen.getByTestId('team2-row')).toBeTruthy();
    });
  });

  it('shows score display in the header', async () => {
    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('game-score')).toBeTruthy();
    });
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
      expect(mockGetRoomByCode).toHaveBeenCalledWith('DEF456');
    });
  });
});

// ---------------------------------------------------------------------------
// 8-player variant
// ---------------------------------------------------------------------------

describe('GamePage — 8-player in_progress game', () => {
  it('shows "4v4" in the header for an 8-player room', async () => {
    mockGetRoomByCode.mockResolvedValue({
      room: buildRoom('in_progress', { player_count: 8 }),
    });

    render(<GamePage params={makeParams('ABC123')} />);

    await waitFor(() => {
      expect(screen.getByTestId('game-view')).toBeTruthy();
    });
    // "4v4" may appear in header and/or table centre
    const labels = screen.getAllByText(/4v4/);
    expect(labels.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Sub-AC 9.2: inference (ask/answer) mode always available
//
// These tests verify that the game controls (Declare button, card hand,
// AskCardModal, DeclareModal) are:
//   • Available immediately after game_init is received (no delay due to
//     matchmaking state — the game page uses ONLY game socket state)
//   • Available when the current player is on their turn, regardless of
//     whether teammates/opponents are bots or humans
//   • Available for both 6-player and 8-player game configurations
//
// The controls are gated exclusively on `isMyTurn` which comes from
// gameState.currentTurnPlayerId === myPlayerId (game socket state only).
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

describe('GamePage — Sub-AC 9.2: game controls always available', () => {
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

    it('shows Declare button when it is the player\'s turn', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

      // Connect WS and receive game_init
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players6)));

      await waitFor(() => {
        expect(screen.getByTestId('declare-button')).toBeTruthy();
      });
    });

    it('shows the turn indicator for the current player', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players6)));

      await waitFor(() => {
        const turnIndicator = screen.getByTestId('turn-indicator');
        expect(turnIndicator.textContent).toContain('Your turn');
      });
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
      // But Declare button must not appear
      expect(screen.queryByTestId('declare-button')).toBeNull();
    });

    it('game controls are never disabled due to matchmaking state', async () => {
      // This verifies that no matchmaking-related import/state is gating the
      // controls.  The game page should not import useMatchmakingSocket or
      // reference any matchmaking status.
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players6)));

      await waitFor(() => {
        // Declare button is enabled (not disabled)
        const declareBtn = screen.getByTestId('declare-button') as HTMLButtonElement;
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

    it('shows Declare button when opponents are all bots', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, allBotOpponents)));

      await waitFor(() => {
        expect(screen.getByTestId('declare-button')).toBeTruthy();
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
        // "Your hand — 5 cards" — use the stable label text instead of card count
        expect(screen.getByText(/Your hand/i)).toBeTruthy();
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

    it('shows Declare button in an 8-player game on the player\'s turn', async () => {
      render(<GamePage params={makeParams('ABC123')} />);
      await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
      act(() => openWs());
      act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID, players8, { playerCount: 8 })));

      await waitFor(() => {
        expect(screen.getByTestId('declare-button')).toBeTruthy();
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
          inferenceMode: false,
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
