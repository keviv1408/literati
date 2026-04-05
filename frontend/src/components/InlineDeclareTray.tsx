'use client';

/**
 * InlineDeclareTray -- inline tray for the declaration card-assignment flow.
 *
 * Mirrors the InlineAskTray pattern: appears above the card hand in the footer,
 * uses violet/purple theming, and on desktop centers itself in the viewport
 * when cards are being displayed.
 *
 * The tray shows unassigned half-suit cards as large draggable cards.
 * Players drag (or tap-to-assign) cards to teammate seats (DeclareDropSeat)
 * which remain as overlays on the game table above.
 */

import { DeclareDraggableCard } from './InlineDeclare';
import DeclarationTimerBar from './DeclarationTimerBar';
import { halfSuitLabel } from '@/types/game';
import type { CardId, HalfSuitId } from '@/types/game';
import type { DeclarationTimerPayload } from '@/hooks/useGameSocket';

interface InlineDeclareTrayProps {
  halfSuitId: HalfSuitId;
  unassignedCards: CardId[];
  selectedCard: CardId | null;
  onTapCard: (cardId: CardId) => void;
  totalCards: number;
  assignedCount: number;
  declarationTimer?: DeclarationTimerPayload | null;
  onTimerExpiry: () => void;
  isComplete: boolean;
  isLoading: boolean;
  onConfirm: () => void;
}

export default function InlineDeclareTray({
  halfSuitId,
  unassignedCards,
  selectedCard,
  onTapCard,
  totalCards,
  assignedCount,
  declarationTimer,
  onTimerExpiry,
  isComplete,
  isLoading,
  onConfirm,
}: InlineDeclareTrayProps) {
  const hasCards = unassignedCards.length > 0;
  const isDesktopCentered = hasCards;

  return (
    <div
      className={[
        'rounded-2xl border border-violet-500/20 bg-slate-900/85 px-3 py-3 shadow-[0_12px_30px_rgba(2,6,23,0.38)] backdrop-blur-sm',
        isDesktopCentered
          ? 'mb-3 max-h-[42dvh] overflow-y-auto sm:fixed sm:left-1/2 sm:top-1/2 sm:z-40 sm:mb-0 sm:w-auto sm:min-w-[26rem] sm:max-w-[40rem] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:max-h-[80vh]'
          : 'mb-3',
      ].join(' ')}
      role="region"
      aria-label={`Declaring ${halfSuitLabel(halfSuitId)}`}
      data-testid="inline-declare-tray"
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.24em] text-violet-300/80">
            Declare Mode
          </p>
          <p className="mt-1 text-sm text-slate-200">
            <span className="font-semibold text-white">{halfSuitLabel(halfSuitId)}</span>
            {' '}&mdash;{' '}
            <span className="text-violet-300">{assignedCount}/{totalCards} assigned</span>
          </p>
          {hasCards && (
            <p className="mt-0.5 text-xs text-slate-400">
              {selectedCard
                ? 'Tap a teammate seat to assign the selected card. Click anywhere outside to cancel.'
                : 'Drag cards to teammate seats above, or tap a card then tap a seat. Click anywhere outside to cancel.'}
            </p>
          )}
          {isComplete && (
            <p className="mt-0.5 text-xs text-emerald-400 animate-pulse">
              All cards assigned -- ready to declare!
            </p>
          )}
        </div>

        {isComplete && (
          <div className="flex-shrink-0">
            <button
              onClick={onConfirm}
              disabled={isLoading}
              className="rounded-xl border border-emerald-600 bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid="inline-declare-confirm"
            >
              {isLoading ? 'Declaring...' : 'Confirm'}
            </button>
          </div>
        )}
      </div>

      {/* Declaration timer bar */}
      {declarationTimer && (
        <DeclarationTimerBar
          expiresAt={declarationTimer.expiresAt}
          durationMs={declarationTimer.durationMs}
          onExpiry={onTimerExpiry}
          className="mt-2 w-full"
        />
      )}

      {/* Unassigned cards */}
      {hasCards && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2 sm:gap-3">
          {unassignedCards.map((cardId) => (
            <div
              key={cardId}
              className={[
                'rounded-2xl border-2 p-1.5 transition-all',
                selectedCard === cardId
                  ? 'border-amber-400 bg-amber-500/15 shadow-[0_0_0_1px_rgba(251,191,36,0.28)]'
                  : 'border-transparent bg-slate-800/40 hover:border-slate-500/70',
              ].join(' ')}
            >
              <DeclareDraggableCard
                cardId={cardId}
                isSelected={selectedCard === cardId}
                onTap={() => onTapCard(cardId)}
                size="xl"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
