'use client';

/**
 * GameOverScreen — Displayed when a game reaches `status: 'completed'`.
 *
 * Shows:
 *   • Winner announcement with team colour, trophy emoji, or tie indicator
 *   • Final score (Team 1 X — Team 2 Y) with per-team pill
 *   • Tie-break explanation when scores are 4–4 (winner determined by High ♦)
 *   • Full half-suit tally — all 8 half-suits organised by suit with the
 *     declaring team colour-coded (emerald = T1, violet = T2)
 *   • Per-player declaration stats table — attempts, successes, and failures
 *     for every player who made at least one declaration attempt
 *
 * Props:
 *   winner           — 1 | 2 | null (null = unexpected edge-case; treated as tie)
 *   tiebreakerWinner — 1 | 2 | null (non-null when 4-4 tie was broken by high_d)
 *   scores           — { team1: number; team2: number }
 *   declaredSuits    — array of DeclaredSuit from the final game state
 *   myTeamId         — local player's team (null for spectators)
 *   players          — array of GamePlayer from the final game state (for stats table)
 *   variant          — card-removal variant label string (optional, for display)
 *   roomCode         — room code string (optional, shown as subtitle)
 */

import React from 'react';
import type { DeclaredSuit, GamePlayer, HalfSuitId } from '@/types/game';
import { halfSuitLabel, SUIT_SYMBOLS } from '@/types/game';

// ── Canonical half-suit order ─────────────────────────────────────────────────
//
// Displayed in a 4-column grid: Low Spades | High Spades | Low Hearts | High Hearts
// … etc.  We group by suit so the visual pairs (Low/High) are adjacent.

const SUITS: Array<{ id: 's' | 'h' | 'd' | 'c'; label: string }> = [
  { id: 's', label: 'Spades' },
  { id: 'h', label: 'Hearts' },
  { id: 'd', label: 'Diamonds' },
  { id: 'c', label: 'Clubs' },
];

const TIEBREAKER_HALF_SUIT: HalfSuitId = 'high_d';

// ── Helper ────────────────────────────────────────────────────────────────────

function getTierLabel(halfSuitId: HalfSuitId): string {
  return halfSuitId.startsWith('low_') ? 'Low' : 'High';
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface TeamBadgeProps {
  teamId: 1 | 2;
  size?: 'sm' | 'xs';
}

function TeamBadge({ teamId, size = 'sm' }: TeamBadgeProps) {
  const base = size === 'xs' ? 'px-1.5 py-0.5 text-xs' : 'px-2.5 py-1 text-sm';
  const colour =
    teamId === 1
      ? 'bg-emerald-900/60 border-emerald-600/60 text-emerald-300'
      : 'bg-violet-900/60 border-violet-600/60 text-violet-300';
  return (
    <span
      className={`inline-block rounded-full font-semibold border ${base} ${colour}`}
      aria-label={`Team ${teamId}`}
    >
      T{teamId}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

/** Per-player declaration statistics derived from declaredSuits + players. */
export interface PlayerDeclarationStats {
  playerId: string;
  displayName: string;
  teamId: 1 | 2;
  /** Total number of declaration attempts (correct + incorrect). */
  attempts: number;
  /** Number of declarations that were correct (scoring for own team). */
  successes: number;
  /** Number of declarations that were incorrect (scoring for opposing team). */
  failures: number;
}

export interface GameOverScreenProps {
  winner: 1 | 2 | null;
  tiebreakerWinner: 1 | 2 | null;
  scores: { team1: number; team2: number };
  declaredSuits: DeclaredSuit[];
  /** null = spectator; undefined = not yet known */
  myTeamId?: 1 | 2 | null;
  /**
   * Full player roster from the final game state.  When provided, a per-player
   * declaration stats table (attempts / successes / failures) is rendered below
   * the half-suit tally.  When omitted the table is hidden.
   */
  players?: GamePlayer[];
  /** Optional: card-removal variant label e.g. "Remove 7s (Classic)" */
  variant?: string;
  /** Optional: room code for subtitle display */
  roomCode?: string;
  /** Optional: test id override */
  testId?: string;
}

/**
 * Derive per-player declaration statistics from the declared suits array.
 *
 * For each player:
 *   attempts  = number of half-suits where `declaredBy === player.playerId`
 *   successes = those declarations where the winning team (DeclaredSuit.teamId)
 *               matches the player's own team  → correct declaration
 *   failures  = attempts − successes            → incorrect declaration
 *
 * Only players who made at least one attempt appear in the returned array.
 * Results are sorted: Team 1 first, then Team 2, each sub-sorted by successes
 * descending so top contributors appear first.
 */
export function computePlayerStats(
  declaredSuits: DeclaredSuit[],
  players: GamePlayer[],
): PlayerDeclarationStats[] {
  // Build playerId → GamePlayer lookup
  const playerMap = new Map<string, GamePlayer>();
  for (const p of players) {
    playerMap.set(p.playerId, p);
  }

  // Accumulate raw counts
  const statsMap = new Map<
    string,
    { displayName: string; teamId: 1 | 2; attempts: number; successes: number }
  >();

  for (const ds of declaredSuits) {
    const { declaredBy, teamId: winningTeamId } = ds;
    const player = playerMap.get(declaredBy);
    if (!player) continue;

    const isSuccess = player.teamId === winningTeamId;

    const existing = statsMap.get(declaredBy);
    if (existing) {
      existing.attempts++;
      if (isSuccess) existing.successes++;
    } else {
      statsMap.set(declaredBy, {
        displayName: player.displayName,
        teamId: player.teamId,
        attempts: 1,
        successes: isSuccess ? 1 : 0,
      });
    }
  }

  // Convert to array and add failures
  const result: PlayerDeclarationStats[] = [];
  for (const [playerId, s] of statsMap) {
    result.push({
      playerId,
      displayName: s.displayName,
      teamId: s.teamId,
      attempts: s.attempts,
      successes: s.successes,
      failures: s.attempts - s.successes,
    });
  }

  // Sort: T1 before T2; within team sort by successes desc, then attempts desc
  result.sort((a, b) => {
    if (a.teamId !== b.teamId) return a.teamId - b.teamId;
    if (b.successes !== a.successes) return b.successes - a.successes;
    return b.attempts - a.attempts;
  });

  return result;
}

export default function GameOverScreen({
  winner,
  tiebreakerWinner,
  scores,
  declaredSuits,
  myTeamId,
  players,
  variant,
  roomCode,
  testId = 'game-over-screen',
}: GameOverScreenProps) {
  // Build a fast lookup: halfSuitId → teamId
  const declaredMap = React.useMemo(() => {
    const m = new Map<HalfSuitId, 1 | 2>();
    for (const ds of declaredSuits) {
      m.set(ds.halfSuitId, ds.teamId);
    }
    return m;
  }, [declaredSuits]);

  // Per-player declaration stats (only computed when players prop is provided)
  const playerStats = React.useMemo(
    () => (players && players.length > 0 ? computePlayerStats(declaredSuits, players) : []),
    [declaredSuits, players],
  );

  const isTie = winner === null || scores.team1 === scores.team2;
  const isWinner = !isTie && myTeamId !== null && myTeamId !== undefined && winner === myTeamId;
  const isLoser = !isTie && myTeamId !== null && myTeamId !== undefined && winner !== myTeamId;

  // Tie-break applies when the final scores are exactly 4–4 and a tiebreaker
  // winner is recorded (meaning high_d decided the game).
  const showTiebreak = scores.team1 === 4 && scores.team2 === 4 && tiebreakerWinner !== null;

  // Headline emoji
  let emoji = '🤝';
  if (!isTie) {
    // For non-spectators use personal perspective; for spectators show trophy
    if (myTeamId != null) {
      emoji = isWinner ? '🏆' : '😔';
    } else {
      emoji = '🏆';
    }
  }

  return (
    <div
      className="flex flex-col items-center gap-6 w-full max-w-lg mx-auto"
      data-testid={testId}
      role="main"
      aria-label="Game over"
    >
      {/* ── Hero: winner announcement ──────────────────────────────────────── */}
      <section
        className="text-center w-full"
        data-testid="game-over-hero"
        aria-label="Result"
      >
        <div className="text-5xl mb-3" role="img" aria-label={isTie ? 'Tie' : `Team ${winner} wins`}>
          {emoji}
        </div>

        <h1 className="text-2xl font-bold text-white mb-1">Game Over</h1>

        {isTie ? (
          <p className="text-lg font-semibold text-slate-300" data-testid="result-tie">
            It&apos;s a tie!
          </p>
        ) : (
          <p
            className={`text-xl font-bold ${winner === 1 ? 'text-emerald-300' : 'text-violet-300'}`}
            data-testid="result-winner"
            aria-label={`Team ${winner} wins`}
          >
            Team {winner} wins{isWinner ? ' 🎉' : ''}
          </p>
        )}
      </section>

      {/* ── Final score ────────────────────────────────────────────────────── */}
      <section
        className="flex items-center justify-center gap-6"
        data-testid="final-score"
        aria-label="Final score"
      >
        <div className="flex flex-col items-center gap-1">
          <span className="text-xs uppercase tracking-widest text-slate-400">Team 1</span>
          <span
            className={`text-4xl font-extrabold tabular-nums ${winner === 1 ? 'text-emerald-300' : 'text-slate-300'}`}
            data-testid="score-team1"
          >
            {scores.team1}
          </span>
        </div>

        <span className="text-2xl font-light text-slate-500">—</span>

        <div className="flex flex-col items-center gap-1">
          <span className="text-xs uppercase tracking-widest text-slate-400">Team 2</span>
          <span
            className={`text-4xl font-extrabold tabular-nums ${winner === 2 ? 'text-violet-300' : 'text-slate-300'}`}
            data-testid="score-team2"
          >
            {scores.team2}
          </span>
        </div>
      </section>

      {/* ── Tiebreak reason ────────────────────────────────────────────────── */}
      {showTiebreak && (
        <section
          className="w-full rounded-xl bg-amber-900/30 border border-amber-700/40 px-4 py-3 text-center"
          data-testid="tiebreak-reason"
          aria-label="Tiebreak reason"
        >
          <p className="text-sm text-amber-300 font-semibold mb-0.5">Tiebreaker</p>
          <p className="text-sm text-amber-200/80">
            Team {tiebreakerWinner} declared{' '}
            <span className="font-semibold text-amber-100">
              High {SUIT_SYMBOLS['d']} (High Diamonds)
            </span>
          </p>
        </section>
      )}

      {/* ── Half-suit tally ────────────────────────────────────────────────── */}
      <section
        className="w-full"
        data-testid="half-suit-tally"
        aria-label="Half-suit tally"
      >
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 text-center mb-3">
          Half-Suit Tally
        </h2>

        {/* Grid: 4 suits × 2 tiers (Low / High) */}
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {SUITS.map(({ id: suitId, label: suitLabel }) => {
            const sym = SUIT_SYMBOLS[suitId];
            const isRed = suitId === 'h' || suitId === 'd';
            const symbolClass = isRed ? 'text-red-400' : 'text-slate-300';

            return (
              <div
                key={suitId}
                className="rounded-lg bg-slate-800/50 border border-slate-700/40 overflow-hidden"
                data-testid={`tally-suit-${suitId}`}
              >
                {/* Suit header */}
                <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-700/30 border-b border-slate-700/40">
                  <span className={`text-base font-bold ${symbolClass}`} aria-hidden="true">{sym}</span>
                  <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">{suitLabel}</span>
                </div>

                {/* Low and High rows */}
                {(['low', 'high'] as const).map((tier) => {
                  const halfSuitId: HalfSuitId = `${tier}_${suitId}`;
                  const teamId = declaredMap.get(halfSuitId);
                  const isUndeclared = teamId === undefined;
                  const isTiebreakerSuit = halfSuitId === TIEBREAKER_HALF_SUIT;

                  return (
                    <div
                      key={halfSuitId}
                      className={[
                        'flex items-center justify-between px-3 py-2',
                        !isUndeclared && teamId === 1 ? 'bg-emerald-950/30' : '',
                        !isUndeclared && teamId === 2 ? 'bg-violet-950/30' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      data-testid={`tally-row-${halfSuitId}`}
                      aria-label={`${halfSuitLabel(halfSuitId)}: ${isUndeclared ? 'undeclared' : `Team ${teamId}`}`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-slate-400">{getTierLabel(halfSuitId)}</span>
                        {isTiebreakerSuit && (
                          <span
                            className="text-xs text-amber-400 font-semibold"
                            title="Tiebreaker suit"
                            data-testid="tiebreak-suit-marker"
                          >
                            ★
                          </span>
                        )}
                      </div>

                      {isUndeclared ? (
                        <span
                          className="text-xs text-slate-600 italic"
                          data-testid={`tally-undeclared-${halfSuitId}`}
                        >
                          —
                        </span>
                      ) : (
                        <TeamBadge teamId={teamId!} size="xs" />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Per-player declaration stats ───────────────────────────────────── */}
      {playerStats.length > 0 && (
        <section
          className="w-full"
          data-testid="player-stats-table"
          aria-label="Player declaration statistics"
        >
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 text-center mb-3">
            Declaration Stats
          </h2>

          <div className="w-full rounded-xl overflow-hidden border border-slate-700/40">
            {/* Table header */}
            <div
              className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 px-3 py-2 bg-slate-700/30 border-b border-slate-700/40"
              aria-hidden="true"
            >
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Player</span>
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide text-center w-8">Att</span>
              <span className="text-xs font-semibold text-emerald-400/80 uppercase tracking-wide text-center w-8">✓</span>
              <span className="text-xs font-semibold text-red-400/80 uppercase tracking-wide text-center w-8">✗</span>
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide text-center w-8">T</span>
            </div>

            {/* Player rows */}
            {playerStats.map((stat, idx) => {
              const isEven = idx % 2 === 0;
              const isMe = stat.teamId === myTeamId;
              const teamColour =
                stat.teamId === 1
                  ? 'text-emerald-300'
                  : 'text-violet-300';

              return (
                <div
                  key={stat.playerId}
                  className={[
                    'grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 px-3 py-2 items-center',
                    isEven ? 'bg-slate-800/30' : 'bg-slate-800/10',
                    isMe ? 'ring-1 ring-inset ring-emerald-700/40' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-testid={`player-stats-row-${stat.playerId}`}
                  aria-label={`${stat.displayName}: ${stat.attempts} attempts, ${stat.successes} successes, ${stat.failures} failures`}
                >
                  {/* Name + team badge */}
                  <div className="flex items-center gap-2 min-w-0">
                    <TeamBadge teamId={stat.teamId} size="xs" />
                    <span
                      className={`text-sm font-medium truncate ${isMe ? 'text-white' : teamColour}`}
                      data-testid={`stats-player-name-${stat.playerId}`}
                    >
                      {stat.displayName}
                      {isMe && (
                        <span className="ml-1 text-xs text-emerald-400 font-normal">(You)</span>
                      )}
                    </span>
                  </div>

                  {/* Attempts */}
                  <span
                    className="text-sm tabular-nums text-slate-300 text-center w-8"
                    data-testid={`stats-attempts-${stat.playerId}`}
                    aria-label={`${stat.attempts} attempts`}
                  >
                    {stat.attempts}
                  </span>

                  {/* Successes */}
                  <span
                    className={`text-sm tabular-nums font-semibold text-center w-8 ${stat.successes > 0 ? 'text-emerald-400' : 'text-slate-600'}`}
                    data-testid={`stats-successes-${stat.playerId}`}
                    aria-label={`${stat.successes} successes`}
                  >
                    {stat.successes}
                  </span>

                  {/* Failures */}
                  <span
                    className={`text-sm tabular-nums font-semibold text-center w-8 ${stat.failures > 0 ? 'text-red-400' : 'text-slate-600'}`}
                    data-testid={`stats-failures-${stat.playerId}`}
                    aria-label={`${stat.failures} failures`}
                  >
                    {stat.failures}
                  </span>

                  {/* Team number */}
                  <span
                    className={`text-xs tabular-nums text-center w-8 ${teamColour}`}
                    aria-hidden="true"
                  >
                    T{stat.teamId}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Room / variant subtitle ────────────────────────────────────────── */}
      {(roomCode || variant) && (
        <p className="text-slate-600 text-xs font-mono" data-testid="game-over-subtitle">
          {[roomCode, variant].filter(Boolean).join(' · ')}
        </p>
      )}
    </div>
  );
}
