/**
 * @jest-environment jsdom
 *
 * Inference-mode tests for AskCardModal — Sub-AC 37c
 *
 * Verifies that when `getCardProbabilities` is provided, the modal renders
 * uniform-distribution probability hints next to each opponent.
 *
 * Coverage:
 *   • No inference hints when getCardProbabilities is not provided
 *   • Renders inference-pct-hint for each opponent when mode is active
 *   • Shows correct ~XX% value from getCardProbabilities
 *   • Hint is not shown for players with 0% probability
 *   • aria-label includes "~XX% likely" when inference is active
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import AskCardModal from '@/components/AskCardModal';
import type { GamePlayer } from '@/types/game';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makePlayer(overrides: Partial<GamePlayer> = {}): GamePlayer {
  return {
    playerId: 'p1',
    displayName: 'Alice',
    avatarId: null,
    teamId: 1,
    seatIndex: 0,
    cardCount: 6,
    isBot: false,
    isGuest: false,
    isCurrentTurn: false,
    ...overrides,
  };
}

function make6Players(): GamePlayer[] {
  return [
    makePlayer({ playerId: 'p1', displayName: 'Me',    teamId: 1, seatIndex: 0 }),
    makePlayer({ playerId: 'p2', displayName: 'Alice', teamId: 1, seatIndex: 2 }),
    makePlayer({ playerId: 'p3', displayName: 'Bob',   teamId: 1, seatIndex: 4 }),
    makePlayer({ playerId: 'p4', displayName: 'Carol', teamId: 2, seatIndex: 1, cardCount: 4 }),
    makePlayer({ playerId: 'p5', displayName: 'Dave',  teamId: 2, seatIndex: 3, cardCount: 4 }),
    makePlayer({ playerId: 'p6', displayName: 'Eve',   teamId: 2, seatIndex: 5, cardCount: 4 }),
  ];
}

function renderModal(opts: {
  getCardProbabilities?: (cardId: string) => Record<string, number>;
} = {}) {
  const players = make6Players();
  return render(
    <AskCardModal
      selectedCard="5_h"
      myPlayerId="p1"
      players={players}
      variant="remove_7s"
      onConfirm={jest.fn()}
      onCancel={jest.fn()}
      getCardProbabilities={opts.getCardProbabilities}
    />,
  );
}

// ── No inference mode ─────────────────────────────────────────────────────────

describe('AskCardModal — no inference mode', () => {
  it('renders no probability hints when getCardProbabilities is undefined', () => {
    renderModal();
    const hints = document.querySelectorAll('[data-testid="inference-pct-hint"]');
    expect(hints.length).toBe(0);
  });
});

// ── With inference mode ───────────────────────────────────────────────────────

describe('AskCardModal — with inference mode active', () => {
  // Simulate: p4=50%, p5=33%, p6=17% (weights: 6,4,2 = total 12)
  const mockGetProbs = jest.fn((cardId: string) => ({
    p4: 50,
    p5: 33,
    p6: 17,
  }));

  beforeEach(() => mockGetProbs.mockClear());

  it('renders inference-pct-hint for each opponent with non-zero probability', () => {
    renderModal({ getCardProbabilities: mockGetProbs });
    const hints = document.querySelectorAll('[data-testid="inference-pct-hint"]');
    // 3 opponents (p4, p5, p6) all have non-zero probs
    expect(hints.length).toBe(3);
  });

  it('shows the correct ~XX% value for each opponent', () => {
    renderModal({ getCardProbabilities: mockGetProbs });
    const hints = Array.from(
      document.querySelectorAll('[data-testid="inference-pct-hint"]'),
    ).map((el) => el.textContent);
    expect(hints.some((t) => t?.includes('50%'))).toBe(true);
    expect(hints.some((t) => t?.includes('33%'))).toBe(true);
    expect(hints.some((t) => t?.includes('17%'))).toBe(true);
  });

  it('does not render hint for opponent with 0% probability', () => {
    const zeroProbs = jest.fn(() => ({ p4: 100, p5: 0, p6: 0 }));
    renderModal({ getCardProbabilities: zeroProbs });
    const hints = document.querySelectorAll('[data-testid="inference-pct-hint"]');
    // Only p4 has non-zero probability
    expect(hints.length).toBe(1);
    expect(hints[0].textContent).toContain('100%');
  });

  it('aria-label of opponent button includes "~XX% likely" when inference is active', () => {
    renderModal({ getCardProbabilities: mockGetProbs });
    // Carol (p4) should have ~50% in aria-label
    const carolBtn = screen.getByRole('button', { name: /Carol/i });
    expect(carolBtn.getAttribute('aria-label')).toContain('~50% likely');
  });

  it('calls getCardProbabilities with the selected card id', () => {
    renderModal({ getCardProbabilities: mockGetProbs });
    expect(mockGetProbs).toHaveBeenCalledWith('5_h');
  });
});
