'use client';

import PlayingCard from './PlayingCard';
import {
  allHalfSuitIds,
  cardLabel,
  getCardHalfSuit,
  getHalfSuitCards,
  halfSuitLabel,
} from '@/types/game';
import type { CardId, DeclaredSuit, HalfSuitId } from '@/types/game';

interface InlineAskTrayProps {
  myHand: CardId[];
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s';
  halfSuitId: HalfSuitId;
  selectedCardIds: CardId[];
  onToggleCard: (cardId: CardId) => void;
  isLoading?: boolean;
}

function getAvailableHalfSuits(
  myHand: CardId[],
  declaredSuits: DeclaredSuit[],
  variant: InlineAskTrayProps['variant'],
): HalfSuitId[] {
  const declaredIds = new Set(declaredSuits.map((ds) => ds.halfSuitId));
  const heldHalfSuits = new Set<HalfSuitId>();

  for (const cardId of myHand) {
    const halfSuitId = getCardHalfSuit(cardId, variant);
    if (halfSuitId && !declaredIds.has(halfSuitId)) {
      heldHalfSuits.add(halfSuitId);
    }
  }

  return allHalfSuitIds().filter((id) => heldHalfSuits.has(id));
}

export function countAskableCardsInHalfSuit(
  myHand: CardId[],
  halfSuitId: HalfSuitId,
  variant: InlineAskTrayProps['variant'],
): number {
  const myHandSet = new Set(myHand);
  return getHalfSuitCards(halfSuitId, variant).filter((cardId) => !myHandSet.has(cardId)).length;
}

export function getAvailableAskHalfSuits(
  myHand: CardId[],
  declaredSuits: DeclaredSuit[],
  variant: InlineAskTrayProps['variant'],
): HalfSuitId[] {
  return getAvailableHalfSuits(myHand, declaredSuits, variant).filter(
    (halfSuitId) => countAskableCardsInHalfSuit(myHand, halfSuitId, variant) > 0,
  );
}

export default function InlineAskTray({
  myHand,
  variant,
  halfSuitId,
  selectedCardIds,
  onToggleCard,
  isLoading = false,
}: InlineAskTrayProps) {
  const myHandSet = new Set(myHand);
  const selectedCardSet = new Set(selectedCardIds);
  const askableCards = getHalfSuitCards(halfSuitId, variant).filter((cardId) => !myHandSet.has(cardId));

  return (
    <div
      className={[
        'mb-3 rounded-2xl border border-emerald-500/20 bg-slate-900/85 px-3 py-3 shadow-[0_12px_30px_rgba(2,6,23,0.38)] backdrop-blur-sm',
        'sm:fixed sm:left-1/2 sm:top-1/2 sm:z-40 sm:mb-0 sm:w-auto sm:min-w-[26rem] sm:max-w-[40rem] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:max-h-[80vh] sm:overflow-y-auto',
      ].join(' ')}
      role="region"
      aria-label="Ask for a card"
      data-testid="inline-ask-tray"
    >
      <div>
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.24em] text-emerald-300/80">
          Ask Mode
        </p>
        {selectedCardIds.length === 0 && (
          <p className="mt-1 text-sm text-slate-200" data-testid="inline-ask-step-card">
            Pick one or more missing cards from <span className="font-semibold text-white">{halfSuitLabel(halfSuitId)}</span>. Click anywhere outside to cancel.
          </p>
        )}
        {selectedCardIds.length > 0 && (
          <p className="mt-1 text-sm text-slate-200" data-testid="inline-ask-step-opponent">
            Tap an opponent avatar to ask for{' '}
            <span className="font-semibold text-white">
              {selectedCardIds.length} card{selectedCardIds.length !== 1 ? 's' : ''}
            </span>.
          </p>
        )}
      </div>

      <div className="mt-3">
        <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
          {askableCards.map((cardId) => {
            const isSelected = selectedCardSet.has(cardId);
            return (
              <button
                key={cardId}
                onClick={() => onToggleCard(cardId)}
                disabled={isLoading}
                className={[
                  'rounded-2xl border-2 p-1.5 transition-all',
                  isSelected
                    ? 'border-emerald-400 bg-emerald-500/15 shadow-[0_0_0_1px_rgba(52,211,153,0.28)]'
                    : 'border-transparent bg-slate-800/40 hover:border-slate-500/70',
                  isLoading ? 'opacity-50' : '',
                ].join(' ')}
                data-testid={`inline-ask-card-${cardId}`}
                aria-label={`${isSelected ? 'Deselect' : 'Select'} ${cardLabel(cardId)}`}
                aria-pressed={isSelected}
              >
                <PlayingCard cardId={cardId} size="xl" />
              </button>
            );
          })}
        </div>

        {selectedCardIds.length > 0 && (
          <p className="mt-3 text-center text-xs text-emerald-300" data-testid="inline-ask-selected-count">
            {selectedCardIds.length} selected. You can keep choosing cards or tap an opponent.
          </p>
        )}

        {askableCards.length === 0 && (
          <p className="text-sm text-slate-400" data-testid="inline-ask-no-cards">
            You already hold every card in {halfSuitLabel(halfSuitId)}.
          </p>
        )}
      </div>
    </div>
  );
}
