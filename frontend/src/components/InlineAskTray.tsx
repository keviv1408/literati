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
      className="action-tray"
      role="region"
      aria-label="Ask for a card"
      data-testid="inline-ask-tray"
    >
      <div className="tray-card-row ask-card-row">
        {askableCards.map((cardId) => {
          const isSelected = selectedCardSet.has(cardId);
          return (
            <button
              key={cardId}
              onClick={() => onToggleCard(cardId)}
              disabled={isLoading}
              className="tray-card-cell ask-card"
              data-testid={`inline-ask-card-${cardId}`}
              aria-label={`${isSelected ? 'Deselect' : 'Select'} ${cardLabel(cardId)}`}
              aria-pressed={isSelected}
            >
              <PlayingCard cardId={cardId} size="xl" />
            </button>
          );
        })}
      </div>

      {askableCards.length === 0 && (
        <p className="text-sm text-slate-400" data-testid="inline-ask-no-cards">
          You already hold every card in {halfSuitLabel(halfSuitId)}.
        </p>
      )}
    </div>
  );
}
