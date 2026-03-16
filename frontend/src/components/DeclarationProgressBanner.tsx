'use client';

/**
 * DeclarationProgressBanner — live "declaration in progress" indicator.
 *
 * Shown to all players and spectators (except the declarant) while the
 * active player is filling out the DeclareModal Step 2 card-assignment form.
 */

import type { DeclareProgressPayload, GamePlayer } from '@/types/game';
import { halfSuitLabel, SUIT_SYMBOLS } from '@/types/game';

interface DeclarationProgressBannerProps {
  /** The in-progress declaration payload from the server broadcast. */
  progress: DeclareProgressPayload;
  /** All players in the game (used to look up the declarant's display name). */
  players: GamePlayer[];
  /** Optional extra CSS classes. */
  className?: string;
}

export default function DeclarationProgressBanner({
  progress,
  players,
  className = '',
}: DeclarationProgressBannerProps) {
  const { declarerId, halfSuitId, assignedCount, totalCards } = progress;

  if (!halfSuitId) return null;

  const declarant = players.find((p) => p.playerId === declarerId);
  const declarantName = declarant?.displayName ?? 'Someone';

  const [, suit] = halfSuitId.split('_');
  const suitSymbol = SUIT_SYMBOLS[suit as 's' | 'h' | 'd' | 'c'] ?? '?';
  const isRedSuit = suit === 'h' || suit === 'd';

  const fraction = totalCards > 0 ? assignedCount / totalCards : 0;
  const pct = Math.round(fraction * 100);

  return (
    <div
      className={[
        'flex items-center gap-3 px-4 py-3',
        'bg-amber-950/80 border border-amber-700/60 rounded-xl',
        'backdrop-blur-sm shadow-lg',
        className,
      ].join(' ')}
      role="status"
      aria-live="polite"
      aria-label={`${declarantName} is declaring ${halfSuitLabel(halfSuitId)}, ${assignedCount} of ${totalCards} cards assigned`}
      data-testid="declaration-progress-banner"
    >
      <span
        className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0"
        aria-hidden="true"
      />

      <span
        className={[
          'text-xl flex-shrink-0',
          isRedSuit ? 'text-red-400' : 'text-slate-300',
        ].join(' ')}
        aria-hidden="true"
      >
        {suitSymbol}
      </span>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-amber-200 truncate">
          <span className="text-white">{declarantName}</span>
          {' '}is declaring{' '}
          <span className="text-amber-300">{halfSuitLabel(halfSuitId)}</span>
        </p>

        <div className="flex items-center gap-2 mt-1">
          <div
            className="flex-1 h-1.5 bg-amber-900/60 rounded-full overflow-hidden"
            aria-hidden="true"
          >
            <div
              className="h-full bg-amber-400 rounded-full transition-all duration-300 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>

          <span
            className="text-xs text-amber-400 font-mono flex-shrink-0 tabular-nums"
            aria-hidden="true"
          >
            {assignedCount}/{totalCards}
          </span>
        </div>
      </div>
    </div>
  );
}
