/**
 * @jest-environment jsdom
 *
 * Tests for DeclareModal — Revision UI.
 *
 * The revision badge is a visual indicator shown on each non-locked card row
 * that prominently displays the current assignee with a "✎ change" hint.
 * Clicking the badge (or the card row) enters seat-targeting mode so the
 * player can easily change the assignment. Every change is broadcast in
 * real-time via the `onDeclareProgress` callback → WebSocket.
 *
 * Coverage:
 * [revision-badge presence]
 * 1. Revision badge appears for each non-owned, unconfirmed card that has
 * an assignment
 * 2. Owned ("In your hand") cards do NOT have a revision badge
 * 3. Confirmed/locked cards do NOT have a revision badge (locked-assignment-badge instead)
 * 4. Badge is NOT present when the assignment is empty (placeholder)
 *
 * [revision-badge content]
 * 5. Badge shows the currently-assigned teammate's display name
 * 6. Badge shows "(you)" suffix when the card is assigned to the declarant
 * 7. Badge shows "✎ change" hint (visible when not submitted)
 * 8. Change hint is hidden when declaration is in-flight (isLoading=true)
 *
 * [revision interaction — badge click]
 * 9. Clicking the badge (which propagates to the outer card-row div) enters
 * seat-targeting mode (seat-targeting strip appears)
 * 10. After seat-targeting: changing via seat chip updates the revision badge
 * to show the new assignee
 * 11. revision-badge data-assigned-to reflects the new assignee after change
 *
 * [revision interaction — dropdown]
 * 12. Changing the dropdown updates the revision badge to show the new assignee
 *
 * [real-time broadcast]
 * 13. onDeclareProgress is called when an assignment is changed via seat chip
 * 14. onDeclareProgress is called when an assignment is changed via dropdown
 * 15. Multiple revisions each trigger separate onDeclareProgress calls
 *
 * [accessibility]
 * 16. revision-badge has a descriptive aria-label including the assignee name
 * 17. revision-badge aria-label includes "tap to change" when not submitted
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

type RenderOpts = {
  myHand?: string[];
  players?: GamePlayer[];
  myPlayerId?: string;
  declaredSuits?: DeclaredSuit[];
  onConfirm?: jest.Mock;
  onCancel?: jest.Mock;
  isLoading?: boolean;
  onDeclareProgress?: jest.Mock;
};

function renderAndOpenLowSpades(opts: RenderOpts = {}) {
  const props = {
    myPlayerId: 'p1',
    // Hold 1_s to enable the Low Spades button; remaining 5 cards are assignable.
    myHand: opts.myHand ?? ['1_s'],
    players: opts.players ?? build6Players(),
    variant: 'remove_7s' as const,
    declaredSuits: opts.declaredSuits ?? [],
    onConfirm: opts.onConfirm ?? jest.fn(),
    onCancel: opts.onCancel ?? jest.fn(),
    isLoading: opts.isLoading ?? false,
    onDeclareProgress: opts.onDeclareProgress,
  };

  const utils = render(<DeclareModal {...props} />);
  // Navigate to Step 2 — card assignment
  fireEvent.click(screen.getByRole('button', { name: /Low Spades/i }));
  return { ...utils, props };
}

// ---------------------------------------------------------------------------
// Tests — revision badge presence
// ---------------------------------------------------------------------------

describe('DeclareModal revision badge — presence', () => {
  test('1. revision badges appear for each non-owned assignable card', () => {
    renderAndOpenLowSpades();
    // Pre-fill assigns all 5 non-owned cards to first teammate (p1 — Me)
    const badges = screen.getAllByTestId('revision-badge');
    // 5 non-owned cards in Low Spades (2_s–6_s for remove_7s; 1_s is held)
    expect(badges).toHaveLength(5);
  });

  test('2. owned cards do NOT have a revision badge', () => {
    renderAndOpenLowSpades({ myHand: ['1_s'] });
    // 1_s is in hand — the owned-card-row should NOT contain a revision-badge
    const ownedRow = screen.getAllByTestId('owned-card-row')[0];
    expect(within(ownedRow).queryByTestId('revision-badge')).toBeNull();
  });

  test('3. confirmed/locked cards have locked-assignment-badge, not revision-badge', () => {
    renderAndOpenLowSpades();
    // Lock the first assignable card via the confirm button
    const confirmBtns = screen.getAllByTestId('confirm-assignment-btn');
    fireEvent.click(confirmBtns[0]);

    // The first locked row should now show locked-assignment-badge
    const lockedRow = screen.getAllByTestId('locked-card-row')[0];
    expect(within(lockedRow).getByTestId('locked-assignment-badge')).toBeTruthy();
    expect(within(lockedRow).queryByTestId('revision-badge')).toBeNull();
  });

  test('4. revision badge not present when assignment is cleared to empty placeholder', () => {
    renderAndOpenLowSpades();
    // Clear first assignable card's dropdown to the empty placeholder
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: '' } });

    // Badges should decrease by 1 (the cleared card has no assignee)
    const badgesAfter = screen.getAllByTestId('revision-badge');
    expect(badgesAfter).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Tests — revision badge content
// ---------------------------------------------------------------------------

describe('DeclareModal revision badge — content', () => {
  test('5. badge shows the currently assigned teammate display name', () => {
    renderAndOpenLowSpades();
    // Pre-fill: all 5 non-owned cards assigned to the first OTHER teammate (p2 = Alice)
    const badges = screen.getAllByTestId('revision-badge');
    // Every badge should show "Alice" (first non-self teammate for p1 in build6Players)
    const firstBadge = badges[0];
    expect(firstBadge.textContent).toMatch(/Alice/i);
  });

  test('6. badge shows "(you)" suffix when card is assigned to the declarant', () => {
    renderAndOpenLowSpades({ myPlayerId: 'p1' });
    // Manually re-assign the first card to the declarant (p1) via dropdown,
    // then check the badge shows "(you)" suffix.
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'p1' } });
    const badge = screen.getAllByTestId('revision-badge')[0];
    expect(badge.textContent).toMatch(/\(you\)/i);
  });

  test('7. badge shows "✎ change" hint when not in loading state', () => {
    renderAndOpenLowSpades();
    const hints = screen.getAllByTestId('revision-badge-change-hint');
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0].textContent).toMatch(/change/i);
  });

  test('8. change hint is hidden when isLoading=true (declaration in-flight)', () => {
    // Render a fresh modal with isLoading=true and a partial hand
    render(
      <DeclareModal
        myPlayerId="p1"
        myHand={['1_s']}
        players={build6Players()}
        variant="remove_7s"
        declaredSuits={[]}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        isLoading={true}
      />
    );
    // Click the first (and only) "Low Spades" button to enter Step 2
    fireEvent.click(screen.getAllByRole('button', { name: /Low Spades/i })[0]);
    // Hints should not be present when submitted/loading
    expect(screen.queryByTestId('revision-badge-change-hint')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — revision interaction (badge click → seat-targeting)
// ---------------------------------------------------------------------------

describe('DeclareModal revision badge — interaction', () => {
  test('9. clicking a revision badge (which propagates to card-row) enters seat-targeting', () => {
    renderAndOpenLowSpades();
    const badge = screen.getAllByTestId('revision-badge')[0];
    // Click the badge (propagates to outer card-row div → handleCardTap)
    fireEvent.click(badge);
    expect(screen.getByTestId('seat-targeting-strip')).toBeTruthy();
  });

  test('10. after seat-targeting change, revision badge shows the new assignee', () => {
    renderAndOpenLowSpades();
    const badge = screen.getAllByTestId('revision-badge')[0];
    // Enter seat-targeting for the first assignable card
    fireEvent.click(badge);
    const strip = screen.getByTestId('seat-targeting-strip');
    // Tap the "Bob" chip (p3)
    const chips = within(strip).getAllByTestId('seat-target-chip');
    const bobChip = chips.find((c) => c.textContent?.includes('Bob'));
    expect(bobChip).toBeTruthy();
    fireEvent.click(bobChip!);
    // Badge should now show Bob, not Me
    const updatedBadge = screen.getAllByTestId('revision-badge')[0];
    expect(updatedBadge.textContent).toMatch(/Bob/i);
    expect(updatedBadge.textContent).not.toMatch(/^Me\b/);
  });

  test('11. revision-badge data-assigned-to reflects the new assignee after revision', () => {
    renderAndOpenLowSpades();
    const badge = screen.getAllByTestId('revision-badge')[0];
    // Enter seat-targeting
    fireEvent.click(badge);
    const strip = screen.getByTestId('seat-targeting-strip');
    // Tap Alice (p2)
    const chips = within(strip).getAllByTestId('seat-target-chip');
    const aliceChip = chips.find((c) => c.getAttribute('data-player-id') === 'p2');
    expect(aliceChip).toBeTruthy();
    fireEvent.click(aliceChip!);
    // data-assigned-to attribute should update to p2
    const updatedBadge = screen.getAllByTestId('revision-badge')[0];
    expect(updatedBadge.getAttribute('data-assigned-to')).toBe('p2');
  });
});

// ---------------------------------------------------------------------------
// Tests — revision via dropdown
// ---------------------------------------------------------------------------

describe('DeclareModal revision badge — dropdown revision', () => {
  test('12. changing the dropdown updates the revision badge to show the new assignee', () => {
    renderAndOpenLowSpades({ myPlayerId: 'p1' });
    const selects = screen.getAllByRole('combobox');
    // Change first card to Bob (p3) via dropdown
    fireEvent.change(selects[0], { target: { value: 'p3' } });
    // Badge for first assignable card should show Bob
    const badge = screen.getAllByTestId('revision-badge')[0];
    expect(badge.textContent).toMatch(/Bob/i);
    expect(badge.getAttribute('data-assigned-to')).toBe('p3');
  });
});

// ---------------------------------------------------------------------------
// Tests — real-time broadcast on revision
// ---------------------------------------------------------------------------

describe('DeclareModal revision badge — real-time broadcast', () => {
  test('13. onDeclareProgress called when assignment changed via seat chip revision', () => {
    const onDeclareProgress = jest.fn();
    renderAndOpenLowSpades({ onDeclareProgress: onDeclareProgress as jest.Mock });
    onDeclareProgress.mockClear(); // ignore initial suit-select broadcast

    // Enter seat-targeting for first card and pick Alice
    const badge = screen.getAllByTestId('revision-badge')[0];
    fireEvent.click(badge);
    const strip = screen.getByTestId('seat-targeting-strip');
    const chips = within(strip).getAllByTestId('seat-target-chip');
    const aliceChip = chips.find((c) => c.getAttribute('data-player-id') === 'p2');
    fireEvent.click(aliceChip!);

    // onDeclareProgress should have been called with updated assignment
    expect(onDeclareProgress).toHaveBeenCalled();
    const [suitId, assignmentArg] = onDeclareProgress.mock.calls[
      onDeclareProgress.mock.calls.length - 1
    ];
    expect(suitId).toBe('low_s');
    // First assignable card in low_s is 2_s (1_s is held by p1)
    const firstAssignableCard = Object.keys(assignmentArg).find(
      (k) => assignmentArg[k] === 'p2'
    );
    expect(firstAssignableCard).toBeTruthy();
  });

  test('14. onDeclareProgress called when assignment changed via dropdown revision', () => {
    const onDeclareProgress = jest.fn();
    renderAndOpenLowSpades({ onDeclareProgress: onDeclareProgress as jest.Mock });
    onDeclareProgress.mockClear();

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'p3' } });

    expect(onDeclareProgress).toHaveBeenCalled();
    const [suitId, assignmentArg] = onDeclareProgress.mock.calls[
      onDeclareProgress.mock.calls.length - 1
    ];
    expect(suitId).toBe('low_s');
    // Some card should be assigned to p3 after the change
    const hasP3Assignment = Object.values(assignmentArg as Record<string, string>).includes('p3');
    expect(hasP3Assignment).toBe(true);
  });

  test('15. multiple revisions each trigger separate onDeclareProgress calls', () => {
    const onDeclareProgress = jest.fn();
    renderAndOpenLowSpades({ onDeclareProgress: onDeclareProgress as jest.Mock });
    onDeclareProgress.mockClear();

    const selects = screen.getAllByRole('combobox');
    // Three dropdown revisions
    fireEvent.change(selects[0], { target: { value: 'p2' } }); // revision 1
    fireEvent.change(selects[0], { target: { value: 'p3' } }); // revision 2
    fireEvent.change(selects[1], { target: { value: 'p2' } }); // revision 3

    // Each change triggers an effect → broadcast
    expect(onDeclareProgress.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Tests — accessibility
// ---------------------------------------------------------------------------

describe('DeclareModal revision badge — accessibility', () => {
  test('16. revision badge has aria-label including the assignee name', () => {
    renderAndOpenLowSpades();
    const badge = screen.getAllByTestId('revision-badge')[0];
    const label = badge.getAttribute('aria-label') ?? '';
    // Label should reference the assigned player (default pre-fill is Alice / p2)
    expect(label).toMatch(/assigned to/i);
    expect(label).toMatch(/Alice/i);
  });

  test('17. revision badge aria-label includes "tap to change" when not submitted', () => {
    renderAndOpenLowSpades();
    const badge = screen.getAllByTestId('revision-badge')[0];
    const label = badge.getAttribute('aria-label') ?? '';
    expect(label).toMatch(/tap to change/i);
  });

  test('18. revision badge aria-label does not include "tap to change" when submitted', () => {
    // Render a fresh modal with isLoading=true
    render(
      <DeclareModal
        myPlayerId="p1"
        myHand={['1_s']}
        players={build6Players()}
        variant="remove_7s"
        declaredSuits={[]}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        isLoading={true}
      />
    );
    fireEvent.click(screen.getAllByRole('button', { name: /Low Spades/i })[0]);
    const badges = screen.queryAllByTestId('revision-badge');
    for (const b of badges) {
      const label = b.getAttribute('aria-label') ?? '';
      expect(label).not.toMatch(/tap to change/i);
    }
  });
});
