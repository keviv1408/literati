'use client';

import PlayingCard from '@/components/PlayingCard';
import {
  halfSuitLabel,
  SUIT_SYMBOLS,
  type DeclaredSuit,
} from '@/types/game';

interface DeclaredBooksTableProps {
  declaredSuits: DeclaredSuit[];
  playerCount: 6 | 8;
}

function representativeCardForHalfSuit(halfSuitId: string): string {
  const [tier, suit] = halfSuitId.split('_');
  return `${tier === 'low' ? 1 : 13}_${suit}`;
}

function halfSuitPip(halfSuitId: string): { symbol: string; isRed: boolean; tier: string } {
  const [tier, suit] = halfSuitId.split('_');
  return {
    symbol: SUIT_SYMBOLS[suit as keyof typeof SUIT_SYMBOLS] ?? '?',
    isRed: suit === 'h' || suit === 'd',
    tier: tier === 'high' ? 'H' : 'L',
  };
}

function BookZone({
  teamId,
  declaredSuits,
}: {
  teamId: 1 | 2;
  declaredSuits: DeclaredSuit[];
}) {
  const teamBooks = declaredSuits.filter((declaredSuit) => declaredSuit.teamId === teamId);
  return (
    <div
      className="book-zone"
      data-testid={`table-books-team${teamId}`}
      aria-label={`Team ${teamId} declared books`}
    >
      <div
        className={`book-team-label font-semibold uppercase tracking-[0.18em] sm:tracking-[0.28em] ${teamId === 2 ? 'top-0 text-violet-200/60' : 'bottom-0 text-emerald-200/60'}`}
        aria-hidden="true"
      >
        <span className="sm:hidden">T{teamId}</span>
        <span className="hidden sm:inline">Team {teamId}</span>
      </div>
      <div className="book-row">
        {teamBooks.map((declaredSuit) => {
          const pip = halfSuitPip(declaredSuit.halfSuitId);
          const representativeCard = representativeCardForHalfSuit(declaredSuit.halfSuitId);
          return (
            <div
              key={declaredSuit.halfSuitId}
              className="relative"
              title={halfSuitLabel(declaredSuit.halfSuitId)}
              data-testid={`table-book-${declaredSuit.halfSuitId}`}
            >
              {/* Mobile: suit pip — fits inside the tiny mobile felt */}
              <div
                className="sm:hidden flex aspect-[4/5] flex-col items-center justify-center rounded-[3px] bg-white/10 shadow-sm"
                aria-hidden="true"
              >
                <span
                  className={[
                    'text-[min(0.65rem,72cqw)] leading-none font-bold',
                    pip.isRed ? 'text-red-400' : 'text-slate-200',
                  ].join(' ')}
                >
                  {pip.symbol}
                </span>
                <span className="text-[min(0.4rem,44cqw)] leading-none text-white/60 font-semibold">
                  {pip.tier}
                </span>
              </div>

              {/* Desktop: full playing card */}
              <PlayingCard
                cardId={representativeCard}
                size="sm"
                className="hidden sm:block rounded-[6px] shadow-[0_4px_10px_rgba(15,23,42,0.32)]"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function DeclaredBooksTable({
  declaredSuits,
  playerCount,
}: DeclaredBooksTableProps) {
  return (
    <div
      className="absolute inset-0 grid grid-rows-2"
      data-testid="declared-books-table"
      aria-label={`Declared books table for a ${playerCount === 6 ? '3v3' : '4v4'} game`}
    >
      <div
        className="absolute inset-2 sm:inset-3 rounded-[50%] border border-emerald-800/40 sm:border-2 sm:border-emerald-800/50 bg-emerald-900/15 shadow-inner shadow-black/40"
        aria-hidden="true"
      />
      <div
        className="absolute inset-x-[8%] top-1/2 h-px -translate-y-1/2 bg-white/10"
        aria-hidden="true"
      />

      <BookZone
        teamId={2}
        declaredSuits={declaredSuits}
      />
      <BookZone
        teamId={1}
        declaredSuits={declaredSuits}
      />
    </div>
  );
}
