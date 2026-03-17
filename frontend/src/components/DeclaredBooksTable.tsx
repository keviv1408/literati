'use client';

import PlayingCard from '@/components/PlayingCard';
import {
  halfSuitLabel,
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
    ? 'top-3 items-end content-end'
    : 'bottom-3 items-start content-start';

  return (
    <div
      className={[
        'absolute inset-x-5 flex h-[36%] flex-wrap justify-center gap-1.5 overflow-hidden',
        zonePositionClass,
      ].join(' ')}
      data-testid={zoneTestId}
      aria-label={`Team ${teamId} declared books`}
    >
      {teamBooks.map((declaredSuit) => {
        const representativeCard = representativeCardForHalfSuit(declaredSuit.halfSuitId);
        return (
          <div
            key={declaredSuit.halfSuitId}
            className="relative"
            title={halfSuitLabel(declaredSuit.halfSuitId)}
            data-testid={`table-book-${declaredSuit.halfSuitId}`}
          >
            <PlayingCard
              cardId={representativeCard}
              size="sm"
              className="h-10 w-7 rounded-[6px] shadow-[0_4px_10px_rgba(15,23,42,0.32)]"
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
      className="relative w-full aspect-[2/1] rounded-full border-2 border-emerald-800/50 bg-emerald-900/20 shadow-inner shadow-black/40 overflow-hidden"
      data-testid="declared-books-table"
      aria-label={`Declared books table for a ${playerCount === 6 ? '3v3' : '4v4'} game`}
    >
      <div
        className="absolute inset-x-8 top-1/2 h-px -translate-y-1/2 bg-white/10"
        aria-hidden="true"
      />
      <div
        className="absolute inset-x-0 top-[18%] text-center text-[9px] font-semibold uppercase tracking-[0.28em] text-violet-200/45"
        aria-hidden="true"
      >
        Team 2
      </div>
      <div
        className="absolute inset-x-0 bottom-[18%] text-center text-[9px] font-semibold uppercase tracking-[0.28em] text-emerald-200/45"
        aria-hidden="true"
      >
        Team 1
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
