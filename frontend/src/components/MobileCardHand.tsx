'use client';

/**
 * MobileCardHand — mobile-optimised card hand display component.
 *
 * Shows the local player's sorted cards in two display modes:
 *
 *   Mobile  (<640 px) — Horizontal-scroll row with overlapping cards.
 *     Each card has an enlarged tap-target wrapper (≥44×44 px per Apple HIG).
 *     A right-side scroll-fade hint shows when more cards are off-screen.
 *     Selected card lifts above the row with an emerald ring highlight.
 *     Scrolls automatically to keep the selected card in view.
 *
 *   Desktop (≥640 px) — Fan/arc layout.
 *     Cards spread in an arc by rotating around a virtual origin
 *     (ARC_ORIGIN_OFFSET_PX) below each card's bottom-centre.  Because all
 *     cards share the same offset, they radiate from the same distant point,
 *     creating a uniform arc rather than simple individual rotations.
 *     Spread angle adapts to hand size so cards never overflow the container.
 *     Selected card lifts cleanly above the fan.
 *
 * Cards are always sorted by suit (Spades → Hearts → Diamonds → Clubs) then
 * by ascending rank for easy readability.
 *
 * Props are intentionally identical to the existing CardHand interface so this
 * component can be used as a drop-in replacement.
 */

import { useEffect, useRef, useState } from 'react';
import PlayingCard from './PlayingCard';
import CardFlipWrapper from './CardFlipWrapper';
import type { CardId } from '@/types/game';
import { parseCard } from '@/types/game';
import { sortHandByHalfSuit } from '@/utils/cardSort';

// ── Types ───────────────────────────────────────────────────────────────────

/** Card-removal variant type (mirrors CardHand / DesktopCardHand). */
export type CardVariant = 'remove_2s' | 'remove_7s' | 'remove_8s';

export interface MobileCardHandProps {
  /** The local player's hand of card IDs. */
  hand: CardId[];
  /** Currently selected card (highlighted and lifted). */
  selectedCard?: CardId | null;
  /** Called when the user taps/clicks a card. */
  onSelectCard?: (cardId: CardId) => void;
  /** When true the ask/declare controls are enabled (it is this player's turn). */
  isMyTurn: boolean;
  /** Show face-down card backs instead of faces (e.g. during deal animation). */
  faceDown?: boolean;
  /** Disable all card click interactions. */
  disabled?: boolean;
  /**
   * Card-removal variant — when provided cards are sorted by half-suit
   * (Low → High within each suit) matching the canonical Literature grouping.
   * When omitted cards are sorted by suit (S/H/D/C) then ascending rank.
   */
  variant?: CardVariant;
  /**
   * Card ID that just arrived via a successful ask.  When set, that specific
   * card is rendered with a CardFlipWrapper (back → face flip animation)
   * instead of a plain PlayingCard.
   * Ignored when `faceDown` is true (deal animation already handles that path).
   */
  newlyArrivedCardId?: CardId | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Suit sort priority: Spades < Hearts < Diamonds < Clubs */
const SUIT_ORDER: Record<string, number> = { s: 0, h: 1, d: 2, c: 3 };

/**
 * The virtual arc origin is placed this many pixels below the bottom-centre
 * of each card.  Rotating around a distant common point creates a gentle,
 * natural-looking arc rather than a tight pivot fan.
 */
const ARC_ORIGIN_OFFSET_PX = 320;

/**
 * Maximum total angular spread (in degrees) of the fan.
 * Reduces for large hands so cards remain within the container.
 */
const MAX_SPREAD_DEG = 64;

/**
 * Minimum angular spread (in degrees) so even a 1–2 card hand looks like a
 * fan and not a vertically stacked pile.
 */
const MIN_SPREAD_DEG = 10;

/**
 * How many pixels to lift the selected card above the fan (desktop arc).
 */
const SELECTED_LIFT_PX = 22;

/**
 * How many pixels each card overlaps the previous card in the mobile
 * horizontal-scroll row.  Larger overlap = more cards visible at once.
 */
const MOBILE_CARD_OVERLAP_PX = 26;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sort a hand for display.
 *
 * When `variant` is provided, uses half-suit grouping (Low→High within each
 * suit) matching the canonical Literature display order.  When variant is
 * unknown, falls back to suit order (S→H→D→C) then ascending rank.
 */
function sortHand(hand: CardId[], variant?: CardVariant): CardId[] {
  if (variant) return sortHandByHalfSuit(hand, variant);
  return [...hand].sort((a, b) => {
    const pa = parseCard(a);
    const pb = parseCard(b);
    const suitDiff = SUIT_ORDER[pa.suit] - SUIT_ORDER[pb.suit];
    return suitDiff !== 0 ? suitDiff : pa.rank - pb.rank;
  });
}

/**
 * Compute the fan-spread parameters for a given hand size.
 *
 * Returns:
 *   - `spreadDeg`  — total angular width of the fan in degrees
 *   - `stepDeg`    — degrees between adjacent cards
 *   - `startDeg`   — rotation angle for the leftmost card
 */
function computeFanParams(count: number): {
  spreadDeg: number;
  stepDeg: number;
  startDeg: number;
} {
  if (count <= 1) return { spreadDeg: 0, stepDeg: 0, startDeg: 0 };
  // Scale spread with hand size, clamped to [MIN, MAX]
  const spreadDeg = Math.min(MAX_SPREAD_DEG, Math.max(MIN_SPREAD_DEG, count * 7));
  const stepDeg = spreadDeg / (count - 1);
  const startDeg = -(spreadDeg / 2);
  return { spreadDeg, stepDeg, startDeg };
}

// ── Component ────────────────────────────────────────────────────────────────

export default function MobileCardHand({
  hand,
  selectedCard = null,
  onSelectCard,
  isMyTurn,
  faceDown = false,
  disabled = false,
  variant,
  newlyArrivedCardId = null,
}: MobileCardHandProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const selectedCardRef = useRef<HTMLDivElement>(null);
  const [showRightFade, setShowRightFade] = useState(true);
  const [showLeftFade, setShowLeftFade] = useState(false);

  const canInteract = isMyTurn && !disabled && !!onSelectCard;
  const sorted = sortHand(hand, variant);
  const count = sorted.length;

  // ── Scroll the selected card into view on mobile ──────────────────────────
  useEffect(() => {
    if (selectedCard && selectedCardRef.current) {
      // Guard: scrollIntoView may not be available in all environments (e.g. JSDOM).
      if (typeof selectedCardRef.current.scrollIntoView === 'function') {
        selectedCardRef.current.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'center',
        });
      }
    }
  }, [selectedCard]);

  // ── Update scroll fade indicators ────────────────────────────────────────
  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const atStart = el.scrollLeft <= 4;
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
    setShowLeftFade(!atStart);
    setShowRightFade(!atEnd);
  }

  // Initialise fade state after mount (cards may not overflow on short hands)
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
    setShowRightFade(!atEnd);
    setShowLeftFade(false);
  }, [count]);

  // ── Empty hand state ─────────────────────────────────────────────────────
  if (count === 0) {
    return (
      <div
        className="flex items-center justify-center h-16 text-xs text-slate-500"
        aria-label="Your hand: 0 cards"
        data-testid="card-hand-empty"
      >
        No cards — waiting for the next declaration…
      </div>
    );
  }

  // ── Fan parameters (used by desktop arc layout) ──────────────────────────
  const { stepDeg, startDeg } = computeFanParams(count);

  return (
    <div
      className="relative w-full"
      aria-label={`Your hand: ${count} card${count !== 1 ? 's' : ''}`}
      data-testid="mobile-card-hand"
    >
      {/* ── Mobile: horizontal-scroll row ─────────────────────────────────
       *
       * All cards are laid out in a scrollable flex row with overlap.
       * Each card is wrapped in a touch-target div that ensures ≥44×44 px.
       * The selected card is lifted above the row via translateY.
       *
       * Left / right gradient fades are positioned above the scroll area and
       * toggled via state derived from the scroll position.
       */}
      <div
        className="sm:hidden relative"
        data-testid="mobile-scroll-container"
      >
        {/* Left scroll fade */}
        <div
          className={[
            'pointer-events-none absolute left-0 top-0 bottom-0 w-10 z-10',
            'bg-gradient-to-r from-slate-900/90 to-transparent',
            'transition-opacity duration-200',
            showLeftFade ? 'opacity-100' : 'opacity-0',
          ].join(' ')}
          aria-hidden="true"
          data-testid="mobile-hand-left-fade"
        />
        {/* Right scroll fade */}
        <div
          className={[
            'pointer-events-none absolute right-0 top-0 bottom-0 w-10 z-10',
            'bg-gradient-to-l from-slate-900/90 to-transparent',
            'transition-opacity duration-200',
            showRightFade ? 'opacity-100' : 'opacity-0',
          ].join(' ')}
          aria-hidden="true"
          data-testid="mobile-hand-right-fade"
        />

        {/* Scrollable card row */}
        <div
          ref={scrollContainerRef}
          className="flex items-end overflow-x-auto pb-3 pt-2 px-3"
          style={{
            WebkitOverflowScrolling: 'touch',
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
          }}
          onScroll={handleScroll}
          role="list"
          aria-label={`Your hand: ${count} cards`}
          data-testid="mobile-hand-scroll"
        >
          {sorted.map((cardId, i) => {
            const isSelected = cardId === selectedCard;
            return (
              <div
                key={cardId}
                ref={isSelected ? selectedCardRef : null}
                role="listitem"
                className="flex-shrink-0"
                style={{
                  /* Overlap each card onto the previous one */
                  marginLeft: i === 0 ? 0 : -MOBILE_CARD_OVERLAP_PX,
                  zIndex: isSelected ? 60 : i + 1,
                  position: 'relative',
                  /* Lift selected card above the row */
                  transform: isSelected ? 'translateY(-14px)' : 'translateY(0)',
                  transition: 'transform 150ms ease',
                }}
              >
                {/*
                 * Enlarged tap-target wrapper.
                 * PlayingCard `md` size is 48×72 px (w-12 h-18).
                 * Adding 4px vertical padding achieves ≥44 px min tap height.
                 * The horizontal overlap handles width — each exposed slice is
                 * at least 22 px wide; users typically swipe/tap the top portion
                 * which is 48 px wide (full card width visible at the top).
                 */}
                <div
                  style={{ paddingTop: '4px', paddingBottom: '4px' }}
                  aria-label={isSelected ? 'Selected card' : undefined}
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
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Desktop: fan / arc layout ──────────────────────────────────────
       *
       * Cards are positioned in a flex row, each rotated by `stepDeg` around a
       * virtual origin ARC_ORIGIN_OFFSET_PX below the card's bottom centre.
       * Using `transform-origin: 50% calc(100% + ARC_ORIGIN_OFFSET_PX)` ensures
       * all cards rotate around the SAME distant point, creating a uniform arc.
       *
       * The outer container has `overflow: visible` so rotated extremes are not
       * clipped. The `minHeight` is set to accommodate the tallest card in the fan.
       */}
      <div
        className="hidden sm:flex items-end justify-center overflow-visible"
        style={{ minHeight: '110px', paddingBottom: '8px' }}
        role="list"
        aria-label={`Your hand: ${count} cards`}
        data-testid="desktop-hand-fan"
      >
        {sorted.map((cardId, i) => {
          const isSelected = cardId === selectedCard;
          const angleDeg = startDeg + i * stepDeg;

          return (
            <div
              key={cardId}
              role="listitem"
              style={{
                position: 'relative',
                flexShrink: 0,
                /*
                 * Overlap cards so the fan fits within the container.
                 * The negative margin value scales with hand size.
                 */
                marginLeft: count > 5 ? '-12px' : '-4px',
                marginRight: count > 5 ? '-12px' : '-4px',
                /*
                 * Rotate around a point ARC_ORIGIN_OFFSET_PX below the card's
                 * bottom centre — all cards share this same virtual pivot point.
                 */
                transformOrigin: `50% calc(100% + ${ARC_ORIGIN_OFFSET_PX}px)`,
                transform: `rotate(${angleDeg}deg) translateY(${isSelected ? -SELECTED_LIFT_PX : 0}px)`,
                zIndex: isSelected ? 60 : i + 1,
                transition: 'transform 150ms ease, z-index 0ms',
              }}
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
            </div>
          );
        })}
      </div>

      {/* Card count badge — visible on both mobile and desktop for large hands */}
      {count > 9 && (
        <span
          className="absolute -top-1 right-1 text-xs text-slate-400 font-mono bg-slate-800/70 rounded px-1"
          aria-hidden="true"
          data-testid="card-count-badge"
        >
          {count}
        </span>
      )}
    </div>
  );
}
