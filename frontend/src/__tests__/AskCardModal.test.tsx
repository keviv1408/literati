/**
 * @jest-environment jsdom
 *
 * Tests for AskCardModal.
 *
 * Coverage:
 *   • Renders the selected card info and "Ask for a card" heading
 *   • Shows valid opponent targets from the other team with ≥1 card
 *   • Excludes teammates and players with 0 cards
 *   • Bot opponents appear as valid targets (bots are fully askable)
 *   • Auto-selects the single opponent when only one target is available
 *   • Does NOT auto-select when multiple targets are available
 *   • Confirm button is disabled when no target is selected
 *   • Confirm button is enabled once a target is selected
 *   • Clicking Confirm fires onConfirm with (targetPlayerId, selectedCard)
 *   • Clicking Cancel fires onCancel
 *   • Shows "No opponents" message when all opponents have 0 cards
 *   • Shows 3 opponent targets for a 6-player game (3 per team)
 *   • Shows 4 opponent targets for an 8-player game (4 per team)
 *   • Confirm button is disabled while isLoading is true
 *   • Cancel button is disabled while isLoading is true
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import AskCardModal from '@/components/AskCardModal';
import type { GamePlayer } from '@/types/game';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPlayer(overrides: Partial<GamePlayer> = {}): GamePlayer {
  return {
    playerId: 'p1',
    displayName: 'Player 1',
    avatarId: null,
    teamId: 1,
    seatIndex: 0,
    cardCount: 5,
    isBot: false,
    isGuest: true,
    isCurrentTurn: false,
    ...overrides,
  };
}

/** Build a standard 6-player roster: team 1 = p1–p3, team 2 = p4–p6 */
function build6Players(myPlayerId = 'p1'): GamePlayer[] {
  return [
    buildPlayer({ playerId: myPlayerId, displayName: 'Me',       teamId: 1, seatIndex: 0 }),
    buildPlayer({ playerId: 'p2',       displayName: 'Alice',    teamId: 1, seatIndex: 2 }),
    buildPlayer({ playerId: 'p3',       displayName: 'Bob',      teamId: 1, seatIndex: 4 }),
    buildPlayer({ playerId: 'p4',       displayName: 'Carol',    teamId: 2, seatIndex: 1 }),
    buildPlayer({ playerId: 'p5',       displayName: 'Dave',     teamId: 2, seatIndex: 3 }),
    buildPlayer({ playerId: 'p6',       displayName: 'Eve',      teamId: 2, seatIndex: 5 }),
  ];
}

/** Build a standard 8-player roster: team 1 = p1–p4, team 2 = p5–p8 */
function build8Players(myPlayerId = 'p1'): GamePlayer[] {
  return [
    buildPlayer({ playerId: myPlayerId, displayName: 'Me',    teamId: 1, seatIndex: 0 }),
    buildPlayer({ playerId: 'p2',       displayName: 'T1B',   teamId: 1, seatIndex: 2 }),
    buildPlayer({ playerId: 'p3',       displayName: 'T1C',   teamId: 1, seatIndex: 4 }),
    buildPlayer({ playerId: 'p4',       displayName: 'T1D',   teamId: 1, seatIndex: 6 }),
    buildPlayer({ playerId: 'p5',       displayName: 'T2A',   teamId: 2, seatIndex: 1 }),
    buildPlayer({ playerId: 'p6',       displayName: 'T2B',   teamId: 2, seatIndex: 3 }),
    buildPlayer({ playerId: 'p7',       displayName: 'T2C',   teamId: 2, seatIndex: 5 }),
    buildPlayer({ playerId: 'p8',       displayName: 'T2D',   teamId: 2, seatIndex: 7 }),
  ];
}

/** Render AskCardModal with sensible defaults. */
function renderModal(
  overrides: Partial<{
    selectedCard: string;
    myPlayerId: string;
    players: GamePlayer[];
    variant: 'remove_2s' | 'remove_7s' | 'remove_8s';
    onConfirm: jest.Mock;
    onCancel: jest.Mock;
    isLoading: boolean;
  }> = {}
) {
  const props = {
    selectedCard: '3_h',
    myPlayerId: 'p1',
    players: build6Players(),
    variant: 'remove_7s' as const,
    onConfirm: jest.fn(),
    onCancel: jest.fn(),
    isLoading: false,
    ...overrides,
  };
  return { ...render(<AskCardModal {...props} />), props };
}

// ---------------------------------------------------------------------------
// Basic rendering
// ---------------------------------------------------------------------------

describe('AskCardModal — basic rendering', () => {
  it('renders the dialog with "Ask for a card" heading', () => {
    renderModal();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Ask for a card')).toBeTruthy();
  });

  it('shows the selected card description in the subtitle', () => {
    renderModal({ selectedCard: '3_h' });
    // card label "3♥" should appear in the subtitle
    expect(screen.getByText(/3♥/)).toBeTruthy();
  });

  it('renders a card preview for the selected card', () => {
    renderModal({ selectedCard: '5_s' });
    // PlayingCard renders aria-label like "5 of Spades"
    expect(screen.getByLabelText(/5 of Spades/i)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Opponent filtering — 6-player game
// ---------------------------------------------------------------------------

describe('AskCardModal — opponent filtering (6-player, all human)', () => {
  it('shows the 3 opponents (team 2 players) as valid targets', () => {
    renderModal({ players: build6Players(), myPlayerId: 'p1' });
    expect(screen.getByRole('button', { name: /Carol/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Dave/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Eve/i })).toBeTruthy();
  });

  it('does NOT show teammates as targets', () => {
    renderModal({ players: build6Players(), myPlayerId: 'p1' });
    expect(screen.queryByRole('button', { name: /^Alice$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Bob$/i })).toBeNull();
  });

  it('excludes opponents with 0 cards', () => {
    const players = build6Players();
    // Give Carol (p4) zero cards
    players[3] = { ...players[3], cardCount: 0 };
    renderModal({ players, myPlayerId: 'p1' });
    expect(screen.queryByRole('button', { name: /Carol/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Dave/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Eve/i })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Opponent filtering — 8-player game
// ---------------------------------------------------------------------------

describe('AskCardModal — opponent filtering (8-player)', () => {
  it('shows all 4 opponents as targets in an 8-player game', () => {
    renderModal({ players: build8Players(), myPlayerId: 'p1' });
    expect(screen.getByRole('button', { name: /T2A/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /T2B/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /T2C/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /T2D/i })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Bot opponents
// ---------------------------------------------------------------------------

describe('AskCardModal — bot opponents', () => {
  it('shows bot opponents as valid ask targets', () => {
    const players = build6Players();
    // Replace Carol (p4) with a bot
    players[3] = { ...players[3], displayName: 'curious_maxwell', isBot: true };
    renderModal({ players, myPlayerId: 'p1' });
    // Bot should still show as a valid target
    expect(screen.getByRole('button', { name: /curious_maxwell/i })).toBeTruthy();
  });

  it('shows a mix of bot and human opponents as targets', () => {
    const players = build6Players();
    players[3] = { ...players[3], displayName: 'bot_alpha', isBot: true };
    players[4] = { ...players[4], displayName: 'human_player', isBot: false };
    renderModal({ players, myPlayerId: 'p1' });
    expect(screen.getByRole('button', { name: /bot_alpha/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /human_player/i })).toBeTruthy();
  });

  it('shows all-bot opponent team as valid targets', () => {
    const players: GamePlayer[] = [
      buildPlayer({ playerId: 'p1', displayName: 'Me', teamId: 1, seatIndex: 0 }),
      buildPlayer({ playerId: 'p2', displayName: 'T1B', teamId: 1, seatIndex: 2 }),
      buildPlayer({ playerId: 'p3', displayName: 'T1C', teamId: 1, seatIndex: 4 }),
      buildPlayer({ playerId: 'bot1', displayName: 'silly_penguin',    teamId: 2, seatIndex: 1, isBot: true }),
      buildPlayer({ playerId: 'bot2', displayName: 'clever_dolphin',   teamId: 2, seatIndex: 3, isBot: true }),
      buildPlayer({ playerId: 'bot3', displayName: 'curious_maxwell',  teamId: 2, seatIndex: 5, isBot: true }),
    ];
    renderModal({ players, myPlayerId: 'p1' });
    expect(screen.getByRole('button', { name: /silly_penguin/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /clever_dolphin/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /curious_maxwell/i })).toBeTruthy();
  });

  it('displays the robot emoji for bot opponents', () => {
    const players = build6Players();
    players[3] = { ...players[3], displayName: 'bot_alpha', isBot: true };
    renderModal({ players, myPlayerId: 'p1' });
    // BotBadge shows 🤖 inside the target button
    const botButton = screen.getByRole('button', { name: /bot_alpha/i });
    expect(botButton.textContent).toContain('🤖');
  });
});

// ---------------------------------------------------------------------------
// Auto-selection behaviour
// ---------------------------------------------------------------------------

describe('AskCardModal — auto-selection', () => {
  it('auto-selects the single opponent when exactly one valid target exists', () => {
    const players = build6Players();
    // Give p5 (Dave) and p6 (Eve) 0 cards so only Carol (p4) is valid
    players[4] = { ...players[4], cardCount: 0 };
    players[5] = { ...players[5], cardCount: 0 };
    renderModal({ players, myPlayerId: 'p1' });
    // Confirm button (text = "Ask") should be enabled because one target was
    // auto-selected.  We use getByText since the button's aria-label includes
    // the full "Ask <name> for <card>" pattern which doesn't match /^Ask$/.
    const confirmBtn = screen.getByText('Ask');
    expect(confirmBtn.closest('button')).not.toBeDisabled();
  });

  it('does NOT auto-select when multiple valid targets exist', () => {
    renderModal({ players: build6Players(), myPlayerId: 'p1' });
    // Confirm button should be disabled (no target chosen yet)
    const confirmBtn = screen.getByText('Ask');
    expect(confirmBtn.closest('button')).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Confirm / Cancel interaction
// ---------------------------------------------------------------------------

describe('AskCardModal — confirm/cancel interaction', () => {
  // Helper: find the confirm button by text content (not aria-label, since the
  // button's aria-label is "Ask <name> for <card>" which doesn't match /^Ask$/).
  function getConfirmBtn() { return screen.getByText('Ask').closest('button')!; }

  it('Confirm is disabled when no target is selected', () => {
    renderModal({ players: build6Players() });
    expect(getConfirmBtn()).toBeDisabled();
  });

  it('Confirm is enabled after selecting a target', () => {
    renderModal({ players: build6Players(), myPlayerId: 'p1' });
    fireEvent.click(screen.getByRole('button', { name: /Carol/i }));
    expect(getConfirmBtn()).not.toBeDisabled();
  });

  it('fires onConfirm with targetPlayerId and selectedCard when confirmed', () => {
    const onConfirm = jest.fn();
    renderModal({ players: build6Players(), myPlayerId: 'p1', selectedCard: '5_d', onConfirm });
    fireEvent.click(screen.getByRole('button', { name: /Carol/i }));
    fireEvent.click(getConfirmBtn());
    expect(onConfirm).toHaveBeenCalledWith('p4', '5_d');
  });

  it('fires onCancel when Cancel is clicked', () => {
    const onCancel = jest.fn();
    renderModal({ onCancel });
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('selecting a different target changes the selection', () => {
    renderModal({ players: build6Players(), myPlayerId: 'p1' });
    // Click Carol first
    fireEvent.click(screen.getByRole('button', { name: /Carol/i }));
    expect(getConfirmBtn()).not.toBeDisabled();
    // Click Dave — now Dave is selected, confirm stays enabled
    fireEvent.click(screen.getByRole('button', { name: /Dave/i }));
    expect(getConfirmBtn()).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// No opponents state
// ---------------------------------------------------------------------------

describe('AskCardModal — no opponents available', () => {
  it('shows "No opponents" message when all opponents have 0 cards', () => {
    const players = build6Players();
    // Zero out all team-2 card counts
    players[3] = { ...players[3], cardCount: 0 };
    players[4] = { ...players[4], cardCount: 0 };
    players[5] = { ...players[5], cardCount: 0 };
    renderModal({ players, myPlayerId: 'p1' });
    expect(screen.getByText(/No opponents with cards available/i)).toBeTruthy();
  });

  it('Confirm is disabled when no opponents are available', () => {
    const players = build6Players();
    players[3] = { ...players[3], cardCount: 0 };
    players[4] = { ...players[4], cardCount: 0 };
    players[5] = { ...players[5], cardCount: 0 };
    renderModal({ players, myPlayerId: 'p1' });
    const confirmBtn = screen.getByText('Ask').closest('button')!;
    expect(confirmBtn).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

describe('AskCardModal — loading state', () => {
  it('disables the Confirm button while isLoading is true', () => {
    const players = build6Players();
    renderModal({ players, myPlayerId: 'p1', isLoading: true });
    // When loading the button text changes to "Asking…"; find by text content.
    const confirmBtn = screen.getByText('Asking…').closest('button')!;
    expect(confirmBtn).toBeDisabled();
  });

  it('disables the Cancel button while isLoading is true', () => {
    renderModal({ isLoading: true });
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();
  });

  it('shows "Asking…" label on Confirm when loading', () => {
    renderModal({ isLoading: true });
    expect(screen.getByText('Asking…')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Card variants
// ---------------------------------------------------------------------------

describe('AskCardModal — card variants', () => {
  it('works with remove_2s variant', () => {
    renderModal({ variant: 'remove_2s', selectedCard: '3_s' });
    expect(screen.getByText('Ask for a card')).toBeTruthy();
  });

  it('works with remove_8s variant', () => {
    renderModal({ variant: 'remove_8s', selectedCard: '6_c' });
    expect(screen.getByText('Ask for a card')).toBeTruthy();
  });

  it('shows half-suit label in subtitle for remove_7s', () => {
    // 3_h is in Low Hearts for remove_7s
    renderModal({ variant: 'remove_7s', selectedCard: '3_h' });
    expect(screen.getByText(/Low Hearts/i)).toBeTruthy();
  });
});
