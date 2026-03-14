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
 *
 * Props:
 *   winner           — 1 | 2 | null (null = unexpected edge-case; treated as tie)
 *   tiebreakerWinner — 1 | 2 | null (non-null when 4-4 tie was broken by high_d)
 *   scores           — { team1: number; team2: number }
 *   declaredSuits    — array of DeclaredSuit from the final game state
 *   myTeamId         — local player's team (null for spectators)
 *   variant          — card-removal variant label string (optional, for display)
 *   roomCode         — room code string (optional, shown as subtitle)
 */

import React from 'react';
import type { DeclaredSuit, HalfSuitId } from '@/types/game';
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

export interface GameOverScreenProps {
  winner: 1 | 2 | null;
  tiebreakerWinner: 1 | 2 | null;
  scores: { team1: number; team2: number };
  declaredSuits: DeclaredSuit[];
  /** null = spectator; undefined = not yet known */
  myTeamId?: 1 | 2 | null;
  /** Optional: card-removal variant label e.g. "Remove 7s (Classic)" */
  variant?: string;
  /** Optional: room code for subtitle display */
  roomCode?: string;
  /** Optional: test id override */
  testId?: string;
}

export default function GameOverScreen({
  winner,
  tiebreakerWinner,
  scores,
  declaredSuits,
  myTeamId,
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

      {/* ── Room / variant subtitle ────────────────────────────────────────── */}
      {(roomCode || variant) && (
        <p className="text-slate-600 text-xs font-mono" data-testid="game-over-subtitle">
          {[roomCode, variant].filter(Boolean).join(' · ')}
        </p>
      )}
    </div>
  );
}
