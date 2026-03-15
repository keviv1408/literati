/**
 * @jest-environment jsdom
 *
 * Tests for CardRequestWizard — Sub-AC 1: 3-step card request UI wizard.
 *
 * Coverage:
 *   Step 1 — Half-suit selection
 *     • Renders the wizard dialog with step indicator at Step 1
 *     • Shows only half-suits where the player holds ≥1 card
 *     • Excludes already-declared half-suits
 *     • Shows "in hand" count per half-suit
 *     • Clicking a half-suit advances to Step 2
 *     • Cancel fires onCancel at Step 1
 *     • Shows "no available half-suits" message when hand is empty
 *
 *   Step 2 — Card selection
 *     • Shows all askable cards (those NOT in the player's hand)
 *     • Renders player's own cards as disabled / "in your hand" section
 *     • Clicking a card advances to Step 3
 *     • Back button returns to Step 1 with half-suit still highlighted
 *     • "No askable cards" message when all 6 are in player's hand
 *
 *   Step 3 — Opponent selection
 *     • Shows valid opponents (other team, cardCount > 0)
 *     • Excludes teammates
 *     • Excludes opponents with 0 cards
 *     • Auto-selects when only one valid opponent exists
 *     • Confirm fires onConfirm(targetPlayerId, cardId)
 *     • Confirm is disabled when no target selected
 *     • Back button returns to Step 2
 *     • Loading state disables Back and shows "Asking…"
 *
 *   Entry via initialCard
 *     • When initialCard is passed, wizard opens at Step 2
 *     • Card is pre-selected and opponent list is one step ahead
 *     • Back from Step 2 goes to Step 1 (half-suit pre-highlighted)
 *
 *   Visibility gate
 *     • Wizard renders a dialog accessible to the caller via role="dialog"
 *     • The wizard is only shown by the game page when isMyTurn is true
 *       (this component itself contains no isMyTurn logic — gating tested
 *        indirectly by verifying the dialog role is present when rendered)
 *
 *   Inference mode
 *     • Step 3 shows probability hints when getCardProbabilities is provided
 *     • Hints are absent when getCardProbabilities is omitted
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import CardRequestWizard from '@/components/CardRequestWizard';
import type { GamePlayer, DeclaredSuit } from '@/types/game';

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

function build6Players(myPlayerId = 'p1'): GamePlayer[] {
  return [
    buildPlayer({ playerId: myPlayerId, displayName: 'Me',    teamId: 1, seatIndex: 0 }),
    buildPlayer({ playerId: 'p2',       displayName: 'Alice', teamId: 1, seatIndex: 2 }),
    buildPlayer({ playerId: 'p3',       displayName: 'Bob',   teamId: 1, seatIndex: 4 }),
    buildPlayer({ playerId: 'p4',       displayName: 'Carol', teamId: 2, seatIndex: 1 }),
    buildPlayer({ playerId: 'p5',       displayName: 'Dave',  teamId: 2, seatIndex: 3 }),
    buildPlayer({ playerId: 'p6',       displayName: 'Eve',   teamId: 2, seatIndex: 5 }),
  ];
}

interface RenderOptions {
  myPlayerId?: string;
  myHand?: string[];
  players?: GamePlayer[];
  variant?: 'remove_2s' | 'remove_7s' | 'remove_8s';
  declaredSuits?: DeclaredSuit[];
  onConfirm?: jest.Mock;
  onCancel?: jest.Mock;
  isLoading?: boolean;
  initialCard?: string;
  getCardProbabilities?: (cardId: string) => Record<string, number>;
}

function renderWizard(options: RenderOptions = {}) {
  const props = {
    myPlayerId:    options.myPlayerId    ?? 'p1',
    // Default hand: has cards in low_h (remove_7s → 1,2,3,4,5,6 of hearts)
    myHand:        options.myHand        ?? ['3_h', '5_h', '9_s'],
    players:       options.players       ?? build6Players(),
    variant:       options.variant       ?? ('remove_7s' as const),
    declaredSuits: options.declaredSuits ?? [],
    onConfirm:     options.onConfirm     ?? jest.fn(),
    onCancel:      options.onCancel      ?? jest.fn(),
    isLoading:     options.isLoading     ?? false,
    initialCard:   options.initialCard,
    getCardProbabilities: options.getCardProbabilities,
  };
  return { ...render(<CardRequestWizard {...props} />), props };
}

// ---------------------------------------------------------------------------
// Step 1 — Half-suit selection
// ---------------------------------------------------------------------------

describe('CardRequestWizard — Step 1 (half-suit selection)', () => {
  it('renders the wizard dialog', () => {
    renderWizard();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('card-request-wizard')).toBeTruthy();
  });

  it('shows the step indicator at step 1', () => {
    renderWizard();
    const indicator = screen.getByTestId('wizard-step-indicator');
    expect(indicator).toBeTruthy();
    // Step 1 should be aria-current="step"
    const step1Node = within(indicator).getByText('1');
    expect(step1Node.getAttribute('aria-current')).toBe('step');
  });

  it('shows "Ask for a card" heading on step 1', () => {
    renderWizard();
    expect(screen.getByText('Ask for a card')).toBeTruthy();
  });

  it('shows half-suits where player holds ≥1 card (remove_7s)', () => {
    // hand: 3_h, 5_h → low_h; 9_s → high_s
    renderWizard({ myHand: ['3_h', '5_h', '9_s'] });
    expect(screen.getByTestId('halfsuit-option-low_h')).toBeTruthy();
    expect(screen.getByTestId('halfsuit-option-high_s')).toBeTruthy();
  });

  it('does NOT show half-suits where player holds 0 cards', () => {
    // Only holds low_h cards
    renderWizard({ myHand: ['3_h'] });
    expect(screen.queryByTestId('halfsuit-option-low_s')).toBeNull();
    expect(screen.queryByTestId('halfsuit-option-high_d')).toBeNull();
  });

  it('excludes already-declared half-suits', () => {
    const declared: DeclaredSuit[] = [
      { halfSuitId: 'low_h', teamId: 1, declaredBy: 'p1' },
    ];
    // Player holds low_h and high_s
    renderWizard({ myHand: ['3_h', '9_s'], declaredSuits: declared });
    // low_h is declared — should not appear
    expect(screen.queryByTestId('halfsuit-option-low_h')).toBeNull();
    // high_s is not declared — should appear
    expect(screen.getByTestId('halfsuit-option-high_s')).toBeTruthy();
  });

  it('shows card count per half-suit', () => {
    renderWizard({ myHand: ['3_h', '5_h'] });
    // 2/6 in low_h
    const btn = screen.getByTestId('halfsuit-option-low_h');
    expect(btn.textContent).toMatch(/2\/6/);
  });

  it('clicking a half-suit option advances to Step 2', () => {
    renderWizard({ myHand: ['3_h'] });
    fireEvent.click(screen.getByTestId('halfsuit-option-low_h'));
    expect(screen.getByTestId('wizard-step-2')).toBeTruthy();
  });

  it('Cancel button fires onCancel', () => {
    const onCancel = jest.fn();
    renderWizard({ onCancel });
    fireEvent.click(screen.getByTestId('wizard-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows "no available half-suits" when player hand is empty', () => {
    renderWizard({ myHand: [] });
    expect(screen.getByTestId('no-available-halfsuits')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Step 2 — Card selection
// ---------------------------------------------------------------------------

describe('CardRequestWizard — Step 2 (card selection)', () => {
  function goToStep2(hand = ['3_h'], halfSuit = 'low_h') {
    renderWizard({ myHand: hand });
    fireEvent.click(screen.getByTestId(`halfsuit-option-${halfSuit}`));
    expect(screen.getByTestId('wizard-step-2')).toBeTruthy();
  }

  it('shows askable cards (cards NOT in player hand)', () => {
    // remove_7s: low_h = [1,2,3,4,5,6]_h; player holds 3_h → can ask for 1,2,4,5,6_h
    goToStep2(['3_h']);
    // Should show 1_h, 2_h, 4_h, 5_h, 6_h as askable
    expect(screen.getByTestId('card-option-1_h')).toBeTruthy();
    expect(screen.getByTestId('card-option-2_h')).toBeTruthy();
    expect(screen.getByTestId('card-option-4_h')).toBeTruthy();
    expect(screen.getByTestId('card-option-5_h')).toBeTruthy();
    expect(screen.getByTestId('card-option-6_h')).toBeTruthy();
  });

  it('renders player\'s held cards in the "in your hand" section (disabled)', () => {
    goToStep2(['3_h', '5_h']);
    // 3_h and 5_h are held — shown as disabled in the "in your hand" section
    expect(screen.getByTestId('card-in-hand-3_h')).toBeTruthy();
    expect(screen.getByTestId('card-in-hand-5_h')).toBeTruthy();
  });

  it('does NOT show held cards in askable list', () => {
    goToStep2(['3_h']);
    // 3_h is held — should not appear as an askable option
    expect(screen.queryByTestId('card-option-3_h')).toBeNull();
  });

  it('clicking an askable card advances to Step 3', () => {
    goToStep2(['3_h']);
    fireEvent.click(screen.getByTestId('card-option-1_h'));
    expect(screen.getByTestId('wizard-step-3')).toBeTruthy();
  });

  it('Back button returns to Step 1', () => {
    goToStep2(['3_h']);
    fireEvent.click(screen.getByTestId('wizard-back-to-step1'));
    expect(screen.getByTestId('wizard-step-1')).toBeTruthy();
  });

  it('shows "no askable cards" message when player holds all 6 cards in the suit', () => {
    // remove_7s: low_h = [1,2,3,4,5,6]_h
    const fullHalfSuit = ['1_h', '2_h', '3_h', '4_h', '5_h', '6_h'];
    renderWizard({ myHand: fullHalfSuit });
    fireEvent.click(screen.getByTestId('halfsuit-option-low_h'));
    expect(screen.getByTestId('no-askable-cards')).toBeTruthy();
  });

  it('step indicator shows step 2 as active on step 2', () => {
    goToStep2(['3_h']);
    // Within the step indicator, step 2's node should have aria-current="step"
    const indicator = screen.getByTestId('wizard-step-indicator');
    const step2Node = within(indicator).getByText('2');
    expect(step2Node.getAttribute('aria-current')).toBe('step');
  });

  it('after returning to step 1 and re-selecting, card selection is reset', () => {
    // Start at step 1, select low_h → step 2
    renderWizard({ myHand: ['3_h'] });
    fireEvent.click(screen.getByTestId('halfsuit-option-low_h'));
    // Go back to step 1
    fireEvent.click(screen.getByTestId('wizard-back-to-step1'));
    // Re-select low_h
    fireEvent.click(screen.getByTestId('halfsuit-option-low_h'));
    // Step 2 should have no card pre-selected (no "selected" class on cards)
    expect(screen.queryByTestId('wizard-step-3')).toBeNull();
    expect(screen.getByTestId('wizard-step-2')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Step 3 — Opponent selection
// ---------------------------------------------------------------------------

describe('CardRequestWizard — Step 3 (opponent selection)', () => {
  function goToStep3(
    hand = ['3_h'],
    players = build6Players(),
  ) {
    renderWizard({ myHand: hand, players });
    // Step 1: select half-suit
    fireEvent.click(screen.getByTestId('halfsuit-option-low_h'));
    // Step 2: pick a card
    fireEvent.click(screen.getByTestId('card-option-1_h'));
    expect(screen.getByTestId('wizard-step-3')).toBeTruthy();
  }

  it('shows valid opponents (other team, cardCount > 0)', () => {
    goToStep3();
    expect(screen.getByTestId('opponent-option-p4')).toBeTruthy(); // Carol
    expect(screen.getByTestId('opponent-option-p5')).toBeTruthy(); // Dave
    expect(screen.getByTestId('opponent-option-p6')).toBeTruthy(); // Eve
  });

  it('does NOT show teammates as targets', () => {
    goToStep3();
    expect(screen.queryByTestId('opponent-option-p2')).toBeNull(); // Alice (T1)
    expect(screen.queryByTestId('opponent-option-p3')).toBeNull(); // Bob (T1)
  });

  it('excludes opponents with 0 cards', () => {
    const players = build6Players();
    players[3] = { ...players[3], cardCount: 0 }; // Carol has 0 cards
    goToStep3(['3_h'], players);
    expect(screen.queryByTestId('opponent-option-p4')).toBeNull();
    expect(screen.getByTestId('opponent-option-p5')).toBeTruthy();
  });

  it('shows "No opponents" when all opponents have 0 cards', () => {
    const players = build6Players();
    players[3] = { ...players[3], cardCount: 0 };
    players[4] = { ...players[4], cardCount: 0 };
    players[5] = { ...players[5], cardCount: 0 };
    goToStep3(['3_h'], players);
    expect(screen.getByTestId('no-valid-targets')).toBeTruthy();
  });

  it('auto-selects when only one valid opponent', () => {
    const players = build6Players();
    players[4] = { ...players[4], cardCount: 0 };
    players[5] = { ...players[5], cardCount: 0 };
    goToStep3(['3_h'], players);
    // Only Carol (p4) has cards — confirm should be enabled automatically
    const confirmBtn = screen.getByTestId('wizard-confirm-ask');
    expect(confirmBtn).not.toBeDisabled();
  });

  it('Confirm is disabled when no opponent selected', () => {
    goToStep3();
    const confirmBtn = screen.getByTestId('wizard-confirm-ask');
    expect(confirmBtn).toBeDisabled();
  });

  it('Confirm is enabled after selecting an opponent', () => {
    goToStep3();
    fireEvent.click(screen.getByTestId('opponent-option-p4'));
    expect(screen.getByTestId('wizard-confirm-ask')).not.toBeDisabled();
  });

  it('fires onConfirm(targetId, cardId) when confirmed', () => {
    const onConfirm = jest.fn();
    renderWizard({ myHand: ['3_h'], players: build6Players(), onConfirm });
    fireEvent.click(screen.getByTestId('halfsuit-option-low_h'));
    fireEvent.click(screen.getByTestId('card-option-1_h'));
    fireEvent.click(screen.getByTestId('opponent-option-p4'));
    fireEvent.click(screen.getByTestId('wizard-confirm-ask'));
    expect(onConfirm).toHaveBeenCalledWith('p4', '1_h');
  });

  it('Back button returns to Step 2', () => {
    goToStep3();
    fireEvent.click(screen.getByTestId('wizard-back-to-step2'));
    expect(screen.getByTestId('wizard-step-2')).toBeTruthy();
  });

  it('shows "Asking…" and disables buttons while isLoading', () => {
    const players = build6Players();
    players[4] = { ...players[4], cardCount: 0 };
    players[5] = { ...players[5], cardCount: 0 };
    // Only Carol (p4) — auto-selected
    renderWizard({ myHand: ['3_h'], players, isLoading: true });
    fireEvent.click(screen.getByTestId('halfsuit-option-low_h'));
    fireEvent.click(screen.getByTestId('card-option-1_h'));
    expect(screen.getByText('Asking…')).toBeTruthy();
    expect(screen.getByTestId('wizard-confirm-ask')).toBeDisabled();
    expect(screen.getByTestId('wizard-back-to-step2')).toBeDisabled();
  });

  it('step indicator shows step 3 as active on step 3', () => {
    goToStep3();
    const indicator = screen.getByTestId('wizard-step-indicator');
    const step3Node = within(indicator).getByText('3');
    expect(step3Node.getAttribute('aria-current')).toBe('step');
  });

  it('shows selected card preview in step 3', () => {
    goToStep3();
    // PlayingCard for 1_h: rank 1 → 'A', suit 'h' → 'Hearts'
    // aria-label is "A of Hearts" (cardRankLabel returns 'A', not 'Ace')
    expect(screen.getByLabelText(/A of Hearts/i)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Entry via initialCard (starts at Step 2)
// ---------------------------------------------------------------------------

describe('CardRequestWizard — entry via initialCard', () => {
  it('opens directly at Step 2 when initialCard is provided', () => {
    renderWizard({ myHand: ['3_h'], initialCard: '1_h' });
    expect(screen.getByTestId('wizard-step-2')).toBeTruthy();
    expect(screen.queryByTestId('wizard-step-1')).toBeNull();
  });

  it('shows the correct half-suit name in Step 2 subtitle', () => {
    renderWizard({ myHand: ['3_h'], initialCard: '1_h' });
    expect(screen.getByText(/Low Hearts/i)).toBeTruthy();
  });

  it('Back from Step 2 returns to Step 1 when opened via initialCard', () => {
    renderWizard({ myHand: ['3_h'], initialCard: '1_h' });
    fireEvent.click(screen.getByTestId('wizard-back-to-step1'));
    expect(screen.getByTestId('wizard-step-1')).toBeTruthy();
  });

  it('full wizard flow from initialCard (Step 2 → Step 3 → confirm)', () => {
    const onConfirm = jest.fn();
    renderWizard({
      myHand: ['3_h'],
      players: build6Players(),
      initialCard: '1_h',
      onConfirm,
    });
    // Step 2 — pick a card (1_h is pre-derivable but we need to click)
    fireEvent.click(screen.getByTestId('card-option-1_h'));
    // Step 3 — pick opponent
    fireEvent.click(screen.getByTestId('opponent-option-p4'));
    fireEvent.click(screen.getByTestId('wizard-confirm-ask'));
    expect(onConfirm).toHaveBeenCalledWith('p4', '1_h');
  });
});

// ---------------------------------------------------------------------------
// Inference mode
// ---------------------------------------------------------------------------

describe('CardRequestWizard — inference mode hints in Step 3', () => {
  function goToStep3WithInference(probs: Record<string, number>) {
    const getCardProbabilities = jest.fn(() => probs);
    renderWizard({
      myHand: ['3_h'],
      players: build6Players(),
      getCardProbabilities,
    });
    fireEvent.click(screen.getByTestId('halfsuit-option-low_h'));
    fireEvent.click(screen.getByTestId('card-option-1_h'));
    return { getCardProbabilities };
  }

  it('shows probability hint for opponent when getCardProbabilities returns > 0', () => {
    goToStep3WithInference({ p4: 40, p5: 30, p6: 30 });
    // At least one "% likely" hint should appear
    expect(screen.getAllByTestId('inference-pct-hint').length).toBeGreaterThan(0);
  });

  it('does NOT show inference hints when getCardProbabilities is not provided', () => {
    renderWizard({ myHand: ['3_h'] });
    fireEvent.click(screen.getByTestId('halfsuit-option-low_h'));
    fireEvent.click(screen.getByTestId('card-option-1_h'));
    expect(screen.queryAllByTestId('inference-pct-hint')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// halfSuitCounts — grey-out opponents with 0 cards in selected half-suit
// ---------------------------------------------------------------------------

describe('CardRequestWizard — halfSuitCounts grey-out (Step 3)', () => {
  /** Build players where some have halfSuitCounts populated. */
  function buildPlayersWithHalfSuitCounts(): GamePlayer[] {
    return [
      // Team 1 (my team)
      buildPlayer({ playerId: 'p1', displayName: 'Me',    teamId: 1, seatIndex: 0, cardCount: 3 }),
      buildPlayer({ playerId: 'p2', displayName: 'Alice', teamId: 1, seatIndex: 2, cardCount: 3 }),
      buildPlayer({ playerId: 'p3', displayName: 'Bob',   teamId: 1, seatIndex: 4, cardCount: 2 }),
      // Team 2 — opponents:
      // Carol: has cards but NONE in low_h
      buildPlayer({
        playerId: 'p4', displayName: 'Carol', teamId: 2, seatIndex: 1, cardCount: 4,
        halfSuitCounts: { low_h: 0, high_h: 2, low_s: 1, high_s: 0, low_d: 1, high_d: 0, low_c: 0, high_c: 0 },
      }),
      // Dave: has 2 cards in low_h — fully enabled
      buildPlayer({
        playerId: 'p5', displayName: 'Dave',  teamId: 2, seatIndex: 3, cardCount: 5,
        halfSuitCounts: { low_h: 2, high_h: 1, low_s: 1, high_s: 0, low_d: 1, high_d: 0, low_c: 0, high_c: 0 },
      }),
      // Eve: has 1 card in low_h — enabled
      buildPlayer({
        playerId: 'p6', displayName: 'Eve',   teamId: 2, seatIndex: 5, cardCount: 3,
        halfSuitCounts: { low_h: 1, high_h: 0, low_s: 1, high_s: 0, low_d: 1, high_d: 0, low_c: 0, high_c: 0 },
      }),
    ];
  }

  function goToStep3WithHalfSuitCounts() {
    const players = buildPlayersWithHalfSuitCounts();
    const { container } = renderWizard({ myHand: ['3_h'], players });
    fireEvent.click(screen.getByTestId('halfsuit-option-low_h'));
    fireEvent.click(screen.getByTestId('card-option-1_h'));
    expect(screen.getByTestId('wizard-step-3')).toBeTruthy();
    return { players, container };
  }

  it('shows ALL opponents with cardCount > 0, including those with 0 in half-suit', () => {
    goToStep3WithHalfSuitCounts();
    // Carol (p4) has cardCount=4 but halfSuitCounts.low_h=0 → shows but greyed
    expect(screen.getByTestId('opponent-option-p4')).toBeTruthy();
    // Dave (p5) and Eve (p6) have cards in low_h → shown normally
    expect(screen.getByTestId('opponent-option-p5')).toBeTruthy();
    expect(screen.getByTestId('opponent-option-p6')).toBeTruthy();
  });

  it('greyed-out opponent button is disabled', () => {
    goToStep3WithHalfSuitCounts();
    const carolBtn = screen.getByTestId('opponent-option-p4');
    expect(carolBtn).toBeDisabled();
  });

  it('greyed-out opponent has aria-disabled="true"', () => {
    goToStep3WithHalfSuitCounts();
    const carolBtn = screen.getByTestId('opponent-option-p4');
    expect(carolBtn.getAttribute('aria-disabled')).toBe('true');
  });

  it('greyed-out opponent shows "0 cards in this half-suit" label', () => {
    goToStep3WithHalfSuitCounts();
    expect(screen.getByTestId('opponent-no-cards-in-suit-p4')).toBeTruthy();
  });

  it('enabled opponents (with cards in half-suit) are NOT disabled', () => {
    goToStep3WithHalfSuitCounts();
    const daveBtn = screen.getByTestId('opponent-option-p5');
    expect(daveBtn).not.toBeDisabled();
  });

  it('confirm button stays disabled when no active target is selected', () => {
    goToStep3WithHalfSuitCounts();
    const confirmBtn = screen.getByTestId('wizard-confirm-ask');
    expect(confirmBtn).toBeDisabled();
  });

  it('confirm button is enabled after selecting an enabled opponent', () => {
    goToStep3WithHalfSuitCounts();
    fireEvent.click(screen.getByTestId('opponent-option-p5')); // Dave — enabled
    expect(screen.getByTestId('wizard-confirm-ask')).not.toBeDisabled();
  });

  it('fires onConfirm with the enabled opponent when confirmed', () => {
    const onConfirm = jest.fn();
    const players = buildPlayersWithHalfSuitCounts();
    renderWizard({ myHand: ['3_h'], players, onConfirm });
    fireEvent.click(screen.getByTestId('halfsuit-option-low_h'));
    fireEvent.click(screen.getByTestId('card-option-1_h'));
    fireEvent.click(screen.getByTestId('opponent-option-p5'));   // Dave
    fireEvent.click(screen.getByTestId('wizard-confirm-ask'));
    expect(onConfirm).toHaveBeenCalledWith('p5', '1_h');
  });

  it('opponent without halfSuitCounts (undefined) is treated as enabled (backward-compat)', () => {
    // p4 has NO halfSuitCounts set — should be enabled
    const players = build6Players(); // no halfSuitCounts
    renderWizard({ myHand: ['3_h'], players });
    fireEvent.click(screen.getByTestId('halfsuit-option-low_h'));
    fireEvent.click(screen.getByTestId('card-option-1_h'));
    const carolBtn = screen.getByTestId('opponent-option-p4');
    expect(carolBtn).not.toBeDisabled();
  });

  it('auto-selects when only one opponent has cards in the half-suit', () => {
    // Only p6 (Eve) has cards in low_h
    const players: GamePlayer[] = [
      buildPlayer({ playerId: 'p1', displayName: 'Me',    teamId: 1, seatIndex: 0, cardCount: 3 }),
      buildPlayer({ playerId: 'p2', displayName: 'Alice', teamId: 1, seatIndex: 2, cardCount: 3 }),
      buildPlayer({ playerId: 'p3', displayName: 'Bob',   teamId: 1, seatIndex: 4, cardCount: 2 }),
      buildPlayer({
        playerId: 'p4', displayName: 'Carol', teamId: 2, seatIndex: 1, cardCount: 3,
        halfSuitCounts: { low_h: 0, high_h: 1, low_s: 1, high_s: 0, low_d: 1, high_d: 0, low_c: 0, high_c: 0 },
      }),
      buildPlayer({
        playerId: 'p5', displayName: 'Dave',  teamId: 2, seatIndex: 3, cardCount: 2,
        halfSuitCounts: { low_h: 0, high_h: 1, low_s: 0, high_s: 0, low_d: 1, high_d: 0, low_c: 0, high_c: 0 },
      }),
      buildPlayer({
        playerId: 'p6', displayName: 'Eve',   teamId: 2, seatIndex: 5, cardCount: 3,
        halfSuitCounts: { low_h: 2, high_h: 0, low_s: 0, high_s: 0, low_d: 1, high_d: 0, low_c: 0, high_c: 0 },
      }),
    ];
    renderWizard({ myHand: ['3_h'], players, initialCard: '1_h' });
    // Skip step 2, go directly to step 3
    fireEvent.click(screen.getByTestId('card-option-1_h'));
    expect(screen.getByTestId('wizard-step-3')).toBeTruthy();
    // Eve should be auto-selected (only enabled target)
    expect(screen.getByTestId('wizard-confirm-ask')).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Variant support
// ---------------------------------------------------------------------------

describe('CardRequestWizard — card variant support', () => {
  it('shows correct half-suit in remove_2s variant', () => {
    // remove_2s: low_h = [1,3,4,5,6,7]_h, high_h = [8,9,10,11,12,13]_h
    renderWizard({ myHand: ['3_h'], variant: 'remove_2s' });
    expect(screen.getByTestId('halfsuit-option-low_h')).toBeTruthy();
  });

  it('shows correct half-suit in remove_8s variant', () => {
    // remove_8s: low_h = [1,2,3,4,5,6]_h, high_h = [7,9,10,11,12,13]_h
    renderWizard({ myHand: ['3_h', '9_h'], variant: 'remove_8s' });
    expect(screen.getByTestId('halfsuit-option-low_h')).toBeTruthy();
    expect(screen.getByTestId('halfsuit-option-high_h')).toBeTruthy();
  });

  it('works end-to-end with remove_8s variant', () => {
    const onConfirm = jest.fn();
    renderWizard({
      myHand: ['3_h'],
      players: build6Players(),
      variant: 'remove_8s',
      onConfirm,
    });
    fireEvent.click(screen.getByTestId('halfsuit-option-low_h'));
    // In remove_8s, low_h = [1,2,3,4,5,6]; player holds 3_h, can ask for 1,2,4,5,6
    fireEvent.click(screen.getByTestId('card-option-1_h'));
    fireEvent.click(screen.getByTestId('opponent-option-p4'));
    fireEvent.click(screen.getByTestId('wizard-confirm-ask'));
    expect(onConfirm).toHaveBeenCalledWith('p4', '1_h');
  });
});

// ---------------------------------------------------------------------------
// Free back-navigation end-to-end
// ---------------------------------------------------------------------------

describe('CardRequestWizard — free back-navigation', () => {
  it('allows navigating Step1 → Step2 → Step1 → Step2 → Step3 → Step2 → Step3', () => {
    const onConfirm = jest.fn();
    renderWizard({
      myHand: ['3_h', '9_s'],
      players: build6Players(),
      onConfirm,
    });

    // Step 1: select low_h
    fireEvent.click(screen.getByTestId('halfsuit-option-low_h'));
    expect(screen.getByTestId('wizard-step-2')).toBeTruthy();

    // Back to step 1
    fireEvent.click(screen.getByTestId('wizard-back-to-step1'));
    expect(screen.getByTestId('wizard-step-1')).toBeTruthy();

    // Select high_s instead
    fireEvent.click(screen.getByTestId('halfsuit-option-high_s'));
    expect(screen.getByTestId('wizard-step-2')).toBeTruthy();

    // Step 2: pick a card from high_s (remove_7s: high_s = [8,9,10,11,12,13]; holds 9_s → ask for 8,10,11,12,13)
    fireEvent.click(screen.getByTestId('card-option-8_s'));
    expect(screen.getByTestId('wizard-step-3')).toBeTruthy();

    // Back to step 2
    fireEvent.click(screen.getByTestId('wizard-back-to-step2'));
    expect(screen.getByTestId('wizard-step-2')).toBeTruthy();

    // Pick a different card
    fireEvent.click(screen.getByTestId('card-option-10_s'));
    expect(screen.getByTestId('wizard-step-3')).toBeTruthy();

    // Confirm
    fireEvent.click(screen.getByTestId('opponent-option-p4'));
    fireEvent.click(screen.getByTestId('wizard-confirm-ask'));
    expect(onConfirm).toHaveBeenCalledWith('p4', '10_s');
  });
});
