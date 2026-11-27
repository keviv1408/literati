'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useSensor, useSensors } from '@dnd-kit/core';
import { VoiceProvider } from '@/contexts/VoiceContext';
import { useAskResultAnimations } from '@/hooks/useAskResultAnimations';
import { applyStep, computeState, declareIsCorrect, sortHand, TUTORIAL_VARIANT } from '@/lib/tutorial/engine';
import type { Step } from '@/lib/tutorial/engine';
import { PRACTICE_ASKS, PRACTICE_DEAL } from '@/lib/tutorial/quickTurn';
import { PLAYERS } from '@/lib/tutorial/script';
import { askPayloadFor, toGamePlayers } from '@/lib/tutorial/table';
import { cardLabel, getCardHalfSuit, getHalfSuitCards } from '@/types/game';
import type { CardId, GamePlayer } from '@/types/game';
import ActionModeToggle from './ActionModeToggle';
import AskDeniedAnimation from './AskDeniedAnimation';
import AskSpeechBubbleOverlay from './AskSpeechBubbleOverlay';
import TableCardTransfer from '@/components/creatures/TableCardTransfer';
import CardHand from './CardHand';
import CircularGameTable from './CircularGameTable';
import DeclaredBooksTable from './DeclaredBooksTable';
import { TableScore } from './GameHeader';
import InlineAskTray from './InlineAskTray';
import { DeclareDropSeat } from './InlineDeclare';
import InlineDeclareTray from './InlineDeclareTray';
import LastMoveDisplay from './LastMoveDisplay';
import PlayingCard from './PlayingCard';
import styles from './ShortTutorial.module.css';

const diamonds = getHalfSuitCards('low_d', TUTORIAL_VARIANT);
const opponents = new Set(PLAYERS.filter(p => p.teamId === 2).map(p => p.id));
const playerName = (id: string) => PLAYERS.find(p => p.id === id)?.name;

interface PracticeHandProps {
  returnTo: 'home' | 'lobby';
  onExit: () => void;
}

function PracticeHand({ returnTo, onExit }: PracticeHandProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const popupButton = useRef<HTMLButtonElement>(null);
  const instruction = useRef<HTMLSpanElement>(null);
  const [stage, setStage] = useState<'intro' | 'play' | 'done'>('intro');
  const showPopup = stage !== 'play';
  const [played, setPlayed] = useState(0);
  const [declareMode, setDeclareMode] = useState(false);
  const [picker, setPicker] = useState<'ask' | 'declare' | null>(null);
  const [requested, setRequested] = useState<CardId[]>([]);
  const [assignment, setAssignment] = useState<Record<CardId, string>>({});
  const [selected, setSelected] = useState<CardId | null>(null);
  const [dragged, setDragged] = useState<CardId | null>(null);
  const [hint, setHint] = useState('');
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const state = computeState(PRACTICE_DEAL, PRACTICE_ASKS, played - 1, PLAYERS);
  const next = PRACTICE_ASKS[played];
  const atDeclaration = !next;
  const watching = stage === 'play' && next?.asker === 'lin';
  const canAct = stage === 'play' && state.turn === 'you';
  const declaration: Extract<Step, { kind: 'declare' }> = {
    kind: 'declare', declarer: 'you', halfSuit: 'low_d', assignment, text: '',
  };
  const table = stage === 'done' ? applyStep(state, declaration, PLAYERS) : state;
  const players = toGamePlayers(table);
  const remaining = diamonds.filter(card => !assignment[card]);
  const askResult = useMemo(() => {
    if (!played) return null;
    const before = computeState(PRACTICE_DEAL, PRACTICE_ASKS, played - 2, PLAYERS);
    return askPayloadFor(PRACTICE_ASKS[played - 1], before);
  }, [played]);
  const { cardFlight, askDeniedCue, askSpeechBubble, clearCardFlight, clearAskDeniedCue } =
    useAskResultAnimations(askResult, { getPlayerDisplayName: playerName });
  const showAskAnimation = !declareMode && stage === 'play';
  const lastMove = stage === 'done' ? 'You declared Low Diamonds — correct! Team 1 scores'
    : PRACTICE_ASKS[played - 1]?.text;

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (stage === 'play') instruction.current?.focus();
    else popupButton.current?.focus();
  }, [stage]);
  useEffect(() => {
    if (!watching) return;
    const timer = window.setTimeout(() => setPlayed(played + 1), 4000);
    return () => window.clearTimeout(timer);
  }, [watching, played]);

  function closePicker() {
    setDeclareMode(false);
    setPicker(null);
    setRequested([]);
    setSelected(null);
    setDragged(null);
    setHint('');
  }

  function openSuit(card: CardId) {
    if (!canAct) return;
    if (getCardHalfSuit(card, TUTORIAL_VARIANT) !== 'low_d' || declareMode !== atDeclaration) {
      setHint(atDeclaration ? 'Choose Declare, then tap a low diamond.' : 'Choose Ask, then tap a low diamond in your hand.');
      return;
    }
    setHint('');
    if (declareMode) {
      setAssignment(Object.fromEntries(diamonds.filter(c => state.hands.you.includes(c)).map(c => [c, 'you'])));
      setPicker('declare');
    } else {
      setPicker('ask');
    }
  }

  function askSeat(id: string) {
    if (!next || requested.length !== 1 || requested[0] !== next.card || id !== next.target) {
      if (next) setHint(`For this ask, select only ${cardLabel(next.card)} and tap ${playerName(next.target)}.`);
      return;
    }
    closePicker();
    setPlayed(played + 1);
  }

  function assign(card: CardId, id: string) {
    if (!diamonds.includes(card) || state.hands.you.includes(card) || id === 'you' || !PLAYERS.some(p => p.id === id && p.teamId === 1)) return;
    setAssignment(previous => ({ ...previous, [card]: id }));
    setSelected(null);
    setHint('');
  }

  function confirm() {
    if (!declareIsCorrect(state, declaration)) {
      const missed = diamonds.find(card => !state.hands[assignment[card]]?.includes(card));
      if (missed) setHint(`Check who holds ${cardLabel(missed)}. Tap its assigned card to move it.`);
      return;
    }
    closePicker();
    setStage('done');
  }

  function prompt() {
    if (hint) return hint;
    if (watching) return played === 2 ? 'It’s Lin’s turn. Watch who she asks.' : 'Lin has Raj’s 9♣ now and gets to ask again.';
    if (picker === 'declare') {
      if (!remaining.length) return 'All six assigned. Check the seats, then confirm.';
      if (selected) return `Tap the teammate holding ${cardLabel(selected)}.`;
      return 'Your cards are fixed. Tap or drag a missing card to its holder.';
    }
    if (atDeclaration) return declareMode ? 'Tap a low diamond to declare the set.' : 'Your team has all six low diamonds. Recall the asks. Tap Declare and name each holder.';
    if (declareMode) return 'Switch to Ask for this turn.';
    if (picker === 'ask') {
      const card = cardLabel(next.card);
      if (!requested.length) return `Pick ${card} from the missing diamonds.`;
      if (requested.length !== 1 || requested[0] !== next.card) return `For this ask, select only ${card}.`;
      if (next.target === 'lin') return `Tap Lin’s seat. She doesn’t have ${card}, so she’ll go next.`;
      return `Tap ${playerName(next.target)}’s seat to ask.`;
    }
    return played === 0 ? 'Your A♦ lets you ask for a low diamond. Tap it.' : 'You got the card, so ask again. Tap a low diamond.';
  }

  function renderSeat(player: GamePlayer, seat: ReactNode) {
    const id = player.playerId;
    const practiceSeat = (
      <div className={styles.seat}>
        {seat}
        {id !== 'you' && (
          <div className={styles.openCards} role="group" aria-label={`${player.displayName}’s face-up cards`}>
            {sortHand(table.hands[id]).map(card => (
              <div className={styles.mini} key={card}>
                <PlayingCard cardId={card} size="sm" />
                <b aria-hidden="true" data-red={card.endsWith('_d')}>{cardLabel(card)}</b>
              </div>
            ))}
          </div>
        )}
      </div>
    );
    if (picker !== 'declare' || player.teamId !== 1) return practiceSeat;
    return (
      <DeclareDropSeat playerId={id} name={player.displayName} isMe={id === 'you'} disabled={false}
        hasSelectedCard={!!selected} onTapZone={() => { if (selected) assign(selected, id); }}
        assignedCards={diamonds.filter(c => assignment[c] === id)}
        onRemoveCard={card => {
          setAssignment(previous => Object.fromEntries(Object.entries(previous).filter(([c]) => c !== card)));
          setSelected(null);
          setHint('');
        }}>{practiceSeat}</DeclareDropSeat>
    );
  }

  return (
    <dialog ref={dialog} onClose={onExit} aria-label="Practice hand" className={styles.dialog}
      aria-labelledby={showPopup ? 'practice-popup-title' : undefined}
      aria-describedby={showPopup ? 'practice-popup-rules practice-popup-note' : undefined}>
      <div inert={showPopup} aria-hidden={showPopup} className="relative isolate flex h-dvh flex-col overflow-hidden bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950" onClickCapture={event => {
        if (!picker || !(event.target instanceof Element)) return;
        if (!event.target.closest('.action-tray, [data-ask-targetable="true"], [data-testid="declare-drop-seat"], [role="radiogroup"]')) closePicker();
      }}>
        <header className="player-header">
          <button type="button" aria-label={`Back to ${returnTo}`} className="header-button" onClick={() => dialog.current?.close()}>←</button>
          <TableScore scores={table.scores} myTeamId={1} />
          <span className={styles.practiceLabel}>Face-up practice</span>
        </header>
        <LastMoveDisplay message={lastMove} players={players} />
        <DndContext sensors={sensors} collisionDetection={pointerWithin}
          onDragStart={({ active }) => { setDragged(String(active.id).replace(/^declare-/, '')); setSelected(null); }}
          onDragEnd={({ active, over }) => {
            setDragged(null);
            if (over) assign(String(active.id).replace(/^declare-/, ''), String(over.id));
          }} onDragCancel={() => setDragged(null)}>
          <div className="relative flex min-h-0 flex-1 items-stretch justify-center overflow-hidden px-2 py-2 sm:px-3 lg:px-5">
            <div className="game-table-space h-full w-full">
              <CircularGameTable players={players} myPlayerId="you" playerCount={6} currentTurnPlayerId={table.turn}
                indicatorActive={table.turn === 'you'} renderSeatWrapper={renderSeat}
                askTargetPlayerIds={requested.length ? opponents : undefined} onAskTargetClick={askSeat}>
                <DeclaredBooksTable declaredSuits={table.declared} playerCount={6} />
              </CircularGameTable>
              <TableCardTransfer denial={showAskAnimation ? askDeniedCue : null} flight={showAskAnimation ? cardFlight : null} onComplete={clearCardFlight} />
            </div>
          </div>
          <footer className="hand-tray relative z-20 border-t px-3 py-2.5 lg:px-5 lg:py-3" data-testid="practice-hand-area">
            <div className="mx-auto flex w-full max-w-[82rem] flex-col gap-2">
              {stage === 'play' && (
                <div className="hand-status">
                  <span role="status" ref={instruction} tabIndex={-1} className="text-sm font-medium text-slate-200">{prompt()}</span>
                  {canAct && picker !== 'ask' && <ActionModeToggle declareMode={declareMode}
                    onChange={declare => { closePicker(); setDeclareMode(declare); }} />}
                </div>
              )}
              {picker === 'ask' ? (
                <InlineAskTray myHand={state.hands.you} variant={TUTORIAL_VARIANT} halfSuitId="low_d"
                  selectedCardIds={requested} onToggleCard={card => {
                    setHint('');
                    setRequested(previous => previous.includes(card) ? previous.filter(c => c !== card) : [...previous, card]);
                  }} />
              ) : picker === 'declare' ? (
                <InlineDeclareTray halfSuitId="low_d" unassignedCards={remaining} selectedCard={selected}
                  assignedCount={diamonds.length - remaining.length} totalCards={diamonds.length} isComplete={!remaining.length}
                  isLoading={false} onTimerExpiry={() => {}} onConfirm={confirm}
                  onTapCard={card => { setHint(''); setSelected(selected === card ? null : card); }} />
              ) : (
                <CardHand hand={table.hands.you} variant={TUTORIAL_VARIANT} isMyTurn={table.turn === 'you'}
                  onSelectCard={canAct ? openSuit : undefined} disabled={watching}
                  newlyArrivedCardId={askResult?.success && askResult.askerId === 'you' ? askResult.cardId : null} />
              )}
            </div>
          </footer>
          <DragOverlay dropAnimation={null}>{dragged && <PlayingCard cardId={dragged} size="md" selected />}</DragOverlay>
        </DndContext>
        {showAskAnimation && askSpeechBubble && <AskSpeechBubbleOverlay bubble={askSpeechBubble} />}
        {showAskAnimation && askDeniedCue && <AskDeniedAnimation {...askDeniedCue} onComplete={clearAskDeniedCue} />}
      </div>
      {showPopup && (
        <div className={styles.popupOverlay}>
          <div className={styles.popup}>
            {stage === 'intro' && <button type="button" className={styles.popupClose} aria-label={`Back to ${returnTo}`} onClick={() => dialog.current?.close()}>×</button>}
            <div className={stage === 'intro' ? styles.introCards : styles.wonSet} aria-hidden="true">
              {(stage === 'intro' ? diamonds.slice(0, 3) : diamonds).map(card => <PlayingCard key={card} cardId={card} size="md" />)}
            </div>
            {stage === 'intro' ? (
              <>
                <h1 id="practice-popup-title"><strong>Literature:</strong> a game of memory and fun</h1>
                <p id="practice-popup-rules">Ask opponents for missing cards. When your team holds <b>A–6</b> or <b>8–K</b> of one suit, name who holds each card to score.</p>
                <p id="practice-popup-note" className={styles.goal}>Win the most sets.</p>
                <button type="button" ref={popupButton} className={styles.cta} onClick={() => setStage('play')}>Try an ask</button>
              </>
            ) : (
              <>
                <h1 id="practice-popup-title" className={styles.resultTitle}>One set, one point.</h1>
                <div id="practice-popup-rules">
                  <p>You got all six right! Your team scores, and you can pass the turn to a teammate who still has cards.</p>
                  <p>In a live game, if you name the wrong holder for even one card, the other team gets the point.</p>
                </div>
                <p id="practice-popup-note" className={styles.goal}>Remember to have fun!</p>
                <button type="button" ref={popupButton} className={styles.cta} onClick={() => dialog.current?.close()}>Return to {returnTo}</button>
              </>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}

export default function PracticeSession(props: PracticeHandProps) {
  return (
    <VoiceProvider roomCode={null} bearerToken={null} isGuest canJoin={false}>
      <PracticeHand {...props} />
    </VoiceProvider>
  );
}
