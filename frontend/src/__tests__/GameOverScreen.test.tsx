/**
 * @jest-environment jsdom
 *
 * Sub-AC 32d: GameOverScreen — frontend game-over screen tests.
 *
 * Coverage:
 *   1.  Renders with data-testid="game-over-screen" by default
 *   2.  Custom testId override works
 *   3.  Shows "Game Over" heading always
 *   4.  Winner announcement: Team 1 wins
 *   5.  Winner announcement: Team 2 wins
 *   6.  Tie announcement when winner is null
 *   7.  Tie announcement when scores are equal (4-4, no tiebreaker)
 *   8.  Winning player (myTeamId matches winner) sees '🎉'
 *   9.  Losing player (myTeamId does not match winner) sees '😔' emoji
 *  10.  Spectator (myTeamId is null) sees '🏆' emoji for non-tie
 *  11.  Displays correct Team 1 score
 *  12.  Displays correct Team 2 score
 *  13.  Tiebreak section shown when scores are 4-4 and tiebreakerWinner is set
 *  14.  Tiebreak section mentions the winning team
 *  15.  Tiebreak section mentions "High ♦" and "High Diamonds"
 *  16.  Tiebreak section NOT shown when scores are NOT 4-4
 *  17.  Tiebreak section NOT shown when tiebreakerWinner is null even if scores are 4-4
 *  18.  Half-suit tally section is rendered
 *  19.  All 4 suit groups are rendered (spades, hearts, diamonds, clubs)
 *  20.  All 8 half-suit rows are present
 *  21.  Declared half-suit shows team badge
 *  22.  Undeclared half-suit shows "—"
 *  23.  Team 1 declared suit shows T1 badge
 *  24.  Team 2 declared suit shows T2 badge
 *  25.  high_d row carries the tiebreaker star marker
 *  26.  Room code shown in subtitle
 *  27.  Variant shown in subtitle
 *  28.  No subtitle rendered when neither roomCode nor variant is provided
 *  29.  Correct aria-label on the root element
 *  30.  score-team1 and score-team2 testIds carry the numeric values
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import GameOverScreen from '@/components/GameOverScreen';
import type { DeclaredSuit } from '@/types/game';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ALL_HALF_SUITS: DeclaredSuit[] = [
  { halfSuitId: 'low_s',  teamId: 1, declaredBy: 'p1' },
  { halfSuitId: 'high_s', teamId: 2, declaredBy: 'p2' },
  { halfSuitId: 'low_h',  teamId: 1, declaredBy: 'p1' },
  { halfSuitId: 'high_h', teamId: 2, declaredBy: 'p2' },
  { halfSuitId: 'low_d',  teamId: 1, declaredBy: 'p1' },
  { halfSuitId: 'high_d', teamId: 2, declaredBy: 'p2' },
  { halfSuitId: 'low_c',  teamId: 1, declaredBy: 'p1' },
  { halfSuitId: 'high_c', teamId: 2, declaredBy: 'p2' },
];

function makeProps(overrides: Partial<React.ComponentProps<typeof GameOverScreen>> = {}) {
  return {
    winner: 1 as const,
    tiebreakerWinner: null,
    scores: { team1: 5, team2: 3 },
    declaredSuits: ALL_HALF_SUITS,
    myTeamId: 1 as const,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GameOverScreen', () => {
  // 1. Default testId
  it('renders with data-testid="game-over-screen" by default', () => {
    render(<GameOverScreen {...makeProps()} />);
    expect(screen.getByTestId('game-over-screen')).toBeTruthy();
  });

  // 2. Custom testId
  it('accepts a custom testId override', () => {
    render(<GameOverScreen {...makeProps()} testId="my-custom-id" />);
    expect(screen.getByTestId('my-custom-id')).toBeTruthy();
  });

  // 3. "Game Over" heading always present
  it('shows "Game Over" heading', () => {
    render(<GameOverScreen {...makeProps()} />);
    expect(screen.getByRole('heading', { name: /game over/i })).toBeTruthy();
  });

  // 4. Team 1 winner announcement
  it('shows "Team 1 wins" when winner is 1', () => {
    render(<GameOverScreen {...makeProps({ winner: 1, scores: { team1: 5, team2: 3 } })} />);
    const el = screen.getByTestId('result-winner');
    expect(el.textContent).toMatch(/Team 1 wins/i);
  });

  // 5. Team 2 winner announcement
  it('shows "Team 2 wins" when winner is 2', () => {
    render(<GameOverScreen {...makeProps({ winner: 2, myTeamId: 1, scores: { team1: 3, team2: 5 } })} />);
    const el = screen.getByTestId('result-winner');
    expect(el.textContent).toMatch(/Team 2 wins/i);
  });

  // 6. Tie announcement (winner null)
  it('shows tie message when winner is null', () => {
    render(<GameOverScreen {...makeProps({ winner: null, scores: { team1: 4, team2: 4 } })} />);
    expect(screen.getByTestId('result-tie')).toBeTruthy();
  });

  // 7. Tie announcement (scores equal, winner explicitly null)
  it('shows tie message when scores are equal and winner is null', () => {
    render(<GameOverScreen {...makeProps({ winner: null, scores: { team1: 4, team2: 4 }, tiebreakerWinner: null })} />);
    expect(screen.getByTestId('result-tie')).toBeTruthy();
  });

  // 8. Winning player sees 🎉
  it('shows 🎉 when the local player is on the winning team', () => {
    render(<GameOverScreen {...makeProps({ winner: 1, myTeamId: 1 })} />);
    const el = screen.getByTestId('result-winner');
    expect(el.textContent).toContain('🎉');
  });

  // 9. Losing player sees 😔 emoji
  it('shows 😔 emoji when local player is on the losing team', () => {
    render(<GameOverScreen {...makeProps({ winner: 1, myTeamId: 2, scores: { team1: 5, team2: 3 } })} />);
    const hero = screen.getByTestId('game-over-hero');
    expect(hero.textContent).toContain('😔');
  });

  // 10. Spectator (myTeamId null) sees 🏆 for a non-tie
  it('shows 🏆 emoji for spectator on non-tie games', () => {
    render(<GameOverScreen {...makeProps({ winner: 1, myTeamId: null, scores: { team1: 5, team2: 3 } })} />);
    const hero = screen.getByTestId('game-over-hero');
    expect(hero.textContent).toContain('🏆');
  });

  // 11. Team 1 score displayed
  it('displays Team 1 score in score-team1 element', () => {
    render(<GameOverScreen {...makeProps({ scores: { team1: 6, team2: 2 } })} />);
    expect(screen.getByTestId('score-team1').textContent).toBe('6');
  });

  // 12. Team 2 score displayed
  it('displays Team 2 score in score-team2 element', () => {
    render(<GameOverScreen {...makeProps({ scores: { team1: 6, team2: 2 } })} />);
    expect(screen.getByTestId('score-team2').textContent).toBe('2');
  });

  // 13. Tiebreak section shown for 4-4 with tiebreakerWinner
  it('renders tiebreak section when scores are 4-4 and tiebreakerWinner is set', () => {
    render(
      <GameOverScreen
        {...makeProps({ winner: 2, scores: { team1: 4, team2: 4 }, tiebreakerWinner: 2 })}
      />
    );
    expect(screen.getByTestId('tiebreak-reason')).toBeTruthy();
  });

  // 14. Tiebreak section mentions winning team
  it('tiebreak section mentions the winning team number', () => {
    render(
      <GameOverScreen
        {...makeProps({ winner: 2, scores: { team1: 4, team2: 4 }, tiebreakerWinner: 2 })}
      />
    );
    const section = screen.getByTestId('tiebreak-reason');
    expect(section.textContent).toContain('Team 2');
  });

  // 15. Tiebreak section mentions "High ♦" and "High Diamonds"
  it('tiebreak section mentions High ♦ (High Diamonds)', () => {
    render(
      <GameOverScreen
        {...makeProps({ winner: 1, scores: { team1: 4, team2: 4 }, tiebreakerWinner: 1 })}
      />
    );
    const section = screen.getByTestId('tiebreak-reason');
    expect(section.textContent).toContain('High');
    expect(section.textContent).toContain('Diamonds');
  });

  // 16. Tiebreak NOT shown when scores differ
  it('does not render tiebreak section when scores are not 4-4', () => {
    render(<GameOverScreen {...makeProps({ winner: 1, scores: { team1: 5, team2: 3 }, tiebreakerWinner: 1 })} />);
    expect(screen.queryByTestId('tiebreak-reason')).toBeNull();
  });

  // 17. Tiebreak NOT shown when tiebreakerWinner is null even at 4-4
  it('does not render tiebreak section when tiebreakerWinner is null at 4-4', () => {
    render(
      <GameOverScreen
        {...makeProps({ winner: null, scores: { team1: 4, team2: 4 }, tiebreakerWinner: null })}
      />
    );
    expect(screen.queryByTestId('tiebreak-reason')).toBeNull();
  });

  // 18. Half-suit tally section rendered
  it('renders half-suit tally section', () => {
    render(<GameOverScreen {...makeProps()} />);
    expect(screen.getByTestId('half-suit-tally')).toBeTruthy();
  });

  // 19. All 4 suit groups present
  it('renders tally groups for all 4 suits', () => {
    render(<GameOverScreen {...makeProps()} />);
    expect(screen.getByTestId('tally-suit-s')).toBeTruthy();
    expect(screen.getByTestId('tally-suit-h')).toBeTruthy();
    expect(screen.getByTestId('tally-suit-d')).toBeTruthy();
    expect(screen.getByTestId('tally-suit-c')).toBeTruthy();
  });

  // 20. All 8 half-suit rows present
  it('renders all 8 half-suit rows', () => {
    render(<GameOverScreen {...makeProps()} />);
    const halfSuits = ['low_s', 'high_s', 'low_h', 'high_h', 'low_d', 'high_d', 'low_c', 'high_c'];
    for (const id of halfSuits) {
      expect(screen.getByTestId(`tally-row-${id}`)).toBeTruthy();
    }
  });

  // 21. Declared half-suit shows team badge (aria-label contains team info)
  it('shows team badge for declared half-suits', () => {
    render(<GameOverScreen {...makeProps()} />);
    const row = screen.getByTestId('tally-row-low_s');
    // low_s is declared by team 1
    expect(row.getAttribute('aria-label')).toContain('Team 1');
  });

  // 22. Undeclared half-suit shows "—"
  it('shows "—" for undeclared half-suits', () => {
    render(
      <GameOverScreen
        {...makeProps({ declaredSuits: [] })}
      />
    );
    // All suits undeclared — check the first one
    const undeclaredEl = screen.getByTestId('tally-undeclared-low_s');
    expect(undeclaredEl).toBeTruthy();
  });

  // 23. Team 1 declared suit shows T1 badge
  it('shows T1 badge for team 1 declared suits', () => {
    const suits: DeclaredSuit[] = [{ halfSuitId: 'low_s', teamId: 1, declaredBy: 'p1' }];
    render(<GameOverScreen {...makeProps({ declaredSuits: suits })} />);
    const row = screen.getByTestId('tally-row-low_s');
    const badge = within(row).getByText('T1');
    expect(badge).toBeTruthy();
  });

  // 24. Team 2 declared suit shows T2 badge
  it('shows T2 badge for team 2 declared suits', () => {
    const suits: DeclaredSuit[] = [{ halfSuitId: 'high_s', teamId: 2, declaredBy: 'p2' }];
    render(<GameOverScreen {...makeProps({ declaredSuits: suits })} />);
    const row = screen.getByTestId('tally-row-high_s');
    const badge = within(row).getByText('T2');
    expect(badge).toBeTruthy();
  });

  // 25. high_d row has tiebreaker star marker
  it('high_d row has a tiebreaker star marker', () => {
    render(<GameOverScreen {...makeProps()} />);
    expect(screen.getByTestId('tiebreak-suit-marker')).toBeTruthy();
  });

  // 26. Room code shown in subtitle
  it('shows room code in subtitle', () => {
    render(<GameOverScreen {...makeProps({ roomCode: 'ABC123' })} />);
    expect(screen.getByTestId('game-over-subtitle').textContent).toContain('ABC123');
  });

  // 27. Variant shown in subtitle
  it('shows variant in subtitle', () => {
    render(<GameOverScreen {...makeProps({ variant: 'Remove 7s (Classic)' })} />);
    expect(screen.getByTestId('game-over-subtitle').textContent).toContain('Remove 7s');
  });

  // 28. No subtitle when neither roomCode nor variant provided
  it('does not render subtitle when no roomCode or variant', () => {
    render(<GameOverScreen {...makeProps({ roomCode: undefined, variant: undefined })} />);
    expect(screen.queryByTestId('game-over-subtitle')).toBeNull();
  });

  // 29. Correct aria-label on root
  it('has aria-label="Game over" on the root element', () => {
    render(<GameOverScreen {...makeProps()} />);
    expect(screen.getByRole('main', { name: /game over/i })).toBeTruthy();
  });

  // 30. score-team1 and score-team2 carry numeric values as text
  it('score-team1 and score-team2 textContent reflect the scores', () => {
    render(<GameOverScreen {...makeProps({ scores: { team1: 7, team2: 1 } })} />);
    expect(screen.getByTestId('score-team1').textContent).toBe('7');
    expect(screen.getByTestId('score-team2').textContent).toBe('1');
  });
});
