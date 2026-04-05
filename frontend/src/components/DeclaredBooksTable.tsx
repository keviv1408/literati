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
  const zoneTestId = teamId === 2 ? 'table-books-team2' : 'table-books-team1';
  const zonePositionClass = teamId === 2
    ? 'top-2 items-end content-end'
    : 'bottom-2 items-start content-start';

  return (
    <div
      className={[
        'absolute inset-x-1 sm:inset-x-5 flex h-[44%] flex-wrap justify-center gap-0.5 sm:gap-1.5 overflow-hidden',
        zonePositionClass,
      ].join(' ')}
      data-testid={zoneTestId}
      aria-label={`Team ${teamId} declared books`}
    >
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
              className="sm:hidden flex flex-col items-center justify-center w-[1.1rem] h-[1.4rem] rounded-[3px] bg-white/10 shadow-sm"
              aria-hidden="true"
            >
              <span
                className={[
                  'text-[0.65rem] leading-none font-bold',
                  pip.isRed ? 'text-red-400' : 'text-slate-200',
                ].join(' ')}
              >
                {pip.symbol}
              </span>
              <span className="text-[0.4rem] leading-none text-white/40 font-semibold">
                {pip.tier}
              </span>
            </div>

            {/* Desktop: full playing card */}
            <PlayingCard
              cardId={representativeCard}
              size="sm"
              className="hidden sm:block h-10 w-7 rounded-[6px] shadow-[0_4px_10px_rgba(15,23,42,0.32)]"
            />
          </div>
        );
      })}
    </div>
  );
}

export default function DeclaredBooksTable({
  declaredSuits,
  playerCount,
}: DeclaredBooksTableProps) {
  return (
    <div
      className="relative w-full aspect-[2/1] rounded-full border border-emerald-800/40 sm:border-2 sm:border-emerald-800/50 bg-emerald-900/15 shadow-inner shadow-black/40 overflow-hidden"
      data-testid="declared-books-table"
      aria-label={`Declared books table for a ${playerCount === 6 ? '3v3' : '4v4'} game`}
    >
      <div
        className="absolute inset-x-8 top-1/2 h-px -translate-y-1/2 bg-white/10"
        aria-hidden="true"
      />
      <div
        className="absolute inset-x-0 top-[18%] text-center text-[6px] sm:text-[9px] font-semibold uppercase tracking-[0.18em] sm:tracking-[0.28em] text-violet-200/40"
        aria-hidden="true"
      >
        <span className="sm:hidden">T2</span>
        <span className="hidden sm:inline">Team 2</span>
      </div>
      <div
        className="absolute inset-x-0 bottom-[18%] text-center text-[6px] sm:text-[9px] font-semibold uppercase tracking-[0.18em] sm:tracking-[0.28em] text-emerald-200/40"
        aria-hidden="true"
      >
        <span className="sm:hidden">T1</span>
        <span className="hidden sm:inline">Team 1</span>
      </div>

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
