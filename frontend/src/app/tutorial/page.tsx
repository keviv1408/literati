'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import AskDeniedAnimation from '@/components/AskDeniedAnimation';
import AskSpeechBubbleOverlay from '@/components/AskSpeechBubbleOverlay';
import CardFlightAnimation from '@/components/CardFlightAnimation';
import CardHand from '@/components/CardHand';
import CircularGameTable from '@/components/CircularGameTable';
import DeclaredBooksTable from '@/components/DeclaredBooksTable';
import PlayingCard from '@/components/PlayingCard';
import { VoiceProvider } from '@/contexts/VoiceContext';
import { useAskResultAnimations } from '@/hooks/useAskResultAnimations';
import {
  buildDeclarationSeatRevealMap,
  buildSuccessfulDeclarationSeatRevealMap,
} from '@/lib/declarationSeatReveal';
import {
  askSucceeds,
  computeState,
  declareIsCorrect,
  sortHand,
  stateBefore,
  teamOf,
  TUTORIAL_VARIANT,
} from '@/lib/tutorial/engine';
import type { Step, TableState } from '@/lib/tutorial/engine';
import { INITIAL_STATE, PLAYERS, SCRIPT } from '@/lib/tutorial/script';
import {
  allHalfSuitIds,
  getHalfSuitCards,
  halfSuitLabel,
  parseCard,
  SUIT_SYMBOLS,
} from '@/types/game';
import type { AskResultPayload, CardId, GamePlayer, WrongAssignmentDiff } from '@/types/game';

const ME = 'you';
const getPlayerDisplayName = (id: string) => PLAYERS.find((p) => p.id === id)?.name;

function toGamePlayers(state: TableState): GamePlayer[] {
  return PLAYERS.map((p, seatIndex) => ({
    playerId: p.id,
    displayName: p.name,
    avatarId: null,
    teamId: p.teamId,
    seatIndex,
    cardCount: state.hands[p.id].length,
    isBot: false,
    isGuest: true,
    isCurrentTurn: state.turn === p.id,
    isEliminated: state.hands[p.id].length === 0,
  }));
}

/** Which seats and cards the current step is talking about. */
function highlightsFor(step: Step, before: TableState) {
  const none = { focus: new Set<string>(), askTarget: new Set<string>(), cards: new Set<CardId>() };
  switch (step.kind) {
    case 'note':
    case 'choice':
      return { ...none, focus: new Set(step.focus ?? []), cards: new Set(step.cards ?? []) };
    case 'ask':
      return {
        focus: new Set([step.asker]),
        askTarget: new Set([step.target]),
        cards: new Set(askSucceeds(before, step) ? [step.card] : []),
      };
    case 'turn':
      return { ...none, focus: new Set([step.to]) };
    default:
      return none;
  }
}

function askPayloadFor(step: Step, before: TableState): AskResultPayload | null {
  if (step.kind !== 'ask') return null;
  const success = askSucceeds(before, step);
  return {
    type: 'ask_result',
    askerId: step.asker,
    targetId: step.target,
    cardId: step.card,
    success,
    newTurnPlayerId: success ? step.asker : step.target,
    lastMove: '',
  };
}

function declarationRevealFor(step: Step, before: TableState, players: GamePlayer[]) {
  if (step.kind !== 'declare') return null;
  const team = teamOf(PLAYERS, step.declarer);
  if (declareIsCorrect(before, step)) {
    return buildSuccessfulDeclarationSeatRevealMap(
      {
        type: 'declaration_result',
        declarerId: step.declarer,
        halfSuitId: step.halfSuit,
        correct: true,
        winningTeam: team,
        newTurnPlayerId: step.declarer,
        assignment: step.assignment,
        lastMove: '',
      },
      TUTORIAL_VARIANT,
    );
  }
  const actualHolders: Record<CardId, string> = {};
  const wrongAssignmentDiffs: WrongAssignmentDiff[] = [];
  for (const card of getHalfSuitCards(step.halfSuit, TUTORIAL_VARIANT)) {
    const actual = Object.keys(before.hands).find((pid) => before.hands[pid].includes(card)) ?? null;
    if (actual) actualHolders[card] = actual;
    if (actual !== step.assignment[card]) {
      wrongAssignmentDiffs.push({ card, claimedPlayerId: step.assignment[card], actualPlayerId: actual });
    }
  }
  return buildDeclarationSeatRevealMap(
    {
      type: 'declarationFailed',
      declarerId: step.declarer,
      halfSuitId: step.halfSuit,
      winningTeam: team === 1 ? 2 : 1,
      assignment: step.assignment,
      wrongAssignmentDiffs,
      actualHolders,
      lastMove: '',
    },
    players,
    TUTORIAL_VARIANT,
  );
}

export default function TutorialPage() {
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  // Seat tapped to inspect a hand in the footer; null shows your own hand.
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const shownId = inspectedId ?? ME;

  const step = SCRIPT[index];
  const isLast = index === SCRIPT.length - 1;
  const state = useMemo(() => computeState(INITIAL_STATE, SCRIPT, index, PLAYERS), [index]);
  const before = useMemo(() => stateBefore(INITIAL_STATE, SCRIPT, index, PLAYERS), [index]);
  const players = useMemo(() => toGamePlayers(state), [state]);
  const { focus, askTarget, cards } = highlightsFor(step, before);
  // Keep the same payload object across non-ask steps so the bubble's own
  // timer can clear it; the hook only resets when the payload identity changes.
  const lastAskIndex = useMemo(() => {
    for (let i = index; i >= 0; i--) if (SCRIPT[i].kind === 'ask') return i;
    return -1;
  }, [index]);
  const askPayload = useMemo(
    () =>
      lastAskIndex < 0
        ? null
        : askPayloadFor(SCRIPT[lastAskIndex], stateBefore(INITIAL_STATE, SCRIPT, lastAskIndex, PLAYERS)),
    [lastAskIndex],
  );
  const declarationReveal = useMemo(
    () => declarationRevealFor(step, before, players),
    [step, before, players],
  );
  const { cardFlight, askDeniedCue, askSpeechBubble, clearCardFlight, clearAskDeniedCue } =
    useAskResultAnimations(askPayload, { getPlayerDisplayName });

  const pickedOption = step.kind === 'choice' && picked !== null ? step.options[picked] : null;
  const canAdvance = !isLast && (step.kind !== 'choice' || Boolean(pickedOption?.correct));
  const turnPlayer = PLAYERS.find((p) => p.id === state.turn);
  const newlyArrivedCardId =
    step.kind === 'ask' && askPayload?.success && askPayload.askerId === ME ? askPayload.cardId : null;

  function goTo(delta: number) {
    setIndex((i) => Math.min(Math.max(i + delta, 0), SCRIPT.length - 1));
    setPicked(null);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight' && canAdvance) goTo(1);
      if (e.key === 'ArrowLeft') goTo(-1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canAdvance]);

  return (
    <VoiceProvider roomCode={null} bearerToken={null} canJoin={false}>
      <div
        className="flex h-[100dvh] flex-col bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 overflow-hidden"
        data-testid="tutorial-view"
      >
        <div className="pointer-events-none fixed inset-0 overflow-hidden opacity-5 select-none" aria-hidden="true">
          <span className="absolute text-[20rem] -top-16 -right-16 text-white">♦</span>
          <span className="absolute text-[14rem] bottom-0 -left-8 text-white">♣</span>
        </div>

        <header className="relative z-20 flex items-center justify-between px-3 py-2 border-b border-slate-700/50 bg-slate-900/70 backdrop-blur-sm">
          <div className="flex items-center gap-2">
            <Link href="/" aria-label="Home" className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg">
              ←
            </Link>
            <span className="font-mono font-bold text-white text-sm">TUTORIAL</span>
            <span className="text-xs text-slate-500 hidden sm:inline">Remove 7s (Classic) · 3v3</span>
          </div>
          <div className="flex items-center gap-2 text-sm font-semibold" aria-label="Score">
            <span className="text-slate-400">
              T1 <span className="text-white text-base tabular-nums">{state.scores.team1}</span>
            </span>
            <span className="text-slate-600">—</span>
            <span className="text-slate-400">
              <span className="text-white text-base tabular-nums">{state.scores.team2}</span> T2
            </span>
          </div>
          <span className="text-xs text-slate-400 tabular-nums">
            {index + 1} / {SCRIPT.length}
          </span>
        </header>
        <div className="relative z-20 h-1 bg-slate-800">
          <div
            className="h-full bg-emerald-500 transition-all duration-300"
            style={{ width: `${((index + 1) / SCRIPT.length) * 100}%` }}
          />
        </div>

        <div
          className={[
            'relative z-10 flex items-center justify-center gap-2 px-4 py-1.5 text-sm font-medium border-b',
            state.turn === ME
              ? 'bg-emerald-700/60 text-emerald-100 border-emerald-600/40'
              : 'bg-slate-800/50 text-slate-300 border-slate-700/40',
          ].join(' ')}
          role="status"
        >
          <span aria-hidden="true">{state.turn === ME ? '🎯' : '⏳'}</span>
          <span>{state.turn === ME ? 'Your turn' : `${turnPlayer?.name}'s turn`}</span>
        </div>

        <main className="relative z-10 flex min-h-0 flex-1 items-stretch justify-center overflow-y-auto px-2 py-2 sm:px-3 sm:py-3 lg:px-5">
          {/* Width follows the free height (header + turn strip + footer ~26rem) so the 5:3 table never squashes. */}
          <div className="w-full max-w-[82rem] sm:max-w-[calc((100dvh-26rem)*5/3)] flex flex-col justify-center">
            <CircularGameTable
              players={players}
              myPlayerId={ME}
              playerCount={6}
              currentTurnPlayerId={state.turn}
              indicatorActive={state.turn === ME}
              highlightedPlayerIds={inspectedId ? new Set([...focus, inspectedId]) : focus}
              onDirectSeatClick={(id) => setInspectedId(id === ME ? null : id)}
              askTargetPlayerIds={askTarget}
              declarationSeatRevealByPlayerId={declarationReveal}
              renderSeatWrapper={(player, seat) => (
                <div className="flex flex-col items-center gap-1">
                  {seat}
                  <OpenHand hand={state.hands[player.playerId]} highlighted={cards} />
                </div>
              )}
            >
              <DeclaredBooksTable declaredSuits={state.declared} playerCount={6} />
            </CircularGameTable>
          </div>

          {step.kind === 'intro' && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4 overflow-y-auto">
              <IntroCard step={step} />
            </div>
          )}
        </main>

        <footer className="relative z-20 border-t border-slate-700/50 bg-slate-900/85 px-3 py-2.5 backdrop-blur-sm lg:px-5">
          <div className="mx-auto flex w-full max-w-[82rem] xl:max-w-[90rem] flex-col gap-2">
            <section className="rounded-2xl border border-emerald-700/40 bg-slate-950/70 p-3" aria-live="polite">
              {step.kind === 'choice' ? (
                <>
                  <p className="text-sm sm:text-base font-semibold text-white mb-2">{step.prompt}</p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    {step.options.map((opt, i) => {
                      const isPicked = picked === i;
                      const tone = !isPicked
                        ? 'border-slate-600 hover:border-emerald-500 hover:bg-slate-800'
                        : opt.correct
                          ? 'border-emerald-400 bg-emerald-900/40'
                          : 'border-amber-500 bg-amber-900/30';
                      return (
                        <button
                          key={opt.label}
                          type="button"
                          onClick={() => setPicked(i)}
                          className={`flex-1 text-left rounded-xl border px-3 py-2 text-sm transition-colors ${tone}`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  {pickedOption && (
                    <p role="status" className={`mt-2 text-sm ${pickedOption.correct ? 'text-emerald-200' : 'text-amber-200'}`}>
                      <span className="mr-1.5">{pickedOption.correct ? '✅' : '🤔'}</span>
                      {pickedOption.feedback}
                      {!pickedOption.correct && ' Try another option.'}
                    </p>
                  )}
                </>
              ) : step.kind !== 'intro' ? (
                <p className="text-sm sm:text-base text-slate-100 leading-relaxed">{step.text}</p>
              ) : (
                <p className="text-sm text-slate-400">Read the card above, then press Next.</p>
              )}

              <div className="mt-2 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => goTo(-1)}
                  disabled={index === 0}
                  className="rounded-xl border border-slate-600 px-4 py-1.5 text-sm text-slate-300 hover:border-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  ← Back
                </button>
                {isLast ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => goTo(-index)}
                      className="rounded-xl border border-slate-600 px-4 py-1.5 text-sm text-slate-300 hover:border-slate-400 hover:text-white"
                    >
                      Restart
                    </button>
                    <Link href="/" className="rounded-xl bg-emerald-600 hover:bg-emerald-500 px-5 py-1.5 text-sm font-bold text-white">
                      Play a real game →
                    </Link>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => goTo(1)}
                    disabled={!canAdvance}
                    className="rounded-xl bg-emerald-600 hover:bg-emerald-500 px-5 py-1.5 text-sm font-bold text-white disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Next →
                  </button>
                )}
              </div>
            </section>

            <div className={inspectedId ? 'block' : 'hidden sm:block'} data-testid="footer-hand">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-slate-400">
                  {inspectedId ? `${getPlayerDisplayName(inspectedId)}'s hand` : 'Your hand'} —{' '}
                  <strong className="text-white">{state.hands[shownId].length}</strong> card
                  {state.hands[shownId].length !== 1 ? 's' : ''}
                </span>
                {inspectedId ? (
                  <button
                    type="button"
                    onClick={() => setInspectedId(null)}
                    className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
                  >
                    Show my hand
                  </button>
                ) : (
                  <span className="text-xs text-slate-500">Tap a seat to see that player’s hand here</span>
                )}
              </div>
              <CardHand
                hand={state.hands[shownId]}
                isMyTurn={state.turn === shownId}
                disabled
                variant={TUTORIAL_VARIANT}
                newlyArrivedCardId={inspectedId ? null : newlyArrivedCardId}
              />
            </div>
          </div>
        </footer>

        {cardFlight && (
          <CardFlightAnimation
            cardId={cardFlight.cardId}
            fromX={cardFlight.fromX}
            fromY={cardFlight.fromY}
            toX={cardFlight.toX}
            toY={cardFlight.toY}
            onComplete={clearCardFlight}
          />
        )}
        {askSpeechBubble && <AskSpeechBubbleOverlay bubble={askSpeechBubble} />}
        {askDeniedCue && (
          <AskDeniedAnimation
            cardId={askDeniedCue.cardId}
            seatLeft={askDeniedCue.seatLeft}
            seatTop={askDeniedCue.seatTop}
            seatWidth={askDeniedCue.seatWidth}
            seatHeight={askDeniedCue.seatHeight}
            onComplete={clearAskDeniedCue}
          />
        )}
      </div>
    </VoiceProvider>
  );
}

/** Face-up mini hand under a seat; the tutorial's "all cards open" device. */
function OpenHand({ hand, highlighted }: { hand: CardId[]; highlighted: Set<CardId> }) {
  return (
    <div className="flex flex-wrap justify-center gap-px lg:gap-0.5 w-[11rem] lg:w-[15rem]" data-testid="open-hand">
      {sortHand(hand).map((card) => (
        <PlayingCard
          key={card}
          cardId={card}
          size="sm"
          className={[
            // "!" beats PlayingCard's own size classes, which Tailwind sorts later.
            'w-5! h-[1.875rem]! lg:w-7! lg:h-[2.625rem]! rounded-[4px]! lg:rounded-[6px]!',
            highlighted.has(card) ? 'ring-2 ring-amber-400 -translate-y-1 border-amber-300' : '',
          ].join(' ')}
        />
      ))}
    </div>
  );
}

function IntroCard({ step }: { step: Extract<Step, { kind: 'intro' }> }) {
  return (
    <section className="w-full max-w-2xl rounded-2xl border border-slate-700/60 bg-slate-900/95 p-6 shadow-2xl">
      <h1 className="text-2xl sm:text-3xl font-black text-white mb-4">{step.title}</h1>
      <div className="space-y-3 text-sm sm:text-base text-slate-200 leading-relaxed">
        {step.body.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
      {step.showHalfSuits && (
        <ul className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-2" aria-label="The eight half-suits">
          {allHalfSuitIds().map((id) => {
            const { suit } = parseCard(getHalfSuitCards(id, TUTORIAL_VARIANT)[0]);
            const red = suit === 'h' || suit === 'd';
            return (
              <li key={id} className="rounded-xl border border-slate-600/60 bg-slate-950/70 px-3 py-2 text-center">
                <span className={`text-2xl ${red ? 'text-red-400' : 'text-slate-100'}`}>{SUIT_SYMBOLS[suit]}</span>
                <p className="text-xs font-semibold text-white">{halfSuitLabel(id)}</p>
                <p className="text-[0.65rem] text-slate-400">{id.startsWith('low') ? 'A 2 3 4 5 6' : '8 9 10 J Q K'}</p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

