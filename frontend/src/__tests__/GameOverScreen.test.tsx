/**
 * @jest-environment jsdom
 *
 * + 44a: GameOverScreen — frontend game-over screen tests.
 *
 * Coverage:
 * 1. Renders with data-testid="game-over-screen" by default
 * 2. Custom testId override works
 * 3. Shows "Game Over" heading always
 * 4. Winner announcement: Team 1 wins
 * 5. Winner announcement: Team 2 wins
 * 6. Tie announcement when winner is null
 * 7. Tie announcement when scores are equal (4-4, no tiebreaker)
 * 8. Winning player (myTeamId matches winner) sees '🎉'
 * 9. Losing player (myTeamId does not match winner) sees '😔' emoji
 * 10. Spectator (myTeamId is null) sees '🏆' emoji for non-tie
 * 11. Displays correct Team 1 score
 * 12. Displays correct Team 2 score
 * 13. Tiebreak section shown when scores are 4-4 and tiebreakerWinner is set
 * 14. Tiebreak section mentions the winning team
 * 15. Tiebreak section mentions "High ♦" and "High Diamonds"
 * 16. Tiebreak section NOT shown when scores are NOT 4-4
 * 17. Tiebreak section NOT shown when tiebreakerWinner is null even if scores are 4-4
 * 18. Half-suit tally section is rendered
 * 19. All 4 suit groups are rendered (spades, hearts, diamonds, clubs)
 * 20. All 8 half-suit rows are present
 * 21. Declared half-suit shows team badge
 * 22. Undeclared half-suit shows "—"
 * 23. Team 1 declared suit shows T1 badge
 * 24. Team 2 declared suit shows T2 badge
 * 25. high_d row carries the tiebreaker star marker
 * 26. Room code shown in subtitle
 * 27. Variant shown in subtitle
 * 28. No subtitle rendered when neither roomCode nor variant is provided
 * 29. Correct aria-label on the root element
 * 30. score-team1 and score-team2 testIds carry the numeric values
 * -- per-player declaration stats table --
 * 31. Stats table NOT rendered when players prop is omitted
 * 32. Stats table NOT rendered when players array is empty
 * 33. Stats table rendered when players prop is provided
 * 34. Only players who made at least one declaration appear in the table
 * 35. Player row shows correct display name
 * 36. Attempts column shows total declaration count per player
 * 37. Successes column shows correct declaration count per player
 * 38. Failures column shows incorrect declaration count per player
 * 39. Player on own team sees "(You)" label
 * 40. Correct declaration = player's team matches winning team
 * 41. Incorrect declaration = player's team does not match winning team
 * 42. Stats table aria-label is present
 * 43. Each player row has correct aria-label with attempt/success/failure counts
 * 44. Rows are sorted: Team 1 first, then Team 2, within team by successes desc
 * 45. computePlayerStats exported function: handles empty inputs
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import GameOverScreen, { computePlayerStats } from '@/components/GameOverScreen';
import type { DeclaredSuit, GamePlayer } from '@/types/game';

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

/** Helper: build a minimal GamePlayer object for testing. */
function makePlayer(
  playerId: string,
  displayName: string,
  teamId: 1 | 2,
  overrides: Partial<GamePlayer> = {},
): GamePlayer {
  return {
    playerId,
    displayName,
    teamId,
    avatarId: null,
    seatIndex: 0,
    cardCount: 0,
    isBot: false,
    isGuest: false,
    isCurrentTurn: false,
    ...overrides,
  };
}

/** 6-player roster: p1–p3 on T1, p4–p6 on T2. */
const SIX_PLAYERS: GamePlayer[] = [
  makePlayer('p1', 'Alice',   1, { seatIndex: 0 }),
  makePlayer('p2', 'Bob',     2, { seatIndex: 1 }),
  makePlayer('p3', 'Charlie', 1, { seatIndex: 2 }),
  makePlayer('p4', 'Dana',    2, { seatIndex: 3 }),
  makePlayer('p5', 'Eve',     1, { seatIndex: 4 }),
  makePlayer('p6', 'Frank',   2, { seatIndex: 5 }),
];

/**
 * Declared suits where:
 * - p1 (T1) declared low_s → T1 scores → SUCCESS for p1
 * - p1 (T1) declared low_h → T2 scores → FAILURE for p1 (incorrect)
 * - p2 (T2) declared high_s → T2 scores → SUCCESS for p2
 * - p3 (T1) declared low_d → T1 scores → SUCCESS for p3
 * - p3 (T1) declared high_d → T1 scores → SUCCESS for p3
 * - p4 (T2) declared high_h → T1 scores → FAILURE for p4 (incorrect)
 * - p4 (T2) declared low_c → T2 scores → SUCCESS for p4
 * - p6 (T2) declared high_c → T2 scores → SUCCESS for p6
 */
const MIXED_DECLARATIONS: DeclaredSuit[] = [
  { halfSuitId: 'low_s',  teamId: 1, declaredBy: 'p1' }, // p1 success
  { halfSuitId: 'low_h',  teamId: 2, declaredBy: 'p1' }, // p1 failure (T1 declared, T2 got point)
  { halfSuitId: 'high_s', teamId: 2, declaredBy: 'p2' }, // p2 success
  { halfSuitId: 'low_d',  teamId: 1, declaredBy: 'p3' }, // p3 success
  { halfSuitId: 'high_d', teamId: 1, declaredBy: 'p3' }, // p3 success
  { halfSuitId: 'high_h', teamId: 1, declaredBy: 'p4' }, // p4 failure (T2 declared, T1 got point)
  { halfSuitId: 'low_c',  teamId: 2, declaredBy: 'p4' }, // p4 success
  { halfSuitId: 'high_c', teamId: 2, declaredBy: 'p6' }, // p6 success
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

  // ── per-player declaration stats table ──────────────────────────

  // 31. Stats table NOT rendered when players prop is omitted
  it('does not render player-stats-table when players prop is omitted', () => {
    render(<GameOverScreen {...makeProps({ declaredSuits: MIXED_DECLARATIONS })} />);
    expect(screen.queryByTestId('player-stats-table')).toBeNull();
  });

  // 32. Stats table NOT rendered when players array is empty
  it('does not render player-stats-table when players array is empty', () => {
    render(<GameOverScreen {...makeProps({ declaredSuits: MIXED_DECLARATIONS, players: [] })} />);
    expect(screen.queryByTestId('player-stats-table')).toBeNull();
  });

  // 33. Stats table IS rendered when players prop is provided with data
  it('renders player-stats-table when players prop is provided', () => {
    render(
      <GameOverScreen
        {...makeProps({ declaredSuits: MIXED_DECLARATIONS, players: SIX_PLAYERS })}
      />,
    );
    expect(screen.getByTestId('player-stats-table')).toBeTruthy();
  });

  // 34. Only players who declared appear in the table (p5 never declared — not shown)
  it('shows only players who made at least one declaration', () => {
    render(
      <GameOverScreen
        {...makeProps({ declaredSuits: MIXED_DECLARATIONS, players: SIX_PLAYERS })}
      />,
    );
    // p5 (Eve) never declared — should not appear
    expect(screen.queryByTestId('player-stats-row-p5')).toBeNull();
    // p1, p2, p3, p4, p6 all declared — should appear
    expect(screen.getByTestId('player-stats-row-p1')).toBeTruthy();
    expect(screen.getByTestId('player-stats-row-p2')).toBeTruthy();
    expect(screen.getByTestId('player-stats-row-p3')).toBeTruthy();
    expect(screen.getByTestId('player-stats-row-p4')).toBeTruthy();
    expect(screen.getByTestId('player-stats-row-p6')).toBeTruthy();
  });

  // 35. Player row shows correct display name
  it('shows the player display name in the stats row', () => {
    render(
      <GameOverScreen
        {...makeProps({ declaredSuits: MIXED_DECLARATIONS, players: SIX_PLAYERS })}
      />,
    );
    expect(screen.getByTestId('stats-player-name-p1').textContent).toContain('Alice');
    expect(screen.getByTestId('stats-player-name-p2').textContent).toContain('Bob');
  });

  // 36. Attempts column shows total declaration count per player
  it('shows correct attempts count for each player', () => {
    render(
      <GameOverScreen
        {...makeProps({ declaredSuits: MIXED_DECLARATIONS, players: SIX_PLAYERS })}
      />,
    );
    // p1 declared 2 suits (low_s + low_h)
    expect(screen.getByTestId('stats-attempts-p1').textContent).toBe('2');
    // p3 declared 2 suits (low_d + high_d)
    expect(screen.getByTestId('stats-attempts-p3').textContent).toBe('2');
    // p2 declared 1 suit (high_s)
    expect(screen.getByTestId('stats-attempts-p2').textContent).toBe('1');
    // p4 declared 2 suits (high_h + low_c)
    expect(screen.getByTestId('stats-attempts-p4').textContent).toBe('2');
    // p6 declared 1 suit (high_c)
    expect(screen.getByTestId('stats-attempts-p6').textContent).toBe('1');
  });

  // 37. Successes column shows correct declaration count
  it('shows correct successes count for each player', () => {
    render(
      <GameOverScreen
        {...makeProps({ declaredSuits: MIXED_DECLARATIONS, players: SIX_PLAYERS })}
      />,
    );
    // p1 (T1): low_s → T1 scores (SUCCESS), low_h → T2 scores (FAILURE) → 1 success
    expect(screen.getByTestId('stats-successes-p1').textContent).toBe('1');
    // p3 (T1): low_d → T1 scores (SUCCESS), high_d → T1 scores (SUCCESS) → 2 successes
    expect(screen.getByTestId('stats-successes-p3').textContent).toBe('2');
    // p2 (T2): high_s → T2 scores (SUCCESS) → 1 success
    expect(screen.getByTestId('stats-successes-p2').textContent).toBe('1');
    // p4 (T2): high_h → T1 scores (FAILURE), low_c → T2 scores (SUCCESS) → 1 success
    expect(screen.getByTestId('stats-successes-p4').textContent).toBe('1');
  });

  // 38. Failures column shows incorrect declaration count
  it('shows correct failures count for each player', () => {
    render(
      <GameOverScreen
        {...makeProps({ declaredSuits: MIXED_DECLARATIONS, players: SIX_PLAYERS })}
      />,
    );
    // p1: 1 failure (low_h gave T2 the point)
    expect(screen.getByTestId('stats-failures-p1').textContent).toBe('1');
    // p3: 0 failures
    expect(screen.getByTestId('stats-failures-p3').textContent).toBe('0');
    // p4: 1 failure (high_h gave T1 the point)
    expect(screen.getByTestId('stats-failures-p4').textContent).toBe('1');
    // p6: 0 failures
    expect(screen.getByTestId('stats-failures-p6').textContent).toBe('0');
  });

  // 39. Player on own team sees "(You)" label
  it('shows (You) label for the local player', () => {
    // myTeamId=1 and p1 is on T1; p1 will show (You)
    // NOTE: isMe is checked by teamId, not playerId — all T1 players show (You)
    // Confirm Alice (p1, T1) shows (You) when myTeamId=1
    render(
      <GameOverScreen
        {...makeProps({
          declaredSuits: MIXED_DECLARATIONS,
          players: SIX_PLAYERS,
          myTeamId: 1,
        })}
      />,
    );
    const aliceName = screen.getByTestId('stats-player-name-p1');
    expect(aliceName.textContent).toContain('(You)');
  });

  // 40. Correct declaration: player's team matches winning team
  it('computePlayerStats: correct declaration increments successes', () => {
    const suits: DeclaredSuit[] = [
      { halfSuitId: 'low_s', teamId: 1, declaredBy: 'p1' }, // p1 (T1) declared, T1 wins → success
    ];
    const players: GamePlayer[] = [makePlayer('p1', 'Alice', 1)];
    const stats = computePlayerStats(suits, players);
    expect(stats).toHaveLength(1);
    expect(stats[0].successes).toBe(1);
    expect(stats[0].failures).toBe(0);
  });

  // 41. Incorrect declaration: player's team does not match winning team
  it('computePlayerStats: incorrect declaration increments failures', () => {
    const suits: DeclaredSuit[] = [
      { halfSuitId: 'low_s', teamId: 2, declaredBy: 'p1' }, // p1 (T1) declared, T2 wins → failure
    ];
    const players: GamePlayer[] = [makePlayer('p1', 'Alice', 1)];
    const stats = computePlayerStats(suits, players);
    expect(stats).toHaveLength(1);
    expect(stats[0].successes).toBe(0);
    expect(stats[0].failures).toBe(1);
  });

  // 42. Stats table has correct aria-label
  it('player-stats-table section has aria-label="Player declaration statistics"', () => {
    render(
      <GameOverScreen
        {...makeProps({ declaredSuits: MIXED_DECLARATIONS, players: SIX_PLAYERS })}
      />,
    );
    const section = screen.getByTestId('player-stats-table');
    expect(section.getAttribute('aria-label')).toBe('Player declaration statistics');
  });

  // 43. Each player row has correct aria-label with attempt/success/failure counts
  it('each player row aria-label contains attempts, successes, failures counts', () => {
    render(
      <GameOverScreen
        {...makeProps({ declaredSuits: MIXED_DECLARATIONS, players: SIX_PLAYERS })}
      />,
    );
    // p3: 2 attempts, 2 successes, 0 failures
    const row = screen.getByTestId('player-stats-row-p3');
    const label = row.getAttribute('aria-label') ?? '';
    expect(label).toContain('2 attempts');
    expect(label).toContain('2 successes');
    expect(label).toContain('0 failures');
  });

  // 44. Rows sorted: T1 first, then T2; within team by successes desc
  it('computePlayerStats: rows are sorted T1 first, then T2, successes desc within team', () => {
    const stats = computePlayerStats(MIXED_DECLARATIONS, SIX_PLAYERS);
    // T1 players: p1 (1 success, 2 attempts), p3 (2 successes, 2 attempts)
    // Within T1: p3 (2 successes) before p1 (1 success)
    // T2 players: p2 (1 success, 1 attempt), p4 (1 success, 2 attempts), p6 (1 success, 1 attempt)
    const t1Stats = stats.filter((s) => s.teamId === 1);
    const t2Stats = stats.filter((s) => s.teamId === 2);

    // All T1 rows appear before all T2 rows
    const firstT2Idx = stats.findIndex((s) => s.teamId === 2);
    const lastT1Idx = stats.reduce((acc, s, i) => (s.teamId === 1 ? i : acc), -1);
    expect(lastT1Idx).toBeLessThan(firstT2Idx);

    // Within T1: p3 (2 successes) comes before p1 (1 success)
    expect(t1Stats[0].playerId).toBe('p3');
    expect(t1Stats[1].playerId).toBe('p1');

    // All T2 players have 1 success; p4 has 2 attempts so comes before p2/p6 (1 attempt each)
    expect(t2Stats[0].playerId).toBe('p4');
  });

  // 45. computePlayerStats: handles empty inputs gracefully
  it('computePlayerStats: returns empty array for empty declaredSuits', () => {
    const stats = computePlayerStats([], SIX_PLAYERS);
    expect(stats).toHaveLength(0);
  });
});
