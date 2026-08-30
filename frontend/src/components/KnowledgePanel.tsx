'use client';

/**
 * KnowledgePanel: the "what I know" note-taking assist. Replays the public ask
 * log into what each other player is known to hold or lack. Only shows
 * information the whole table already saw.
 */

import { buildKnowledge } from '@/lib/knowledge';
import { SUIT_SYMBOLS, cardRankLabel, parseCard } from '@/types/game';
import type { AskRecord, CardId, CardSuit, GamePlayer, HalfSuitId } from '@/types/game';

interface KnowledgePanelProps {
  players: GamePlayer[];
  myPlayerId: string | null;
  askHistory: AskRecord[];
  declaredSuits: HalfSuitId[];
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s';
  onClose: () => void;
}

function CardChip({ card, muted }: { card: CardId; muted?: boolean }) {
  const { rank, suit } = parseCard(card);
  const red = suit === 'h' || suit === 'd';
  return (
    <span
      className={[
        'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold tabular-nums',
        muted ? 'bg-slate-800 text-slate-500 line-through' : red ? 'bg-white text-red-600' : 'bg-white text-slate-900',
      ].join(' ')}
    >
      {cardRankLabel(rank)}{SUIT_SYMBOLS[suit]}
    </span>
  );
}

function halfSuitShort(id: HalfSuitId): string {
  const [tier, suit] = id.split('_');
  return `${tier === 'low' ? 'Low' : 'High'} ${SUIT_SYMBOLS[suit as CardSuit] ?? suit}`;
}

export default function KnowledgePanel({
  players,
  myPlayerId,
  askHistory,
  declaredSuits,
  variant,
  onClose,
}: KnowledgePanelProps) {
  const knowledge = buildKnowledge(askHistory, declaredSuits, variant);
  const others = [...players]
    .filter((p) => p.playerId !== myPlayerId)
    .sort((a, b) => a.seatIndex - b.seatIndex);

  return (
    <aside
      className="
        fixed z-30 right-2 top-12 w-[calc(100vw-1rem)] sm:w-72 max-h-[70dvh] overflow-y-auto
        rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur-sm shadow-2xl shadow-black/50
        text-sm text-slate-200
      "
      aria-label="What I know"
      data-testid="knowledge-panel"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60 sticky top-0 bg-slate-900/95">
        <span className="font-semibold text-white">What I know</span>
        <button
          onClick={onClose}
          aria-label="Close what I know"
          className="text-slate-400 hover:text-white px-1 rounded focus:outline-none focus:ring-2 focus:ring-emerald-400"
        >
          ✕
        </button>
      </div>

      {askHistory.length === 0 ? (
        <p className="px-3 py-4 text-slate-500 text-xs">Nothing yet. Asks show up here as they happen.</p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {others.map((p) => {
            const k = knowledge[p.playerId];
            const empty = !k || (k.has.length === 0 && k.lacks.length === 0 && k.halfSuits.length === 0);
            return (
              <li key={p.playerId} className="px-3 py-2 flex flex-col gap-1.5" data-testid={`knowledge-${p.playerId}`}>
                <div className="flex items-center gap-2">
                  <span className={['w-2 h-2 rounded-full', p.teamId === 1 ? 'bg-emerald-400' : 'bg-violet-400'].join(' ')} aria-hidden="true" />
                  <span className="font-medium text-white truncate">{p.displayName}</span>
                  <span className="text-slate-500 text-xs ml-auto tabular-nums">{p.cardCount} cards</span>
                </div>
                {empty ? (
                  <span className="text-slate-500 text-xs">Nothing known yet</span>
                ) : (
                  <>
                    {k.has.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-xs text-emerald-300 w-14 shrink-0">Has</span>
                        {k.has.map((c) => <CardChip key={c} card={c} />)}
                      </div>
                    )}
                    {k.lacks.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-xs text-slate-400 w-14 shrink-0">Not</span>
                        {k.lacks.map((c) => <CardChip key={c} card={c} muted />)}
                      </div>
                    )}
                    {k.halfSuits.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-xs text-slate-400 w-14 shrink-0">Suits</span>
                        <span className="text-xs text-slate-300">{k.halfSuits.map(halfSuitShort).join(' · ')}</span>
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
