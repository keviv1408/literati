'use client';

/**
 * AskCardModal — lets the current-turn player ask for a specific card.
 *
 * Flow:
 *   1. Player taps a card from their hand (CardHand sets selectedCard)
 *   2. This modal opens automatically when a card is selected
 *   3. Player picks an opponent to ask
 *   4. Confirm button sends ask_card message
 *
 * Server-side rules enforced separately; client provides UX guidance:
 *   - Only show opponents with ≥1 card
 *   - Disable confirm if no target selected
 */

import { useState } from 'react';
import PlayingCard from './PlayingCard';
import TurnTimerStrip from './TurnTimerStrip';
import {
  cardLabel,
  halfSuitLabel,
  getCardHalfSuit,
} from '@/types/game';
import type { CardId, GamePlayer } from '@/types/game';
import type { TurnTimerPayload } from '@/hooks/useGameSocket';

interface AskCardModalProps {
  selectedCard: CardId;
  myPlayerId: string;
  players: GamePlayer[];
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s';
  onConfirm: (targetPlayerId: string, cardId: CardId) => void;
  onCancel: () => void;
  isLoading?: boolean;
  /**
   * Active server-side turn timer payload.  When provided, the modal renders
   * a `TurnTimerStrip` so the countdown remains visible even though the modal
   * backdrop covers the full-width `TurnTimerBar` in the game page layout.
   * Keeps the 30-second timer continuous across all steps of the ask flow.
   */
  turnTimer?: TurnTimerPayload | null;
}

export default function AskCardModal({
  selectedCard,
  myPlayerId,
  players,
  variant,
  onConfirm,
  onCancel,
  isLoading = false,
  turnTimer,
}: AskCardModalProps) {
  const myPlayer = players.find((p) => p.playerId === myPlayerId);
  const myTeamId = myPlayer?.teamId;

  // Valid targets: opponents with ≥1 card
  const validTargets = players.filter(
    (p) => p.teamId !== myTeamId && p.cardCount > 0
  );

  const [selectedTarget, setSelectedTarget] = useState<string | null>(
    validTargets.length === 1 ? validTargets[0].playerId : null
  );

  const halfSuitId = getCardHalfSuit(selectedCard, variant);
  const suitName   = halfSuitId ? halfSuitLabel(halfSuitId) : '';

  function handleConfirm() {
    if (!selectedTarget || isLoading) return;
    onConfirm(selectedTarget, selectedCard);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Ask for a card"
    >
      <div className="w-full max-w-md bg-slate-800 rounded-2xl shadow-xl border border-slate-700/50 overflow-hidden">
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-slate-700/50">
          <h2 className="text-lg font-bold text-white">Ask for a card</h2>
          <p className="text-sm text-slate-400 mt-0.5">
            Choose an opponent to ask for{' '}
            <span className="font-semibold text-white">{cardLabel(selectedCard)}</span>
            {suitName && (
              <span className="text-slate-500"> ({suitName})</span>
            )}
          </p>
          {/* Turn timer strip — keeps the server-side countdown visible while
              the modal is open, so the timer persists across all ask-flow steps. */}
          {turnTimer && (
            <TurnTimerStrip
              turnTimer={turnTimer}
              isMyTimer={turnTimer.playerId === myPlayerId}
              className="mt-3"
            />
          )}
        </div>

        {/* Selected card preview */}
        <div className="flex justify-center py-4 bg-slate-900/30">
          <PlayingCard cardId={selectedCard} size="lg" />
        </div>

        {/* Opponent list */}
        <div className="px-5 py-3">
          <p className="text-xs text-slate-500 uppercase tracking-widest mb-2">
            Ask from:
          </p>

          {validTargets.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-3">
              No opponents with cards available to ask.
            </p>
          ) : (
            <div className="space-y-2">
              {validTargets.map((player) => {
                const isSelected = selectedTarget === player.playerId;
                return (
                  <button
                    key={player.playerId}
                    onClick={() => setSelectedTarget(player.playerId)}
                    className={[
                      'w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-all duration-100',
                      'text-left focus:outline-none focus:ring-2 focus:ring-emerald-400',
                      isSelected
                        ? 'border-emerald-500 bg-emerald-900/30 text-white'
                        : 'border-slate-600/50 bg-slate-700/30 text-slate-300 hover:border-slate-500 hover:bg-slate-700/50',
                    ].join(' ')}
                    aria-pressed={isSelected}
                    aria-label={`Ask ${player.displayName} (Team ${player.teamId}, ${player.cardCount} cards)`}
                  >
                    {/* Avatar */}
                    <div
                      className={[
                        'w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0',
                        player.teamId === 2 ? 'bg-violet-700 text-violet-100' : 'bg-blue-700 text-blue-100',
                      ].join(' ')}
                    >
                      {player.isBot ? '🤖' : player.displayName.slice(0, 2).toUpperCase()}
                    </div>

                    {/* Name + info */}
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm truncate">{player.displayName}</p>
                      <p className="text-xs text-slate-500">
                        Team {player.teamId} &bull; {player.cardCount} card{player.cardCount !== 1 ? 's' : ''}
                      </p>
                    </div>

                    {/* Radio indicator */}
                    <div
                      className={[
                        'w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0',
                        isSelected ? 'border-emerald-400 bg-emerald-400' : 'border-slate-500',
                      ].join(' ')}
                    >
                      {isSelected && <div className="w-2 h-2 rounded-full bg-white" />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-5 pb-5 pt-2 flex gap-3">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="flex-1 py-3 rounded-xl font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!selectedTarget || isLoading || validTargets.length === 0}
            className="flex-1 py-3 rounded-xl font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label={`Ask ${validTargets.find((p) => p.playerId === selectedTarget)?.displayName ?? ''} for ${cardLabel(selectedCard)}`}
          >
            {isLoading ? 'Asking…' : 'Ask'}
          </button>
        </div>
      </div>
    </div>
  );
}
