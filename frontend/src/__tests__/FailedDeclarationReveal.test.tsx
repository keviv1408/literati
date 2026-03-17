/**
 * @jest-environment jsdom
 *
 * Tests for FailedDeclarationReveal — * Frontend overlay that receives the `declarationFailed` diff payload and
 * renders each half-suit card with the claimed holder crossed out and the
 * actual holder highlighted.
 *
 * Coverage:
 *
 * Rendering:
 * • Renders the overlay wrapper (data-testid="failed-declaration-reveal")
 * • Renders the panel (data-testid="failed-declaration-reveal-panel")
 * • Renders a title including "Declaration Failed"
 * • Shows the declarant's name in the header
 * • Shows the half-suit name in the header
 * • Shows which team scores the point
 * • Renders one row per card in the half-suit (6 rows for 6 cards)
 * • Each row has correct data-testid
 *
 * Wrong assignments (claimedPlayerId ≠ actualPlayerId):
 * • Card row has data-wrong="true"
 * • Claimed holder is rendered with strikethrough
 * • Actual holder is rendered highlighted (testid "actual-holder-*")
 * • Status icon is "✗"
 *
 * Correct assignments (card NOT in wrongAssignmentDiffs):
 * • Card row has data-wrong="false"
 * • Only correct-holder element is rendered (no claimed-holder-* testid)
 * • Status icon is "✓"
 *
 * Dismiss behaviour:
 * • Clicking the dismiss button calls onDismiss
 * • Clicking the backdrop (outside the panel) calls onDismiss
 * • onDismiss is NOT called immediately on render (before any interaction)
 *
 * Auto-dismiss:
 * • onDismiss is called after AUTO_DISMISS_MS (via fake timers)
 * • Clears the timeout on unmount (no stale callback)
 *
 * Accessibility:
 * • role="dialog" with aria-modal="true"
 * • aria-labelledby points to the title element
 * • role="list" on the card rows container
 * • Each row has role="listitem"
 * • Dismiss button has aria-label
 *
 * Edge cases:
 * • All 6 cards wrong (entire declaration incorrect)
 * • All 6 cards correct (shouldn't happen in practice, but no crash)
 * • Unknown player IDs fall back to the raw playerId string
 * • Card chip shows correct rank and suit symbol
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import FailedDeclarationReveal from '@/components/FailedDeclarationReveal';
import type { DeclarationFailedPayload, GamePlayer } from '@/types/game';

// ---------------------------------------------------------------------------
// Suppress animation frame warnings in jsdom
// ---------------------------------------------------------------------------
beforeAll(() => {
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PLAYERS: GamePlayer[] = [
  {
    playerId: 'p1',
    displayName: 'Alice',
    avatarId: null,
    teamId: 1,
    seatIndex: 0,
    cardCount: 3,
    isBot: false,
    isGuest: false,
    isCurrentTurn: false,
  },
  {
    playerId: 'p2',
    displayName: 'Bob',
    avatarId: null,
    teamId: 1,
    seatIndex: 2,
    cardCount: 3,
    isBot: false,
    isGuest: false,
    isCurrentTurn: false,
  },
  {
    playerId: 'p3',
    displayName: 'Carol',
    avatarId: null,
    teamId: 1,
    seatIndex: 4,
    cardCount: 3,
    isBot: false,
    isGuest: false,
    isCurrentTurn: false,
  },
];

/** All 6 low-spades cards for the remove_7s variant: 1_s, 2_s, 3_s, 4_s, 5_s, 6_s */
const LOW_S_CARDS = ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'];

/**
 * Build a payload where the first N cards are wrong.
 * assignment: all claimed as p1
 * actualHolders: wrong cards are actually held by p2; others by p1
 */
function buildPayload(wrongCount: number): DeclarationFailedPayload {
  const assignment: Record<string, string> = {};
  const actualHolders: Record<string, string> = {};
  const wrongAssignmentDiffs: DeclarationFailedPayload['wrongAssignmentDiffs'] = [];

  for (let i = 0; i < LOW_S_CARDS.length; i++) {
    const card = LOW_S_CARDS[i];
    assignment[card] = 'p1';  // claimed: all assigned to p1
    if (i < wrongCount) {
      actualHolders[card] = 'p2'; // actually held by p2
      wrongAssignmentDiffs.push({
        card,
        claimedPlayerId: 'p1',
        actualPlayerId: 'p2',
      });
    } else {
      actualHolders[card] = 'p1'; // correct
    }
  }

  return {
    type: 'declarationFailed',
    declarerId: 'p1',
    halfSuitId: 'low_s',
    winningTeam: 2,
    assignment,
    wrongAssignmentDiffs,
    actualHolders,
    lastMove: 'Alice declared Low Spades — incorrect! Team 2 scores',
  };
}

const VARIANT = 'remove_7s';

// ---------------------------------------------------------------------------
// Helper: render with defaults
// ---------------------------------------------------------------------------
function renderOverlay(
  payload: DeclarationFailedPayload = buildPayload(2),
  onDismiss: jest.Mock = jest.fn(),
) {
  return render(
    <FailedDeclarationReveal
      payload={payload}
      players={PLAYERS}
      variant={VARIANT}
      onDismiss={onDismiss}
    />
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('FailedDeclarationReveal — rendering', () => {
  it('renders the overlay wrapper', () => {
    renderOverlay();
    expect(screen.getByTestId('failed-declaration-reveal')).toBeTruthy();
  });

  it('renders the panel', () => {
    renderOverlay();
    expect(screen.getByTestId('failed-declaration-reveal-panel')).toBeTruthy();
  });

  it('renders a title containing "Declaration Failed"', () => {
    renderOverlay();
    const title = screen.getByTestId('failed-declaration-title');
    expect(title.textContent).toMatch(/Declaration Failed/i);
  });

  it('shows the declarant display name in the header', () => {
    renderOverlay();
    // "Alice declared Low Spades" — player p1 is Alice
    const panel = screen.getByTestId('failed-declaration-reveal-panel');
    expect(panel.textContent).toContain('Alice');
  });

  it('shows the half-suit name in the header', () => {
    renderOverlay();
    const panel = screen.getByTestId('failed-declaration-reveal-panel');
    expect(panel.textContent).toContain('Low Spades');
  });

  it('shows the winning team number', () => {
    renderOverlay();
    const teamLabel = screen.getByTestId('failed-declaration-winning-team');
    expect(teamLabel.textContent).toContain('2');
  });

  it('renders 6 card rows for a 6-card half-suit', () => {
    renderOverlay();
    const list = screen.getByRole('list', { name: /card assignment results/i });
    const rows = list.querySelectorAll('[role="listitem"]');
    expect(rows).toHaveLength(6);
  });

  it('renders a card-row testid for each card', () => {
    renderOverlay();
    for (const card of LOW_S_CARDS) {
      expect(screen.getByTestId(`card-row-${card}`)).toBeTruthy();
    }
  });

  it('renders card chip for each card', () => {
    renderOverlay();
    for (const card of LOW_S_CARDS) {
      expect(screen.getByTestId(`card-chip-${card}`)).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Wrong assignments
// ---------------------------------------------------------------------------

describe('FailedDeclarationReveal — wrong assignments', () => {
  it('marks wrong card rows with data-wrong="true"', () => {
    renderOverlay(buildPayload(2));
    // First 2 cards (1_s, 2_s) are wrong
    expect(screen.getByTestId('card-row-1_s').getAttribute('data-wrong')).toBe('true');
    expect(screen.getByTestId('card-row-2_s').getAttribute('data-wrong')).toBe('true');
    // Card 3 onwards are correct
    expect(screen.getByTestId('card-row-3_s').getAttribute('data-wrong')).toBe('false');
  });

  it('renders the claimed holder with a strikethrough class for wrong cards', () => {
    renderOverlay(buildPayload(3));
    const claimedEl = screen.getByTestId('claimed-holder-1_s');
    expect(claimedEl).toBeTruthy();
    // Should have a line-through style class
    expect(claimedEl.className).toMatch(/line-through/);
  });

  it('renders the claimed holder display name for wrong cards', () => {
    renderOverlay(buildPayload(1));
    // p1 is Alice; 1_s is the only wrong card
    const claimedEl = screen.getByTestId('claimed-holder-1_s');
    expect(claimedEl.textContent).toContain('Alice');
  });

  it('renders the actual holder element for wrong cards', () => {
    renderOverlay(buildPayload(2));
    const actualEl = screen.getByTestId('actual-holder-1_s');
    expect(actualEl).toBeTruthy();
  });

  it('renders the actual holder display name for wrong cards', () => {
    renderOverlay(buildPayload(2));
    // p2 is Bob; 1_s is actually held by p2
    const actualEl = screen.getByTestId('actual-holder-1_s');
    expect(actualEl.textContent).toContain('Bob');
  });

  it('does NOT render actual-holder testid for correct cards', () => {
    renderOverlay(buildPayload(1));
    // 2_s is correct (only 1 wrong)
    expect(screen.queryByTestId('actual-holder-2_s')).toBeNull();
  });

  it('renders the status icon as ✗ for wrong cards', () => {
    renderOverlay(buildPayload(1));
    const icon = screen.getByTestId('status-icon-1_s');
    expect(icon.textContent).toBe('✗');
  });
});

// ---------------------------------------------------------------------------
// Correct assignments
// ---------------------------------------------------------------------------

describe('FailedDeclarationReveal — correct assignments', () => {
  it('marks correct card rows with data-wrong="false"', () => {
    renderOverlay(buildPayload(2));
    // Cards 3–6 are correct
    expect(screen.getByTestId('card-row-3_s').getAttribute('data-wrong')).toBe('false');
    expect(screen.getByTestId('card-row-6_s').getAttribute('data-wrong')).toBe('false');
  });

  it('does NOT render claimed-holder testid for correct cards', () => {
    renderOverlay(buildPayload(1));
    // 2_s is correct
    expect(screen.queryByTestId('claimed-holder-2_s')).toBeNull();
  });

  it('renders the correct-holder element for correct cards', () => {
    renderOverlay(buildPayload(1));
    const correctEl = screen.getByTestId('correct-holder-2_s');
    expect(correctEl).toBeTruthy();
  });

  it('renders the correct holder display name for correct cards', () => {
    renderOverlay(buildPayload(1));
    // 2_s is actually held by p1 (Alice)
    const correctEl = screen.getByTestId('correct-holder-2_s');
    expect(correctEl.textContent).toContain('Alice');
  });

  it('renders the status icon as ✓ for correct cards', () => {
    renderOverlay(buildPayload(1));
    const icon = screen.getByTestId('status-icon-2_s');
    expect(icon.textContent).toBe('✓');
  });
});

// ---------------------------------------------------------------------------
// Dismiss behaviour
// ---------------------------------------------------------------------------

describe('FailedDeclarationReveal — dismiss behaviour', () => {
  it('calls onDismiss when the dismiss button is clicked', () => {
    const onDismiss = jest.fn();
    renderOverlay(buildPayload(1), onDismiss);
    const btn = screen.getByTestId('failed-declaration-dismiss');
    fireEvent.click(btn);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss when the backdrop is clicked', () => {
    const onDismiss = jest.fn();
    renderOverlay(buildPayload(1), onDismiss);
    const backdrop = screen.getByTestId('failed-declaration-reveal');
    // Simulate a click on the backdrop itself (not its children)
    fireEvent.click(backdrop);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onDismiss immediately on render', () => {
    const onDismiss = jest.fn();
    renderOverlay(buildPayload(1), onDismiss);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does NOT call onDismiss when clicking the panel (not the backdrop)', () => {
    const onDismiss = jest.fn();
    renderOverlay(buildPayload(1), onDismiss);
    // Clicking inside the panel should not close the overlay (backdrop check)
    const panel = screen.getByTestId('failed-declaration-reveal-panel');
    fireEvent.click(panel);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auto-dismiss
// ---------------------------------------------------------------------------

describe('FailedDeclarationReveal — auto-dismiss', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('calls onDismiss after 6 000 ms', () => {
    const onDismiss = jest.fn();
    renderOverlay(buildPayload(1), onDismiss);
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(6_000); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onDismiss before 6 000 ms', () => {
    const onDismiss = jest.fn();
    renderOverlay(buildPayload(1), onDismiss);
    act(() => { jest.advanceTimersByTime(5_999); });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('clears the auto-dismiss timer on unmount', () => {
    const onDismiss = jest.fn();
    const { unmount } = renderOverlay(buildPayload(1), onDismiss);
    unmount();
    act(() => { jest.advanceTimersByTime(10_000); });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe('FailedDeclarationReveal — accessibility', () => {
  it('has role="dialog"', () => {
    renderOverlay();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('has aria-modal="true"', () => {
    renderOverlay();
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
  });

  it('has aria-labelledby pointing to the title', () => {
    renderOverlay();
    const dialog = screen.getByRole('dialog');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    // The element with that id must contain the title text
    const titleEl = document.getElementById(labelId!);
    expect(titleEl?.textContent).toMatch(/Declaration Failed/i);
  });

  it('has a list with role="list" for card rows', () => {
    renderOverlay();
    expect(screen.getByRole('list', { name: /card assignment results/i })).toBeTruthy();
  });

  it('each card row has role="listitem"', () => {
    renderOverlay();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(6);
  });

  it('dismiss button has an aria-label', () => {
    renderOverlay();
    const btn = screen.getByTestId('failed-declaration-dismiss');
    expect(btn.getAttribute('aria-label')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('FailedDeclarationReveal — edge cases', () => {
  it('renders without crash when all 6 cards are wrong', () => {
    renderOverlay(buildPayload(6));
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(6);
    for (const card of LOW_S_CARDS) {
      expect(screen.getByTestId(`card-row-${card}`).getAttribute('data-wrong')).toBe('true');
    }
  });

  it('renders without crash when all 6 cards are correct', () => {
    renderOverlay(buildPayload(0));
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(6);
    for (const card of LOW_S_CARDS) {
      expect(screen.getByTestId(`card-row-${card}`).getAttribute('data-wrong')).toBe('false');
    }
  });

  it('falls back to playerId when player is not in the players list', () => {
    const payload = buildPayload(1);
    // Override actualHolders to reference an unknown player
    payload.actualHolders['1_s'] = 'unknown-player-xyz';
    payload.wrongAssignmentDiffs[0].actualPlayerId = 'unknown-player-xyz';
    renderOverlay(payload);
    const actualEl = screen.getByTestId('actual-holder-1_s');
    expect(actualEl.textContent).toContain('unknown-player-xyz');
  });

  it('renders card rank label correctly (Ace → A)', () => {
    renderOverlay();
    // 1_s → rank 1 → "A"
    const chip = screen.getByTestId('card-chip-1_s');
    expect(chip.textContent).toContain('A');
  });

  it('renders card suit symbol correctly (spades → ♠)', () => {
    renderOverlay();
    const chip = screen.getByTestId('card-chip-1_s');
    expect(chip.textContent).toContain('♠');
  });

  it('renders without crash when actualPlayerId is null in diff', () => {
    const payload = buildPayload(1);
    payload.wrongAssignmentDiffs[0].actualPlayerId = null;
    payload.actualHolders['1_s'] = null as unknown as string;
    expect(() => renderOverlay(payload)).not.toThrow();
  });
});
