'use client';

/**
 * CardRequestWizard — 3-step wizard for asking an opponent for a card.
 *
 * Steps:
 *   1. Select half-suit  — from half-suits where the player holds ≥1 card
 *                          and the suit has not yet been declared.
 *   2. Pick a card       — all 6 cards in the chosen half-suit are shown;
 *                          cards the player already holds are greyed out
 *                          (they cannot be asked for — server enforces this).
 *   3. Pick an opponent  — opponents on the other team who still have cards.
 *
 * Back-navigation:
 *   • Step 2 → "Back" returns to Step 1 (half-suit selection).
 *   • Step 3 → "Back" returns to Step 2 (card selection).
 *   • Step 1 → "Cancel" closes the wizard.
 *
 * Entry point:
 *   • Pass `initialCard` to open directly at Step 2 (e.g. from a card tap).
 *   • Omit `initialCard` (or pass undefined) to start at Step 1.
 *
 * Visibility:
 *   The caller (game page) must gate rendering on `isMyTurn`.
 *   This component contains no `isMyTurn` logic of its own.
 */

import { useState, useMemo, useEffect } from 'react';
import PlayingCard from './PlayingCard';
import TurnTimerStrip from './TurnTimerStrip';
import {
  cardLabel,
  halfSuitLabel,
  getHalfSuitCards,
  getCardHalfSuit,
  allHalfSuitIds,
  SUIT_SYMBOLS,
  parseCard,
} from '@/types/game';
import type { CardId, HalfSuitId, GamePlayer, DeclaredSuit } from '@/types/game';
import type { TurnTimerPayload, PartialSelectionPayload } from '@/hooks/useGameSocket';

// ── Types ────────────────────────────────────────────────────────────────────

type WizardStep = 1 | 2 | 3;

export interface CardRequestWizardProps {
  myPlayerId: string;
  myHand: CardId[];
  players: GamePlayer[];
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s';
  /** Half-suits that have already been declared (removed from step-1 choices). */
  declaredSuits: DeclaredSuit[];
  onConfirm: (targetPlayerId: string, cardId: CardId) => void;
  onCancel: () => void;
  isLoading?: boolean;
  /**
   * When provided the wizard opens at Step 2 with this card pre-selected,
   * deriving the half-suit automatically.  The player can still navigate
   * back to Step 1 to change the half-suit.
   */
  initialCard?: CardId;
  /**
   * Active server-side turn timer payload.  When provided, the wizard renders
   * a `TurnTimerStrip` below the step indicator so the 30-second countdown
   * remains visible as the player navigates through all three steps.
   */
  turnTimer?: TurnTimerPayload | null;
  /**
   * Called after each step transition so the server can store partial state
   * for bot completion if the turn timer expires mid-wizard.
   *
   * • After Step 1 (half-suit selected): { flow: 'ask', halfSuitId }
   * • After Step 2 (card selected):      { flow: 'ask', halfSuitId, cardId }
   *
   * This is fire-and-forget — no response is expected.
   */
  onPartialSelection?: (partial: PartialSelectionPayload) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Return the half-suits where the player holds ≥1 card and suit is not declared. */
function getAvailableHalfSuits(
  myHand: CardId[],
  declaredSuits: DeclaredSuit[],
  variant: CardRequestWizardProps['variant'],
): HalfSuitId[] {
  const declaredIds = new Set(declaredSuits.map((ds) => ds.halfSuitId));
  const heldHalfSuits = new Set<HalfSuitId>();
  for (const cardId of myHand) {
    const hs = getCardHalfSuit(cardId, variant);
    if (hs && !declaredIds.has(hs)) {
      heldHalfSuits.add(hs);
    }
  }
  // Return in standard order (low_s, low_h, low_d, low_c, high_s, …)
  return allHalfSuitIds().filter((id) => heldHalfSuits.has(id));
}

/** Count how many cards the player holds in a given half-suit. */
function countHeld(myHand: CardId[], halfSuitId: HalfSuitId, variant: CardRequestWizardProps['variant']): number {
  const cards = new Set(getHalfSuitCards(halfSuitId, variant));
  return myHand.filter((c) => cards.has(c)).length;
}

// ── Step-indicator ────────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: WizardStep }) {
  const steps: { n: WizardStep; label: string }[] = [
    { n: 1, label: 'Half-suit' },
    { n: 2, label: 'Card' },
    { n: 3, label: 'Opponent' },
  ];
  return (
    <div className="flex items-center justify-center gap-0 mb-1" aria-label={`Step ${current} of 3`} data-testid="wizard-step-indicator">
      {steps.map(({ n, label }, idx) => {
        const done    = n < current;
        const active  = n === current;
        return (
          <div key={n} className="flex items-center">
            <div className="flex flex-col items-center gap-0.5">
              <div
                className={[
                  'w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-all',
                  done   ? 'bg-emerald-500 border-emerald-400 text-white' : '',
                  active ? 'bg-emerald-600 border-emerald-400 text-white ring-2 ring-emerald-400/40' : '',
                  !done && !active ? 'bg-slate-700 border-slate-600 text-slate-400' : '',
                ].join(' ')}
                aria-current={active ? 'step' : undefined}
              >
                {done ? '✓' : n}
              </div>
              <span className={['text-[9px] uppercase tracking-wide font-semibold', active ? 'text-emerald-300' : done ? 'text-emerald-500' : 'text-slate-500'].join(' ')}>
                {label}
              </span>
            </div>
            {idx < steps.length - 1 && (
              <div className={['w-8 h-0.5 mx-1 mb-4 rounded', done ? 'bg-emerald-500' : 'bg-slate-600'].join(' ')} aria-hidden="true" />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1: Half-suit selection ────────────────────────────────────────────────

function Step1HalfSuit({
  availableHalfSuits,
  myHand,
  variant,
  selectedHalfSuit,
  onSelect,
  onCancel,
}: {
  availableHalfSuits: HalfSuitId[];
  myHand: CardId[];
  variant: CardRequestWizardProps['variant'];
  selectedHalfSuit: HalfSuitId | null;
  onSelect: (hs: HalfSuitId) => void;
  onCancel: () => void;
}) {
  return (
    <div data-testid="wizard-step-1">
      <div className="px-5 pt-4 pb-2 border-b border-slate-700/50">
        <h2 className="text-lg font-bold text-white">Ask for a card</h2>
        <p className="text-sm text-slate-400 mt-0.5">Step 1 — Choose a half-suit</p>
      </div>

      <div className="px-5 py-3">
        {availableHalfSuits.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-4" data-testid="no-available-halfsuits">
            No half-suits available to ask about.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2" role="listbox" aria-label="Available half-suits">
            {availableHalfSuits.map((hs) => {
              const [tier, suit] = hs.split('_');
              const symbol = SUIT_SYMBOLS[suit as 's' | 'h' | 'd' | 'c'] ?? suit;
              const label  = halfSuitLabel(hs);
              const held   = countHeld(myHand, hs, variant);
              const total  = getHalfSuitCards(hs, variant).length; // always 6
              const isSelected = hs === selectedHalfSuit;
              const isRed = suit === 'h' || suit === 'd';

              return (
                <button
                  key={hs}
                  onClick={() => onSelect(hs)}
                  role="option"
                  aria-selected={isSelected}
                  aria-label={`${label} — ${held} of ${total} cards in hand`}
                  data-testid={`halfsuit-option-${hs}`}
                  className={[
                    'flex flex-col items-center gap-1 p-3 rounded-xl border-2 transition-all duration-100',
                    'focus:outline-none focus:ring-2 focus:ring-emerald-400',
                    isSelected
                      ? 'border-emerald-500 bg-emerald-900/30 text-white'
                      : 'border-slate-600/50 bg-slate-700/30 hover:border-slate-500 hover:bg-slate-700/50',
                  ].join(' ')}
                >
                  <span
                    className={['text-2xl font-bold leading-none', isRed ? 'text-red-400' : 'text-slate-100'].join(' ')}
                    aria-hidden="true"
                  >
                    {symbol}
                  </span>
                  <span className={['text-[10px] font-bold uppercase tracking-wider', tier === 'high' ? 'text-amber-400' : 'text-sky-400'].join(' ')}>
                    {tier === 'high' ? '▲ High' : '▽ Low'}
                  </span>
                  <span className={['text-xs font-semibold truncate w-full text-center', isSelected ? 'text-white' : 'text-slate-300'].join(' ')}>
                    {label}
                  </span>
                  <span className="text-[10px] text-slate-400">
                    {held}/{total} in hand
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="px-5 pb-5 pt-1 flex gap-3">
        <button
          onClick={onCancel}
          className="flex-1 py-3 rounded-xl font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors focus:outline-none focus:ring-2 focus:ring-slate-400"
          data-testid="wizard-cancel"
        >
          Cancel
        </button>
        <button
          disabled
          className="flex-1 py-3 rounded-xl font-semibold bg-emerald-700/40 text-emerald-300/40 cursor-not-allowed"
          aria-label="Select a half-suit to continue"
        >
          Next →
        </button>
      </div>
    </div>
  );
}

// ── Step 2: Card selection ─────────────────────────────────────────────────────

function Step2Card({
  halfSuitId,
  myHand,
  variant,
  selectedCard,
  onSelect,
  onBack,
}: {
  halfSuitId: HalfSuitId;
  myHand: CardId[];
  variant: CardRequestWizardProps['variant'];
  selectedCard: CardId | null;
  onSelect: (card: CardId) => void;
  onBack: () => void;
}) {
  const allCards    = getHalfSuitCards(halfSuitId, variant);
  const myHandSet   = new Set(myHand);
  // Cards NOT in the player's hand are askable targets
  const askableCards   = allCards.filter((c) => !myHandSet.has(c));
  const inHandCards    = allCards.filter((c) =>  myHandSet.has(c));

  return (
    <div data-testid="wizard-step-2">
      <div className="px-5 pt-4 pb-2 border-b border-slate-700/50">
        <h2 className="text-lg font-bold text-white">Ask for a card</h2>
        <p className="text-sm text-slate-400 mt-0.5">
          Step 2 — Pick a card from{' '}
          <span className="font-semibold text-white">{halfSuitLabel(halfSuitId)}</span>
        </p>
      </div>

      <div className="px-5 py-3">
        {/* Cards you can ask for */}
        {askableCards.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-3" data-testid="no-askable-cards">
            You already hold all cards in this half-suit.
          </p>
        ) : (
          <>
            <p className="text-xs text-slate-500 uppercase tracking-widest mb-2">
              Cards to ask for:
            </p>
            <div
              className="flex flex-wrap gap-2 justify-center mb-3"
              role="listbox"
              aria-label="Cards to ask for"
            >
              {askableCards.map((card) => {
                const isSelected = card === selectedCard;
                return (
                  <button
                    key={card}
                    onClick={() => onSelect(card)}
                    role="option"
                    aria-selected={isSelected}
                    aria-label={`Ask for ${cardLabel(card)}`}
                    data-testid={`card-option-${card}`}
                    className={[
                      'p-1 rounded-lg border-2 transition-all duration-100',
                      'focus:outline-none focus:ring-2 focus:ring-emerald-400',
                      isSelected
                        ? 'border-emerald-500 bg-emerald-900/40'
                        : 'border-transparent hover:border-slate-500',
                    ].join(' ')}
                  >
                    <PlayingCard
                      cardId={card}
                      size="md"
                      selected={isSelected}
                    />
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* Cards you already hold (informational, not selectable) */}
        {inHandCards.length > 0 && (
          <>
            <p className="text-xs text-slate-500 uppercase tracking-widest mb-2">
              Already in your hand:
            </p>
            <div
              className="flex flex-wrap gap-2 justify-center opacity-40"
              aria-label="Cards already in your hand"
              data-testid="cards-in-hand-display"
            >
              {inHandCards.map((card) => (
                <div
                  key={card}
                  className="p-1 rounded-lg border-2 border-transparent cursor-not-allowed"
                  aria-label={`${cardLabel(card)} — in your hand`}
                  data-testid={`card-in-hand-${card}`}
                >
                  <PlayingCard cardId={card} size="md" disabled />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="px-5 pb-5 pt-1 flex gap-3">
        <button
          onClick={onBack}
          className="flex-1 py-3 rounded-xl font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors focus:outline-none focus:ring-2 focus:ring-slate-400"
          data-testid="wizard-back-to-step1"
        >
          ← Back
        </button>
        <button
          disabled={!selectedCard || askableCards.length === 0}
          onClick={() => { /* navigation is handled by parent via onSelect */ }}
          className="flex-1 py-3 rounded-xl font-semibold bg-emerald-700/40 text-emerald-300/40 cursor-not-allowed disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label={selectedCard ? `Continue with ${cardLabel(selectedCard)}` : 'Select a card to continue'}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

// ── Step 3: Opponent selection ─────────────────────────────────────────────────

function Step3Opponent({
  selectedCard,
  halfSuitId,
  myPlayerId,
  players,
  selectedTarget,
  onSelect,
  onBack,
  onConfirm,
  isLoading,
}: {
  selectedCard: CardId;
  /**
   * The half-suit that was selected in Step 1.  Used to grey out opponents
   * whose server-reported halfSuitCounts[halfSuitId] === 0, meaning they
   * cannot hold the requested card even though they have other cards.
   */
  halfSuitId: HalfSuitId;
  myPlayerId: string;
  players: GamePlayer[];
  selectedTarget: string | null;
  onSelect: (playerId: string) => void;
  onBack: () => void;
  onConfirm: () => void;
  isLoading: boolean;
}) {
  const myPlayer = players.find((p) => p.playerId === myPlayerId);
  const myTeamId = myPlayer?.teamId;

  // All opponents who still have cards (total cardCount > 0).
  const allOpponents = players.filter(
    (p) => p.teamId !== myTeamId && p.cardCount > 0,
  );

  // All opponents with cards are valid targets — we don't reveal which
  // opponents hold cards in a specific half-suit (that would leak information).
  const selectedPlayerCanBeAsked =
    selectedTarget != null &&
    allOpponents.some((p) => p.playerId === selectedTarget);

  return (
    <div data-testid="wizard-step-3">
      <div className="px-5 pt-4 pb-2 border-b border-slate-700/50">
        <h2 className="text-lg font-bold text-white">Ask for a card</h2>
        <p className="text-sm text-slate-400 mt-0.5">
          Step 3 — Choose an opponent to ask for{' '}
          <span className="font-semibold text-white">{cardLabel(selectedCard)}</span>
        </p>
      </div>

      {/* Selected card preview */}
      <div className="flex justify-center py-3 bg-slate-900/30">
        <PlayingCard cardId={selectedCard} size="lg" />
      </div>

      <div className="px-5 py-3">
        <p className="text-xs text-slate-500 uppercase tracking-widest mb-2">Ask from:</p>

        {allOpponents.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-3" data-testid="no-valid-targets">
            No opponents with cards available to ask.
          </p>
        ) : (
          <div
            className="space-y-2"
            role="listbox"
            aria-label="Opponents to ask"
          >
            {allOpponents.map((player) => {
              const isSelected = selectedTarget === player.playerId;
              return (
                <button
                  key={player.playerId}
                  onClick={() => {
                    if (!isLoading) onSelect(player.playerId);
                  }}
                  role="option"
                  aria-selected={isSelected}
                  aria-label={`Ask ${player.displayName} (Team ${player.teamId}, ${player.cardCount} cards)`}
                  data-testid={`opponent-option-${player.playerId}`}
                  disabled={isLoading}
                  className={[
                    'w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-all duration-100',
                    'text-left focus:outline-none focus:ring-2 focus:ring-emerald-400',
                    isSelected
                      ? 'border-emerald-500 bg-emerald-900/30 text-white'
                      : 'border-slate-600/50 bg-slate-700/30 text-slate-300 hover:border-slate-500 hover:bg-slate-700/50',
                  ].join(' ')}
                >
                  {/* Avatar */}
                  <div
                    className={[
                      'w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0',
                      player.teamId === 2
                        ? 'bg-violet-700 text-violet-100'
                        : 'bg-blue-700 text-blue-100',
                    ].join(' ')}
                    aria-hidden="true"
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
                    aria-hidden="true"
                  >
                    {isSelected && <div className="w-2 h-2 rounded-full bg-white" />}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="px-5 pb-5 pt-2 flex gap-3">
        <button
          onClick={onBack}
          disabled={isLoading}
          className="flex-1 py-3 rounded-xl font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-50"
          data-testid="wizard-back-to-step2"
        >
          ← Back
        </button>
        <button
          onClick={onConfirm}
          disabled={!selectedTarget || !selectedPlayerCanBeAsked || isLoading || allOpponents.length === 0}
          className="flex-1 py-3 rounded-xl font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label={
            selectedTarget && selectedPlayerCanBeAsked && allOpponents.find((p) => p.playerId === selectedTarget)
              ? `Ask ${allOpponents.find((p) => p.playerId === selectedTarget)!.displayName} for ${cardLabel(selectedCard)}`
              : 'Ask'
          }
          data-testid="wizard-confirm-ask"
        >
          {isLoading ? 'Asking…' : 'Ask'}
        </button>
      </div>
    </div>
  );
}

// ── Main wizard component ─────────────────────────────────────────────────────

export default function CardRequestWizard({
  myPlayerId,
  myHand,
  players,
  variant,
  declaredSuits,
  onConfirm,
  onCancel,
  isLoading = false,
  initialCard,
  turnTimer,
  onPartialSelection,
}: CardRequestWizardProps) {
  const availableHalfSuits = useMemo(
    () => getAvailableHalfSuits(myHand, declaredSuits, variant),
    [myHand, declaredSuits, variant],
  );

  // Derive initial half-suit from initialCard if provided
  const derivedInitialHalfSuit = useMemo<HalfSuitId | null>(() => {
    if (!initialCard) return null;
    return getCardHalfSuit(initialCard, variant);
  }, [initialCard, variant]);

  // Wizard state
  const [step, setStep] = useState<WizardStep>(() => {
    // If initialCard is provided jump to step 2 (card already chosen)
    if (initialCard) return 2;
    return 1;
  });

  const [selectedHalfSuit, setSelectedHalfSuit] = useState<HalfSuitId | null>(
    derivedInitialHalfSuit,
  );
  const [selectedCard, setSelectedCard] = useState<CardId | null>(initialCard ?? null);
  // Auto-select opponent when only one valid target exists.
  const myPlayer = players.find((p) => p.playerId === myPlayerId);
  const initialValidTargets = useMemo(() => {
    return players.filter(
      (p) => p.teamId !== myPlayer?.teamId && p.cardCount > 0,
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [selectedTarget, setSelectedTarget] = useState<string | null>(
    initialValidTargets.length === 1 ? initialValidTargets[0].playerId : null,
  );

  // ── Emit initial partial state when wizard opens with a pre-selected card ──
  // When opened via a card tap (initialCard provided), the wizard starts at
  // step 2 with the half-suit already known.  Emit the partial state once on
  // mount so the server has context if the timer fires immediately.
  useEffect(() => {
    if (initialCard && derivedInitialHalfSuit) {
      onPartialSelection?.({ flow: 'ask', halfSuitId: derivedInitialHalfSuit });
    }
    // Only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Step 1 handlers ────────────────────────────────────────────────────────
  function handleHalfSuitSelect(hs: HalfSuitId) {
    setSelectedHalfSuit(hs);
    // Reset card if half-suit changed
    if (hs !== selectedHalfSuit) {
      setSelectedCard(null);
    }
    setStep(2);
    // Report partial state to server: half-suit chosen, no card yet
    onPartialSelection?.({ flow: 'ask', halfSuitId: hs });
  }

  // ── Step 2 handlers ────────────────────────────────────────────────────────
  function handleCardSelect(card: CardId) {
    setSelectedCard(card);
    setStep(3);
    // Report partial state to server: half-suit + card both known
    if (selectedHalfSuit) {
      onPartialSelection?.({ flow: 'ask', halfSuitId: selectedHalfSuit, cardId: card });
    }
  }

  function handleBackToStep1() {
    setStep(1);
    // Don't reset selectedHalfSuit — keep it highlighted on return
  }

  // ── Step 3 handlers ────────────────────────────────────────────────────────
  function handleBackToStep2() {
    setStep(2);
  }

  function handleConfirm() {
    if (!selectedTarget || !selectedCard || isLoading) return;
    onConfirm(selectedTarget, selectedCard);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Ask for a card"
      data-testid="card-request-wizard"
    >
      <div className="w-full max-w-md bg-slate-800 rounded-2xl shadow-xl border border-slate-700/50 overflow-hidden">
        {/* Step indicator + persistent turn timer strip */}
        <div className="px-5 pt-4 pb-1">
          <StepIndicator current={step} />
          {/* Timer strip sits below the step indicator so it's visible
              throughout all three steps of the ask flow. */}
          {turnTimer && (
            <TurnTimerStrip
              turnTimer={turnTimer}
              isMyTimer={turnTimer.playerId === myPlayerId}
              className="mt-2"
            />
          )}
        </div>

        {/* Step content */}
        {step === 1 && (
          <Step1HalfSuit
            availableHalfSuits={availableHalfSuits}
            myHand={myHand}
            variant={variant}
            selectedHalfSuit={selectedHalfSuit}
            onSelect={handleHalfSuitSelect}
            onCancel={onCancel}
          />
        )}

        {step === 2 && selectedHalfSuit && (
          <Step2Card
            halfSuitId={selectedHalfSuit}
            myHand={myHand}
            variant={variant}
            selectedCard={selectedCard}
            onSelect={handleCardSelect}
            onBack={handleBackToStep1}
          />
        )}

        {step === 3 && selectedCard && selectedHalfSuit && (
          <Step3Opponent
            selectedCard={selectedCard}
            halfSuitId={selectedHalfSuit}
            myPlayerId={myPlayerId}
            players={players}
            selectedTarget={selectedTarget}
            onSelect={setSelectedTarget}
            onBack={handleBackToStep2}
            onConfirm={handleConfirm}
            isLoading={isLoading}
          />
        )}
      </div>
    </div>
  );
}
