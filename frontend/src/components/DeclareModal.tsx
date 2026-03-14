'use client';

/**
 * DeclareModal — lets the current-turn player declare a half-suit.
 *
 * Flow:
 *   1. Player clicks "Declare" button
 *   2. Selects which half-suit to declare (only undeclared ones shown)
 *   3. For each card in the half-suit, assigns it to a teammate (or themselves)
 *   4. Confirms — sends declare_suit message
 *
 * Cards known by the player (in their hand) are pre-filled.
 * Unknown cards can be assigned to any teammate by the player.
 *
 * ### Seat-targeting interaction (Sub-AC 22c):
 *   In Step 2 (card assignment), the player can also assign cards via a two-tap
 *   seat-targeting flow instead of the dropdown:
 *
 *   1. Tap a card row to select it (the row highlights and a seat strip appears
 *      at the top of the assignment list).
 *   2. Tap a teammate chip in the seat strip to complete the assignment.
 *   3. The card row assignment updates, the selection clears, and the seat strip
 *      dismisses until the next card is tapped.
 *
 *   Tapping the same selected card again deselects it.
 *   Changing the suit (Back → Step 1) also clears the selection.
 *   The dropdown is still present alongside the seat-targeting approach.
 *
 * Real-time broadcast (Sub-AC 21b):
 *   While in Step 2 (card assignment), the modal calls `onDeclareProgress`
 *   on every assignment change so the parent can forward it to the server
 *   as a `declare_progress` WebSocket message.  All other connected clients
 *   (players + spectators) then receive a live "X is declaring Low Spades
 *   (3/6 assigned)" progress banner via the server broadcast.
 *
 *   `onDeclareProgress(null, {})` is called when the player goes back to
 *   Step 1 or cancels the modal, signalling a cancellation to observers.
 */

import { useState, useEffect, useCallback } from 'react';
import PlayingCard from './PlayingCard';
import Avatar from './Avatar';
import TurnTimerStrip from './TurnTimerStrip';
import {
  halfSuitLabel,
  getHalfSuitCards,
  allHalfSuitIds,
  cardLabel,
  SUIT_SYMBOLS,
} from '@/types/game';
import type { CardId, HalfSuitId, GamePlayer, DeclaredSuit } from '@/types/game';
import type { ProbabilityMap } from '@/utils/cardProbabilities';
import type { TurnTimerPayload } from '@/hooks/useGameSocket';

interface DeclareModalProps {
  myPlayerId: string;
  myHand: CardId[];
  players: GamePlayer[];
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s';
  declaredSuits: DeclaredSuit[];
  onConfirm: (halfSuitId: HalfSuitId, assignment: Record<CardId, string>) => void;
  onCancel: () => void;
  isLoading?: boolean;
  /**
   * When inference mode is active, the parent passes this function so the
   * modal can show probability hints alongside each card's teammate selector.
   *
   * `getCardProbabilities(cardId)` returns a ProbabilityMap (playerId → %)
   * for the card.  The modal uses this to label each teammate option with the
   * likelihood that they hold the card.
   */
  getCardProbabilities?: (cardId: CardId) => ProbabilityMap;
  /**
   * Active server-side turn timer payload.  When provided, the modal renders
   * a `TurnTimerStrip` so the countdown remains visible even though the modal
   * backdrop covers the full-width `TurnTimerBar` in the game page layout.
   * Ensures the 30-second timer is continuous across both declaration steps
   * (suit selection → card assignment).
   */
  turnTimer?: TurnTimerPayload | null;
  /**
   * Called each time the in-progress card assignment changes (Sub-AC 21b).
   *
   * Pass to the parent so it can forward the progress to the server as a
   * `declare_progress` WebSocket message, which is then broadcast to all
   * OTHER connected clients (players + spectators) for a live progress banner.
   *
   * Signature:
   *   `onDeclareProgress(halfSuitId, assignment)`
   *     - halfSuitId: the half-suit being declared
   *     - assignment: partial { cardId → playerId } map as assembled so far
   *
   *   `onDeclareProgress(null, {})` — declarant cancelled (back / modal close)
   *
   * If omitted, progress events are silently skipped (backward-compatible).
   */
  onDeclareProgress?: (halfSuitId: HalfSuitId | null, assignment: Record<CardId, string>) => void;
  /**
   * Called when the player picks a half-suit in Step 1 (suit picker phase)
   * or clears their selection (Sub-AC 21a — private suit selection).
   *
   * The parent forwards this as a `declare_selecting` WebSocket message.
   * The server stores the suit PRIVATELY — it is NEVER broadcast to other
   * players until the final `declare_suit` is submitted.
   *
   * Called with the chosen `halfSuitId` when a suit is selected.
   * Called with `null` when the player presses "Back" or cancels, clearing
   * the stored selection on the server.
   *
   * If omitted, the private selection signal is silently skipped (backward-compatible).
   */
  onSuitSelect?: (halfSuitId: HalfSuitId | null) => void;
}

export default function DeclareModal({
  myPlayerId,
  myHand,
  players,
  variant,
  declaredSuits,
  onConfirm,
  onCancel,
  isLoading = false,
  getCardProbabilities,
  turnTimer,
  onDeclareProgress,
  onSuitSelect,
}: DeclareModalProps) {
  const myPlayer  = players.find((p) => p.playerId === myPlayerId);
  const myTeamId  = myPlayer?.teamId;
  const teammates = players.filter((p) => p.teamId === myTeamId);

  const declaredIds    = new Set(declaredSuits.map((d) => d.halfSuitId));
  const undeclaredSuits = allHalfSuitIds().filter((id) => !declaredIds.has(id));

  const [selectedSuit, setSelectedSuit] = useState<HalfSuitId | null>(null);
  const [assignment, setAssignment]     = useState<Record<CardId, string>>({});
  /**
   * Card selected for seat-targeting assignment (Sub-AC 22c).
   *
   * When non-null, a seat strip is shown at the top of the card assignment
   * section with one chip per teammate.  Tapping a chip assigns this card to
   * that teammate and clears the selection.  Tapping the same card row again
   * deselects it.  Reset to null whenever the selected suit changes.
   */
  const [selectedCardForAssign, setSelectedCardForAssign] = useState<CardId | null>(null);

  // When a suit is selected, pre-fill known cards and broadcast initial progress.
  // Also clear any pending seat-targeting selection from a previous suit.
  useEffect(() => {
    if (!selectedSuit) return;

    // Clear seat-targeting selection when suit changes
    setSelectedCardForAssign(null);

    const cards = getHalfSuitCards(selectedSuit, variant);
    const initial: Record<CardId, string> = {};

    for (const card of cards) {
      if (myHand.includes(card)) {
        initial[card] = myPlayerId;
      } else {
        // Pre-assign to first teammate (unknown; can be changed by player)
        initial[card] = teammates[0]?.playerId ?? myPlayerId;
      }
    }

    setAssignment(initial);
    // Broadcast initial state immediately so other clients see "declaring started"
    onDeclareProgress?.(selectedSuit, initial);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSuit]);

  // Broadcast progress whenever assignment changes while in Step 2.
  // The `selectedSuit` check ensures we don't re-broadcast on cancel/reset.
  // Separate from the selectedSuit effect to avoid double-firing on suit select.
  useEffect(() => {
    if (!selectedSuit || Object.keys(assignment).length === 0) return;
    onDeclareProgress?.(selectedSuit, assignment);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignment]);

  const setCardAssignee = useCallback((cardId: CardId, playerId: string) => {
    // Update assignment; the effect above will broadcast the change.
    setAssignment((prev) => ({ ...prev, [cardId]: playerId }));
  }, []);

  /**
   * Sub-AC 22c — card row tap: select this card for seat-targeting.
   *
   * Tapping a non-mine card row toggles `selectedCardForAssign`:
   *   • If the card is already selected → deselect (clear).
   *   • If another card is selected → switch to this card.
   *   • If nothing is selected → select this card.
   */
  const handleCardTap = useCallback((cardId: CardId) => {
    setSelectedCardForAssign((prev) => (prev === cardId ? null : cardId));
  }, []);

  /**
   * Sub-AC 22c — teammate seat chip tap: complete the assignment.
   *
   * Assigns `selectedCardForAssign` to `playerId`, then clears the selection
   * so the seat strip dismisses.  No-op if there is no card currently selected.
   */
  const handleSeatTargetClick = useCallback((playerId: string) => {
    if (!selectedCardForAssign) return;
    setCardAssignee(selectedCardForAssign, playerId);
    setSelectedCardForAssign(null);
  }, [selectedCardForAssign, setCardAssignee]);

  function handleBack() {
    // Clear private server-side suit selection (Sub-AC 21a)
    onSuitSelect?.(null);
    // Broadcast cancellation before resetting state so observers clear their banners
    onDeclareProgress?.(null, {});
    setSelectedSuit(null);
    setAssignment({});
  }

  function handleCancel() {
    // Clear private server-side suit selection if we were in Step 1 or Step 2 (Sub-AC 21a)
    if (selectedSuit) {
      onSuitSelect?.(null);
      onDeclareProgress?.(null, {});
    }
    onCancel();
  }

  function handleConfirm() {
    if (!selectedSuit || isLoading) return;
    const cards = getHalfSuitCards(selectedSuit, variant);
    // Ensure all 6 cards are assigned
    const complete = cards.every((c) => assignment[c]);
    if (!complete) return;
    onConfirm(selectedSuit, assignment);
  }

  const suitCards = selectedSuit ? getHalfSuitCards(selectedSuit, variant) : [];
  const isComplete = suitCards.every((c) => assignment[c]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Declare a half-suit"
    >
      <div className="w-full max-w-lg bg-slate-800 rounded-2xl shadow-xl border border-slate-700/50 overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-slate-700/50 flex-shrink-0">
          <h2 className="text-lg font-bold text-white">Declare a Half-Suit</h2>
          <p className="text-sm text-slate-400 mt-0.5">
            Assign all 6 cards to teammates. Correct → your team scores. Wrong → opponents score.
          </p>
          {/* Turn timer strip — keeps the server-side countdown visible while
              the modal is open across both declaration steps (suit selection
              and card assignment), so the timer persists throughout. */}
          {turnTimer && (
            <TurnTimerStrip
              turnTimer={turnTimer}
              isMyTimer={turnTimer.playerId === myPlayerId}
              className="mt-3"
            />
          )}
        </div>

        <div className="overflow-y-auto flex-1">
          {/* Step 1: Choose half-suit */}
          {!selectedSuit ? (
            <div className="px-5 py-4">
              <p className="text-xs text-slate-500 uppercase tracking-widest mb-3">
                Select a half-suit to declare:
              </p>
              <div className="grid grid-cols-2 gap-2">
                {undeclaredSuits.map((suitId) => {
                  const [tier, suit] = suitId.split('_');
                  const cards = getHalfSuitCards(suitId, variant);
                  const myCardsInSuit = cards.filter((c) => myHand.includes(c));
                  const suitSymbol = SUIT_SYMBOLS[suit as 's' | 'h' | 'd' | 'c'];

                  const noCards = myCardsInSuit.length === 0;
                  return (
                    <button
                      key={suitId}
                      onClick={() => {
                        if (noCards) return;
                        // Notify server of the private suit selection (Sub-AC 21a)
                        onSuitSelect?.(suitId);
                        setSelectedSuit(suitId);
                      }}
                      disabled={noCards}
                      className={[
                        'flex items-center gap-2 px-3 py-3 rounded-xl border-2 transition-all duration-100 text-left',
                        'focus:outline-none focus:ring-2 focus:ring-emerald-400',
                        noCards
                          ? 'border-slate-700/30 bg-slate-800/30 text-slate-500 cursor-not-allowed opacity-50'
                          : 'border-slate-600 bg-slate-700/30 text-white hover:border-emerald-500',
                      ].join(' ')}
                      aria-label={`Declare ${halfSuitLabel(suitId)} (you hold ${myCardsInSuit.length}/6)`}
                      aria-disabled={noCards}
                      title={noCards ? 'You hold no cards from this half-suit' : undefined}
                    >
                      <span className={[
                        'text-2xl',
                        suit === 'h' || suit === 'd' ? 'text-red-400' : 'text-slate-300',
                      ].join(' ')}>
                        {suitSymbol}
                      </span>
                      <div>
                        <p className="font-semibold text-sm">{halfSuitLabel(suitId)}</p>
                        <p className="text-xs text-slate-500">
                          You hold {myCardsInSuit.length}/6
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
              {undeclaredSuits.length === 0 && (
                <p className="text-sm text-slate-500 text-center py-4">
                  All half-suits have been declared.
                </p>
              )}
            </div>
          ) : (
            /* Step 2: Assign cards */
            <div className="px-5 py-4">
              <div className="flex items-center gap-2 mb-4">
                <button
                  onClick={handleBack}
                  className="text-slate-400 hover:text-white text-sm"
                  aria-label="Back to suit selection"
                >
                  ← Back
                </button>
                <h3 className="font-semibold text-white">{halfSuitLabel(selectedSuit)}</h3>
              </div>

              {/* ── Seat-targeting strip (Sub-AC 22c) ────────────────────────
                  Appears when the player taps a card row to enter targeting mode.
                  Shows one chip per teammate; tapping a chip completes the
                  assignment and dismisses the strip.
              ─────────────────────────────────────────────────────────────── */}
              {selectedCardForAssign && (
                <div
                  className="mb-3 p-3 bg-amber-900/30 border border-amber-600/50 rounded-xl"
                  data-testid="seat-targeting-strip"
                  role="group"
                  aria-label={`Tap a teammate to assign ${cardLabel(selectedCardForAssign)}`}
                >
                  <p className="text-xs text-amber-300 font-semibold mb-2 flex items-center gap-1">
                    <span aria-hidden="true">🎯</span>
                    Tap a teammate to assign{' '}
                    <span className="font-bold text-amber-100">{cardLabel(selectedCardForAssign)}</span>:
                  </p>
                  <div className="flex flex-wrap gap-2" role="list">
                    {teammates.map((p) => {
                      const isCurrentAssignee = assignment[selectedCardForAssign] === p.playerId;
                      return (
                        <button
                          key={p.playerId}
                          type="button"
                          onClick={() => handleSeatTargetClick(p.playerId)}
                          className={[
                            'flex items-center gap-1.5 px-2 py-1.5 rounded-xl border-2 transition-all',
                            'focus:outline-none focus:ring-2 focus:ring-amber-400',
                            isCurrentAssignee
                              ? 'border-amber-400 bg-amber-600/40 text-amber-100'
                              : 'border-amber-700/60 bg-amber-900/20 text-amber-200 hover:border-amber-500 hover:bg-amber-800/30',
                          ].join(' ')}
                          aria-label={`Assign ${cardLabel(selectedCardForAssign)} to ${p.displayName}${p.playerId === myPlayerId ? ' (you)' : ''}${isCurrentAssignee ? ', currently assigned' : ''}`}
                          aria-pressed={isCurrentAssignee}
                          role="listitem"
                          data-testid="seat-target-chip"
                          data-player-id={p.playerId}
                        >
                          <Avatar
                            displayName={p.displayName}
                            imageUrl={p.avatarId ?? undefined}
                            size="xs"
                          />
                          <span className="text-xs font-medium truncate max-w-[5rem]">
                            {p.displayName}
                            {p.playerId === myPlayerId && (
                              <span className="text-amber-400 ml-0.5">(you)</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <p className="text-xs text-slate-500 mb-3">
                {selectedCardForAssign
                  ? 'Or use the dropdowns below:'
                  : 'Tap a card to use seat targeting, or assign via dropdown:'}
              </p>

              <div className="space-y-3">
                {suitCards.map((cardId) => {
                  const isMine   = myHand.includes(cardId);
                  const assignee = assignment[cardId];
                  const isSelectedForTargeting = selectedCardForAssign === cardId;
                  // Per-card probability map (only when inference is active)
                  const cardProbs = getCardProbabilities ? getCardProbabilities(cardId) : null;

                  return (
                    <div
                      key={cardId}
                      className={[
                        'flex items-center gap-3 rounded-xl transition-all duration-100',
                        // Highlight selected card row; non-mine cards become clickable
                        !isMine && isSelectedForTargeting
                          ? 'bg-amber-900/20 ring-2 ring-amber-500/60 p-1 -mx-1'
                          : !isMine
                          ? 'cursor-pointer hover:bg-slate-700/30 rounded-lg p-1 -mx-1'
                          : '',
                      ].join(' ')}
                      // Tap card row to enter seat-targeting mode (Sub-AC 22c)
                      onClick={!isMine ? () => handleCardTap(cardId) : undefined}
                      role={!isMine ? 'button' : undefined}
                      tabIndex={!isMine ? 0 : undefined}
                      onKeyDown={!isMine ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleCardTap(cardId);
                        }
                      } : undefined}
                      aria-label={!isMine
                        ? `${cardLabel(cardId)} — tap to ${isSelectedForTargeting ? 'deselect' : 'select for seat targeting'}`
                        : undefined}
                      aria-pressed={!isMine ? isSelectedForTargeting : undefined}
                      data-testid={!isMine ? 'assignable-card-row' : 'owned-card-row'}
                      data-card-id={cardId}
                      data-selected={isSelectedForTargeting ? 'true' : undefined}
                    >
                      {/* Card preview — Sub-AC 22b: selected state lifts the
                          card with an emerald ring to clearly indicate which
                          card is pending assignment.  Locked (in-hand) cards
                          are never shown in the selected state. */}
                      <div className="flex-shrink-0 min-w-[36px] min-h-[44px] flex items-center justify-center">
                        <PlayingCard
                          cardId={cardId}
                          size="sm"
                          selected={!isMine && isSelectedForTargeting}
                        />
                      </div>

                      {/* Assignment selector */}
                      <div className="flex-1">
                        {isMine ? (
                          <div className="flex items-center gap-2 px-3 py-2 bg-emerald-900/30 border border-emerald-700/50 rounded-lg">
                            <span className="text-xs text-emerald-400">In your hand ✓</span>
                          </div>
                        ) : (
                          <div onClick={(e) => e.stopPropagation()}>
                            <select
                              value={assignee ?? ''}
                              onChange={(e) => {
                                setCardAssignee(cardId, e.target.value);
                                // Clear seat-targeting selection when dropdown is used
                                if (selectedCardForAssign === cardId) setSelectedCardForAssign(null);
                              }}
                              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                              aria-label={`Who holds ${cardLabel(cardId)}?`}
                            >
                              <option value="">Who holds this?</option>
                              {teammates.map((p) => {
                                const pct = cardProbs ? (cardProbs[p.playerId] ?? 0) : null;
                                return (
                                  <option key={p.playerId} value={p.playerId}>
                                    {p.displayName}{p.playerId === myPlayerId ? ' (you)' : ''}{pct !== null && pct > 0 ? ` — ~${pct}%` : ''}
                                  </option>
                                );
                              })}
                            </select>
                            {/* Inference probability breakdown below the select */}
                            {cardProbs && Object.keys(cardProbs).length > 0 && (
                              <div
                                className="flex flex-wrap gap-1 mt-1"
                                data-testid="inference-prob-row"
                                aria-label={`Probability hints for ${cardLabel(cardId)}`}
                              >
                                {teammates.map((p) => {
                                  const pct = cardProbs[p.playerId] ?? 0;
                                  if (pct === 0) return null;
                                  const isAssigned = assignee === p.playerId;
                                  return (
                                    <button
                                      key={p.playerId}
                                      type="button"
                                      onClick={() => setCardAssignee(cardId, p.playerId)}
                                      className={[
                                        'text-[0.6rem] font-semibold px-1.5 py-0.5 rounded-full transition-colors',
                                        isAssigned
                                          ? 'bg-cyan-600/60 text-cyan-100 border border-cyan-500'
                                          : 'bg-cyan-900/40 text-cyan-400 border border-cyan-800/60 hover:bg-cyan-800/50',
                                      ].join(' ')}
                                      aria-label={`Assign to ${p.displayName} (~${pct}%)`}
                                      data-testid="inference-prob-chip"
                                    >
                                      {p.displayName.slice(0, 6)}: ~{pct}%
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-5 pb-5 pt-3 flex gap-3 flex-shrink-0 border-t border-slate-700/50">
          <button
            onClick={handleCancel}
            disabled={isLoading}
            className="flex-1 py-3 rounded-xl font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-50"
          >
            Cancel
          </button>
          {selectedSuit && (
            <button
              onClick={handleConfirm}
              disabled={!isComplete || isLoading}
              className="flex-1 py-3 rounded-xl font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isLoading ? 'Declaring…' : 'Declare!'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
