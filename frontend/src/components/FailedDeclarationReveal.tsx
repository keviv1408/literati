'use client';

/**
 * FailedDeclarationReveal — overlay shown to all clients after an incorrect
 * declaration.  Displays each card in the declared half-suit with:
 *
 *   - The **claimed holder** crossed out in red  (declarant's guess)
 *   - The **actual holder** highlighted in green  (ground truth)
 *
 * Correct assignments (claimed === actual) are rendered normally with a
 * green checkmark so players can clearly see which cards were right.
 *
 * ## Data flow
 * The overlay is driven by the `declarationFailed` socket event:
 *   { type: 'declarationFailed', declarerId, halfSuitId, winningTeam,
 *     assignment, wrongAssignmentDiffs, actualHolders, lastMove }
 *
 * It is cleared (unmounted) by the parent when the next ask_result or
 * declaration_result arrives, or immediately when the player dismisses it.
 *
 * ## Accessibility
 * - role="dialog" with aria-modal="true"
 * - aria-labelledby points to the title
 * - Dismiss button has a descriptive aria-label
 * - Each card row has an aria-label summarising the outcome
 *
 * ## Auto-dismiss
 * The overlay auto-dismisses after AUTO_DISMISS_MS (6 000 ms) so the game
 * can resume without requiring manual interaction.  The dismiss button
 * allows players to clear it sooner.
 */

import { useEffect, useRef } from 'react';
import type { DeclarationFailedPayload, GamePlayer } from '@/types/game';
import {
  parseCard,
  cardRankLabel,
  cardLabel,
  halfSuitLabel,
  getHalfSuitCards,
  SUIT_SYMBOLS,
  SUIT_COLORS,
} from '@/types/game';

/** Time (ms) before the overlay auto-dismisses. */
const AUTO_DISMISS_MS = 6_000;

interface FailedDeclarationRevealProps {
  /** Diff payload from the `declarationFailed` socket event. */
  payload: DeclarationFailedPayload;
  /** Full player list so we can look up display names. */
  players: GamePlayer[];
  /** Card variant to determine which 6 cards belong to the half-suit. */
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s';
  /** Called when the overlay should be hidden (dismiss button or auto-dismiss). */
  onDismiss: () => void;
}

export default function FailedDeclarationReveal({
  payload,
  players,
  variant,
  onDismiss,
}: FailedDeclarationRevealProps) {
  const titleId = 'failed-declaration-reveal-title';
  const dismissRef = useRef<HTMLButtonElement>(null);

  // ── Auto-dismiss ────────────────────────────────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  // ── Focus the dismiss button on mount for keyboard accessibility ───────────
  useEffect(() => {
    dismissRef.current?.focus();
  }, []);

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const cards = getHalfSuitCards(payload.halfSuitId, variant);

  /** Wrong-assignment lookup by cardId for O(1) access. */
  const wrongByCard = new Map(
    payload.wrongAssignmentDiffs.map((d) => [d.card, d])
  );

  function playerName(playerId: string | null | undefined): string {
    if (!playerId) return 'Unknown';
    return players.find((p) => p.playerId === playerId)?.displayName ?? playerId;
  }

  const declarer = playerName(payload.declarerId);
  const halfSuit = halfSuitLabel(payload.halfSuitId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="failed-declaration-reveal"
      // Click outside backdrop → dismiss
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div
        className="relative w-full max-w-md bg-slate-900 border border-red-700/60 rounded-2xl shadow-2xl overflow-hidden animate-modal-in"
        data-testid="failed-declaration-reveal-panel"
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
          <div>
            <h2
              id={titleId}
              className="text-base font-bold text-red-300 leading-tight"
              data-testid="failed-declaration-title"
            >
              ✗ Declaration Failed
            </h2>
            <p className="text-sm text-slate-300 mt-0.5">
              <strong className="text-white">{declarer}</strong> declared{' '}
              <strong className="text-white">{halfSuit}</strong>
            </p>
            <p
              className="text-xs text-violet-300 mt-1"
              data-testid="failed-declaration-winning-team"
            >
              Team {payload.winningTeam} scores the point
            </p>
          </div>
          <button
            ref={dismissRef}
            onClick={onDismiss}
            aria-label="Dismiss declaration result"
            className="shrink-0 text-slate-400 hover:text-white transition-colors p-1 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-400"
            data-testid="failed-declaration-dismiss"
          >
            ✕
          </button>
        </div>

        {/* ── Card-by-card diff ───────────────────────────────────────────── */}
        <div
          className="px-5 pb-5 flex flex-col gap-2"
          role="list"
          aria-label="Card assignment results"
        >
          {cards.map((cardId) => {
            const diff = wrongByCard.get(cardId);
            const isWrong = Boolean(diff);
            const claimedId  = payload.assignment[cardId] ?? null;
            const actualId   = payload.actualHolders[cardId] ?? null;
            const claimedName = playerName(claimedId);
            const actualName  = playerName(actualId);

            const { rank, suit } = parseCard(cardId);
            const rankLabel = cardRankLabel(rank);
            const suitSym   = SUIT_SYMBOLS[suit];
            const suitColor = SUIT_COLORS[suit];

            const ariaRow = isWrong
              ? `${cardLabel(cardId)}: claimed ${claimedName} but actually held by ${actualName}`
              : `${cardLabel(cardId)}: correctly assigned to ${actualName}`;

            return (
              <div
                key={cardId}
                role="listitem"
                aria-label={ariaRow}
                className={[
                  'flex items-center gap-3 rounded-xl px-3 py-2 border',
                  isWrong
                    ? 'bg-red-950/40 border-red-700/50'
                    : 'bg-emerald-950/30 border-emerald-700/40',
                ].join(' ')}
                data-testid={`card-row-${cardId}`}
                data-wrong={isWrong ? 'true' : 'false'}
              >
                {/* Card chip */}
                <span
                  className={[
                    'shrink-0 flex items-center justify-center',
                    'w-9 h-12 rounded-lg border-2 bg-white font-bold text-sm select-none',
                    isWrong ? 'border-red-400' : 'border-emerald-400',
                    suitColor,
                  ].join(' ')}
                  aria-hidden="true"
                  data-testid={`card-chip-${cardId}`}
                >
                  <span className="flex flex-col items-center leading-none">
                    <span>{rankLabel}</span>
                    <span>{suitSym}</span>
                  </span>
                </span>

                {/* Assignment column */}
                <div className="flex flex-col min-w-0 flex-1">
                  {isWrong ? (
                    <>
                      {/* Claimed holder — crossed out */}
                      <span
                        className="text-xs text-red-400 line-through opacity-70 truncate"
                        aria-label={`Claimed: ${claimedName}`}
                        data-testid={`claimed-holder-${cardId}`}
                      >
                        {claimedName}
                      </span>
                      {/* Actual holder — highlighted */}
                      <span
                        className="text-sm font-semibold text-emerald-300 truncate"
                        aria-label={`Actual: ${actualName}`}
                        data-testid={`actual-holder-${cardId}`}
                      >
                        ✓ {actualName}
                      </span>
                    </>
                  ) : (
                    /* Correct assignment */
                    <span
                      className="text-sm font-semibold text-emerald-300 truncate"
                      aria-label={`Correct: ${actualName}`}
                      data-testid={`correct-holder-${cardId}`}
                    >
                      ✓ {actualName}
                    </span>
                  )}
                </div>

                {/* Status icon */}
                <span
                  className={[
                    'shrink-0 text-base leading-none',
                    isWrong ? 'text-red-400' : 'text-emerald-400',
                  ].join(' ')}
                  aria-hidden="true"
                  data-testid={`status-icon-${cardId}`}
                >
                  {isWrong ? '✗' : '✓'}
                </span>
              </div>
            );
          })}
        </div>

        {/* ── Auto-dismiss progress bar ──────────────────────────────────── */}
        <div
          className="h-0.5 bg-slate-800"
          aria-hidden="true"
        >
          <div
            className="h-full bg-red-600/70 origin-left"
            style={{
              animation: `shrink-width ${AUTO_DISMISS_MS}ms linear forwards`,
            }}
            data-testid="failed-declaration-auto-dismiss-bar"
          />
        </div>
      </div>
    </div>
  );
}
