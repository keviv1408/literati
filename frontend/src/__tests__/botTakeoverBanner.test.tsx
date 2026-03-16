/**
 * @jest-environment jsdom
 *
 * Tests for the bot-takeover banner (Sub-AC 2 of AC 39).
 *
 * When a human player's 30-second turn timer expires, the server broadcasts a
 * `bot_takeover` event then auto-executes a move via bot logic.  The game page
 * shows a brief orange banner notifying all connected clients.
 *
 * Coverage:
 *   1. Banner is NOT rendered when botTakeover is null
 *   2. Banner renders when bot_takeover WS message is received
 *   3. Banner shows "Your turn timed out" message for the local player
 *   4. Banner shows the timed-out player's display name for another player
 *   5. Banner has data-testid="bot-takeover-banner"
 *   6. Banner disappears when ask_result arrives (move complete)
 *   7. Banner disappears when declaration_result arrives (move complete)
 *   8. Multiple clients all see the banner (broadcast)
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks (must be set up before importing the page)
// ---------------------------------------------------------------------------

const mockPush    = jest.fn();
const mockReplace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

const mockGetRoomByCode = jest.fn();
jest.mock('@/lib/api', () => ({
  getRoomByCode:      (...args: unknown[]) => mockGetRoomByCode(...args),
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

jest.mock('@/lib/backendSession', () => ({
  getCachedToken: jest.fn().mockReturnValue('cached-token'),
}));

jest.mock('@/lib/kickedRooms', () => ({
  isKickedFromRoom: jest.fn().mockReturnValue(false),
}));

const mockGuestSession = { displayName: 'TestPlayer', sessionId: 'guest-123' };
jest.mock('@/contexts/GuestContext', () => ({
  useGuest: () => ({ guestSession: mockGuestSession }),
}));

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

let lastMockWs: MockWebSocket | null = null;

class MockWebSocket {
  onopen:    (() => void) | null = null;
  onclose:   ((e: CloseEvent) => void) | null = null;
  onerror:   (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  readyState = 0; // CONNECTING
  close() { this.readyState = 3; }
  send() {}
  constructor(public url: string) {
    lastMockWs = this;
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).WebSocket = MockWebSocket;

function openWs() {
  if (lastMockWs) {
    lastMockWs.readyState = 1;
    lastMockWs.onopen?.();
  }
}

function sendWsMessage(msg: Record<string, unknown>) {
  lastMockWs?.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
}

// ---------------------------------------------------------------------------
// Import the page AFTER mocks
// ---------------------------------------------------------------------------

let GamePage: React.ComponentType<{ params: Promise<{ 'room-id': string }> }>;

beforeAll(async () => {
  const mod = await import('@/app/game/[room-id]/page');
  GamePage = mod.default;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MY_PLAYER_ID  = 'player-me';
const OTHER_PLAYER_ID = 'player-carol';

function makeParams(roomId: string): Promise<{ 'room-id': string }> {
  return Promise.resolve({ 'room-id': roomId });
}

function buildInProgressRoom() {
  return {
    id:                   'room-uuid-1',
    code:                 'ABC123',
    invite_code:          'invite-abc123',
    host_user_id:         'host-uuid',
    player_count:         6,
    card_removal_variant: 'remove_7s',
    status:               'in_progress',
    created_at:           '2026-01-01T00:00:00Z',
    updated_at:           '2026-01-01T00:00:00Z',
  };
}

function makePlayer(
  playerId: string,
  displayName: string,
  teamId: 1 | 2,
  seatIndex: number,
) {
  return {
    playerId,
    displayName,
    avatarId:      null,
    teamId,
    seatIndex,
    cardCount:     6,
    isBot:         false,
    isGuest:       true,
    isCurrentTurn: false,
  };
}

const players6 = [
  makePlayer(MY_PLAYER_ID,    'Me',    1, 0),
  makePlayer('player-alice',  'Alice', 1, 2),
  makePlayer('player-bob',    'Bob',   1, 4),
  makePlayer(OTHER_PLAYER_ID, 'Carol', 2, 1),
  makePlayer('player-dave',   'Dave',  2, 3),
  makePlayer('player-eve',    'Eve',   2, 5),
];

function makeGameInit(currentTurnPlayerId: string) {
  return {
    type: 'game_init',
    myPlayerId: MY_PLAYER_ID,
    myHand:     ['1_s', '2_s', '3_s', '4_s', '5_s'],
    players:    players6,
    gameState: {
      status:             'active',
      currentTurnPlayerId,
      scores:             { team1: 0, team2: 0 },
      lastMove:           null,
      winner:             null,
      tiebreakerWinner:   null,
      declaredSuits:      [],
    },
    variant:     'remove_7s',
    playerCount: 6,
  };
}

function makeAskResult(newTurnPlayerId: string) {
  return {
    type:            'ask_result',
    askerId:         MY_PLAYER_ID,
    targetId:        OTHER_PLAYER_ID,
    cardId:          '6_s',
    success:         false,
    newTurnPlayerId,
    lastMove:        `${MY_PLAYER_ID} asked ${OTHER_PLAYER_ID} for 6_s — no`,
  };
}

function makeDeclarationResult() {
  return {
    type:            'declaration_result',
    declarerId:      MY_PLAYER_ID,
    halfSuitId:      'low_s',
    correct:         false,
    winningTeam:     2,
    newTurnPlayerId: OTHER_PLAYER_ID,
    assignment:      {},
    lastMove:        `${MY_PLAYER_ID} declared low_s — wrong`,
  };
}

function makeBotTakeover(playerId: string, partialState: unknown = null) {
  return { type: 'bot_takeover', playerId, partialState };
}

// Also send a game_state after bot takeover so the page stays in sync
function makeGameState(currentTurnPlayerId: string) {
  return {
    type: 'game_state',
    state: {
      status:             'active',
      currentTurnPlayerId,
      scores:             { team1: 0, team2: 0 },
      lastMove:           null,
      winner:             null,
      tiebreakerWinner:   null,
      declaredSuits:      [],
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  lastMockWs = null;
  mockGetRoomByCode.mockResolvedValue({ room: buildInProgressRoom() });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bot-takeover banner (Sub-AC 2 of AC 39)', () => {
  it('1. Banner is NOT rendered on initial game load (no bot_takeover received)', async () => {
    render(<GamePage params={makeParams('ABC123')} />);
    await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

    act(() => openWs());
    act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID)));

    await waitFor(() => expect(screen.getByTestId('turn-indicator')).toBeTruthy());

    // Banner should NOT appear initially
    expect(screen.queryByTestId('bot-takeover-banner')).toBeNull();
  });

  it('2. Banner renders when bot_takeover WS message is received', async () => {
    render(<GamePage params={makeParams('ABC123')} />);
    await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

    act(() => openWs());
    act(() => sendWsMessage(makeGameInit(OTHER_PLAYER_ID)));
    act(() => sendWsMessage(makeBotTakeover(OTHER_PLAYER_ID)));

    await waitFor(() => {
      expect(screen.getByTestId('bot-takeover-banner')).toBeTruthy();
    });
  });

  it('3. Banner shows "Your turn timed out" when the local player timed out', async () => {
    render(<GamePage params={makeParams('ABC123')} />);
    await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

    act(() => openWs());
    act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID)));
    // My turn timer expired
    act(() => sendWsMessage(makeBotTakeover(MY_PLAYER_ID)));

    await waitFor(() => {
      const banner = screen.getByTestId('bot-takeover-banner');
      expect(banner.textContent).toContain('Your turn timed out');
    });
  });

  it('4. Banner shows the timed-out player\'s display name for another player', async () => {
    render(<GamePage params={makeParams('ABC123')} />);
    await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

    act(() => openWs());
    act(() => sendWsMessage(makeGameInit(OTHER_PLAYER_ID)));
    // Carol's (OTHER_PLAYER_ID) turn timer expired
    act(() => sendWsMessage(makeBotTakeover(OTHER_PLAYER_ID)));

    await waitFor(() => {
      const banner = screen.getByTestId('bot-takeover-banner');
      // Should mention "Carol" (the display name of OTHER_PLAYER_ID)
      expect(banner.textContent).toContain("Carol");
      expect(banner.textContent).toContain("timed out");
    });
  });

  it('5. Banner has the correct data-testid attribute', async () => {
    render(<GamePage params={makeParams('ABC123')} />);
    await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

    act(() => openWs());
    act(() => sendWsMessage(makeGameInit(OTHER_PLAYER_ID)));
    act(() => sendWsMessage(makeBotTakeover(OTHER_PLAYER_ID)));

    await waitFor(() => {
      const banner = screen.queryByTestId('bot-takeover-banner');
      expect(banner).not.toBeNull();
    });
  });

  it('6. Banner disappears when ask_result arrives (move is complete)', async () => {
    render(<GamePage params={makeParams('ABC123')} />);
    await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

    act(() => openWs());
    act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID)));
    act(() => sendWsMessage(makeBotTakeover(MY_PLAYER_ID)));

    // Banner should appear
    await waitFor(() => {
      expect(screen.getByTestId('bot-takeover-banner')).toBeTruthy();
    });

    // Simulate the bot completing the ask
    act(() => sendWsMessage(makeAskResult(OTHER_PLAYER_ID)));
    act(() => sendWsMessage(makeGameState(OTHER_PLAYER_ID)));

    // Banner should be cleared after the move result
    await waitFor(() => {
      expect(screen.queryByTestId('bot-takeover-banner')).toBeNull();
    });
  });

  it('7. Banner disappears when declaration_result arrives (move is complete)', async () => {
    render(<GamePage params={makeParams('ABC123')} />);
    await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

    act(() => openWs());
    act(() => sendWsMessage(makeGameInit(MY_PLAYER_ID)));
    act(() => sendWsMessage(makeBotTakeover(MY_PLAYER_ID)));

    // Banner should appear
    await waitFor(() => {
      expect(screen.getByTestId('bot-takeover-banner')).toBeTruthy();
    });

    // Simulate the bot completing a declaration
    act(() => sendWsMessage(makeDeclarationResult()));
    act(() => sendWsMessage(makeGameState(OTHER_PLAYER_ID)));

    // Banner should be cleared after the declaration result
    await waitFor(() => {
      expect(screen.queryByTestId('bot-takeover-banner')).toBeNull();
    });
  });

  it('8. Banner role is "status" with aria-live="polite" for accessibility', async () => {
    render(<GamePage params={makeParams('ABC123')} />);
    await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());

    act(() => openWs());
    act(() => sendWsMessage(makeGameInit(OTHER_PLAYER_ID)));
    act(() => sendWsMessage(makeBotTakeover(OTHER_PLAYER_ID)));

    await waitFor(() => {
      const banner = screen.getByTestId('bot-takeover-banner');
      expect(banner.getAttribute('role')).toBe('status');
      expect(banner.getAttribute('aria-live')).toBe('polite');
    });
  });
});
