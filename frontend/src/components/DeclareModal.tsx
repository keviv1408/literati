'use client';

/**
 * DeclareModal — lets the current-turn player declare a half-suit.
 *
 * Flow:
 * 1. Player clicks "Declare" button
 * 2. Selects which half-suit to declare (only undeclared ones shown)
 * 3. Cards from that half-suit appear — drag and drop them to teammates
 * 4. Confirms — sends declare_suit message
 *
 * Cards in the player's hand are auto-assigned and shown in the "You" zone.
 * Remaining cards start in an unassigned pool and can be dragged to any
 * teammate zone (or tap-to-assign on mobile).
 *
 * Real-time broadcast:
 * While in Step 2, the modal calls `onDeclareProgress` on every assignment
 * change so the parent can forward it to the server as a `declare_progress`
 * WebSocket message. `onDeclareProgress(null, {})` signals cancellation.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  closestCenter,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import PlayingCard from './PlayingCard';
import Avatar from './Avatar';
import TurnTimerStrip from './TurnTimerStrip';
import DeclarationTimerBar from './DeclarationTimerBar';
import {
  halfSuitLabel,
  getHalfSuitCards,
  allHalfSuitIds,
  cardLabel,
  SUIT_SYMBOLS,
} from '@/types/game';
import type { CardId, HalfSuitId, GamePlayer, DeclaredSuit } from '@/types/game';
import type { TurnTimerPayload, DeclarationTimerPayload } from '@/hooks/useGameSocket';

// ── Sub-components ────────────────────────────────────────────────────────────

/** Draggable card — used in both the unassigned pool and teammate zones. */
function DraggableCard({
  cardId,
  isSelected,
  onTap,
  isDraggable,
}: {
  cardId: CardId;
  isSelected: boolean;
  onTap: () => void;
  isDraggable: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: cardId,
    disabled: !isDraggable,
  });

  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(isDraggable ? { ...listeners, ...attributes } : {})}
      className={[
        'relative transition-all duration-100',
        isDraggable ? 'cursor-grab active:cursor-grabbing' : '',
        isDragging ? 'opacity-30 scale-95' : '',
        isSelected ? 'ring-2 ring-amber-400 rounded-lg scale-105' : '',
      ].filter(Boolean).join(' ')}
      role="button"
      tabIndex={isDraggable ? 0 : -1}
      onClick={(e) => { e.stopPropagation(); if (isDraggable) onTap(); }}
      onKeyDown={(e) => {
        if (isDraggable && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onTap();
        }
      }}
      aria-label={`${cardLabel(cardId)}${isSelected ? ', selected' : ''} — drag to a teammate or tap to select`}
      data-testid="draggable-card"
      data-card-id={cardId}
    >
      <PlayingCard cardId={cardId} size="md" selected={isSelected} />
    </div>
  );
}

/** Droppable teammate zone — shows avatar, name, and assigned cards. */
function TeammateDropZone({
  playerId,
  player,
  isMe,
  assignedCards,
  myHand,
  onTapZone,
  onRemoveCard,
  hasSelectedCard,
  isSubmitted,
}: {
  playerId: string;
  player: GamePlayer;
  isMe: boolean;
  assignedCards: CardId[];
  myHand: CardId[];
  onTapZone: () => void;
  onRemoveCard: (cardId: CardId) => void;
  hasSelectedCard: boolean;
  isSubmitted: boolean;
}) {
  const isDisabled = isMe;
  const { setNodeRef, isOver } = useDroppable({
    id: playerId,
    disabled: isDisabled || isSubmitted,
  });

  const handCards = assignedCards.filter((c) => myHand.includes(c));
  const nonHandCards = assignedCards.filter((c) => !myHand.includes(c));

  return (
    <div
      ref={setNodeRef}
      onClick={!isDisabled && !isSubmitted && hasSelectedCard ? onTapZone : undefined}
      className={[
        'flex flex-col items-center gap-1.5 p-2.5 rounded-xl border-2 transition-all duration-150',
        'min-h-[7rem] flex-1 min-w-0',
        isDisabled
          ? 'border-slate-700/60 bg-slate-900/45 opacity-70 cursor-not-allowed'
          : isOver
          ? 'border-amber-400 bg-amber-900/30 scale-[1.03] shadow-lg shadow-amber-900/20'
          : hasSelectedCard && !isSubmitted
          ? 'border-dashed border-amber-600/50 bg-slate-800/50 cursor-pointer hover:border-amber-500'
          : 'border-slate-600/40 bg-slate-800/30',
      ].filter(Boolean).join(' ')}
      role="region"
      aria-label={`${player.displayName}${isMe ? ' (you, auto-assigned only)' : ''} — ${assignedCards.length} card${assignedCards.length !== 1 ? 's' : ''} assigned`}
      aria-disabled={isDisabled}
      title={isDisabled ? 'Your cards are auto-assigned during declaration' : undefined}
      data-testid="teammate-drop-zone"
      data-player-id={playerId}
    >
      <Avatar displayName={player.displayName} imageUrl={player.avatarId ?? undefined} size="sm" />
      <span className="text-[0.65rem] font-medium text-slate-200 truncate max-w-full text-center leading-tight">
        {player.displayName}
      </span>
      {isMe && (
        <span className="text-[0.5rem] font-semibold text-slate-400 uppercase tracking-wider -mt-0.5">
          You
        </span>
      )}
      {isMe && (
        <span className="text-[0.45rem] font-medium text-slate-500 uppercase tracking-[0.18em] -mt-1">
          Auto-assigned
        </span>
      )}

      {/* Assigned cards */}
      <div className="flex flex-wrap gap-1 justify-center mt-1 min-h-[3.5rem] w-full">
        {handCards.map((cardId) => (
          <div key={cardId} className="relative" title={`${cardLabel(cardId)} — in your hand`}>
            <PlayingCard cardId={cardId} size="sm" />
            <span className="absolute -bottom-0.5 -right-0.5 text-[0.45rem] bg-emerald-800 text-emerald-300 rounded-full px-0.5 leading-tight">
              ✓
            </span>
          </div>
        ))}
        {nonHandCards.map((cardId) => (
          <DraggableCard
            key={cardId}
            cardId={cardId}
            isSelected={false}
            onTap={() => { if (!isSubmitted) onRemoveCard(cardId); }}
            isDraggable={!isSubmitted}
          />
        ))}
        {assignedCards.length === 0 && (
          <span className="text-[0.55rem] text-slate-500 italic mt-3">
            Drop here
          </span>
        )}
      </div>

      {isOver && !isDisabled && (
        <span className="text-[0.5rem] text-amber-300 font-medium animate-pulse">
          Release to assign
        </span>
      )}
    </div>
  );
}

/** Droppable zone for unassigned cards. */
function UnassignedPool({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'unassigned-pool' });

  return (
    <div
      ref={setNodeRef}
      className={[
        'p-3 rounded-xl border-2 border-dashed transition-all duration-150 min-h-[4.5rem]',
        isOver
          ? 'border-slate-400 bg-slate-700/40'
          : 'border-slate-700/50 bg-slate-800/20',
      ].join(' ')}
      role="region"
      aria-label="Unassigned cards"
      data-testid="unassigned-pool"
    >
      {children}
    </div>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface DeclareModalProps {
  myPlayerId: string;
  myHand: CardId[];
  players: GamePlayer[];
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s';
  declaredSuits: DeclaredSuit[];
  onConfirm: (halfSuitId: HalfSuitId, assignment: Record<CardId, string>) => void;
  onCancel: () => void;
  isLoading?: boolean;
  turnTimer?: TurnTimerPayload | null;
  onDeclareProgress?: (halfSuitId: HalfSuitId | null, assignment: Record<CardId, string>) => void;
  onSuitSelect?: (halfSuitId: HalfSuitId | null) => void;
  declarationTimer?: DeclarationTimerPayload | null;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DeclareModal({
  myPlayerId,
  myHand,
  players,
  variant,
  declaredSuits,
  onConfirm,
  onCancel,
  isLoading = false,
  turnTimer,
  onDeclareProgress,
  onSuitSelect,
  declarationTimer,
}: DeclareModalProps) {
  const myPlayer  = players.find((p) => p.playerId === myPlayerId);
  const myTeamId  = myPlayer?.teamId;
  // Sort teammates by seatIndex so the left-right order reflects the table.
  const teammates = players
    .filter((p) => p.teamId === myTeamId)
    .sort((a, b) => a.seatIndex - b.seatIndex);

  const declaredIds    = new Set(declaredSuits.map((d) => d.halfSuitId));
  const undeclaredSuits = allHalfSuitIds().filter((id) => !declaredIds.has(id));

  const [selectedSuit, setSelectedSuit] = useState<HalfSuitId | null>(null);
  const [assignment, setAssignment]     = useState<Record<CardId, string>>({});
  /** ID of the card currently being dragged (for DragOverlay). */
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  /** Card selected via tap (for tap-to-assign mobile flow). */
  const [selectedCard, setSelectedCard] = useState<CardId | null>(null);

  // DnD sensors — pointer requires 8px movement, touch requires 200ms hold.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  // ── Suit selection → initialize assignment with hand cards only ──────────
  useEffect(() => {
    if (!selectedSuit) return;
    setSelectedCard(null);
    setActiveDragId(null);

    const cards = getHalfSuitCards(selectedSuit, variant);
    const initial: Record<CardId, string> = {};
    for (const card of cards) {
      if (myHand.includes(card)) {
        initial[card] = myPlayerId;
      }
      // Non-hand cards start unassigned — player drags them to teammates.
    }
    setAssignment(initial);
    onDeclareProgress?.(selectedSuit, initial);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSuit]);

  // Broadcast progress whenever assignment changes while in Step 2.
  useEffect(() => {
    if (!selectedSuit || Object.keys(assignment).length === 0) return;
    onDeclareProgress?.(selectedSuit, assignment);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignment]);

  // ── DnD handlers ─────────────────────────────────────────────────────────
  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
    setSelectedCard(null);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragId(null);
    const cardId = String(event.active.id) as CardId;
    const overId = event.over?.id;
    if (!overId) return;
    // Never allow moving hand cards
    if (myHand.includes(cardId)) return;

    const overStr = String(overId);
    if (overStr === 'unassigned-pool') {
      // Move back to unassigned
      setAssignment((prev) => {
        const next = { ...prev };
        delete next[cardId];
        return next;
      });
    } else {
      // Assign to teammate (overStr is playerId)
      // Verify the target is actually a teammate
      if (teammates.some((t) => t.playerId === overStr && t.playerId !== myPlayerId)) {
        setAssignment((prev) => ({ ...prev, [cardId]: overStr }));
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myHand, teammates, myPlayerId]);

  // ── Tap-to-assign handlers (mobile-friendly alternative to drag) ─────────
  const handleTapUnassignedCard = useCallback((cardId: CardId) => {
    if (myHand.includes(cardId)) return;
    setSelectedCard((prev) => (prev === cardId ? null : cardId));
  }, [myHand]);

  const handleTapZone = useCallback((playerId: string) => {
    if (!selectedCard || playerId === myPlayerId) return;
    setAssignment((prev) => ({ ...prev, [selectedCard]: playerId }));
    setSelectedCard(null);
  }, [selectedCard, myPlayerId]);

  const handleRemoveCard = useCallback((cardId: CardId) => {
    if (myHand.includes(cardId)) return;
    setAssignment((prev) => {
      const next = { ...prev };
      delete next[cardId];
      return next;
    });
  }, [myHand]);

  // ── Derived data ─────────────────────────────────────────────────────────
  const suitCards = selectedSuit ? getHalfSuitCards(selectedSuit, variant) : [];
  const unassignedCards = suitCards.filter((c) => !assignment[c]);
  const isComplete = suitCards.length > 0 && suitCards.every((c) => assignment[c]);
  const isSubmitted = isLoading;

  /** Cards assigned to a specific teammate. */
  const getTeammateCards = (playerId: string): CardId[] =>
    suitCards.filter((c) => assignment[c] === playerId);

  // ── Navigation & submission ──────────────────────────────────────────────
  function handleBack() {
    onSuitSelect?.(null);
    onDeclareProgress?.(null, {});
    setSelectedSuit(null);
    setAssignment({});
    setSelectedCard(null);
  }

  function handleCancel() {
    if (selectedSuit) {
      onSuitSelect?.(null);
      onDeclareProgress?.(null, {});
    }
    onCancel();
  }

  function handleConfirm() {
    if (!selectedSuit || isLoading) return;
    if (!isComplete) return;
    onConfirm(selectedSuit, assignment);
  }

  /** Timer expiry — auto-fill unassigned cards to first teammate, then submit. */
  const handleTimerExpiry = useCallback(() => {
    if (!selectedSuit || isLoading) return;
    const cards = getHalfSuitCards(selectedSuit, variant);
    const filled = { ...assignment };
    const firstOther = teammates.find((p) => p.playerId !== myPlayerId);
    for (const card of cards) {
      if (!filled[card]) {
        filled[card] = firstOther?.playerId ?? myPlayerId;
      }
    }
    onConfirm(selectedSuit, filled);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSuit, isLoading, assignment, teammates, myPlayerId, variant, onConfirm]);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Declare a half-suit"
      aria-busy={isSubmitted}
    >
      <div className="w-full max-w-lg bg-slate-800 rounded-2xl shadow-xl border border-slate-700/50 overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-slate-700/50 flex-shrink-0">
          <h2 className="text-lg font-bold text-white">Declare a Half-Suit</h2>
          <p className="text-sm text-slate-400 mt-0.5">
            Drag cards to your teammates to declare who holds what.
          </p>
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
                  const [, suit] = suitId.split('_');
                  const cards = getHalfSuitCards(suitId, variant);
                  const myCardsInSuit = cards.filter((c) => myHand.includes(c));
                  const suitSymbol = SUIT_SYMBOLS[suit as 's' | 'h' | 'd' | 'c'];
                  const noCards = myCardsInSuit.length === 0;

                  return (
                    <button
                      key={suitId}
                      onClick={() => {
                        if (noCards) return;
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
            /* Step 2: Drag-and-drop card assignment */
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <div className="px-5 py-4">
                <div className="flex items-center gap-2 mb-3">
                  <button
                    onClick={handleBack}
                    className="text-slate-400 hover:text-white text-sm"
                    aria-label="Back to suit selection"
                  >
                    ← Back
                  </button>
                  <h3 className="font-semibold text-white">{halfSuitLabel(selectedSuit)}</h3>
                  <span className="ml-auto text-xs text-slate-500">
                    {suitCards.length - unassignedCards.length}/{suitCards.length} assigned
                  </span>
                </div>

                {declarationTimer && (
                  <DeclarationTimerBar
                    expiresAt={declarationTimer.expiresAt}
                    durationMs={declarationTimer.durationMs}
                    onExpiry={handleTimerExpiry}
                    className="mb-3"
                  />
                )}

                {/* ── Teammate drop zones ──────────────────────── */}
                <div
                  className={[
                    'grid gap-2 mb-4',
                    teammates.length <= 3 ? 'grid-cols-3' : 'grid-cols-4',
                  ].join(' ')}
                >
                  {teammates.map((p) => (
                    <TeammateDropZone
                      key={p.playerId}
                      playerId={p.playerId}
                      player={p}
                      isMe={p.playerId === myPlayerId}
                      assignedCards={getTeammateCards(p.playerId)}
                      myHand={myHand}
                      onTapZone={() => handleTapZone(p.playerId)}
                      onRemoveCard={handleRemoveCard}
                      hasSelectedCard={!!selectedCard}
                      isSubmitted={isSubmitted}
                    />
                  ))}
                </div>

                {/* ── Unassigned card pool ─────────────────────── */}
                {unassignedCards.length > 0 && (
                  <>
                    <p className="text-xs text-slate-500 mb-2">
                      {selectedCard
                        ? 'Tap a teammate above to assign the selected card:'
                        : 'Drag cards to teammates above, or tap a card then tap a teammate:'}
                    </p>
                    <UnassignedPool>
                      <div className="flex flex-wrap gap-2 justify-center">
                        {unassignedCards.map((cardId) => (
                          <DraggableCard
                            key={cardId}
                            cardId={cardId}
                            isSelected={selectedCard === cardId}
                            onTap={() => handleTapUnassignedCard(cardId)}
                            isDraggable={!isSubmitted}
                          />
                        ))}
                      </div>
                    </UnassignedPool>
                  </>
                )}

                {unassignedCards.length === 0 && isComplete && (
                  <p className="text-xs text-emerald-400 text-center py-2">
                    ✓ All cards assigned — ready to declare!
                  </p>
                )}
              </div>

              {/* DragOverlay — visual card following the pointer during drag */}
              <DragOverlay dropAnimation={null}>
                {activeDragId ? (
                  <div className="opacity-90 scale-110 rotate-3 pointer-events-none">
                    <PlayingCard cardId={activeDragId} size="md" selected />
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
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
              data-testid="declare-submit-btn"
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
