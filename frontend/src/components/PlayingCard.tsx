'use client';

/**
 * PlayingCard — renders a single playing card face-up or face-down.
 *
 * Face-up shows the rank + suit symbol with correct color.
 * Face-down shows the card back pattern.
 * Selected state adds an emerald highlight ring.
 */

import { parseCard, cardRankLabel, SUIT_SYMBOLS, SUIT_COLORS } from '@/types/game';
import type { CardId } from '@/types/game';

interface PlayingCardProps {
  cardId: CardId;
  faceDown?: boolean;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** Extra Tailwind classes */
  className?: string;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

const CARD_SVG_BASE_PATH = '/cards/svg';

const SUIT_FILE_NAMES = {
  s: 'spades',
  h: 'hearts',
  d: 'diamonds',
  c: 'clubs',
} as const;

const ILLUSTRATED_VARIANT_RANKS = new Set([11, 12, 13]);

function cardSvgPath(cardId: CardId): string {
  const { rank, suit } = parseCard(cardId);
  const rankFileName =
    rank === 1 ? 'ace'
      : rank === 11 ? 'jack'
        : rank === 12 ? 'queen'
          : rank === 13 ? 'king'
            : String(rank);
  const variantSuffix = ILLUSTRATED_VARIANT_RANKS.has(rank) ? '2' : '';

  return `${CARD_SVG_BASE_PATH}/${rankFileName}_of_${SUIT_FILE_NAMES[suit]}${variantSuffix}.svg`;
}

export default function PlayingCard({
  cardId,
  faceDown = false,
  selected = false,
  disabled = false,
  onClick,
  className = '',
  size = 'md',
}: PlayingCardProps) {
  const SIZE_CLASSES = {
    sm: 'w-9 h-14',
    md: 'w-12 h-18',
    lg: 'w-16 h-24',
    xl: 'w-[4.5rem] h-[6.75rem]',
  };
  const CORNER_RANK_CLASSES = {
    sm: 'text-[0.62rem]',
    md: 'text-[0.72rem]',
    lg: 'text-[0.9rem]',
    xl: 'text-[1rem]',
  };
  const CORNER_SUIT_CLASSES = {
    sm: 'text-[0.56rem]',
    md: 'text-[0.66rem]',
    lg: 'text-[0.82rem]',
    xl: 'text-[0.92rem]',
  };
  const CENTER_SUIT_CLASSES = {
    sm: 'text-[1.1rem]',
    md: 'text-[1.55rem]',
    lg: 'text-[2rem]',
    xl: 'text-[2.2rem]',
  };

  const baseClasses = [
    'relative overflow-hidden rounded-[10px] border select-none font-bold',
    'transition-all duration-150',
    'shadow-[0_1px_1px_rgba(15,23,42,0.28),0_4px_10px_rgba(15,23,42,0.18)]',
    SIZE_CLASSES[size],
    onClick && !disabled ? 'cursor-pointer hover:-translate-y-2 hover:shadow-[0_10px_18px_rgba(15,23,42,0.26)] active:scale-95' : '',
    selected ? 'border-emerald-400 ring-2 ring-emerald-400 -translate-y-3 shadow-emerald-500/30 shadow-lg' : 'border-slate-300/90',
    disabled ? 'opacity-40 cursor-not-allowed' : '',
    faceDown ? 'bg-blue-900 border-slate-200/80' : 'bg-gradient-to-b from-white via-white to-slate-50',
    className,
  ].join(' ');

  if (faceDown) {
    return (
      <div
        className={baseClasses}
        role="img"
        aria-label="Card (face down)"
        onClick={disabled ? undefined : onClick}
      >
        {/* Card back frame */}
        <div className="absolute inset-[3px] rounded-[7px] border border-blue-100/75 bg-blue-800 shadow-inner" />
        <div
          className="absolute inset-[6px] rounded-[5px] border border-blue-200/80"
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, rgba(191,219,254,0.72) 0px, rgba(191,219,254,0.72) 2px, rgba(30,64,175,0.85) 2px, rgba(30,64,175,0.85) 5px)',
          }}
        />
      </div>
    );
  }

  const { rank, suit } = parseCard(cardId);
  const rankStr  = cardRankLabel(rank);
  const suitSymbol = SUIT_SYMBOLS[suit];
  const colorClass = SUIT_COLORS[suit];
  const svgPath = cardSvgPath(cardId);

  return (
    <div
      className={baseClasses}
      role={onClick ? 'button' : 'img'}
      aria-label={`${rankStr} of ${suit === 's' ? 'Spades' : suit === 'h' ? 'Hearts' : suit === 'd' ? 'Diamonds' : 'Clubs'}${selected ? ' (selected)' : ''}`}
      aria-pressed={onClick ? selected : undefined}
      tabIndex={onClick && !disabled ? 0 : undefined}
      onClick={disabled ? undefined : onClick}
      onKeyDown={(e) => {
        if (onClick && !disabled && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {/* Keep a minimal fallback card under the SVG in case the asset fails to load. */}
      <div className="absolute inset-[2px] rounded-[7px] border border-slate-200/85 pointer-events-none" />

      {/* Top-left rank+suit */}
      <div className={`absolute top-1 left-1 z-10 flex flex-col items-start leading-[0.92] ${colorClass}`}>
        <span className={`font-black ${CORNER_RANK_CLASSES[size]}`}>{rankStr}</span>
        <span className={CORNER_SUIT_CLASSES[size]}>{suitSymbol}</span>
      </div>

      {/* Center suit symbol */}
      <div className={`absolute inset-0 z-0 flex items-center justify-center ${CENTER_SUIT_CLASSES[size]} ${colorClass}`}>
        {suitSymbol}
      </div>

      {/* Bottom-right rank+suit (rotated) */}
      <div className={`absolute bottom-1 right-1 z-10 flex flex-col items-end leading-[0.92] rotate-180 ${colorClass}`}>
        <span className={`font-black ${CORNER_RANK_CLASSES[size]}`}>{rankStr}</span>
        <span className={CORNER_SUIT_CLASSES[size]}>{suitSymbol}</span>
      </div>

      <img
        src={svgPath}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="absolute inset-0 z-20 h-full w-full rounded-[10px] object-fill pointer-events-none"
      />
    </div>
  );
}
