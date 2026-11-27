'use client';

/**
 * InlineDeclare — sub-components for the inline (no-modal) declaration flow.
 *
 * Instead of a modal overlay, declaring happens directly on the game table:
 * 1. Player enters "declare mode" via the Declare toggle button
 * 2. Cards in hand get a purple glow; player clicks a card to select its half-suit
 * 3. Non-hand cards from that half-suit appear in a floating pool
 * 4. Player drags (or taps) cards to teammate avatar seats (which become drop zones)
 * 5. A floating "Confirm" button appears when all 6 cards are assigned
 *
 * Components exported:
 * - DeclareDropSeat: wrapper that makes a GamePlayerSeat a droppable zone
 * - DeclareDraggableCard: a card in the unassigned pool that can be dragged
 * - DeclareCardPool: the floating pool of unassigned cards (center of table)
 * - DeclareActionBar: floating confirm/cancel buttons
 */

import React from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import PlayingCard from './PlayingCard';
import { cardLabel, halfSuitLabel } from '@/types/game';
import type { CardId, HalfSuitId } from '@/types/game';
import DeclarationTimerBar from './DeclarationTimerBar';
import type { DeclarationTimerPayload } from '@/hooks/useGameSocket';

// ── DeclareDraggableCard ──────────────────────────────────────────────────────

/** A card in the unassigned pool that can be dragged to a teammate seat. */
export function DeclareDraggableCard({
  cardId,
  isSelected,
  onTap,
  size = 'md',
}: {
  cardId: CardId;
  isSelected: boolean;
  onTap: () => void;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `declare-${cardId}`,
  });

  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={[
        'relative transition-all duration-100 cursor-grab active:cursor-grabbing',
        isDragging ? 'opacity-30 scale-95' : '',
        isSelected ? 'ring-2 ring-amber-400 rounded-lg scale-105' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onTap();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onTap();
        }
      }}
      aria-label={`${cardLabel(cardId)}${isSelected ? ', selected' : ''} — drag to a teammate`}
      data-testid="declare-draggable-card"
      data-card-id={cardId}
    >
      <PlayingCard cardId={cardId} size={size} selected={isSelected} />
    </div>
  );
}

// ── DeclareDropSeat ───────────────────────────────────────────────────────────

/**
 * Wrapper that makes a GamePlayerSeat a droppable zone during inline declare.
 * Keeps the entire seat available as a drop target.
 */
export function DeclareDropSeat({
  playerId,
  children,
  hasSelectedCard,
  onTapZone,
  isMe,
}: {
  playerId: string;
  /** The GamePlayerSeat element to wrap. */
  children: React.ReactNode;
  hasSelectedCard: boolean;
  onTapZone: () => void;
  isMe: boolean;
}) {
  const isDisabled = isMe;
  const { setNodeRef, isOver } = useDroppable({ id: playerId, disabled: isDisabled });

  return (
    <div
      ref={setNodeRef}
      onClick={!isDisabled && hasSelectedCard ? onTapZone : undefined}
      className={[
        'relative flex flex-col items-center transition-all duration-150',
        isDisabled ? 'opacity-65 cursor-not-allowed' : '',
        isOver ? 'scale-110 z-20' : '',
        hasSelectedCard && !isDisabled ? 'cursor-pointer' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-disabled={isDisabled}
      title={isDisabled ? 'Your cards are auto-assigned during declaration' : undefined}
      data-testid="declare-drop-seat"
      data-player-id={playerId}
    >
      {/* Visual ring around the seat */}
      <div
        className={[
          'rounded-xl transition-all duration-150',
          isDisabled
            ? 'ring-1 ring-slate-600/60 ring-offset-1 ring-offset-slate-950 bg-slate-950/30'
            : isOver
            ? 'ring-2 ring-amber-400 ring-offset-2 ring-offset-slate-950 shadow-lg shadow-amber-500/20'
            : 'ring-2 ring-violet-500/60 ring-offset-1 ring-offset-slate-950',
        ].join(' ')}
      >
        {children}
      </div>

    </div>
  );
}

// ── DeclareCardPool ───────────────────────────────────────────────────────────

/**
 * Floating pool of unassigned half-suit cards shown in the center of the table.
 * Each card is draggable to a teammate seat or tappable for tap-to-assign.
 */
export function DeclareCardPool({
  halfSuitId,
  unassignedCards,
  selectedCard,
  onTapCard,
  totalCards,
  assignedCount,
  declarationTimer,
  onTimerExpiry,
}: {
  halfSuitId: HalfSuitId;
  unassignedCards: CardId[];
  selectedCard: CardId | null;
  onTapCard: (cardId: CardId) => void;
  totalCards: number;
  assignedCount: number;
  declarationTimer?: DeclarationTimerPayload | null;
  onTimerExpiry: () => void;
}) {
  const isComplete = assignedCount === totalCards;

  return (
    <div
      className="w-full flex flex-col items-center gap-2"
      role="region"
      aria-label={`Declaring ${halfSuitLabel(halfSuitId)}`}
      data-testid="declare-card-pool"
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-violet-300">
          {halfSuitLabel(halfSuitId)}
        </span>
        <span className="text-xs text-slate-500">
          {assignedCount}/{totalCards} assigned
        </span>
      </div>

      {declarationTimer && (
        <DeclarationTimerBar
          expiresAt={declarationTimer.expiresAt}
          durationMs={declarationTimer.durationMs}
          onExpiry={onTimerExpiry}
          className="w-full max-w-xs"
        />
      )}

      {/* Unassigned cards */}
      {unassignedCards.length > 0 ? (
        <div className="flex flex-wrap gap-2 justify-center">
          {unassignedCards.map((cardId) => (
            <DeclareDraggableCard
              key={cardId}
              cardId={cardId}
              isSelected={selectedCard === cardId}
              onTap={() => onTapCard(cardId)}
            />
          ))}
        </div>
      ) : isComplete ? (
        <p className="text-xs text-emerald-400 animate-pulse">
          ✓ All cards assigned — ready to declare!
        </p>
      ) : null}

      {unassignedCards.length > 0 && (
        <p className="text-[0.65rem] text-slate-500">
          {selectedCard
            ? 'Tap a teammate seat to assign the selected card'
            : 'Drag cards to teammate seats above, or tap a card then tap a seat'}
        </p>
      )}
    </div>
  );
}

// ── DeclareActionBar ──────────────────────────────────────────────────────────

/**
 * Floating action bar with Cancel and Confirm buttons during inline declare.
 * Positioned fixed at bottom of screen above the card hand.
 */
export function DeclareActionBar({
  isComplete,
  isLoading,
  hasSuitSelected,
  onBack,
  onCancel,
  onConfirm,
}: {
  isComplete: boolean;
  isLoading: boolean;
  hasSuitSelected: boolean;
  onBack: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="flex items-center justify-center gap-3"
      data-testid="declare-action-bar"
    >
      {hasSuitSelected && (
        <button
          onClick={onBack}
          disabled={isLoading}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors disabled:opacity-50"
          data-testid="declare-back-btn"
        >
          ← Back
        </button>
      )}
      <button
        onClick={onCancel}
        disabled={isLoading}
        className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors disabled:opacity-50"
        data-testid="declare-cancel-btn"
      >
        Cancel Declaration
      </button>
      {hasSuitSelected && (
        <button
          onClick={onConfirm}
          disabled={!isComplete || isLoading}
          className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="declare-confirm-btn"
        >
          {isLoading ? 'Declaring…' : 'Confirm Declaration'}
        </button>
      )}
    </div>
  );
}
