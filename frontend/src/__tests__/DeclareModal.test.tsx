/**
 * @jest-environment jsdom
 *
 * Tests for DeclareModal — Sub-AC 9.2: inference (ask/answer) mode always
 * available during a game session regardless of player count or bot presence.
 *
 * Also covers Sub-AC 22c: Seat-targeting interaction — selecting a card row
 * opens a teammate seat strip; tapping a seat chip completes the assignment
 * and clears the selection state.
 *
 * Coverage:
 *   • Renders the half-suit selection step on open
 *   • Shows all 8 undeclared half-suit options
 *   • Already-declared suits are excluded from the selection grid
 *   • Shows "you hold N/6" for each half-suit
 *   • Selecting a suit navigates to the card assignment step
 *   • Back button returns to the suit selection step
 *   • Pre-fills cards the player holds in their hand
 *   • Unknown cards show a teammate dropdown selector
 *   • Confirm is disabled until all 6 cards are assigned
 *   • Confirm is enabled once all cards are assigned
 *   • Fires onConfirm with halfSuitId and assignment when confirmed
 *   • Fires onCancel when Cancel is clicked
 *   • Works with a 6-player roster (bots in teammates)
 *   • Works with an 8-player roster
 *   • Confirm shows "Declaring…" and is disabled while isLoading
 *   [Sub-AC 22c — Seat-targeting]
 *   • Tapping a non-mine card row shows the seat-targeting strip
 *   • Seat strip shows all teammates as chips
 *   • Tapping a seat chip assigns the card and clears the strip
 *   • Assigned card chip reflects current assignee (aria-pressed)
 *   • Tapping same card row again deselects (dismisses strip)
 *   • Switching suit clears any pending selection (no stale strip)
 *   • Keyboard Enter on card row triggers seat-targeting selection
 *   • Dropdown change while card is selected clears the selection
 *   • "In your hand" card rows are NOT selectable for seat targeting
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import DeclareModal from '@/components/DeclareModal';
import type { GamePlayer, DeclaredSuit } from '@/types/game';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPlayer(overrides: Partial<GamePlayer> = {}): GamePlayer {
  return {
    playerId: 'p1',
    displayName: 'Me',
    avatarId: null,
    teamId: 1,
    seatIndex: 0,
    cardCount: 5,
    isBot: false,
    isGuest: true,
    isCurrentTurn: true,
    ...overrides,
  };
}

/** Build a 6-player roster; player 'p1' is on team 1 */
function build6Players(): GamePlayer[] {
  return [
    buildPlayer({ playerId: 'p1', displayName: 'Me',    teamId: 1, seatIndex: 0 }),
    buildPlayer({ playerId: 'p2', displayName: 'Alice', teamId: 1, seatIndex: 2 }),
    buildPlayer({ playerId: 'p3', displayName: 'Bob',   teamId: 1, seatIndex: 4 }),
    buildPlayer({ playerId: 'p4', displayName: 'Carol', teamId: 2, seatIndex: 1 }),
    buildPlayer({ playerId: 'p5', displayName: 'Dave',  teamId: 2, seatIndex: 3 }),
    buildPlayer({ playerId: 'p6', displayName: 'Eve',   teamId: 2, seatIndex: 5 }),
  ];
}

/** Build an 8-player roster; player 'p1' is on team 1 */
function build8Players(): GamePlayer[] {
  return [
    buildPlayer({ playerId: 'p1',  displayName: 'Me',   teamId: 1, seatIndex: 0 }),
    buildPlayer({ playerId: 'p2',  displayName: 'T1B',  teamId: 1, seatIndex: 2 }),
    buildPlayer({ playerId: 'p3',  displayName: 'T1C',  teamId: 1, seatIndex: 4 }),
    buildPlayer({ playerId: 'p4',  displayName: 'T1D',  teamId: 1, seatIndex: 6 }),
    buildPlayer({ playerId: 'p5',  displayName: 'T2A',  teamId: 2, seatIndex: 1 }),
    buildPlayer({ playerId: 'p6',  displayName: 'T2B',  teamId: 2, seatIndex: 3 }),
    buildPlayer({ playerId: 'p7',  displayName: 'T2C',  teamId: 2, seatIndex: 5 }),
    buildPlayer({ playerId: 'p8',  displayName: 'T2D',  teamId: 2, seatIndex: 7 }),
  ];
}

/** Render DeclareModal with sensible defaults. */
function renderModal(
  overrides: Partial<{
    myPlayerId: string;
    myHand: string[];
    players: GamePlayer[];
    variant: 'remove_2s' | 'remove_7s' | 'remove_8s';
    declaredSuits: DeclaredSuit[];
    onConfirm: jest.Mock;
    onCancel: jest.Mock;
    isLoading: boolean;
  }> = {}
) {
  const props = {
    myPlayerId: 'p1',
    // Hold one card in Low Spades so the suit button is enabled for card-assignment tests.
    // For remove_7s, Low Spades = 1_s 2_s 3_s 4_s 5_s 6_s.
    myHand: ['1_s'],
    players: build6Players(),
    variant: 'remove_7s' as const,
    declaredSuits: [],
    onConfirm: jest.fn(),
    onCancel: jest.fn(),
    isLoading: false,
    ...overrides,
  };
  return { ...render(<DeclareModal {...props} />), props };
}

// ---------------------------------------------------------------------------
// Suit selection step
// ---------------------------------------------------------------------------

describe('DeclareModal — suit selection step', () => {
  it('renders the "Declare a Half-Suit" heading', () => {
    renderModal();
    expect(screen.getByText('Declare a Half-Suit')).toBeTruthy();
  });

  it('shows the "Select a half-suit to declare" prompt', () => {
    renderModal();
    expect(screen.getByText(/Select a half-suit to declare/i)).toBeTruthy();
  });

  it('renders 8 half-suit buttons when nothing has been declared', () => {
    renderModal({ declaredSuits: [] });
    // 8 half-suits: low/high × spades/hearts/diamonds/clubs
    const suitButtons = screen.getAllByRole('button', { name: /Declare (Low|High)/i });
    expect(suitButtons).toHaveLength(8);
  });

  it('excludes already-declared suits from the selection grid', () => {
    const declared: DeclaredSuit[] = [
      { halfSuitId: 'low_s', teamId: 1, declaredBy: 'p1' },
    ];
    renderModal({ declaredSuits: declared });
    const suitButtons = screen.getAllByRole('button', { name: /Declare (Low|High)/i });
    expect(suitButtons).toHaveLength(7);
    // Low Spades button should be gone
    expect(screen.queryByRole('button', { name: /Low Spades/i })).toBeNull();
  });

  it('shows "you hold N/6" count for each undeclared suit', () => {
    // Player holds 2 low-heart cards (ranks 1 and 3 for remove_7s)
    const myHand = ['1_h', '3_h'];
    renderModal({ myHand });
    // Low Hearts button should say "You hold 2/6"
    expect(screen.getByRole('button', { name: /Declare Low Hearts.*2\/6/i })).toBeTruthy();
  });

  it('shows "all half-suits declared" message when everything is declared', () => {
    const allSuits: DeclaredSuit[] = [
      'low_s', 'low_h', 'low_d', 'low_c',
      'high_s', 'high_h', 'high_d', 'high_c',
    ].map((halfSuitId) => ({ halfSuitId, teamId: 1 as const, declaredBy: 'p1' }));
    renderModal({ declaredSuits: allSuits });
    expect(screen.getByText(/All half-suits have been declared/i)).toBeTruthy();
  });

  it('fires onCancel when Cancel is clicked from the selection step', () => {
    const onCancel = jest.fn();
    renderModal({ onCancel });
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Card assignment step
// ---------------------------------------------------------------------------

describe('DeclareModal — card assignment step', () => {
  function openSuit(suitLabel: string | RegExp) {
    const btn = screen.getByRole('button', { name: suitLabel });
    fireEvent.click(btn);
  }

  it('navigates to card assignment after selecting a suit', () => {
    renderModal();
    openSuit(/Low Spades/i);
    expect(screen.getByText(/Low Spades/)).toBeTruthy();
    // Instruction text in Step 2 guides the player on how to assign cards
    expect(screen.getByText(/seat targeting|assign via dropdown/i)).toBeTruthy();
  });

  it('shows "Back" button in the card assignment step', () => {
    renderModal();
    openSuit(/Low Spades/i);
    expect(screen.getByRole('button', { name: /Back/i })).toBeTruthy();
  });

  it('clicking Back returns to suit selection', () => {
    renderModal();
    openSuit(/Low Spades/i);
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    // Back at selection step
    expect(screen.getByText(/Select a half-suit to declare/i)).toBeTruthy();
  });

  it('pre-fills "In your hand" for cards the player holds', () => {
    // Player holds 1_s (Ace of Spades) which is in Low Spades for remove_7s
    const myHand = ['1_s'];
    renderModal({ myHand });
    openSuit(/Low Spades/i);
    expect(screen.getByText(/In your hand ✓/i)).toBeTruthy();
  });

  it('shows a dropdown for cards NOT in the player\'s hand', () => {
    // Hold only 1_s so the Low Spades button is enabled; the remaining 5 cards
    // (2_s,3_s,4_s,5_s,6_s) are unknown and each shows a dropdown.
    renderModal({ myHand: ['1_s'] });
    openSuit(/Low Spades/i);
    const selects = screen.getAllByRole('combobox');
    // 5 unknown cards → 5 dropdowns (1_s is pre-filled as "In your hand ✓")
    expect(selects.length).toBe(5);
  });

  it('shows teammates (same team) as dropdown options', () => {
    renderModal({ myHand: ['1_s'], players: build6Players(), myPlayerId: 'p1' });
    openSuit(/Low Spades/i);
    const select = screen.getAllByRole('combobox')[0];
    // Alice (p2) and Bob (p3) are teammates
    expect(within(select).getByText(/Alice/i)).toBeTruthy();
    expect(within(select).getByText(/Bob/i)).toBeTruthy();
    // Carol (p4) is an opponent and should NOT appear
    expect(within(select).queryByText(/Carol/i)).toBeNull();
  });

  it('shows the player themselves as a dropdown option', () => {
    renderModal({ myHand: ['1_s'], players: build6Players(), myPlayerId: 'p1' });
    openSuit(/Low Spades/i);
    const select = screen.getAllByRole('combobox')[0];
    expect(within(select).getByText(/Me.*\(you\)/i)).toBeTruthy();
  });

  it('Confirm is disabled when a card assignment is cleared to empty', () => {
    // DeclareModal pre-fills all cards with the first teammate on suit selection.
    // To test the "disabled when incomplete" branch we must clear one dropdown
    // back to the placeholder "Who holds this?" (value "").
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openSuit(/Low Spades/i);
    const selects = screen.getAllByRole('combobox');
    // Reset one dropdown to empty (the "Who holds this?" placeholder)
    fireEvent.change(selects[0], { target: { value: '' } });
    expect(screen.getByRole('button', { name: /Declare!/i })).toBeDisabled();
  });

  it('Confirm is enabled once all 6 cards are assigned', () => {
    renderModal({ myHand: ['1_s'], players: build6Players(), myPlayerId: 'p1' });
    openSuit(/Low Spades/i);
    // Pre-fill is already complete; confirm should be enabled immediately
    expect(screen.getByRole('button', { name: /Declare!/i })).not.toBeDisabled();
  });

  it('Confirm re-enables after clearing and re-assigning a card', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openSuit(/Low Spades/i);
    const selects = screen.getAllByRole('combobox');
    // Clear one dropdown
    fireEvent.change(selects[0], { target: { value: '' } });
    expect(screen.getByRole('button', { name: /Declare!/i })).toBeDisabled();
    // Reassign it
    fireEvent.change(selects[0], { target: { value: 'p1' } });
    expect(screen.getByRole('button', { name: /Declare!/i })).not.toBeDisabled();
  });

  it('fires onConfirm with halfSuitId and assignment when confirmed', () => {
    const onConfirm = jest.fn();
    renderModal({ myHand: ['1_s', '3_s', '4_s', '5_s', '6_s', '9_s'], players: build6Players(), myPlayerId: 'p1', onConfirm });
    // Open Low Spades — all 6 cards are in hand, so all are pre-filled
    openSuit(/Low Spades/i);
    // No dropdowns needed since all cards are in hand
    fireEvent.click(screen.getByRole('button', { name: /Declare!/i }));
    expect(onConfirm).toHaveBeenCalledWith(
      'low_s',
      expect.objectContaining({
        '1_s': 'p1',
        '3_s': 'p1',
      })
    );
  });

  it('fires onCancel when Cancel is clicked from assignment step', () => {
    const onCancel = jest.fn();
    renderModal({ onCancel });
    openSuit(/Low Spades/i);
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

describe('DeclareModal — loading state', () => {
  it('shows "Declaring…" label when isLoading', () => {
    const modal = renderModal({ isLoading: true, myHand: ['1_s', '3_s', '4_s', '5_s', '6_s', '9_s'] });
    // Navigate to the card assignment step first
    const suitBtn = screen.getByRole('button', { name: /Low Spades/i });
    fireEvent.click(suitBtn);
    expect(screen.getByText('Declaring…')).toBeTruthy();
    void modal;
  });

  it('disables Confirm and Cancel when isLoading', () => {
    renderModal({
      isLoading: true,
      myHand: ['1_s', '3_s', '4_s', '5_s', '6_s', '9_s'],
    });
    openLowSpades();
    expect(screen.getByRole('button', { name: /Declaring…/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();
  });
});

function openLowSpades() {
  fireEvent.click(screen.getByRole('button', { name: /Low Spades/i }));
}

// ---------------------------------------------------------------------------
// Bot teammates
// ---------------------------------------------------------------------------

describe('DeclareModal — bot teammates in 6-player game', () => {
  it('shows bot teammates as assignment options', () => {
    const players = build6Players();
    // Replace Alice (p2) with a bot
    players[1] = { ...players[1], displayName: 'silly_penguin', isBot: true };
    renderModal({ myHand: ['1_s'], players, myPlayerId: 'p1' });
    openLowSpades();
    const select = screen.getAllByRole('combobox')[0];
    // Bot teammate should appear as an option
    expect(within(select).getByText(/silly_penguin/i)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 8-player game
// ---------------------------------------------------------------------------

describe('DeclareModal — 8-player game', () => {
  it('shows all 4 teammates as assignment options', () => {
    renderModal({ myHand: ['1_s'], players: build8Players(), myPlayerId: 'p1' });
    openLowSpades();
    const select = screen.getAllByRole('combobox')[0];
    // T1B, T1C, T1D are teammates (plus Me)
    expect(within(select).getByText(/T1B/i)).toBeTruthy();
    expect(within(select).getByText(/T1C/i)).toBeTruthy();
    expect(within(select).getByText(/T1D/i)).toBeTruthy();
  });

  it('does not show opposing team players in assignment dropdowns', () => {
    renderModal({ myHand: ['1_s'], players: build8Players(), myPlayerId: 'p1' });
    openLowSpades();
    const select = screen.getAllByRole('combobox')[0];
    // T2A–T2D are opponents and must not appear
    expect(within(select).queryByText(/T2A/i)).toBeNull();
    expect(within(select).queryByText(/T2B/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sub-AC 22c — Seat-targeting interaction
// ---------------------------------------------------------------------------

describe('DeclareModal — seat-targeting interaction (Sub-AC 22c)', () => {
  /**
   * Open Low Spades and return the first assignable (non-mine) card row.
   * Player holds only 1_s so the remaining 5 cards (2_s–6_s) are assignable.
   */
  function openAndGetFirstAssignableRow() {
    renderModal({ myHand: ['1_s'], players: build6Players(), myPlayerId: 'p1' });
    openLowSpades();
    const rows = screen.getAllByTestId('assignable-card-row');
    expect(rows.length).toBeGreaterThan(0);
    return rows[0];
  }

  it('seat-targeting strip is NOT shown initially (no card selected)', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    expect(screen.queryByTestId('seat-targeting-strip')).toBeNull();
  });

  it('tapping a non-mine card row shows the seat-targeting strip', () => {
    const row = openAndGetFirstAssignableRow();
    fireEvent.click(row);
    expect(screen.getByTestId('seat-targeting-strip')).toBeTruthy();
  });

  it('seat-targeting strip shows all same-team players as chips', () => {
    const row = openAndGetFirstAssignableRow();
    fireEvent.click(row);
    const chips = screen.getAllByTestId('seat-target-chip');
    // 6-player game, team 1 has 3 players (Me, Alice, Bob)
    expect(chips).toHaveLength(3);
    const chipText = chips.map((c) => c.textContent ?? '').join(' ');
    expect(chipText).toMatch(/Me/i);
    expect(chipText).toMatch(/Alice/i);
    expect(chipText).toMatch(/Bob/i);
  });

  it('seat-targeting strip does NOT show opponents', () => {
    const row = openAndGetFirstAssignableRow();
    fireEvent.click(row);
    const strip = screen.getByTestId('seat-targeting-strip');
    expect(within(strip).queryByText(/Carol/i)).toBeNull();
    expect(within(strip).queryByText(/Dave/i)).toBeNull();
    expect(within(strip).queryByText(/Eve/i)).toBeNull();
  });

  it('tapping a seat chip assigns the card to that teammate', () => {
    const row = openAndGetFirstAssignableRow();
    fireEvent.click(row);
    // Tap the "Alice" chip (p2)
    const chips = screen.getAllByTestId('seat-target-chip');
    const aliceChip = chips.find((c) => c.textContent?.includes('Alice'));
    expect(aliceChip).toBeTruthy();
    fireEvent.click(aliceChip!);

    // The dropdown for that card should now show p2 (Alice) as selected value.
    // The first assignable card is 2_s (after 1_s which is in hand).
    // All dropdowns after assignment update to p2.
    const selects = screen.getAllByRole('combobox');
    // At least the first select changed to Alice (p2)
    const assignedSelect = selects.find((s) => (s as HTMLSelectElement).value === 'p2');
    expect(assignedSelect).toBeTruthy();
  });

  it('tapping a seat chip clears the seat-targeting strip', () => {
    const row = openAndGetFirstAssignableRow();
    fireEvent.click(row);
    expect(screen.getByTestId('seat-targeting-strip')).toBeTruthy();

    const chips = screen.getAllByTestId('seat-target-chip');
    fireEvent.click(chips[0]);

    // Strip should be dismissed
    expect(screen.queryByTestId('seat-targeting-strip')).toBeNull();
  });

  it('currently-assigned chip has aria-pressed=true; others have aria-pressed=false', () => {
    renderModal({ myHand: ['1_s'], players: build6Players(), myPlayerId: 'p1' });
    openLowSpades();
    const rows = screen.getAllByTestId('assignable-card-row');
    fireEvent.click(rows[0]);

    const chips = screen.getAllByTestId('seat-target-chip');
    // The pre-fill assigns to first OTHER teammate (p2 — Alice), NOT the player
    // themselves, because the player knows they don't hold the non-hand cards.
    const aliceChip = chips.find((c) => c.getAttribute('data-player-id') === 'p2');
    expect(aliceChip).toBeTruthy();
    expect(aliceChip!.getAttribute('aria-pressed')).toBe('true');

    // Other chips should NOT be pressed
    const otherChips = chips.filter((c) => c.getAttribute('data-player-id') !== 'p2');
    for (const chip of otherChips) {
      expect(chip.getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('selected card row has aria-pressed=true; others have aria-pressed=false', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    const rows = screen.getAllByTestId('assignable-card-row');
    fireEvent.click(rows[0]);

    expect(rows[0].getAttribute('aria-pressed')).toBe('true');
    expect(rows[1].getAttribute('aria-pressed')).toBe('false');
  });

  it('tapping the same card row again deselects it (dismisses strip)', () => {
    const row = openAndGetFirstAssignableRow();
    fireEvent.click(row);
    expect(screen.getByTestId('seat-targeting-strip')).toBeTruthy();

    // Tap same row again
    fireEvent.click(row);
    expect(screen.queryByTestId('seat-targeting-strip')).toBeNull();
    expect(row.getAttribute('aria-pressed')).toBe('false');
  });

  it('tapping a different card row switches the selected card', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    const rows = screen.getAllByTestId('assignable-card-row');

    fireEvent.click(rows[0]);
    expect(rows[0].getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(rows[1]);
    expect(rows[0].getAttribute('aria-pressed')).toBe('false');
    expect(rows[1].getAttribute('aria-pressed')).toBe('true');
    // Strip still visible for the new selection
    expect(screen.getByTestId('seat-targeting-strip')).toBeTruthy();
  });

  it('"In your hand" card rows are not selectable', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    // Owned card row should not have role="button" or data-testid="assignable-card-row"
    expect(screen.getAllByTestId('owned-card-row')).toHaveLength(1);
    // Clicking the owned row should NOT open the strip
    const ownedRow = screen.getAllByTestId('owned-card-row')[0];
    fireEvent.click(ownedRow);
    expect(screen.queryByTestId('seat-targeting-strip')).toBeNull();
  });

  it('keyboard Enter on card row triggers selection', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    const rows = screen.getAllByTestId('assignable-card-row');
    fireEvent.keyDown(rows[0], { key: 'Enter', code: 'Enter' });
    expect(screen.getByTestId('seat-targeting-strip')).toBeTruthy();
  });

  it('keyboard Space on card row triggers selection', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    const rows = screen.getAllByTestId('assignable-card-row');
    fireEvent.keyDown(rows[0], { key: ' ', code: 'Space' });
    expect(screen.getByTestId('seat-targeting-strip')).toBeTruthy();
  });

  it('changing a dropdown while that card is selected clears the selection', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    const rows = screen.getAllByTestId('assignable-card-row');
    fireEvent.click(rows[0]);
    expect(screen.getByTestId('seat-targeting-strip')).toBeTruthy();

    // Change the dropdown for that card
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'p2' } });
    // Strip should be cleared
    expect(screen.queryByTestId('seat-targeting-strip')).toBeNull();
  });

  it('going Back to suit selection clears any pending seat-targeting selection', () => {
    const row = openAndGetFirstAssignableRow();
    fireEvent.click(row);
    expect(screen.getByTestId('seat-targeting-strip')).toBeTruthy();

    // Go back to suit selection
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    // Back to step 1 — no strip
    expect(screen.queryByTestId('seat-targeting-strip')).toBeNull();
    expect(screen.getByText(/Select a half-suit to declare/i)).toBeTruthy();
  });

  it('seat-targeting assignment triggers onDeclareProgress with updated map', () => {
    const onDeclareProgress = jest.fn();
    renderModal({
      myHand: ['1_s'],
      players: build6Players(),
      myPlayerId: 'p1',
      onDeclareProgress,
    } as Parameters<typeof renderModal>[0] & { onDeclareProgress: jest.Mock });
    openLowSpades();
    onDeclareProgress.mockClear(); // ignore initial broadcast from suit selection

    // Select a card row
    const rows = screen.getAllByTestId('assignable-card-row');
    fireEvent.click(rows[0]);
    // Tap Bob (p3) chip
    const chips = screen.getAllByTestId('seat-target-chip');
    const bobChip = chips.find((c) => c.textContent?.includes('Bob'));
    expect(bobChip).toBeTruthy();
    fireEvent.click(bobChip!);

    // onDeclareProgress should have been called with updated assignment
    expect(onDeclareProgress).toHaveBeenCalled();
    const [suitId, assignmentArg] = onDeclareProgress.mock.calls[onDeclareProgress.mock.calls.length - 1];
    expect(suitId).toBe('low_s');
    // The assigned card should map to p3 (Bob)
    const cardId = rows[0].getAttribute('data-card-id');
    expect(cardId).toBeTruthy();
    expect(assignmentArg[cardId!]).toBe('p3');
  });

  it('seat-targeting works with 8 players — shows all 4 teammates', () => {
    renderModal({ myHand: ['1_s'], players: build8Players(), myPlayerId: 'p1' });
    openLowSpades();
    const rows = screen.getAllByTestId('assignable-card-row');
    fireEvent.click(rows[0]);
    const chips = screen.getAllByTestId('seat-target-chip');
    // Team 1 has 4 players (p1, p2, p3, p4)
    expect(chips).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Sub-AC 22b — Card tap-to-select visual state
//
// Verifies that the PlayingCard component itself reflects the selected state
// (emerald ring + lift) when its container row is tapped, and that the
// interaction correctly toggles selected/deselected states.
// ---------------------------------------------------------------------------

describe('DeclareModal — card tap-to-select interaction (Sub-AC 22b)', () => {
  /**
   * Open Low Spades (player holds 1_s → 5 assignable cards) and return
   * the assignable card rows for interaction.
   */
  function setup() {
    renderModal({ myHand: ['1_s'], players: build6Players(), myPlayerId: 'p1' });
    openLowSpades();
    return screen.getAllByTestId('assignable-card-row');
  }

  it('no card shows "(selected)" in its aria-label before any interaction', () => {
    setup();
    // PlayingCards render with role="img"; none should have "(selected)" label
    expect(screen.queryByRole('img', { name: /\(selected\)/i })).toBeNull();
  });

  it('clicking an assignable card row marks the PlayingCard as selected', () => {
    const rows = setup();
    // Click the first assignable card row
    fireEvent.click(rows[0]);
    // One PlayingCard should now include "(selected)" in its accessible label
    const selectedCards = screen.getAllByRole('img', { name: /\(selected\)/i });
    expect(selectedCards).toHaveLength(1);
  });

  it('only one PlayingCard is in selected state at a time', () => {
    const rows = setup();
    // Select first, then second
    fireEvent.click(rows[0]);
    expect(screen.getAllByRole('img', { name: /\(selected\)/i })).toHaveLength(1);

    fireEvent.click(rows[1]);
    // Still exactly one selected
    expect(screen.getAllByRole('img', { name: /\(selected\)/i })).toHaveLength(1);
  });

  it('clicking the same card row again removes the "(selected)" label (deselect)', () => {
    const rows = setup();
    fireEvent.click(rows[0]);
    expect(screen.getAllByRole('img', { name: /\(selected\)/i })).toHaveLength(1);

    // Tap same row to deselect
    fireEvent.click(rows[0]);
    expect(screen.queryByRole('img', { name: /\(selected\)/i })).toBeNull();
  });

  it('switching selection moves the "(selected)" label to the newly tapped card', () => {
    const rows = setup();
    fireEvent.click(rows[0]);
    const firstSelectedLabels = screen.getAllByRole('img', { name: /\(selected\)/i });
    expect(firstSelectedLabels).toHaveLength(1);

    fireEvent.click(rows[1]);
    // First row is deselected, second is selected
    const nowSelected = screen.getAllByRole('img', { name: /\(selected\)/i });
    expect(nowSelected).toHaveLength(1);
    // The selected card should NOT be the same element as before
    expect(nowSelected[0]).not.toBe(firstSelectedLabels[0]);
  });

  it('locked (in-hand) cards never gain the "(selected)" label', () => {
    setup();
    // 1_s is in hand — owned row should not respond to clicks
    const ownedRows = screen.getAllByTestId('owned-card-row');
    expect(ownedRows).toHaveLength(1);
    fireEvent.click(ownedRows[0]);
    // No card should be selected
    expect(screen.queryByRole('img', { name: /\(selected\)/i })).toBeNull();
  });

  it('assignable card rows have role="button" for accessibility', () => {
    const rows = setup();
    for (const row of rows) {
      expect(row.getAttribute('role')).toBe('button');
    }
  });

  it('owned (locked) card rows do NOT have role="button"', () => {
    setup();
    const ownedRow = screen.getAllByTestId('owned-card-row')[0];
    expect(ownedRow.getAttribute('role')).toBeNull();
  });

  it('hint text "Tap a card" is visible when no card is selected', () => {
    setup();
    expect(screen.getByText(/tap a card to use seat targeting/i)).toBeTruthy();
  });

  it('hint text changes to "Or use the dropdowns below" when a card is selected', () => {
    const rows = setup();
    fireEvent.click(rows[0]);
    expect(screen.getByText(/or use the dropdowns below/i)).toBeTruthy();
  });

  it('deselecting restores the "Tap a card" hint', () => {
    const rows = setup();
    fireEvent.click(rows[0]);
    expect(screen.queryByText(/tap a card to use seat targeting/i)).toBeNull();

    fireEvent.click(rows[0]);
    expect(screen.getByText(/tap a card to use seat targeting/i)).toBeTruthy();
  });

  it('selected card row has data-selected="true" attribute', () => {
    const rows = setup();
    fireEvent.click(rows[0]);
    expect(rows[0].getAttribute('data-selected')).toBe('true');
  });

  it('deselected card row does NOT have data-selected attribute', () => {
    const rows = setup();
    // Initially not selected
    expect(rows[0].getAttribute('data-selected')).toBeNull();
    // Select then deselect
    fireEvent.click(rows[0]);
    fireEvent.click(rows[0]);
    expect(rows[0].getAttribute('data-selected')).toBeNull();
  });

  it('keyboard Enter on card row marks card as selected', () => {
    const rows = setup();
    fireEvent.keyDown(rows[0], { key: 'Enter', code: 'Enter' });
    expect(screen.getAllByRole('img', { name: /\(selected\)/i })).toHaveLength(1);
  });

  it('keyboard Space on card row marks card as selected', () => {
    const rows = setup();
    fireEvent.keyDown(rows[0], { key: ' ', code: 'Space' });
    expect(screen.getAllByRole('img', { name: /\(selected\)/i })).toHaveLength(1);
  });

  it('going Back to suit selection clears all selected card states', () => {
    const rows = setup();
    fireEvent.click(rows[0]);
    expect(screen.getAllByRole('img', { name: /\(selected\)/i })).toHaveLength(1);

    // Navigate back
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    // Now in Step 1 — no cards rendered, so no (selected) state possible
    expect(screen.queryByRole('img', { name: /\(selected\)/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sub-AC 23d — Submit button: enabled only when complete, disables edits
// ---------------------------------------------------------------------------

describe('DeclareModal — Sub-AC 23d submit button and form lock-down', () => {
  /**
   * Renders the modal in Step 2 (card assignment) with the player holding
   * one card (1_s).  The remaining 5 slots start pre-filled with p2's id
   * (first teammate), so isComplete is true from the start.
   */
  function setupStep2(overrides: Partial<Parameters<typeof renderModal>[0]> = {}) {
    renderModal({ myHand: ['1_s'], players: build6Players(), myPlayerId: 'p1', ...overrides });
    fireEvent.click(screen.getByRole('button', { name: /Low Spades/i }));
  }

  // ── Submit button identity ────────────────────────────────────────────────

  it('submit button has data-testid="declare-submit-btn"', () => {
    setupStep2();
    expect(screen.getByTestId('declare-submit-btn')).toBeTruthy();
  });

  it('submit button is rendered only in Step 2, not Step 1', () => {
    renderModal({ myHand: ['1_s'], players: build6Players(), myPlayerId: 'p1' });
    // Step 1 — no submit button
    expect(screen.queryByTestId('declare-submit-btn')).toBeNull();
    // Navigate to Step 2
    fireEvent.click(screen.getByRole('button', { name: /Low Spades/i }));
    expect(screen.getByTestId('declare-submit-btn')).toBeTruthy();
  });

  // ── Enabled / disabled based on completeness ─────────────────────────────

  it('submit button is enabled when all 6 cards are assigned', () => {
    setupStep2();
    // All pre-filled → complete
    expect(screen.getByTestId('declare-submit-btn')).not.toBeDisabled();
  });

  it('submit button is disabled when a dropdown is reset to empty', () => {
    setupStep2();
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: '' } });
    expect(screen.getByTestId('declare-submit-btn')).toBeDisabled();
  });

  it('submit button re-enables after re-assigning the cleared card', () => {
    setupStep2();
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: '' } });
    expect(screen.getByTestId('declare-submit-btn')).toBeDisabled();
    fireEvent.change(selects[0], { target: { value: 'p2' } });
    expect(screen.getByTestId('declare-submit-btn')).not.toBeDisabled();
  });

  // ── Sends payload on click ────────────────────────────────────────────────

  it('clicking submit fires onConfirm with halfSuitId and complete assignment', () => {
    const onConfirm = jest.fn();
    renderModal({
      myHand: ['1_s', '3_s', '4_s', '5_s', '6_s', '9_s'],
      players: build6Players(),
      myPlayerId: 'p1',
      onConfirm,
    });
    fireEvent.click(screen.getByRole('button', { name: /Low Spades/i }));
    fireEvent.click(screen.getByTestId('declare-submit-btn'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [halfSuitId, assignment] = onConfirm.mock.calls[0];
    expect(halfSuitId).toBe('low_s');
    // All 6 cards should be in the payload
    expect(Object.keys(assignment)).toHaveLength(6);
  });

  it('does NOT fire onConfirm when submit is clicked while already loading', () => {
    const onConfirm = jest.fn();
    setupStep2({ isLoading: true, onConfirm });
    // Button is disabled so fireEvent.click should be a no-op, but guard via direct call
    const btn = screen.getByTestId('declare-submit-btn');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // ── Disables further edits once submitted (isLoading=true) ───────────────

  it('shows "Declaring…" label on submit button when isLoading', () => {
    setupStep2({ isLoading: true });
    expect(screen.getByTestId('declare-submit-btn').textContent).toMatch(/Declaring…/);
  });

  it('submit button is disabled while isLoading (in-flight)', () => {
    setupStep2({ isLoading: true });
    expect(screen.getByTestId('declare-submit-btn')).toBeDisabled();
  });

  it('cancel button is disabled while isLoading', () => {
    setupStep2({ isLoading: true });
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();
  });

  it('assignment dropdowns are disabled while isLoading', () => {
    setupStep2({ isLoading: true });
    const selects = screen.getAllByRole('combobox');
    // All dropdowns (for non-mine cards) should be disabled
    selects.forEach((sel) => {
      expect(sel).toBeDisabled();
    });
  });

  it('card rows lose interactivity while isLoading (no tabIndex, no role=button)', () => {
    setupStep2({ isLoading: true });
    const rows = screen.queryAllByTestId('assignable-card-row');
    rows.forEach((row) => {
      // When isSubmitted, tabIndex is not set (undefined → not rendered as attribute)
      expect(row.getAttribute('tabIndex') ?? row.getAttribute('tabindex')).toBeNull();
    });
  });

  it('seat-targeting chip buttons are disabled while isLoading', () => {
    // To get the seat-targeting strip showing, we need a card selected for targeting.
    // However, when isLoading=true from the start, no card can be tapped.
    // We can verify by checking that chips in the strip are disabled if it appears.
    // Since the strip only shows when selectedCardForAssign is set (internal state),
    // and card rows are non-interactive when isLoading, we test the strip in a
    // controlled way by rendering with a pre-selected state cannot be injected
    // from outside.  Instead, verify the chip button disabled attribute is set
    // by rendering with isLoading=false, selecting a card row, then simulating
    // the loading state via re-render.
    const { rerender, props } = renderModal({
      myHand: ['1_s'],
      players: build6Players(),
      myPlayerId: 'p1',
      isLoading: false,
    });
    fireEvent.click(screen.getByRole('button', { name: /Low Spades/i }));
    // Tap first assignable card row to open the seat-targeting strip
    const rows = screen.getAllByTestId('assignable-card-row');
    fireEvent.click(rows[0]);
    // Strip should be visible and chips should be enabled
    const chips = screen.getAllByTestId('seat-target-chip');
    expect(chips.length).toBeGreaterThan(0);
    chips.forEach((chip) => {
      expect(chip).not.toBeDisabled();
    });
    // Re-render with isLoading=true to simulate submission
    rerender(
      <DeclareModal {...props} isLoading={true} />
    );
    // Chips should now be disabled
    const chipsAfter = screen.getAllByTestId('seat-target-chip');
    chipsAfter.forEach((chip) => {
      expect(chip).toBeDisabled();
    });
  });

  // ── aria-busy reflects submission state ───────────────────────────────────

  it('dialog has aria-busy="true" while isLoading', () => {
    setupStep2({ isLoading: true });
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-busy')).toBe('true');
  });

  it('dialog does NOT have aria-busy="true" before submission', () => {
    setupStep2({ isLoading: false });
    const dialog = screen.getByRole('dialog');
    // aria-busy should be absent or false
    const ariaBusy = dialog.getAttribute('aria-busy');
    expect(ariaBusy === null || ariaBusy === 'false').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-AC 23b — Assignment locking: confirm button + locked visual state
// ---------------------------------------------------------------------------

describe('DeclareModal — Sub-AC 23b assignment locking', () => {
  /**
   * Renders the modal in Step 2 for Low Spades (remove_7s variant).
   * p1 holds only 1_s; the remaining 5 cards (2_s…6_s) are assignable.
   */
  function setupStep2(overrides: Partial<Parameters<typeof renderModal>[0]> = {}) {
    const result = renderModal({ myHand: ['1_s'], players: build6Players(), myPlayerId: 'p1', ...overrides });
    fireEvent.click(screen.getByRole('button', { name: /Low Spades/i }));
    return result;
  }

  // ── Confirm button presence ───────────────────────────────────────────────

  it('shows confirm-assignment-btn for each non-mine card that has an assignee', () => {
    setupStep2();
    // 5 non-mine cards, all pre-filled with first teammate → 5 confirm buttons
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    expect(confirmBtns).toHaveLength(5);
  });

  it('does NOT show confirm-assignment-btn for in-hand cards', () => {
    setupStep2();
    // 1_s is in hand — its row is 'owned-card-row' with no confirm button
    const ownedRow = screen.getByTestId('owned-card-row');
    expect(within(ownedRow).queryByTestId('confirm-assignment-btn')).toBeNull();
  });

  it('confirm-assignment-btn carries the correct aria-label', () => {
    setupStep2();
    // Default pre-fill assigns non-mine cards to the first OTHER teammate (p2 = Alice),
    // since the player knows they don't hold those cards.
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    // aria-label should mention "confirm assignment" and reference the assignee name
    const label = confirmBtns[0].getAttribute('aria-label') ?? '';
    expect(label).toMatch(/confirm assignment/i);
    // Alice (p2) is the first other teammate in the pre-fill
    expect(label).toMatch(/Alice/i);
  });

  it('confirm-assignment-btn has the card-id data attribute matching its row', () => {
    setupStep2();
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    const rows = screen.getAllByTestId('assignable-card-row');
    // Each confirm button's data-card-id matches its sibling row's data-card-id
    for (let i = 0; i < confirmBtns.length; i++) {
      expect(confirmBtns[i].getAttribute('data-card-id')).toBe(
        rows[i].getAttribute('data-card-id'),
      );
    }
  });

  // ── Locking transitions the row ───────────────────────────────────────────

  it('clicking confirm-assignment-btn changes the row testid to locked-card-row', () => {
    setupStep2();
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    fireEvent.click(confirmBtns[0]);
    // At least one row should now be 'locked-card-row'
    expect(screen.getAllByTestId('locked-card-row')).toHaveLength(1);
  });

  it('locked row has data-locked="true"', () => {
    setupStep2();
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    fireEvent.click(confirmBtns[0]);
    const lockedRows = screen.getAllByTestId('locked-card-row');
    expect(lockedRows[0].getAttribute('data-locked')).toBe('true');
  });

  it('locked row renders locked-assignment-badge', () => {
    setupStep2();
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    fireEvent.click(confirmBtns[0]);
    expect(screen.getAllByTestId('locked-assignment-badge')).toHaveLength(1);
  });

  it('locked-assignment-badge shows the assignee name', () => {
    setupStep2();
    // Non-mine cards are pre-filled with the first OTHER teammate (p2 = Alice)
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    fireEvent.click(confirmBtns[0]);
    const badge = screen.getByTestId('locked-assignment-badge');
    expect(badge.textContent).toMatch(/Alice/);
  });

  it('locked-assignment-badge shows "confirmed" label', () => {
    setupStep2();
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    fireEvent.click(confirmBtns[0]);
    const badge = screen.getByTestId('locked-assignment-badge');
    expect(badge.textContent?.toLowerCase()).toContain('confirmed');
  });

  // ── Locked rows are not editable ─────────────────────────────────────────

  it('locked row does NOT render a dropdown (select)', () => {
    setupStep2();
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    const cardId = confirmBtns[0].getAttribute('data-card-id') as string;
    fireEvent.click(confirmBtns[0]);
    // The locked row should not contain any select element
    const lockedRow = screen.getByTestId('locked-card-row');
    expect(within(lockedRow).queryByRole('combobox')).toBeNull();
    void cardId; // suppress unused warning
  });

  it('locked row does NOT have confirm-assignment-btn', () => {
    setupStep2();
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    fireEvent.click(confirmBtns[0]);
    const lockedRow = screen.getByTestId('locked-card-row');
    expect(within(lockedRow).queryByTestId('confirm-assignment-btn')).toBeNull();
  });

  it('locked row does NOT have role="button" (not tappable for seat-targeting)', () => {
    setupStep2();
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    fireEvent.click(confirmBtns[0]);
    const lockedRow = screen.getByTestId('locked-card-row');
    expect(lockedRow.getAttribute('role')).toBeNull();
  });

  it('locked row does NOT have tabIndex (keyboard navigation disabled)', () => {
    setupStep2();
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    fireEvent.click(confirmBtns[0]);
    const lockedRow = screen.getByTestId('locked-card-row');
    expect(lockedRow.getAttribute('tabIndex') ?? lockedRow.getAttribute('tabindex')).toBeNull();
  });

  it('locked row has descriptive aria-label mentioning "confirmed"', () => {
    setupStep2();
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    fireEvent.click(confirmBtns[0]);
    const lockedRow = screen.getByTestId('locked-card-row');
    const label = lockedRow.getAttribute('aria-label') ?? '';
    expect(label.toLowerCase()).toContain('confirmed');
  });

  // ── Remaining rows stay editable ─────────────────────────────────────────

  it('locking one card does not affect the other assignable rows', () => {
    setupStep2();
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    // Lock only the first one
    fireEvent.click(confirmBtns[0]);
    // 4 rows should still be assignable-card-row
    expect(screen.getAllByTestId('assignable-card-row')).toHaveLength(4);
    // 1 locked row
    expect(screen.getAllByTestId('locked-card-row')).toHaveLength(1);
  });

  it('multiple cards can be locked independently', () => {
    setupStep2();
    let confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    fireEvent.click(confirmBtns[0]);
    // After first lock, there are 4 confirm buttons left
    confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    fireEvent.click(confirmBtns[0]);
    expect(screen.getAllByTestId('locked-card-row')).toHaveLength(2);
    expect(screen.getAllByTestId('assignable-card-row')).toHaveLength(3);
  });

  // ── Seat-targeting strip interaction ─────────────────────────────────────

  it('locking a card that is selected for targeting dismisses the seat-targeting strip', () => {
    setupStep2();
    // Tap first assignable card row to open targeting strip
    const rows = screen.getAllByTestId('assignable-card-row');
    fireEvent.click(rows[0]);
    expect(screen.getByTestId('seat-targeting-strip')).toBeTruthy();
    // Find the confirm button that matches the selected card row's card-id
    const targetCardId = rows[0].getAttribute('data-card-id') as string;
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    const confirmBtn = confirmBtns.find((btn) => btn.getAttribute('data-card-id') === targetCardId);
    expect(confirmBtn).toBeDefined();
    fireEvent.click(confirmBtn!);
    // Strip should be gone because selectedCardForAssign was cleared
    expect(screen.queryByTestId('seat-targeting-strip')).toBeNull();
  });

  // ── Back navigation clears locks ─────────────────────────────────────────

  it('navigating Back clears all locked assignments', () => {
    setupStep2();
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    fireEvent.click(confirmBtns[0]);
    expect(screen.getAllByTestId('locked-card-row')).toHaveLength(1);

    // Navigate back to Step 1
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    // Re-enter Step 2 for the same suit
    fireEvent.click(screen.getByRole('button', { name: /Low Spades/i }));
    // All rows should be fresh with no locked cards
    expect(screen.queryAllByTestId('locked-card-row')).toHaveLength(0);
    expect(screen.getAllByTestId('assignable-card-row')).toHaveLength(5);
  });

  // ── Submission still works with locked assignments ────────────────────────

  it('Declare! button can be clicked when some assignments are locked', () => {
    const onConfirm = jest.fn();
    setupStep2({ onConfirm });
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    // Lock a few cards
    fireEvent.click(confirmBtns[0]);
    confirmBtns.splice(0, 1);
    // Declare! should still be enabled (all 6 cards are assigned)
    expect(screen.getByTestId('declare-submit-btn')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('declare-submit-btn'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [halfSuitId, assignment] = onConfirm.mock.calls[0];
    expect(halfSuitId).toBe('low_s');
    expect(Object.keys(assignment)).toHaveLength(6);
  });

  it('Declare! button can be clicked when ALL non-hand assignments are locked', () => {
    const onConfirm = jest.fn();
    setupStep2({ onConfirm });
    // Lock all 5 non-mine cards
    let confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    while (confirmBtns.length > 0) {
      fireEvent.click(confirmBtns[0]);
      confirmBtns = screen.queryAllByTestId('confirm-assignment-btn');
    }
    expect(screen.queryAllByTestId('assignable-card-row')).toHaveLength(0);
    expect(screen.getAllByTestId('locked-card-row')).toHaveLength(5);
    // All 6 cards assigned → Declare! enabled
    expect(screen.getByTestId('declare-submit-btn')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('declare-submit-btn'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  // ── Confirm button hidden when isLoading ─────────────────────────────────

  it('confirm-assignment-btn is NOT shown when isLoading=true', () => {
    setupStep2({ isLoading: true });
    // When in-flight, confirm buttons should not be rendered
    expect(screen.queryAllByTestId('confirm-assignment-btn')).toHaveLength(0);
  });
});
