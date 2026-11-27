'use client';

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
  disabled?: boolean;
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
  disabled = false,
  onConfirm,
}: InlineDeclareTrayProps) {
  return (
    <div
      className="action-tray"
      role="region"
      aria-label={`Declaring ${halfSuitLabel(halfSuitId)}`}
      data-testid="inline-declare-tray"
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="mt-1 text-sm text-slate-200">
            <span className="font-semibold text-white">{halfSuitLabel(halfSuitId)}</span>
            {' · '}
            <span className="text-violet-300">{assignedCount}/{totalCards} assigned</span>
          </p>
          <span className="text-xs text-slate-400">Click anywhere outside to cancel.</span>
        </div>

        {isComplete && (
          <div className="flex-shrink-0">
            <button
              onClick={onConfirm}
              disabled={isLoading || disabled}
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

      {unassignedCards.length > 0 && (
        <div className="tray-card-row declare-card-row">
          {unassignedCards.map(cardId => (
            <div key={cardId} className="tray-card-cell">
              <DeclareDraggableCard
                cardId={cardId}
                isSelected={selectedCard === cardId}
                onTap={() => onTapCard(cardId)}
                disabled={disabled || isLoading}
                size="xl"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
