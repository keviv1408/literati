'use client';

import PlayingCard from './PlayingCard';
import {
  allHalfSuitIds,
  cardLabel,
  getCardHalfSuit,
  getHalfSuitCards,
  halfSuitLabel,
  SUIT_SYMBOLS,
} from '@/types/game';
import type { CardId, DeclaredSuit, HalfSuitId } from '@/types/game';

interface InlineAskTrayProps {
  myHand: CardId[];
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s';
  declaredSuits: DeclaredSuit[];
  selectedHalfSuit: HalfSuitId | null;
  selectedCardId: CardId | null;
  onSelectHalfSuit: (halfSuitId: HalfSuitId) => void;
  onSelectCard: (cardId: CardId) => void;
  onBack: () => void;
  onCancel: () => void;
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
  declaredSuits,
  selectedHalfSuit,
  selectedCardId,
  onSelectHalfSuit,
  onSelectCard,
  onBack,
  onCancel,
  isLoading = false,
}: InlineAskTrayProps) {
  const availableHalfSuits = getAvailableAskHalfSuits(myHand, declaredSuits, variant);
  const myHandSet = new Set(myHand);
  const askableCards = selectedHalfSuit
    ? getHalfSuitCards(selectedHalfSuit, variant).filter((cardId) => !myHandSet.has(cardId))
    : [];
  const isDesktopCenteredCardStage = Boolean(selectedHalfSuit);

  return (
    <div
      className={[
        'rounded-2xl border border-emerald-500/20 bg-slate-900/85 px-3 py-3 shadow-[0_12px_30px_rgba(2,6,23,0.38)] backdrop-blur-sm',
        isDesktopCenteredCardStage
          ? 'mb-3 sm:fixed sm:left-1/2 sm:top-1/2 sm:z-40 sm:mb-0 sm:w-auto sm:min-w-[26rem] sm:max-w-[32rem] sm:-translate-x-1/2 sm:-translate-y-1/2'
          : 'mb-3',
      ].join(' ')}
      role="region"
      aria-label="Ask for a card"
      data-testid="inline-ask-tray"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.24em] text-emerald-300/80">
            Ask Mode
          </p>
          {!selectedHalfSuit && (
            <p className="mt-1 text-sm text-slate-200" data-testid="inline-ask-step-halfsuit">
              Choose a half-suit, or tap one of your cards below.
            </p>
          )}
          {selectedHalfSuit && !selectedCardId && (
            <p className="mt-1 text-sm text-slate-200" data-testid="inline-ask-step-card">
              Pick the missing card from <span className="font-semibold text-white">{halfSuitLabel(selectedHalfSuit)}</span>.
            </p>
          )}
          {selectedHalfSuit && selectedCardId && (
            <p className="mt-1 text-sm text-slate-200" data-testid="inline-ask-step-opponent">
              Tap an opponent avatar for <span className="font-semibold text-white">{cardLabel(selectedCardId)}</span>.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {selectedHalfSuit && (
            <button
              onClick={onBack}
              disabled={isLoading}
              className="rounded-xl border border-slate-700 bg-slate-800/70 px-3 py-2 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-700/80 disabled:opacity-50"
              data-testid="inline-ask-back"
            >
              Back
            </button>
          )}
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="rounded-xl border border-slate-700 bg-slate-800/70 px-3 py-2 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-700/80 disabled:opacity-50"
            data-testid="inline-ask-cancel"
          >
            Cancel
          </button>
        </div>
      </div>

      {!selectedHalfSuit ? (
        <div
          className="mt-3 flex flex-wrap items-center gap-2"
          role="listbox"
          aria-label="Available half-suits"
        >
          {availableHalfSuits.map((halfSuitId) => {
            const [tier, suit] = halfSuitId.split('_');
            const symbol = SUIT_SYMBOLS[suit as 's' | 'h' | 'd' | 'c'] ?? suit;
            const askableCount = countAskableCardsInHalfSuit(myHand, halfSuitId, variant);
            return (
              <button
                key={halfSuitId}
                onClick={() => onSelectHalfSuit(halfSuitId)}
                disabled={isLoading}
                className="rounded-2xl border border-emerald-500/30 bg-emerald-950/40 px-3 py-2 text-left transition-colors hover:bg-emerald-900/40 disabled:opacity-50"
                role="option"
                aria-selected="false"
                data-testid={`inline-ask-halfsuit-${halfSuitId}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-base text-slate-100" aria-hidden="true">{symbol}</span>
                  <span className="text-sm font-semibold text-white">{halfSuitLabel(halfSuitId)}</span>
                </div>
                <p className="mt-1 text-[0.7rem] uppercase tracking-[0.18em] text-emerald-300/70">
                  {tier === 'low' ? 'Low' : 'High'} half
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {askableCount} card{askableCount !== 1 ? 's' : ''} to ask for
                </p>
              </button>
            );
          })}
          {availableHalfSuits.length === 0 && (
            <p className="text-sm text-slate-400" data-testid="inline-ask-no-halfsuits">
              No askable half-suits right now.
            </p>
          )}
        </div>
      ) : (
        <div className="mt-3">
          <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
            {askableCards.map((cardId) => {
              const isSelected = selectedCardId === cardId;
              return (
                <button
                  key={cardId}
                  onClick={() => onSelectCard(cardId)}
                  disabled={isLoading}
                  className={[
                    'rounded-2xl border-2 p-1.5 transition-all',
                    isSelected
                      ? 'border-emerald-400 bg-emerald-500/15 shadow-[0_0_0_1px_rgba(52,211,153,0.28)]'
                      : 'border-transparent bg-slate-800/40 hover:border-slate-500/70',
                    isLoading ? 'opacity-50' : '',
                  ].join(' ')}
                  data-testid={`inline-ask-card-${cardId}`}
                  aria-label={`Ask for ${cardLabel(cardId)}`}
                >
                  <PlayingCard cardId={cardId} size={isDesktopCenteredCardStage ? 'xl' : 'lg'} />
                </button>
              );
            })}
          </div>

          {askableCards.length === 0 && (
            <p className="text-sm text-slate-400" data-testid="inline-ask-no-cards">
              You already hold every card in {halfSuitLabel(selectedHalfSuit)}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
