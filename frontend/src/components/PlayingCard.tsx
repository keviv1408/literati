'use client';

/**
 * PlayingCard — renders a single playing card face-up or face-down.
 *
 * Face-up shows the rank + suit symbol with correct color.
 * Face-down shows the card back pattern.
 * Selected state adds an emerald highlight ring.
 */

import { parseCard, cardRankLabel, SUIT_NAMES } from '@/types/game';
import { backUrl, cardBackground } from '@/lib/cardDeck';
import CardMarkings from './CardMarkings';
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
  const baseClasses = [
    'relative overflow-hidden border select-none font-bold',
    'transition-all duration-150',
    'shadow-[0_1px_1px_rgba(15,23,42,0.28),0_4px_10px_rgba(15,23,42,0.18)]',
    SIZE_CLASSES[size],
    onClick && !disabled ? 'cursor-pointer hover:-translate-y-2 hover:shadow-[0_10px_18px_rgba(15,23,42,0.26)] active:scale-95' : '',
    selected ? 'border-emerald-400 ring-2 ring-emerald-400 -translate-y-3 shadow-emerald-500/30 shadow-lg' : 'border-slate-300/90',
    disabled ? 'opacity-40 cursor-not-allowed' : '',
    faceDown ? 'rounded-[8%/5.33%] bg-[#223858] bg-cover bg-center' : 'rounded-[8%/5.33%] bg-[#ffedce]',
    className,
  ].join(' ');

  if (faceDown) {
    return (
      <div
        className={baseClasses}
        role="img"
        aria-label="Card (face down)"
        onClick={disabled ? undefined : onClick}
        style={{ backgroundImage: `url("${backUrl}")` }}
      />
    );
  }

  const { rank, suit } = parseCard(cardId);
  const rankStr  = cardRankLabel(rank);
  return (
    <div
      className={baseClasses}
      role={onClick ? 'button' : 'img'}
      aria-label={`${rankStr} of ${SUIT_NAMES[suit]}${selected ? ' (selected)' : ''}`}
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
      <div className="absolute inset-0 pointer-events-none">
        <CardMarkings rank={rankStr} suit={suit} />
        <div aria-hidden="true" className="absolute inset-0" style={cardBackground(rank, suit)} />
      </div>
    </div>
  );
}
