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
  size?: 'sm' | 'md' | 'lg';
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
    sm: 'w-9 h-14 text-xs',
    md: 'w-12 h-18 text-sm',
    lg: 'w-16 h-24 text-base',
  };

  const baseClasses = [
    'relative rounded-lg border-2 select-none flex flex-col justify-between p-0.5 sm:p-1 font-bold',
    'transition-all duration-150 shadow-md',
    SIZE_CLASSES[size],
    onClick && !disabled ? 'cursor-pointer hover:-translate-y-2 active:scale-95' : '',
    selected ? 'border-emerald-400 ring-2 ring-emerald-400 -translate-y-3 shadow-emerald-500/30 shadow-lg' : 'border-gray-300',
    disabled ? 'opacity-40 cursor-not-allowed' : '',
    faceDown ? 'bg-blue-900 border-blue-700' : 'bg-white',
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
        {/* Card back pattern */}
        <div className="absolute inset-1 rounded border border-blue-600/50 bg-blue-800/50" />
        <div className="absolute inset-2 rounded border border-blue-500/30" />
      </div>
    );
  }

  const { rank, suit } = parseCard(cardId);
  const rankStr  = cardRankLabel(rank);
  const suitSymbol = SUIT_SYMBOLS[suit];
  const colorClass = SUIT_COLORS[suit];

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
      {/* Top-left rank+suit */}
      <div className={`flex flex-col items-start leading-none ${colorClass}`}>
        <span className="font-black">{rankStr}</span>
        <span className="text-[0.6em] mt-[-2px]">{suitSymbol}</span>
      </div>

      {/* Center suit symbol */}
      <div className={`flex items-center justify-center text-xl sm:text-2xl ${colorClass}`}>
        {suitSymbol}
      </div>

      {/* Bottom-right rank+suit (rotated) */}
      <div className={`flex flex-col items-end leading-none rotate-180 ${colorClass}`}>
        <span className="font-black">{rankStr}</span>
        <span className="text-[0.6em] mt-[-2px]">{suitSymbol}</span>
      </div>
    </div>
  );
}
