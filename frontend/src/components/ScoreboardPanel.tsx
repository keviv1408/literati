'use client';

/**
 * ScoreboardPanel — side panel displaying each team's name and score (books won).
 *
 * Shell panel that reactively tracks and displays the number of
 * half-suits (books) each team has won, updating whenever the game state
 * broadcasts a new score.
 *
 * ### Layout
 * - Team 2 at the top (violet theming)
 * - Team 1 at the bottom (emerald theming)
 * - Score displayed as "N 8" books won out of a maximum of 8 half-suits
 * - Declared-suit badges listed per team so players can see which half-suits
 * have already been claimed
 * - "(You)" label appended to the current player's team name
 * - Score flashes yellow briefly when a team just scored a book
 *
 * ### Props vs Context
 * The component accepts plain props so it remains independently testable and
 * composable. The companion `ConnectedScoreboardPanel` wrapper (exported
 * below) wires it automatically to `useGameContext()` for in-game use.
 *
 * @example
 * // Standalone usage (e.g. inside a test):
 * <ScoreboardPanel
 * team1Score={3}
 * team2Score={2}
 * declaredSuits={[{ halfSuitId: 'low_s', teamId: 1, declaredBy: 'p1' }]}
 * myTeamId={1}
 * />
 *
 * @example
 * // Connected usage inside <GameProvider>:
 * <ConnectedScoreboardPanel />
 */

import React from 'react';
import { halfSuitLabel, SUIT_SYMBOLS } from '@/types/game';
import type { DeclaredSuit } from '@/types/game';
import { useGameContext } from '@/contexts/GameContext';

// ── Constants ──────────────────────────────────────────────────────────────────

/** Maximum number of books in a game — 8 half-suits total. */
const MAX_BOOKS = 8;

// ── Props ──────────────────────────────────────────────────────────────────────

export interface ScoreboardPanelProps {
  /** Team 1's current book count (0–8). */
  team1Score: number;
  /** Team 2's current book count (0–8). */
  team2Score: number;
  /**
   * Array of declared half-suits already won this game.
   * Used to render per-team suit badges. Defaults to [].
   */
  declaredSuits?: DeclaredSuit[];
  /**
   * The current player's team ID (1 or 2).
   * When provided, the matching team label gets a "(You)" suffix.
   */
  myTeamId?: 1 | 2 | null;
  /**
   * When non-null, the matching team's score renders with a yellow flash
   * to indicate a newly scored book. Typically driven by
   * `lastDeclareResult.winningTeam` with a short timeout.
   */
  scoreFlash?: 1 | 2 | null;
  /** Extra CSS class names forwarded to the panel's root element. */
  className?: string;
  /** data-testid forwarded to the panel root. Defaults to "scoreboard-panel". */
  'data-testid'?: string;
}

// ── TeamSection helper ─────────────────────────────────────────────────────────

interface TeamSectionProps {
  teamId: 1 | 2;
  score: number;
  declaredSuits: DeclaredSuit[];
  isMyTeam: boolean;
  isFlashing: boolean;
}

/**
 * Single team block: name row + score + declared-suit badges.
 */
function TeamSection({ teamId, score, declaredSuits, isMyTeam, isFlashing }: TeamSectionProps) {
  const isTeam1 = teamId === 1;
  const teamLabel = `Team ${teamId}`;

  // Team-specific colour palette
  const borderColor  = isTeam1 ? 'border-emerald-700/40' : 'border-violet-700/40';
  const bgColor      = isTeam1 ? 'bg-emerald-900/20'     : 'bg-violet-900/20';
  const textColor    = isTeam1 ? 'text-emerald-300'      : 'text-violet-300';
  const badgeBg      = isTeam1 ? 'bg-emerald-900/50 border-emerald-700/50 text-emerald-300'
                               : 'bg-violet-900/50 border-violet-700/50 text-violet-300';
  const scoreTextColor = isFlashing
    ? 'text-yellow-300 scale-110'
    : isTeam1 ? 'text-emerald-400' : 'text-violet-400';

  const teamDeclaredSuits = declaredSuits.filter((ds) => ds.teamId === teamId);

  return (
    <div
      className={[
        'rounded-lg border p-3 flex flex-col gap-2',
        bgColor,
        borderColor,
      ].join(' ')}
      data-testid={`scoreboard-team${teamId}`}
      aria-label={`${teamLabel} scoreboard section`}
    >
      {/* Team name row */}
      <div className="flex items-center justify-between">
        <span
          className={['text-xs font-semibold uppercase tracking-wider', textColor].join(' ')}
          data-testid={`scoreboard-team${teamId}-name`}
        >
          {teamLabel}
          {isMyTeam && (
            <span className="ml-1 text-emerald-400 normal-case font-normal tracking-normal">
              (You)
            </span>
          )}
        </span>

        {/* Score: N 8 books */}
        <div
          className="flex items-baseline gap-0.5"
          aria-label={`${teamLabel} score: ${score} of ${MAX_BOOKS} books`}
        >
          <span
            className={['text-xl font-bold tabular-nums transition-all duration-300', scoreTextColor].join(' ')}
            data-testid={`scoreboard-team${teamId}-score`}
          >
            {score}
          </span>
          <span className="text-xs text-slate-500">/{MAX_BOOKS}</span>
        </div>
      </div>

      {/* Declared-suit badges */}
      <div
        className="flex flex-wrap gap-1 min-h-[1.25rem]"
        aria-label={`${teamLabel} declared suits`}
        data-testid={`scoreboard-team${teamId}-suits`}
      >
        {teamDeclaredSuits.length === 0 ? (
          <span className="text-[10px] text-slate-600 italic">No books yet</span>
        ) : (
          teamDeclaredSuits.map((ds) => {
            const [tier, suit] = ds.halfSuitId.split('_');
            const sym = SUIT_SYMBOLS[suit as 's' | 'h' | 'd' | 'c'] ?? suit;
            return (
              <span
                key={ds.halfSuitId}
                className={['px-1.5 py-0.5 rounded-full text-[10px] font-semibold border', badgeBg].join(' ')}
                title={halfSuitLabel(ds.halfSuitId)}
                data-testid={`scoreboard-suit-badge-${ds.halfSuitId}`}
              >
                {tier === 'high' ? '▲' : '▽'}{sym}
              </span>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── ScoreboardPanel ────────────────────────────────────────────────────────────

/**
 * Side scoreboard panel showing both teams' names and book counts.
 *
 * Receives all data via props — no direct context dependency so it can be
 * rendered in tests and stories without a `<GameProvider>`.
 */
export default function ScoreboardPanel({
  team1Score,
  team2Score,
  declaredSuits = [],
  myTeamId = null,
  scoreFlash = null,
  className = '',
  'data-testid': testId = 'scoreboard-panel',
}: ScoreboardPanelProps) {
  return (
    <aside
      className={[
        'flex flex-col gap-2 w-full',
        className,
      ].join(' ').trim()}
      aria-label="Scoreboard"
      data-testid={testId}
    >
      {/* Panel heading */}
      <div
        className="flex items-center gap-1.5 px-0.5"
        aria-hidden="true"
      >
        <span className="text-[10px] text-slate-500 uppercase tracking-widest font-medium">
          Scoreboard
        </span>
        <span className="flex-1 h-px bg-slate-700/50" />
        <span className="text-[10px] text-slate-500 tabular-nums">
          {team1Score + team2Score}/{MAX_BOOKS}
        </span>
      </div>

      {/* Team 2 — top */}
      <TeamSection
        teamId={2}
        score={team2Score}
        declaredSuits={declaredSuits}
        isMyTeam={myTeamId === 2}
        isFlashing={scoreFlash === 2}
      />

      {/* Visual divider */}
      <div className="flex items-center gap-2 px-1" aria-hidden="true">
        <span className="flex-1 h-px bg-slate-700/30" />
        <span className="text-slate-600 text-xs">vs</span>
        <span className="flex-1 h-px bg-slate-700/30" />
      </div>

      {/* Team 1 — bottom */}
      <TeamSection
        teamId={1}
        score={team1Score}
        declaredSuits={declaredSuits}
        isMyTeam={myTeamId === 1}
        isFlashing={scoreFlash === 1}
      />
    </aside>
  );
}

// ── ConnectedScoreboardPanel ───────────────────────────────────────────────────

/**
 * Wires `ScoreboardPanel` to `useGameContext()`.
 *
 * Must be rendered inside a `<GameProvider>` subtree.
 * The `scoreFlash` prop should be passed from the game page where the
 * `lastDeclareResult.winningTeam` flash-timer is already managed.
 *
 * @example
 * // Inside the game page (inside <GameProvider>):
 * <ConnectedScoreboardPanel myTeamId={myTeamId} scoreFlash={scoreFlash} />
 */
export interface ConnectedScoreboardPanelProps {
  /** The current player's team (pass null/undefined for spectators). */
  myTeamId?: 1 | 2 | null;
  /** Flashing team after a recent declaration (from the game page flash state). */
  scoreFlash?: 1 | 2 | null;
  /** Optional extra className forwarded to ScoreboardPanel. */
  className?: string;
}

export function ConnectedScoreboardPanel({
  myTeamId = null,
  scoreFlash = null,
  className,
}: ConnectedScoreboardPanelProps) {
  const { gameState } = useGameContext();

  if (!gameState) {
    // Render a skeleton placeholder while game state is loading
    return (
      <aside
        className={['flex flex-col gap-2 w-full animate-pulse', className ?? ''].join(' ').trim()}
        aria-label="Scoreboard loading"
        data-testid="scoreboard-panel-skeleton"
      >
        <div className="h-4 bg-slate-700/40 rounded w-24" />
        <div className="h-20 bg-slate-800/40 rounded-lg" />
        <div className="h-20 bg-slate-800/40 rounded-lg" />
      </aside>
    );
  }

  return (
    <ScoreboardPanel
      team1Score={gameState.scores.team1}
      team2Score={gameState.scores.team2}
      declaredSuits={gameState.declaredSuits}
      myTeamId={myTeamId}
      scoreFlash={scoreFlash}
      className={className}
    />
  );
}
