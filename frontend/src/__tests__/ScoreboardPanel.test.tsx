/**
 * @jest-environment jsdom
 *
 * Sub-AC 34a: ScoreboardPanel — side scoreboard panel shell tests.
 *
 * Coverage:
 *   1.  Renders with default data-testid="scoreboard-panel"
 *   2.  Custom testId override works
 *   3.  Renders both team sections (team1 and team2 data-testids)
 *   4.  Displays Team 1 name label
 *   5.  Displays Team 2 name label
 *   6.  Displays Team 1 score as a number
 *   7.  Displays Team 2 score as a number
 *   8.  Score shows correct value for team1 (e.g. 3)
 *   9.  Score shows correct value for team2 (e.g. 5)
 *  10.  "No books yet" placeholder shown when team has no declared suits
 *  11.  Suit badges rendered for each declared suit
 *  12.  Team 1 declared suits appear in Team 1 section only
 *  13.  Team 2 declared suits appear in Team 2 section only
 *  14.  "(You)" suffix shown on Team 1 when myTeamId=1
 *  15.  "(You)" suffix shown on Team 2 when myTeamId=2
 *  16.  "(You)" suffix NOT shown when myTeamId is null
 *  17.  Score flash: team1 score has yellow class when scoreFlash=1
 *  18.  Score flash: team2 score has yellow class when scoreFlash=2
 *  19.  Score flash: no yellow class when scoreFlash is null
 *  20.  aria-label="Scoreboard" on root element
 *  21.  aria-label on team1 section describes team correctly
 *  22.  aria-label on team2 section describes team correctly
 *  23.  Declared suit badge has correct title attribute (human-readable half-suit label)
 *  24.  Skeleton rendered when ConnectedScoreboardPanel has no gameState
 *  25.  ConnectedScoreboardPanel shows scores from GameContext
 *  26.  Score totals header shows combined count (e.g. "3/8")
 *  27.  Zero scores displayed correctly (0 for both teams at game start)
 *  28.  Maximum scores displayed correctly (8 total books)
 *  29.  ScoreboardPanel accepts and applies extra className
 *  30.  Suit badge data-testid follows pattern "scoreboard-suit-badge-{halfSuitId}"
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import ScoreboardPanel, { ConnectedScoreboardPanel } from '@/components/ScoreboardPanel';
import type { DeclaredSuit } from '@/types/game';
import type { GameContextValue } from '@/contexts/GameContext';
import { GameProvider } from '@/contexts/GameContext';
import type { PublicGameState } from '@/types/game';

// ── Helpers ────────────────────────────────────────────────────────────────────

const DECLARED_SUITS_MIXED: DeclaredSuit[] = [
  { halfSuitId: 'low_s',  teamId: 1, declaredBy: 'p1' },
  { halfSuitId: 'high_s', teamId: 2, declaredBy: 'p2' },
  { halfSuitId: 'low_h',  teamId: 1, declaredBy: 'p1' },
];

function makeGameState(overrides: Partial<PublicGameState> = {}): PublicGameState {
  return {
    status: 'active',
    currentTurnPlayerId: 'p1',
    scores: { team1: 2, team2: 1 },
    lastMove: null,
    winner: null,
    tiebreakerWinner: null,
    declaredSuits: DECLARED_SUITS_MIXED,
    ...overrides,
  };
}

/** Minimal GameContext value for ConnectedScoreboardPanel tests. */
function makeContextValue(gameState: PublicGameState | null): Omit<GameContextValue, 'getPlayerBySeat'> {
  return {
    wsStatus: 'connected',
    myPlayerId: 'p1',
    myHand: [],
    players: [],
    gameState,
    variant: 'remove_7s',
    playerCount: 6,
    turnTimer: null,
    lastAskResult: null,
    lastDeclareResult: null,
    declareProgress: null,
    sendDeclareProgress: () => {},
    error: null,
    rematchVote: null,
    rematchDeclined: null,
    sendRematchVote: () => {},
    botTakeover: null,
    sendPartialSelection: () => {},
    sendAsk: () => {},
    sendDeclare: () => {},
    // Sub-AC 28a: eligible next-turn players (empty until first declaration)
    eligibleNextTurnPlayerIds: [],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ScoreboardPanel', () => {
  // ── 1. Default testId ──────────────────────────────────────────────────────
  it('renders with default data-testid="scoreboard-panel"', () => {
    render(<ScoreboardPanel team1Score={0} team2Score={0} />);
    expect(screen.getByTestId('scoreboard-panel')).toBeTruthy();
  });

  // ── 2. Custom testId ──────────────────────────────────────────────────────
  it('accepts a custom data-testid', () => {
    render(<ScoreboardPanel team1Score={0} team2Score={0} data-testid="my-scoreboard" />);
    expect(screen.getByTestId('my-scoreboard')).toBeTruthy();
    expect(screen.queryByTestId('scoreboard-panel')).toBeNull();
  });

  // ── 3. Both team sections ─────────────────────────────────────────────────
  it('renders both team sections', () => {
    render(<ScoreboardPanel team1Score={1} team2Score={2} />);
    expect(screen.getByTestId('scoreboard-team1')).toBeTruthy();
    expect(screen.getByTestId('scoreboard-team2')).toBeTruthy();
  });

  // ── 4. Team 1 name ────────────────────────────────────────────────────────
  it('displays Team 1 label', () => {
    render(<ScoreboardPanel team1Score={0} team2Score={0} />);
    expect(screen.getByTestId('scoreboard-team1-name').textContent).toContain('Team 1');
  });

  // ── 5. Team 2 name ────────────────────────────────────────────────────────
  it('displays Team 2 label', () => {
    render(<ScoreboardPanel team1Score={0} team2Score={0} />);
    expect(screen.getByTestId('scoreboard-team2-name').textContent).toContain('Team 2');
  });

  // ── 6. Team 1 score element ───────────────────────────────────────────────
  it('renders a scoreboard-team1-score element', () => {
    render(<ScoreboardPanel team1Score={3} team2Score={1} />);
    expect(screen.getByTestId('scoreboard-team1-score')).toBeTruthy();
  });

  // ── 7. Team 2 score element ───────────────────────────────────────────────
  it('renders a scoreboard-team2-score element', () => {
    render(<ScoreboardPanel team1Score={3} team2Score={1} />);
    expect(screen.getByTestId('scoreboard-team2-score')).toBeTruthy();
  });

  // ── 8. Team 1 score value ─────────────────────────────────────────────────
  it('shows correct team1 score value', () => {
    render(<ScoreboardPanel team1Score={3} team2Score={5} />);
    expect(screen.getByTestId('scoreboard-team1-score').textContent).toBe('3');
  });

  // ── 9. Team 2 score value ─────────────────────────────────────────────────
  it('shows correct team2 score value', () => {
    render(<ScoreboardPanel team1Score={3} team2Score={5} />);
    expect(screen.getByTestId('scoreboard-team2-score').textContent).toBe('5');
  });

  // ── 10. "No books yet" placeholder ───────────────────────────────────────
  it('shows "No books yet" when team has no declared suits', () => {
    render(<ScoreboardPanel team1Score={0} team2Score={0} declaredSuits={[]} />);
    // Both teams should show placeholder
    const team1Section = screen.getByTestId('scoreboard-team1-suits');
    const team2Section = screen.getByTestId('scoreboard-team2-suits');
    expect(within(team1Section).getByText(/No books yet/i)).toBeTruthy();
    expect(within(team2Section).getByText(/No books yet/i)).toBeTruthy();
  });

  // ── 11. Suit badges rendered for declared suits ────────────────────────────
  it('renders suit badges for each declared suit', () => {
    render(<ScoreboardPanel team1Score={2} team2Score={1} declaredSuits={DECLARED_SUITS_MIXED} />);
    expect(screen.getByTestId('scoreboard-suit-badge-low_s')).toBeTruthy();
    expect(screen.getByTestId('scoreboard-suit-badge-high_s')).toBeTruthy();
    expect(screen.getByTestId('scoreboard-suit-badge-low_h')).toBeTruthy();
  });

  // ── 12. Team 1 suits appear only in Team 1 section ────────────────────────
  it('Team 1 declared suits appear only in Team 1 section', () => {
    render(<ScoreboardPanel team1Score={2} team2Score={1} declaredSuits={DECLARED_SUITS_MIXED} />);
    const team1Section = screen.getByTestId('scoreboard-team1-suits');
    // low_s belongs to team 1
    expect(within(team1Section).getByTestId('scoreboard-suit-badge-low_s')).toBeTruthy();
    // high_s belongs to team 2 — should NOT appear in team 1 section
    expect(within(team1Section).queryByTestId('scoreboard-suit-badge-high_s')).toBeNull();
  });

  // ── 13. Team 2 suits appear only in Team 2 section ────────────────────────
  it('Team 2 declared suits appear only in Team 2 section', () => {
    render(<ScoreboardPanel team1Score={2} team2Score={1} declaredSuits={DECLARED_SUITS_MIXED} />);
    const team2Section = screen.getByTestId('scoreboard-team2-suits');
    // high_s belongs to team 2
    expect(within(team2Section).getByTestId('scoreboard-suit-badge-high_s')).toBeTruthy();
    // low_s belongs to team 1 — should NOT appear in team 2 section
    expect(within(team2Section).queryByTestId('scoreboard-suit-badge-low_s')).toBeNull();
  });

  // ── 14. "(You)" on Team 1 when myTeamId=1 ────────────────────────────────
  it('shows "(You)" on Team 1 when myTeamId is 1', () => {
    render(<ScoreboardPanel team1Score={0} team2Score={0} myTeamId={1} />);
    const name = screen.getByTestId('scoreboard-team1-name');
    expect(name.textContent).toContain('(You)');
  });

  // ── 15. "(You)" on Team 2 when myTeamId=2 ────────────────────────────────
  it('shows "(You)" on Team 2 when myTeamId is 2', () => {
    render(<ScoreboardPanel team1Score={0} team2Score={0} myTeamId={2} />);
    const name = screen.getByTestId('scoreboard-team2-name');
    expect(name.textContent).toContain('(You)');
  });

  // ── 16. No "(You)" when myTeamId is null ─────────────────────────────────
  it('does not show "(You)" when myTeamId is null', () => {
    render(<ScoreboardPanel team1Score={0} team2Score={0} myTeamId={null} />);
    expect(screen.queryByText('(You)')).toBeNull();
  });

  // ── 17. Score flash for team 1 ────────────────────────────────────────────
  it('applies yellow-300 class to team1 score when scoreFlash=1', () => {
    render(<ScoreboardPanel team1Score={3} team2Score={2} scoreFlash={1} />);
    const scoreEl = screen.getByTestId('scoreboard-team1-score');
    expect(scoreEl.className).toContain('text-yellow-300');
  });

  // ── 18. Score flash for team 2 ────────────────────────────────────────────
  it('applies yellow-300 class to team2 score when scoreFlash=2', () => {
    render(<ScoreboardPanel team1Score={3} team2Score={2} scoreFlash={2} />);
    const scoreEl = screen.getByTestId('scoreboard-team2-score');
    expect(scoreEl.className).toContain('text-yellow-300');
  });

  // ── 19. No flash when scoreFlash is null ─────────────────────────────────
  it('does not apply yellow-300 class when scoreFlash is null', () => {
    render(<ScoreboardPanel team1Score={3} team2Score={2} scoreFlash={null} />);
    const t1 = screen.getByTestId('scoreboard-team1-score');
    const t2 = screen.getByTestId('scoreboard-team2-score');
    expect(t1.className).not.toContain('text-yellow-300');
    expect(t2.className).not.toContain('text-yellow-300');
  });

  // ── 20. aria-label on root ────────────────────────────────────────────────
  it('has aria-label="Scoreboard" on root element', () => {
    render(<ScoreboardPanel team1Score={0} team2Score={0} />);
    expect(screen.getByRole('complementary', { name: 'Scoreboard' })).toBeTruthy();
  });

  // ── 21. aria-label on team1 section ──────────────────────────────────────
  it('has correct aria-label on Team 1 section', () => {
    render(<ScoreboardPanel team1Score={0} team2Score={0} />);
    expect(screen.getByLabelText('Team 1 scoreboard section')).toBeTruthy();
  });

  // ── 22. aria-label on team2 section ──────────────────────────────────────
  it('has correct aria-label on Team 2 section', () => {
    render(<ScoreboardPanel team1Score={0} team2Score={0} />);
    expect(screen.getByLabelText('Team 2 scoreboard section')).toBeTruthy();
  });

  // ── 23. Suit badge title attribute ───────────────────────────────────────
  it('suit badge has human-readable title attribute', () => {
    render(
      <ScoreboardPanel
        team1Score={1}
        team2Score={0}
        declaredSuits={[{ halfSuitId: 'low_s', teamId: 1, declaredBy: 'p1' }]}
      />
    );
    const badge = screen.getByTestId('scoreboard-suit-badge-low_s');
    expect(badge.getAttribute('title')).toContain('Spades');
  });

  // ── 26. Score totals header ───────────────────────────────────────────────
  it('shows combined book count in the header (e.g. "3/8")', () => {
    render(<ScoreboardPanel team1Score={2} team2Score={1} />);
    // 2 + 1 = 3
    expect(screen.getByText('3/8')).toBeTruthy();
  });

  // ── 27. Zero scores at game start ────────────────────────────────────────
  it('correctly displays 0-0 scores at game start', () => {
    render(<ScoreboardPanel team1Score={0} team2Score={0} />);
    expect(screen.getByTestId('scoreboard-team1-score').textContent).toBe('0');
    expect(screen.getByTestId('scoreboard-team2-score').textContent).toBe('0');
    expect(screen.getByText('0/8')).toBeTruthy();
  });

  // ── 28. Maximum scores ────────────────────────────────────────────────────
  it('displays maximum score of 8 books correctly', () => {
    render(<ScoreboardPanel team1Score={8} team2Score={0} />);
    expect(screen.getByTestId('scoreboard-team1-score').textContent).toBe('8');
    expect(screen.getByText('8/8')).toBeTruthy();
  });

  // ── 29. Extra className forwarded ────────────────────────────────────────
  it('accepts and applies extra className to root element', () => {
    render(<ScoreboardPanel team1Score={0} team2Score={0} className="hidden lg:flex" />);
    const panel = screen.getByTestId('scoreboard-panel');
    expect(panel.className).toContain('hidden');
    expect(panel.className).toContain('lg:flex');
  });

  // ── 30. Suit badge testId pattern ─────────────────────────────────────────
  it('suit badge data-testid follows "scoreboard-suit-badge-{halfSuitId}" pattern', () => {
    const suits: DeclaredSuit[] = [
      { halfSuitId: 'high_d', teamId: 2, declaredBy: 'p2' },
      { halfSuitId: 'low_c',  teamId: 1, declaredBy: 'p1' },
    ];
    render(<ScoreboardPanel team1Score={1} team2Score={1} declaredSuits={suits} />);
    expect(screen.getByTestId('scoreboard-suit-badge-high_d')).toBeTruthy();
    expect(screen.getByTestId('scoreboard-suit-badge-low_c')).toBeTruthy();
  });

  // ── Reactive updates ──────────────────────────────────────────────────────
  it('updates scores reactively when props change', () => {
    const { rerender } = render(<ScoreboardPanel team1Score={1} team2Score={2} />);
    expect(screen.getByTestId('scoreboard-team1-score').textContent).toBe('1');

    rerender(<ScoreboardPanel team1Score={3} team2Score={2} />);
    expect(screen.getByTestId('scoreboard-team1-score').textContent).toBe('3');
    expect(screen.getByText('5/8')).toBeTruthy();
  });

  it('updates declared suits reactively when props change', () => {
    const { rerender } = render(
      <ScoreboardPanel team1Score={0} team2Score={0} declaredSuits={[]} />
    );
    expect(screen.getAllByText(/No books yet/i)).toHaveLength(2);

    const newSuits: DeclaredSuit[] = [{ halfSuitId: 'low_s', teamId: 1, declaredBy: 'p1' }];
    rerender(<ScoreboardPanel team1Score={1} team2Score={0} declaredSuits={newSuits} />);
    expect(screen.getByTestId('scoreboard-suit-badge-low_s')).toBeTruthy();
  });
});

// ── ConnectedScoreboardPanel ───────────────────────────────────────────────────

describe('ConnectedScoreboardPanel', () => {
  // ── 24. Skeleton when no gameState ────────────────────────────────────────
  it('renders skeleton when gameState is null', () => {
    const value = makeContextValue(null);
    render(
      <GameProvider value={value}>
        <ConnectedScoreboardPanel />
      </GameProvider>
    );
    expect(screen.getByTestId('scoreboard-panel-skeleton')).toBeTruthy();
  });

  // ── 25. Shows scores from GameContext ─────────────────────────────────────
  it('shows scores from GameContext when gameState is available', () => {
    const gs = makeGameState({ scores: { team1: 4, team2: 3 } });
    const value = makeContextValue(gs);
    render(
      <GameProvider value={value}>
        <ConnectedScoreboardPanel />
      </GameProvider>
    );
    expect(screen.getByTestId('scoreboard-team1-score').textContent).toBe('4');
    expect(screen.getByTestId('scoreboard-team2-score').textContent).toBe('3');
  });

  it('passes myTeamId to ScoreboardPanel correctly', () => {
    const gs = makeGameState({ scores: { team1: 1, team2: 0 } });
    const value = makeContextValue(gs);
    render(
      <GameProvider value={value}>
        <ConnectedScoreboardPanel myTeamId={1} />
      </GameProvider>
    );
    const name = screen.getByTestId('scoreboard-team1-name');
    expect(name.textContent).toContain('(You)');
  });

  it('passes scoreFlash to ScoreboardPanel — yellow class appears on flashing team', () => {
    const gs = makeGameState({ scores: { team1: 2, team2: 1 } });
    const value = makeContextValue(gs);
    render(
      <GameProvider value={value}>
        <ConnectedScoreboardPanel scoreFlash={2} />
      </GameProvider>
    );
    const t2Score = screen.getByTestId('scoreboard-team2-score');
    expect(t2Score.className).toContain('text-yellow-300');
  });

  it('shows declared suits from GameContext', () => {
    const gs = makeGameState({ declaredSuits: DECLARED_SUITS_MIXED });
    const value = makeContextValue(gs);
    render(
      <GameProvider value={value}>
        <ConnectedScoreboardPanel />
      </GameProvider>
    );
    expect(screen.getByTestId('scoreboard-suit-badge-low_s')).toBeTruthy();
    expect(screen.getByTestId('scoreboard-suit-badge-high_s')).toBeTruthy();
  });

  it('updates reactively when gameState scores change in context', () => {
    const gs1 = makeGameState({ scores: { team1: 0, team2: 0 } });
    const value1 = makeContextValue(gs1);

    const { rerender } = render(
      <GameProvider value={value1}>
        <ConnectedScoreboardPanel />
      </GameProvider>
    );
    expect(screen.getByTestId('scoreboard-team1-score').textContent).toBe('0');

    const gs2 = makeGameState({ scores: { team1: 1, team2: 0 } });
    const value2 = makeContextValue(gs2);
    rerender(
      <GameProvider value={value2}>
        <ConnectedScoreboardPanel />
      </GameProvider>
    );
    expect(screen.getByTestId('scoreboard-team1-score').textContent).toBe('1');
  });
});
