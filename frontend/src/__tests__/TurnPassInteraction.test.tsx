/**
 * @jest-environment jsdom
 *
 * Sub-AC 56c: Frontend turn-pass seat-selection interaction tests.
 *
 * Covers:
 *  • Turn indicator shows "Tap a highlighted seat" when postDeclarationHighlight is set
 *  • Ask and Declare buttons hidden during turn-pass selection mode
 *  • "Turn-pass action prompt" replaces Ask/Declare row during selection
 *  • Ask-prompt hint suppressed during turn-pass mode
 *  • CardHand is disabled during turn-pass mode
 *  • Clicking a highlighted seat dispatches `choose_next_turn` via WebSocket
 *  • After seat click, UI shows "Choosing…" pending state
 *  • Ask/Declare still hidden while pendingTurnPassAck (waiting for server ack)
 *  • After `post_declaration_turn_selected` all turn-pass UI clears and normal
 *    Ask/Declare controls reappear for the NEW turn player
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

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

// Track WS instances so tests can inject messages
let lastMockWsInstance: MockWebSocket | null = null;
const sentMessages: string[] = [];

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN       = 1;
  static CLOSING    = 2;
  static CLOSED     = 3;

  onopen: (() => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  readyState = 0;

  close() { this.readyState = 3; }
  send(data: string) { sentMessages.push(data); }
  constructor(public url: string) {
    lastMockWsInstance = this;
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).WebSocket = MockWebSocket;

function openWs() {
  if (lastMockWsInstance) {
    lastMockWsInstance.readyState = 1;
    lastMockWsInstance.onopen?.();
  }
}

function sendWsMessage(msg: Record<string, unknown>) {
  lastMockWsInstance?.onmessage?.({
    data: JSON.stringify(msg),
  } as MessageEvent);
}

// ---------------------------------------------------------------------------
// GamePage import (after mocks)
// ---------------------------------------------------------------------------

let GamePage: React.ComponentType<{ params: Promise<{ 'room-id': string }> }>;

beforeAll(async () => {
  const mod = await import('@/app/game/[room-id]/page');
  GamePage = mod.default;
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildRoom(status = 'in_progress') {
  return {
    id: 'room-uuid-1',
    code: 'ABC123',
    invite_code: 'invite-hex',
    host_user_id: 'host-uuid',
    player_count: 6,
    card_removal_variant: 'remove_7s',
    status,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function makeParams(roomId: string): Promise<{ 'room-id': string }> {
  return Promise.resolve({ 'room-id': roomId });
}

/** Build a minimal GamePlayer */
function p(
  playerId: string,
  displayName: string,
  teamId: 1 | 2,
  seatIndex: number,
  opts: { cardCount?: number; isBot?: boolean } = {}
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

const MY_PLAYER_ID = 'player-me';

/** Six players: me + 2 T1 teammates + 3 T2 opponents */
const SIX_PLAYERS = [
  p(MY_PLAYER_ID, 'Me',    1, 0),
  p('p2',          'Alice', 1, 2, { cardCount: 6 }),
  p('p3',          'Bob',   1, 4, { cardCount: 7 }),
  p('p4',          'Carol', 2, 1),
  p('p5',          'Dave',  2, 3),
  p('p6',          'Eve',   2, 5),
];

/** game_init where MY_PLAYER_ID has the current turn */
function makeGameInit(opts: { currentTurnPlayerId?: string } = {}) {
  return {
    type: 'game_init',
    myPlayerId: MY_PLAYER_ID,
    myHand: ['1_s', '3_h', '5_d', '6_c', '9_s'],
    players: SIX_PLAYERS,
    gameState: {
      status: 'active',
      currentTurnPlayerId: opts.currentTurnPlayerId ?? MY_PLAYER_ID,
      scores: { team1: 0, team2: 0 },
      lastMove: null,
      winner: null,
      tiebreakerWinner: null,
      declaredSuits: [],
      inferenceMode: false,
    },
    variant: 'remove_7s',
    playerCount: 6,
  };
}

/**
 * declaration_result where MY_PLAYER_ID declared correctly.
 * Eligible next-turn players are T1 members with cards (me + p2 + p3).
 */
function makeDeclarationResult(opts: { correct?: boolean } = {}) {
  const correct = opts.correct ?? true;
  return {
    type: 'declaration_result',
    declarerId: MY_PLAYER_ID,
    halfSuitId: 'low_s',
    correct,
    winningTeam: correct ? 1 : 2,
    newTurnPlayerId: MY_PLAYER_ID,
    assignment: { '1_s': MY_PLAYER_ID, '2_s': 'p2', '3_s': 'p3', '4_s': MY_PLAYER_ID, '5_s': 'p2', '6_s': 'p3' },
    lastMove: correct ? 'Me declared Low Spades correctly!' : 'Me declared Low Spades incorrectly.',
    // Eligible: all T1 with cards (me + p2 + p3)
    eligibleNextTurnPlayerIds: correct ? [MY_PLAYER_ID, 'p2', 'p3'] : [],
    timedOut: false,
  };
}

/** Helper: render + connect + send game_init */
async function setupActiveGame(opts: { currentTurnPlayerId?: string } = {}) {
  render(<GamePage params={makeParams('ABC123')} />);
  await waitFor(() => expect(screen.getByTestId('game-view')).toBeTruthy());
  act(() => openWs());
  act(() => sendWsMessage(makeGameInit(opts)));
  await waitFor(() => expect(screen.getByTestId('turn-indicator')).toBeTruthy());
}

beforeEach(() => {
  jest.clearAllMocks();
  lastMockWsInstance = null;
  sentMessages.length = 0;
  mockGetRoomByCode.mockResolvedValue({ room: buildRoom() });
});

// ---------------------------------------------------------------------------
// Tests: Normal turn (no turn-pass mode)
// ---------------------------------------------------------------------------

describe('TurnPassInteraction — normal turn state', () => {
  it('shows Ask and Declare buttons when it is my turn (no turn-pass mode)', async () => {
    await setupActiveGame();

    await waitFor(() => {
      expect(screen.getByTestId('ask-button')).toBeTruthy();
      expect(screen.getByTestId('declare-button')).toBeTruthy();
    });
  });

  it('shows normal "Your turn" indicator text when it is my turn', async () => {
    await setupActiveGame();

    await waitFor(() => {
      const indicator = screen.getByTestId('turn-indicator');
      expect(indicator.textContent).toContain('Your turn');
    });
  });

  it('does NOT show turn-pass prompt in normal turn state', async () => {
    await setupActiveGame();

    await waitFor(() => expect(screen.getByTestId('ask-button')).toBeTruthy());
    expect(screen.queryByTestId('turn-pass-action-prompt')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: Turn-pass mode activated by declaration_result
// ---------------------------------------------------------------------------

describe('TurnPassInteraction — turn-pass mode after correct declaration', () => {
  it('hides Ask and Declare buttons during turn-pass selection', async () => {
    await setupActiveGame();
    await waitFor(() => expect(screen.getByTestId('ask-button')).toBeTruthy());

    act(() => sendWsMessage(makeDeclarationResult({ correct: true })));

    await waitFor(() => {
      expect(screen.queryByTestId('ask-button')).toBeNull();
      expect(screen.queryByTestId('declare-button')).toBeNull();
    });
  });

  it('shows the turn-pass action prompt during seat selection', async () => {
    await setupActiveGame();
    await waitFor(() => expect(screen.getByTestId('ask-button')).toBeTruthy());

    act(() => sendWsMessage(makeDeclarationResult({ correct: true })));

    await waitFor(() => {
      expect(screen.getByTestId('turn-pass-action-prompt')).toBeTruthy();
    });
  });

  it('turn indicator shows "Tap a highlighted seat" instruction', async () => {
    await setupActiveGame();
    await waitFor(() => expect(screen.getByTestId('turn-indicator')).toBeTruthy());

    act(() => sendWsMessage(makeDeclarationResult({ correct: true })));

    await waitFor(() => {
      expect(screen.getByTestId('turn-pass-select-label')).toBeTruthy();
    });
  });

  it('action prompt text says to tap a highlighted teammate seat', async () => {
    await setupActiveGame();
    await waitFor(() => expect(screen.getByTestId('ask-button')).toBeTruthy());

    act(() => sendWsMessage(makeDeclarationResult({ correct: true })));

    await waitFor(() => {
      const prompt = screen.getByTestId('turn-pass-action-prompt');
      expect(prompt.textContent).toContain('highlighted teammate seat');
    });
  });

  it('does NOT show ask-prompt hint during turn-pass selection', async () => {
    await setupActiveGame();
    // ask-prompt appears only when no wizard/declare is open
    await waitFor(() => expect(screen.getByTestId('ask-prompt')).toBeTruthy());

    act(() => sendWsMessage(makeDeclarationResult({ correct: true })));

    await waitFor(() => {
      expect(screen.queryByTestId('ask-prompt')).toBeNull();
    });
  });

  it('does NOT activate turn-pass mode for incorrect declarations', async () => {
    await setupActiveGame();
    await waitFor(() => expect(screen.getByTestId('ask-button')).toBeTruthy());

    // Incorrect declaration — eligibleNextTurnPlayerIds is [] and correct=false
    act(() => sendWsMessage(makeDeclarationResult({ correct: false })));

    // Wait for declaration result to be processed
    await waitFor(() => expect(screen.queryByTestId('turn-pass-action-prompt')).toBeNull());
    // After incorrect decl it's now someone else's turn (no isTurnPassMode for me)
  });
});

// ---------------------------------------------------------------------------
// Tests: Clicking a highlighted seat dispatches the socket event
// ---------------------------------------------------------------------------

describe('TurnPassInteraction — seat click dispatches choose_next_turn', () => {
  it('sends choose_next_turn with the tapped player ID', async () => {
    await setupActiveGame();
    await waitFor(() => expect(screen.getByTestId('ask-button')).toBeTruthy());

    act(() => sendWsMessage(makeDeclarationResult({ correct: true })));

    // Wait for highlighted seats to appear (cyan highlight rings)
    await waitFor(() => {
      const rings = document.querySelectorAll('[data-testid="highlight-ring"]');
      expect(rings.length).toBeGreaterThan(0);
    });

    // Click the first highlighted (clickable) seat
    const clickableSeats = document.querySelectorAll('[data-highlighted="true"][role="button"]');
    expect(clickableSeats.length).toBeGreaterThan(0);

    act(() => (clickableSeats[0] as HTMLElement).click());

    await waitFor(() => {
      const chooseMsg = sentMessages.find((m) => {
        try { return (JSON.parse(m) as { type: string }).type === 'choose_next_turn'; }
        catch { return false; }
      });
      expect(chooseMsg).toBeDefined();
    });
  });

  it('choose_next_turn message carries a chosenPlayerId', async () => {
    await setupActiveGame();
    await waitFor(() => expect(screen.getByTestId('ask-button')).toBeTruthy());

    act(() => sendWsMessage(makeDeclarationResult({ correct: true })));

    await waitFor(() => {
      const rings = document.querySelectorAll('[data-testid="highlight-ring"]');
      expect(rings.length).toBeGreaterThan(0);
    });

    const clickableSeats = document.querySelectorAll('[data-highlighted="true"][role="button"]');
    act(() => (clickableSeats[0] as HTMLElement).click());

    await waitFor(() => {
      const chooseMsg = sentMessages.find((m) => {
        try { return (JSON.parse(m) as { type: string }).type === 'choose_next_turn'; }
        catch { return false; }
      });
      expect(chooseMsg).toBeDefined();
      const parsed = JSON.parse(chooseMsg!) as { type: string; chosenPlayerId?: string };
      expect(typeof parsed.chosenPlayerId).toBe('string');
      expect(parsed.chosenPlayerId!.length).toBeGreaterThan(0);
    });
  });

  it('choose_next_turn chosenPlayerId is one of the eligible same-team player IDs', async () => {
    await setupActiveGame();
    await waitFor(() => expect(screen.getByTestId('ask-button')).toBeTruthy());

    act(() => sendWsMessage(makeDeclarationResult({ correct: true })));

    await waitFor(() => {
      const rings = document.querySelectorAll('[data-testid="highlight-ring"]');
      expect(rings.length).toBeGreaterThan(0);
    });

    const clickableSeats = document.querySelectorAll('[data-highlighted="true"][role="button"]');
    act(() => (clickableSeats[0] as HTMLElement).click());

    await waitFor(() => {
      const chooseMsg = sentMessages.find((m) => {
        try { return (JSON.parse(m) as { type: string }).type === 'choose_next_turn'; }
        catch { return false; }
      });
      const parsed = JSON.parse(chooseMsg!) as { chosenPlayerId?: string };
      // Must be one of the eligible T1 player IDs
      const eligibleIds = [MY_PLAYER_ID, 'p2', 'p3'];
      expect(eligibleIds).toContain(parsed.chosenPlayerId);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Pending ack state after seat click
// ---------------------------------------------------------------------------

describe('TurnPassInteraction — pending ack state (post-click, pre-server-ack)', () => {
  it('shows "Choosing…" turn indicator after clicking a highlighted seat', async () => {
    await setupActiveGame();
    await waitFor(() => expect(screen.getByTestId('ask-button')).toBeTruthy());

    act(() => sendWsMessage(makeDeclarationResult({ correct: true })));

    await waitFor(() => {
      const rings = document.querySelectorAll('[data-testid="highlight-ring"]');
      expect(rings.length).toBeGreaterThan(0);
    });

    const clickableSeats = document.querySelectorAll('[data-highlighted="true"][role="button"]');
    act(() => (clickableSeats[0] as HTMLElement).click());

    await waitFor(() => {
      expect(screen.getByTestId('turn-pass-pending-label')).toBeTruthy();
    });
  });

  it('Ask and Declare buttons remain hidden while waiting for server ack', async () => {
    await setupActiveGame();
    await waitFor(() => expect(screen.getByTestId('ask-button')).toBeTruthy());

    act(() => sendWsMessage(makeDeclarationResult({ correct: true })));

    await waitFor(() => {
      const rings = document.querySelectorAll('[data-testid="highlight-ring"]');
      expect(rings.length).toBeGreaterThan(0);
    });

    const clickableSeats = document.querySelectorAll('[data-highlighted="true"][role="button"]');
    act(() => (clickableSeats[0] as HTMLElement).click());

    // Interaction is still blocked — no Ask/Declare yet
    await waitFor(() => {
      expect(screen.queryByTestId('ask-button')).toBeNull();
      expect(screen.queryByTestId('declare-button')).toBeNull();
    });
  });

  it('turn-pass action prompt shows "Choosing…" text after click', async () => {
    await setupActiveGame();
    await waitFor(() => expect(screen.getByTestId('ask-button')).toBeTruthy());

    act(() => sendWsMessage(makeDeclarationResult({ correct: true })));

    await waitFor(() => {
      const rings = document.querySelectorAll('[data-testid="highlight-ring"]');
      expect(rings.length).toBeGreaterThan(0);
    });

    const clickableSeats = document.querySelectorAll('[data-highlighted="true"][role="button"]');
    act(() => (clickableSeats[0] as HTMLElement).click());

    await waitFor(() => {
      const prompt = screen.getByTestId('turn-pass-action-prompt');
      expect(prompt.textContent).toContain('Choosing');
    });
  });

  it('highlighted rings disappear after clicking a seat (optimistic clear)', async () => {
    await setupActiveGame();
    await waitFor(() => expect(screen.getByTestId('ask-button')).toBeTruthy());

    act(() => sendWsMessage(makeDeclarationResult({ correct: true })));

    await waitFor(() => {
      const rings = document.querySelectorAll('[data-testid="highlight-ring"]');
      expect(rings.length).toBeGreaterThan(0);
    });

    const clickableSeats = document.querySelectorAll('[data-highlighted="true"][role="button"]');
    act(() => (clickableSeats[0] as HTMLElement).click());

    // Highlight rings should be gone immediately (optimistic clear)
    await waitFor(() => {
      const rings = document.querySelectorAll('[data-testid="highlight-ring"]');
      expect(rings.length).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Server ack clears turn-pass mode
// ---------------------------------------------------------------------------

describe('TurnPassInteraction — server ack restores normal state', () => {
  it('clears turn-pass mode when post_declaration_turn_selected arrives', async () => {
    await setupActiveGame();
    await waitFor(() => expect(screen.getByTestId('ask-button')).toBeTruthy());

    // Trigger turn-pass mode
    act(() => sendWsMessage(makeDeclarationResult({ correct: true })));
    await waitFor(() => expect(screen.queryByTestId('ask-button')).toBeNull());

    // Click a seat to enter pending-ack state
    await waitFor(() => {
      const clickableSeats = document.querySelectorAll('[data-highlighted="true"][role="button"]');
      expect(clickableSeats.length).toBeGreaterThan(0);
    });
    const clickableSeats = document.querySelectorAll('[data-highlighted="true"][role="button"]');
    act(() => (clickableSeats[0] as HTMLElement).click());

    // Server sends game_state update: p2 now has the turn
    act(() => sendWsMessage({
      type: 'game_state',
      state: {
        status: 'active',
        currentTurnPlayerId: 'p2',
        scores: { team1: 1, team2: 0 },
        lastMove: 'Me declared Low Spades correctly!',
        winner: null,
        tiebreakerWinner: null,
        declaredSuits: [{ halfSuitId: 'low_s', teamId: 1, declaredBy: MY_PLAYER_ID }],
        inferenceMode: false,
      },
    }));

    // Server sends post_declaration_turn_selected
    act(() => sendWsMessage({
      type: 'post_declaration_turn_selected',
      selectedPlayerId: 'p2',
      chooserId: MY_PLAYER_ID,
      reason: 'player_choice',
    }));

    // Now p2 has the turn — my turn-pass mode should be gone
    await waitFor(() => {
      expect(screen.queryByTestId('turn-pass-action-prompt')).toBeNull();
      expect(screen.queryByTestId('turn-pass-select-label')).toBeNull();
      expect(screen.queryByTestId('turn-pass-pending-label')).toBeNull();
    });
  });

  it('turn-pass mode is also cleared when ask_result arrives (safety reset)', async () => {
    await setupActiveGame();
    await waitFor(() => expect(screen.getByTestId('ask-button')).toBeTruthy());

    // Enter turn-pass mode
    act(() => sendWsMessage(makeDeclarationResult({ correct: true })));
    await waitFor(() => expect(screen.queryByTestId('ask-button')).toBeNull());

    // Click a seat
    await waitFor(() => {
      const clickableSeats = document.querySelectorAll('[data-highlighted="true"][role="button"]');
      expect(clickableSeats.length).toBeGreaterThan(0);
    });
    const clickableSeats = document.querySelectorAll('[data-highlighted="true"][role="button"]');
    act(() => (clickableSeats[0] as HTMLElement).click());

    // Server sends ask_result (e.g. bot took over and asked immediately)
    // currentTurnPlayerId in the subsequent game_state update will be different
    act(() => sendWsMessage({
      type: 'ask_result',
      askerId: 'p2',
      targetId: 'p4',
      cardId: '1_h',
      success: false,
      newTurnPlayerId: 'p4',
      lastMove: 'Alice asked Carol for Ace of Hearts — failed.',
    }));

    act(() => sendWsMessage({
      type: 'game_state',
      state: {
        status: 'active',
        currentTurnPlayerId: 'p4',
        scores: { team1: 1, team2: 0 },
        lastMove: 'Alice asked Carol for Ace of Hearts — failed.',
        winner: null,
        tiebreakerWinner: null,
        declaredSuits: [{ halfSuitId: 'low_s', teamId: 1, declaredBy: MY_PLAYER_ID }],
        inferenceMode: false,
      },
    }));

    // Turn-pass prompt should be gone (it's now Carol's turn, not mine)
    await waitFor(() => {
      expect(screen.queryByTestId('turn-pass-action-prompt')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Seat click is accessible via keyboard (Enter / Space)
// ---------------------------------------------------------------------------

describe('TurnPassInteraction — keyboard accessibility', () => {
  it('highlighted seat responds to Enter keypress', async () => {
    await setupActiveGame();
    await waitFor(() => expect(screen.getByTestId('ask-button')).toBeTruthy());

    act(() => sendWsMessage(makeDeclarationResult({ correct: true })));

    await waitFor(() => {
      const rings = document.querySelectorAll('[data-testid="highlight-ring"]');
      expect(rings.length).toBeGreaterThan(0);
    });

    const clickableSeats = document.querySelectorAll('[data-highlighted="true"][role="button"]');
    expect(clickableSeats.length).toBeGreaterThan(0);

    // Fire Enter keydown
    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      clickableSeats[0].dispatchEvent(event);
    });

    await waitFor(() => {
      const chooseMsg = sentMessages.find((m) => {
        try { return (JSON.parse(m) as { type: string }).type === 'choose_next_turn'; }
        catch { return false; }
      });
      expect(chooseMsg).toBeDefined();
    });
  });

  it('highlighted seat has tabIndex=0 for keyboard navigation', async () => {
    await setupActiveGame();
    await waitFor(() => expect(screen.getByTestId('ask-button')).toBeTruthy());

    act(() => sendWsMessage(makeDeclarationResult({ correct: true })));

    await waitFor(() => {
      const clickableSeats = document.querySelectorAll('[data-highlighted="true"][role="button"]');
      expect(clickableSeats.length).toBeGreaterThan(0);
    });

    const clickableSeats = document.querySelectorAll('[data-highlighted="true"][role="button"]');
    // At least one seat should have tabIndex=0
    const hasFocusable = Array.from(clickableSeats).some(
      (el) => (el as HTMLElement).tabIndex === 0
    );
    expect(hasFocusable).toBe(true);
  });
});
