'use client';

/**
 * DesktopCardHand — desktop row/spread layout for the local player's hand.
 *
 * Displays sorted cards in a clean horizontal row grouped by suit:
 *   ♠ Spades → ♥ Hearts → ♦ Diamonds → ♣ Clubs
 *
 * Within each suit group cards are sorted by rank (A–K, omitting the removed
 * rank for the chosen variant). A subtle divider and suit label separates each
 * group. A thin notch between the 6th and 7th remaining rank in each suit
 * marks the Low/High half-suit boundary when the variant is known.
 *
 * Interaction mirrors CardHand:
 *   • Click / Enter / Space selects a card for the ask flow.
 *   • Selected card lifts with an emerald ring.
 *   • Non-selectable cards are dimmed (disabled prop).
 *   • Hover lifts interactive cards slightly.
 *
 * This component is intentionally desktop-only (visible only on sm+ screens).
 * CardHand renders this on desktop and its fan layout on mobile.
 */

import PlayingCard from './PlayingCard';
import CardFlipWrapper from './CardFlipWrapper';
import type { CardId } from '@/types/game';
import {
  parseCard,
  SUIT_SYMBOLS,
  SUIT_NAMES,
} from '@/types/game';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DesktopCardHandProps {
  hand: CardId[];
  selectedCard?: CardId | null;
  onSelectCard?: (cardId: CardId) => void;
  isMyTurn: boolean;
  /** When true, render face-down placeholders (e.g. during a transition). */
  faceDown?: boolean;
  /** Disable all card interactions. */
  disabled?: boolean;
  /**
   * Card-removal variant — when provided the Low/High half-suit boundary
   * notch is shown between the 6th and 7th remaining rank in each suit.
   */
  variant?: 'remove_2s' | 'remove_7s' | 'remove_8s';
  /** Extra className forwarded to the root element. */
  className?: string;
  /**
   * Card ID that just arrived via a successful ask.  When set, that specific
   * card is rendered with a CardFlipWrapper (back → face flip animation)
   * instead of a plain PlayingCard.
   * Ignored when `faceDown` is true (deal animation already handles that path).
   */
  newlyArrivedCardId?: CardId | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

const SUIT_ORDER = ['s', 'h', 'd', 'c'] as const;
const ALL_RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] as const;
const REMOVED_RANK: Record<string, number> = {
  remove_2s: 2,
  remove_7s: 7,
  remove_8s: 8,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the 12 remaining ranks (sorted low-to-high) for a given variant. */
function remainingRanks(variant?: string): number[] {
  const removed = variant ? REMOVED_RANK[variant] : undefined;
  return (ALL_RANKS as readonly number[]).filter((r) => r !== removed);
}

/** Index of the half-suit boundary split (0-based split *after* rank[5]). */
const HALF_SUIT_SPLIT = 6;

// ── Suit-group helpers ───────────────────────────────────────────────────────

interface SuitGroup {
  suit: string;
  cards: CardId[];
  /** Index within `cards` AFTER which the Low/High half-suit boundary falls. */
  halfSuitSplitAfter: number;
}

function buildSuitGroups(hand: CardId[], variant?: string): SuitGroup[] {
  const remaining = remainingRanks(variant);

  // Rank-priority lookup for sorting (lower index = lower rank)
  const rankPriority: Record<number, number> = {};
  remaining.forEach((r, i) => { rankPriority[r] = i; });

  const bySuit: Record<string, CardId[]> = { s: [], h: [], d: [], c: [] };

  for (const cardId of hand) {
    const { suit } = parseCard(cardId);
    if (bySuit[suit]) bySuit[suit].push(cardId);
  }

  return SUIT_ORDER.reduce<SuitGroup[]>((acc, suit) => {
    const cards = bySuit[suit].sort((a, b) => {
      const ra = parseCard(a).rank;
      const rb = parseCard(b).rank;
      return (rankPriority[ra] ?? 99) - (rankPriority[rb] ?? 99);
    });

    if (cards.length > 0) {
      // halfSuitSplitAfter: boundary is after the 6th remaining rank in the
      // suit that happens to be present. We find the first card whose rank
      // priority is >= HALF_SUIT_SPLIT to determine the split index.
      // Only compute when variant is known — without a variant we cannot
      // reliably determine the low/high boundary.
      let halfSuitSplitAfter = cards.length; // default: no boundary
      if (variant) {
        const splitIdx = cards.findIndex((cId) => {
          return (rankPriority[parseCard(cId).rank] ?? 99) >= HALF_SUIT_SPLIT;
        });
        halfSuitSplitAfter = splitIdx === -1 ? cards.length : splitIdx;
      }

      acc.push({ suit, cards, halfSuitSplitAfter });
    }

    return acc;
  }, []);
}

// ── Suit label ───────────────────────────────────────────────────────────────

const SUIT_LABEL_COLORS: Record<string, string> = {
  s: 'text-gray-500',
  h: 'text-red-400',
  d: 'text-red-400',
  c: 'text-gray-500',
};

// ── Component ────────────────────────────────────────────────────────────────

export default function DesktopCardHand({
  hand,
  selectedCard = null,
  onSelectCard,
  isMyTurn,
  faceDown = false,
  disabled = false,
  variant,
  className = '',
  newlyArrivedCardId = null,
}: DesktopCardHandProps) {
  if (hand.length === 0) {
    return (
      <div
        className={`hidden sm:flex items-center justify-center h-20 text-xs text-slate-500 ${className}`}
        data-testid="desktop-hand-empty"
      >
        No cards — waiting for the next declaration…
      </div>
    );
  }

  const canInteract = isMyTurn && !disabled && !!onSelectCard;
  const groups = buildSuitGroups(hand, variant);
  const totalCards = hand.length;

  return (
    <div
      className={`hidden sm:block w-full ${className}`}
      aria-label={`Your hand: ${totalCards} card${totalCards !== 1 ? 's' : ''}`}
      data-testid="desktop-card-hand"
    >
      {/* Scrollable row — allows very large hands to scroll horizontally */}
      <div
        className="flex items-end gap-3 overflow-x-auto pb-2 px-1"
        style={{ scrollbarWidth: 'thin' }}
        role="group"
        aria-label="Card hand groups"
      >
        {groups.map((group, groupIdx) => (
          <div
            key={group.suit}
            className="flex-shrink-0 flex flex-col items-center gap-1"
            data-testid={`suit-group-${group.suit}`}
            role="group"
            aria-label={`${SUIT_NAMES[group.suit as 's' | 'h' | 'd' | 'c']} — ${group.cards.length} card${group.cards.length !== 1 ? 's' : ''}`}
          >
            {/* Suit label above the group */}
            <span
              className={`text-xs font-semibold tracking-wide select-none ${SUIT_LABEL_COLORS[group.suit]}`}
              aria-hidden="true"
              data-testid={`suit-label-${group.suit}`}
            >
              {SUIT_SYMBOLS[group.suit as 's' | 'h' | 'd' | 'c']}
            </span>

            {/* Cards in a row with slight overlap + half-suit boundary notch */}
            <div className="flex items-end relative" role="list">
              {group.cards.map((cardId, cardIdx) => {
                const isSelected = cardId === selectedCard;
                const isBeforeBoundary =
                  group.halfSuitSplitAfter > 0 &&
                  cardIdx === group.halfSuitSplitAfter - 1 &&
                  group.halfSuitSplitAfter < group.cards.length;

                return (
                  <div
                    key={cardId}
                    role="listitem"
                    className="relative"
                    style={{
                      // Slight negative overlap for dense hands
                      marginLeft: cardIdx === 0 ? 0 : totalCards > 16 ? '-10px' : '-4px',
                      zIndex: isSelected ? 50 : cardIdx + 1,
                      // Lift selected cards, apply subtle arc otherwise
                      transform: isSelected
                        ? 'translateY(-14px)'
                        : undefined,
                      transition: 'transform 0.12s ease, z-index 0s',
                    }}
                    data-testid={`card-wrapper-${cardId}`}
                  >
                    {/* Flip animation for newly-arrived cards (Sub-AC 2 of AC 33) */}
                    {!faceDown && cardId === newlyArrivedCardId ? (
                      <CardFlipWrapper
                        cardId={cardId}
                        selected={isSelected}
                        disabled={!canInteract}
                        onClick={canInteract ? () => onSelectCard!(cardId) : undefined}
                        size="md"
                      />
                    ) : (
                      <PlayingCard
                        cardId={cardId}
                        faceDown={faceDown}
                        selected={isSelected}
                        disabled={!canInteract}
                        onClick={canInteract ? () => onSelectCard!(cardId) : undefined}
                        size="md"
                      />
                    )}
                    {/* Half-suit boundary notch: rendered as a thin right border */}
                    {isBeforeBoundary && (
                      <span
                        className="absolute -right-px top-0 bottom-0 w-0.5 bg-slate-500/60 rounded-full pointer-events-none"
                        aria-hidden="true"
                        data-testid={`half-suit-boundary-${group.suit}`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {/* Suit-group separator lines between groups (visual only) */}
        {groups.length > 1 && (
          <div
            className="sr-only"
            aria-label={`${groups.length} suit groups`}
          />
        )}
      </div>

      {/* Card count — shown when hand has many cards */}
      {totalCards >= 8 && (
        <p
          className="text-right text-xs text-slate-500 font-mono pr-1 mt-0.5"
          aria-hidden="true"
          data-testid="desktop-hand-count"
        >
          {totalCards} cards
        </p>
      )}
    </div>
  );
}
