'use client';

/**
 * SpectatorView — read-only game view for spectators.
 *
 * Rendered inside the game page (`/game/[room-id]`) when the WebSocket server
 * sends a `spectator_init` message instead of `game_init`, i.e. when the
 * connecting client's bearer token does not map to any player in the game.
 *
 * ### What is shown
 * - Prominent "👁 SPECTATING" banner so the read-only mode is immediately clear.
 * - Live scores for both teams (Team 1 / Team 2).
 * - Turn indicator — whose turn it currently is.
 * - Animated turn-timer progress bar (same as the player view).
 * - Last-move description (one line, no history log).
 * - All players arranged in two team rows, each with avatar, name, card count,
 * team colour, and active-turn glow.
 * - Declared half-suit badges accumulating in the centre.
 * - WebSocket connection-status dot.
 *
 * ### What is NOT shown
 * - Player's own card hand (spectators have no hand).
 * - Ask-card or declare-suit controls.
 * - Rematch vote panel.
 * - Historical move log (last move only, per spec).
 *
 * @example
 * // Inside /game/[room-id]/page.tsx when spectator mode is detected:
 * <SpectatorView
 * wsStatus={wsStatus}
 * players={players}
 * gameState={gameState}
 * variant={variant}
 * playerCount={playerCount}
 * turnTimer={turnTimer}
 * declarationTimer={declarationTimer}
 * lastAskResult={lastAskResult}
 * lastDeclareResult={lastDeclareResult}
 * roomCode={roomCode}
 * cardRemovalVariant={room.card_removal_variant}
 * gamePlayerCount={room.player_count}
 * onGoHome={handleGoHome}
 * />
 */

import React, { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { advanceAskMoveBatch, buildAskMoveSummaryMessage, type AskMoveBatch } from '@/lib/askMoveSummary';
import {
  buildDeclarationSeatRevealMap,
  buildSuccessfulDeclarationSeatRevealMap,
  FAILED_DECLARATION_SEAT_REVEAL_MS,
} from '@/lib/declarationSeatReveal';
import CircularGameTable from '@/components/CircularGameTable';
import CardHand from '@/components/CardHand';
import type { GameWsStatus, TurnTimerPayload, DeclarationTimerPayload, PostDeclarationTimerPayload } from '@/hooks/useGameSocket';
import DeclarationTimerBar from '@/components/DeclarationTimerBar';
import AskDeniedAnimation from '@/components/AskDeniedAnimation';
import AskSpeechBubbleOverlay from '@/components/AskSpeechBubbleOverlay';
import DeclaredBooksTable from '@/components/DeclaredBooksTable';
import type {
  CardId,
  GamePlayer,
  PublicGameState,
  SpectatorHands,
  SpectatorMoveEntry,
  AskResultPayload,
  DeclarationResultPayload,
  DeclarationFailedPayload,
  DeclareProgressPayload,
} from '@/types/game';
import DeclarationProgressBanner from '@/components/DeclarationProgressBanner';
import LastMoveDisplay from '@/components/LastMoveDisplay';
import CountdownTimer from '@/components/CountdownTimer';
import CardFlightAnimation from '@/components/CardFlightAnimation';
import { useAskResultAnimations } from '@/hooks/useAskResultAnimations';

// ── Variant display helpers ────────────────────────────────────────────────────

const VARIANT_LABELS: Record<string, string> = {
  remove_2s: 'Remove 2s',
  remove_7s: 'Remove 7s (Classic)',
  remove_8s: 'Remove 8s',
};

// ── Props ──────────────────────────────────────────────────────────────────────

export interface SpectatorViewProps {
  /** Current WebSocket connection status. */
  wsStatus: GameWsStatus;
  /** All players in the game, from the WebSocket `spectator_init` / `game_players` messages. */
  players: GamePlayer[];
  /** God-mode spectator hand map keyed by playerId. */
  spectatorHands: SpectatorHands;
  /** Full formatted move log for God-mode spectators. */
  spectatorMoveHistory: SpectatorMoveEntry[];
  /** Public game state broadcast to all clients (scores, turn, declared suits, etc.). */
  gameState: PublicGameState | null;
  /** Card-removal variant from the socket (`spectator_init`); falls back to `cardRemovalVariant`. */
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s' | null;
  /** Player count from the socket (`spectator_init`); falls back to `gamePlayerCount`. */
  playerCount: 6 | 8 | null;
  /** Server-authoritative turn timer, drives the timer progress bar. */
  turnTimer: TurnTimerPayload | null;
  /** Most recent ask-card result (used for the move log and last-move text). */
  lastAskResult: AskResultPayload | null;
  /** Most recent declaration result (used for the move log and last-move text). */
  lastDeclareResult: DeclarationResultPayload | null;
  /** 6-character room code shown in the header. */
  roomCode: string;
  /**
   * Card-removal variant from the room API record.
   * Used as a fallback before the WebSocket delivers `variant`.
   */
  cardRemovalVariant: string;
  /**
   * Player count from the room API record.
   * Used as a fallback before the WebSocket delivers `playerCount`.
   */
  gamePlayerCount: 6 | 8;
  /**
   * Live declaration progress from the active player's DeclareModal.
   */
  declareProgress?: DeclareProgressPayload | null;
  /**
   * Active 60-second declaration phase timer.
   * The server broadcasts `declaration_timer` to ALL connections so spectators
   * can see the same countdown the declaring player sees.
   */
  declarationTimer?: DeclarationTimerPayload | null;
  /** Per-card diff from a failed declaration, used for the seat-level reveal. */
  declarationFailed?: DeclarationFailedPayload | null;
  /**
   * Active post-declaration turn-selection timer (AC 28).
   * Non-null for 30 seconds after a human correct declaration while the
   * declaring team is choosing who takes the next turn.
   */
  postDeclarationTimer?: PostDeclarationTimerPayload | null;
  /** Called when the user clicks "Back to Home". */
  onGoHome: () => void;
}

// ── Component ──────────────────────────────────────────────────────────────────

/**
 * SpectatorView renders the full read-only game table for spectators.
 */
export default function SpectatorView({
  wsStatus,
  players,
  spectatorHands,
  spectatorMoveHistory,
  gameState,
  variant,
  playerCount,
  turnTimer,
  declarationTimer,
  lastAskResult,
  lastDeclareResult,
  declareProgress,
  declarationFailed,
  postDeclarationTimer,
  roomCode,
  cardRemovalVariant,
  gamePlayerCount,
  onGoHome,
}: SpectatorViewProps) {
  // ── Failed Declaration Seat Reveal dismiss state ──────────────
  const [declarationSeatRevealByPlayerId, setDeclarationSeatRevealByPlayerId] =
    useState<Map<string, import('@/lib/declarationSeatReveal').DeclarationSeatRevealCard[]> | null>(null);
  const declarationSeatRevealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [godModeEnabled, setGodModeEnabled] = useState(false);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);

  // ── Last-move display (transient 5-second flash) ───────────────────────────
  const [lastResultMsg, setLastResultMsg] = useState<string | null>(null);
  const [syntheticLastMoveMsg, setSyntheticLastMoveMsg] = useState<string | null>(null);
  const lastResultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observedAskBatchRef = useRef<AskMoveBatch | null>(null);
  const processedAskResultKeyRef = useRef<string | null>(null);
  const processedDeclareResultKeyRef = useRef<string | null>(null);
  const processedDeclarationFailedKeyRef = useRef<string | null>(null);
  const getPlayerDisplayName = useCallback((playerId: string) => {
    return players.find((p) => p.playerId === playerId)?.displayName;
  }, [players]);
  const {
    cardFlight,
    askDeniedCue,
    askSpeechBubble,
    clearCardFlight,
    clearAskDeniedCue,
  } = useAskResultAnimations(lastAskResult, {
    getPlayerDisplayName,
  });
  const showTransientLastResult = useEffectEvent((msg: string, persistentMessage: string | null = null) => {
    setLastResultMsg(msg);
    setSyntheticLastMoveMsg(persistentMessage);
    if (lastResultTimer.current) clearTimeout(lastResultTimer.current);
    lastResultTimer.current = setTimeout(() => setLastResultMsg(null), 5_000);
  });
  const effectiveVariant =
    variant ?? (cardRemovalVariant as 'remove_2s' | 'remove_7s' | 'remove_8s');

  useEffect(() => {
    if (!lastAskResult?.lastMove) return;
    const askResultKey = [
      lastAskResult.askerId,
      lastAskResult.targetId,
      lastAskResult.cardId,
      lastAskResult.success ? '1' : '0',
      lastAskResult.newTurnPlayerId,
      lastAskResult.lastMove,
    ].join('|');
    if (processedAskResultKeyRef.current === askResultKey) return;
    processedAskResultKeyRef.current = askResultKey;

    const observedBatch = advanceAskMoveBatch(observedAskBatchRef.current, lastAskResult);
    observedAskBatchRef.current = observedBatch;
    const askerName =
      players.find((player) => player.playerId === lastAskResult.askerId)?.displayName ?? 'Player';
    const targetName =
      players.find((player) => player.playerId === lastAskResult.targetId)?.displayName ?? 'Player';
    const summaryMessage = buildAskMoveSummaryMessage(
      observedBatch,
      lastAskResult,
      askerName,
      targetName,
    );

    showTransientLastResult(summaryMessage ?? lastAskResult.lastMove, summaryMessage);
  }, [lastAskResult, players]);

  useEffect(() => {
    const result = lastDeclareResult;
    const msg = result?.lastMove ?? null;
    if (!result || !msg) return;
    const declareResultKey = [
      result.declarerId,
      result.halfSuitId,
      result.correct ? '1' : '0',
      result.winningTeam ?? 'none',
      result.newTurnPlayerId ?? 'none',
      msg,
    ].join('|');
    if (processedDeclareResultKeyRef.current === declareResultKey) return;
    processedDeclareResultKeyRef.current = declareResultKey;
    observedAskBatchRef.current = null;
    if (result.correct) {
      setDeclarationSeatRevealByPlayerId(
        buildSuccessfulDeclarationSeatRevealMap(result, effectiveVariant),
      );
      if (declarationSeatRevealTimerRef.current) {
        clearTimeout(declarationSeatRevealTimerRef.current);
      }
      declarationSeatRevealTimerRef.current = setTimeout(() => {
        setDeclarationSeatRevealByPlayerId(null);
      }, FAILED_DECLARATION_SEAT_REVEAL_MS);
    }
    showTransientLastResult(msg, null);
  }, [effectiveVariant, lastDeclareResult]);

  useEffect(() => {
    if (!declarationFailed) {
      processedDeclarationFailedKeyRef.current = null;
      setDeclarationSeatRevealByPlayerId(null);
      return;
    }
    const declarationFailedKey = [
      declarationFailed.declarerId,
      declarationFailed.halfSuitId,
      declarationFailed.winningTeam,
      declarationFailed.lastMove,
    ].join('|');
    if (processedDeclarationFailedKeyRef.current === declarationFailedKey) return;
    processedDeclarationFailedKeyRef.current = declarationFailedKey;
    setDeclarationSeatRevealByPlayerId(
      buildDeclarationSeatRevealMap(declarationFailed, players, effectiveVariant),
    );
    if (declarationSeatRevealTimerRef.current) {
      clearTimeout(declarationSeatRevealTimerRef.current);
    }
    declarationSeatRevealTimerRef.current = setTimeout(() => {
      setDeclarationSeatRevealByPlayerId(null);
    }, FAILED_DECLARATION_SEAT_REVEAL_MS);
    return () => {
      if (declarationSeatRevealTimerRef.current) {
        clearTimeout(declarationSeatRevealTimerRef.current);
      }
    };
  }, [declarationFailed, effectiveVariant, players]);

  useEffect(() => {
    return () => {
      if (declarationSeatRevealTimerRef.current) {
        clearTimeout(declarationSeatRevealTimerRef.current);
      }
    };
  }, []);

  // ── Derived values ─────────────────────────────────────────────────────────
  const effectivePlayerCount = playerCount ?? gamePlayerCount;

  const currentTurnPlayer = gameState?.currentTurnPlayerId
    ? players.find((p) => p.playerId === gameState.currentTurnPlayerId)
    : null;
  const displayedMove = lastResultMsg ?? syntheticLastMoveMsg ?? gameState?.lastMove ?? null;
  const selectedPlayer = selectedPlayerId
    && godModeEnabled
    && players.some((player) => player.playerId === selectedPlayerId)
    ? players.find((player) => player.playerId === selectedPlayerId) ?? null
    : null;
  const selectedPlayerHand: CardId[] = selectedPlayer
    ? (spectatorHands[selectedPlayer.playerId] ?? [])
    : [];

  // ── Connecting state ───────────────────────────────────────────────────────
  if (wsStatus === 'connecting' || wsStatus === 'idle') {
    return (
      <div
        className="flex min-h-screen flex-col bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950"
        data-testid="spectator-connecting"
      >
        <SpectatorHeader
          roomCode={roomCode}
          effectiveVariant={effectiveVariant}
          effectivePlayerCount={effectivePlayerCount}
          wsStatus={wsStatus}
          scores={null}
          onGoHome={onGoHome}
        />
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-slate-400">
            <svg
              className="animate-spin h-8 w-8 text-emerald-500"
              viewBox="0 0 24 24"
              fill="none"
              aria-label="Connecting to game…"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
            <span className="text-sm">Connecting to game…</span>
          </div>
        </div>
      </div>
    );
  }

  // ── Error / disconnected state ─────────────────────────────────────────────
  if (wsStatus === 'error' || wsStatus === 'disconnected') {
    return (
      <div
        className="flex min-h-screen flex-col bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950"
        data-testid="spectator-error"
      >
        <SpectatorHeader
          roomCode={roomCode}
          effectiveVariant={effectiveVariant}
          effectivePlayerCount={effectivePlayerCount}
          wsStatus={wsStatus}
          scores={null}
          onGoHome={onGoHome}
        />
        <div className="flex flex-1 items-center justify-center px-4">
          <div className="flex flex-col items-center gap-4 text-center max-w-xs">
            <span className="text-4xl">⚠️</span>
            <p className="text-white font-semibold text-lg">Connection Lost</p>
            <p className="text-slate-400 text-sm">Spectator connection was interrupted.</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-2 py-2 px-5 rounded-xl font-semibold text-sm bg-emerald-600 hover:bg-emerald-500 text-white transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400"
            >
              Reconnect
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main spectator view ────────────────────────────────────────────────────
  return (
    <div
      className="flex min-h-screen flex-col bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 overflow-hidden"
      data-testid="spectator-view"
    >
      {/* ── Background card suit decorations (same as game view) ─────────── */}
      <div
        className="pointer-events-none fixed inset-0 overflow-hidden opacity-5 select-none"
        aria-hidden="true"
      >
        <span className="absolute text-[20rem] -top-16 -right-16 text-white">♦</span>
        <span className="absolute text-[14rem] bottom-0 -left-8 text-white">♣</span>
      </div>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <SpectatorHeader
        roomCode={roomCode}
        effectiveVariant={effectiveVariant}
        effectivePlayerCount={effectivePlayerCount}
        wsStatus={wsStatus}
        scores={gameState?.scores ?? null}
        onGoHome={onGoHome}
      />

      {/* ── Prominent SPECTATING banner ──────────────────────────────────────
       * Rendered as a full-width strip directly below the header so spectators
       * cannot mistake this view for an interactive player view. The eye icon
       * and ALL-CAPS "SPECTATING · READ ONLY" text make the mode unambiguous
       * on both desktop and mobile without requiring a modal or overlay.
       */}
      <div
        className="relative z-10 flex items-center justify-center gap-2 px-4 py-1.5 bg-amber-900/40 border-b border-amber-700/50 text-amber-200"
        role="status"
        aria-label="Spectator mode — read only"
        data-testid="spectator-banner"
      >
        <span aria-hidden="true" className="text-base leading-none">👁</span>
        <span className="text-xs font-bold uppercase tracking-widest">
          Spectating · Read Only
        </span>
      </div>

      {/* ── Turn indicator ───────────────────────────────────────────────────
       * Shows whose turn it is. Spectators can see this but cannot act.
       * The banner intentionally omits the "ask a card or declare" prompt.
       */}
      {gameState && (
        <div
          className="relative z-10 flex items-center justify-center gap-2 px-4 py-2 bg-slate-800/50 border-b border-slate-700/40 text-slate-300 text-sm"
          role="status"
          aria-live="polite"
          data-testid="spectator-turn-indicator"
        >
          {currentTurnPlayer ? (
            <>
              <span aria-hidden="true">⏳</span>
              <span>
                <strong>{currentTurnPlayer.displayName}</strong>
                {currentTurnPlayer.isBot && ' 🤖'}
                {`'s turn`}
              </span>
            </>
          ) : (
            <span>Waiting for game to start…</span>
          )}
        </div>
      )}

      {/* ── Turn-timer countdown ─────────────────────────────────────────────
       * Re-mounts on each new expiresAt value via the `key` prop.
       * Spectators see the same countdown as players so they can follow along.
       * Uses the shared CountdownTimer component (isMyTimer=false → slate scheme).
       */}
      {turnTimer && gameState && (
        <CountdownTimer
          key={turnTimer.expiresAt}
          expiresAt={turnTimer.expiresAt}
          durationMs={turnTimer.durationMs}
          isMyTimer={false}
          label="Turn timer"
        />
      )}

      {/* ── Declaration-phase countdown ────────────────────
       * Shown to all spectators during the 60-second card-assignment phase.
       * The server broadcasts `declaration_timer` to ALL connections so the
       * entire table (players + spectators) can follow the declarant's timer.
       * Re-mounts on each new expiresAt value via the `key` prop.
       */}
      {declarationTimer && gameState && (
        <div className="relative z-10 px-4 pb-1">
          <DeclarationTimerBar
            key={declarationTimer.expiresAt}
            expiresAt={declarationTimer.expiresAt}
            durationMs={declarationTimer.durationMs}
            className="max-w-xl mx-auto"
          />
        </div>
      )}

      {/* ── Post-declaration turn-selection countdown (AC 28) ───
       * Shown to spectators for 30 seconds after a human correct declaration
       * while the declaring team chooses who takes the next turn.
       * On expiry the server auto-selects a random eligible player.
       */}
      {postDeclarationTimer && gameState && (
        <CountdownTimer
          key={postDeclarationTimer.expiresAt}
          expiresAt={postDeclarationTimer.expiresAt}
          durationMs={postDeclarationTimer.durationMs}
          isMyTimer={false}
          label="Choose next turn"
          className="relative z-10 px-4 pb-1 max-w-xl mx-auto"
        />
      )}

      {/* ── Last move display (AC 35) ────────────────────────────────────────
       * Shows only the single most-recent move (no history log per spec).
       * Uses the shared LastMoveDisplay component.
       */}
      <LastMoveDisplay
        message={displayedMove}
        players={players}
        testId="spectator-last-move"
      />

      {declareProgress && declareProgress.halfSuitId && (
        <div className="relative z-10 px-4 py-2 border-b border-amber-800/40">
          <DeclarationProgressBanner
            progress={declareProgress}
            players={players}
          />
        </div>
      )}

      {/* ── Main content area ─────────────────────────────────────────────── */}
      <main
        className="relative z-10 flex-1 flex flex-col items-center justify-center px-3 py-3 min-h-0 overflow-hidden"
        aria-label="Spectator game table"
      >
        <div className="w-full max-w-[82rem] xl:max-w-[90rem] 2xl:max-w-[98rem]">
          <CircularGameTable
            players={players}
            myPlayerId={null}
            playerCount={(effectivePlayerCount === 8 ? 8 : 6) as 6 | 8}
            currentTurnPlayerId={gameState?.currentTurnPlayerId ?? null}
            indicatorActive={true}
            highlightedPlayerIds={
              godModeEnabled && selectedPlayerId
                ? new Set([selectedPlayerId])
                : undefined
            }
            onDirectSeatClick={godModeEnabled ? setSelectedPlayerId : undefined}
            declarationSeatRevealByPlayerId={declarationSeatRevealByPlayerId}
          >
            <DeclaredBooksTable
              declaredSuits={gameState?.declaredSuits ?? []}
              playerCount={effectivePlayerCount === 8 ? 8 : 6}
            />
          </CircularGameTable>
        </div>
      </main>

      {/* ── Spectator footer ───────────────────────────────────────────────── */}
      <footer
        className="relative z-20 border-t border-slate-700/50 bg-slate-900/80 backdrop-blur-sm px-3 py-3"
        data-testid="spectator-footer"
      >
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <p
              className="text-xs text-amber-400/70 font-medium"
              role="note"
              aria-label="Spectator mode — actions disabled"
              data-testid="spectator-readonly-note"
            >
              👁 You are spectating · No actions available
            </p>
            <button
              type="button"
              onClick={() => setGodModeEnabled((enabled) => !enabled)}
              aria-pressed={godModeEnabled}
              className={[
                'rounded-full border px-3 py-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.2em] transition-colors',
                godModeEnabled
                  ? 'border-amber-400/70 bg-amber-400/10 text-amber-200'
                  : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200',
              ].join(' ')}
              data-testid="spectator-god-mode-toggle"
            >
              {godModeEnabled ? 'Disable God mode' : 'Enable God mode'}
            </button>
          </div>

          {godModeEnabled ? (
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
              {selectedPlayer ? (
                <section
                  className="rounded-2xl border border-slate-700/60 bg-slate-950/70 px-3 py-3"
                  aria-label={`${selectedPlayer.displayName}'s hand`}
                  data-testid="spectator-hand-panel"
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">
                        {selectedPlayer.displayName}
                        {selectedPlayer.isBot ? ' 🤖' : ''}
                      </p>
                      <p className="text-xs text-slate-400">
                        {selectedPlayerHand.length} card{selectedPlayerHand.length !== 1 ? 's' : ''} visible
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedPlayerId(null)}
                      className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
                    >
                      Clear
                    </button>
                  </div>

                  <CardHand
                    hand={selectedPlayerHand}
                    isMyTurn={false}
                    disabled={true}
                    variant={effectiveVariant}
                  />
                </section>
              ) : (
                <div
                  className="rounded-2xl border border-dashed border-slate-700/70 bg-slate-950/40 px-4 py-4 text-center"
                  data-testid="spectator-hand-placeholder"
                >
                  <p className="text-sm font-medium text-slate-200">
                    Tap a player to inspect their hand
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    God mode reveals cards at the bottom of the table.
                  </p>
                </div>
              )}

              <section
                className="rounded-2xl border border-slate-700/60 bg-slate-950/70 px-3 py-3"
                aria-label="Move log"
                data-testid="spectator-move-log"
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-white">Move log</p>
                    <p className="text-xs text-slate-400">
                      {spectatorMoveHistory.length} move{spectatorMoveHistory.length !== 1 ? 's' : ''} so far
                    </p>
                  </div>
                  <p className="text-[0.65rem] uppercase tracking-[0.2em] text-slate-500">
                    Full history
                  </p>
                </div>

                {spectatorMoveHistory.length > 0 ? (
                  <ol className="max-h-56 space-y-2 overflow-y-auto pr-1" data-testid="spectator-move-log-list">
                    {[...spectatorMoveHistory].reverse().map((move, index) => (
                      <li
                        key={`${move.ts}-${index}`}
                        className="rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2"
                      >
                        <p className="text-[0.65rem] uppercase tracking-[0.2em] text-slate-500">
                          Move {spectatorMoveHistory.length - index}
                        </p>
                        <p className="mt-1 text-sm text-slate-100">
                          {move.message}
                        </p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div
                    className="rounded-xl border border-dashed border-slate-800 px-3 py-4 text-center text-sm text-slate-500"
                    data-testid="spectator-move-log-empty"
                  >
                    No moves yet.
                  </div>
                )}
              </section>
            </div>
          ) : (
            <div
              className="rounded-2xl border border-dashed border-slate-700/70 bg-slate-950/40 px-4 py-4 text-center"
              data-testid="spectator-god-mode-disabled"
            >
              <p className="text-sm font-medium text-slate-200">
                Enable God mode to inspect hands and view the full move log
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Spectator mode stays read-only either way.
              </p>
            </div>
          )}
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

      {askSpeechBubble && (
        <AskSpeechBubbleOverlay bubble={askSpeechBubble} />
      )}

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
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

/**
 * SpectatorHeader — top header bar shared across all spectator view states.
 *
 * Shows: back button, room code, variant label, score, and WS status dot.
 * Score is hidden when `scores` is null (connecting / error states).
 */
function SpectatorHeader({
  roomCode,
  effectiveVariant,
  effectivePlayerCount,
  wsStatus,
  scores,
  onGoHome,
}: {
  roomCode: string;
  effectiveVariant: string;
  effectivePlayerCount: number;
  wsStatus: GameWsStatus;
  scores: { team1: number; team2: number } | null;
  onGoHome: () => void;
}) {
  return (
    <header
      className="relative z-20 flex items-center justify-between px-3 py-2 border-b border-slate-700/50 bg-slate-900/70 backdrop-blur-sm"
      data-testid="spectator-header"
    >
      {/* Left: back + room code */}
      <div className="flex items-center gap-2">
        <button
          onClick={onGoHome}
          aria-label="Home"
          className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-400"
        >
          ←
        </button>
        <span
          className="font-mono font-bold text-white text-sm"
          data-testid="spectator-room-code"
        >
          {roomCode}
        </span>
        <span className="text-xs text-slate-500 hidden sm:inline">
          {VARIANT_LABELS[effectiveVariant] ?? effectiveVariant}
          {' · '}
          {effectivePlayerCount === 6 ? '3v3' : '4v4'}
        </span>
      </div>

      {/* Centre: score (only shown when game state is available) */}
      {scores && (
        <div
          className="flex items-center gap-2 text-sm font-semibold"
          aria-label="Score"
          data-testid="spectator-score"
        >
          <span className="text-slate-400">
            T1 <span className="text-white text-base">{scores.team1}</span>
          </span>
          <span className="text-slate-600">—</span>
          <span className="text-slate-400">
            <span className="text-white text-base">{scores.team2}</span> T2
          </span>
        </div>
      )}

      {/* Right: connection status dot */}
      <div
        className="flex items-center gap-1.5"
        title={`Connection: ${wsStatus}`}
        data-testid="spectator-ws-status"
      >
        <span
          className={[
            'w-2 h-2 rounded-full',
            wsStatus === 'connected'    ? 'bg-emerald-400'
            : wsStatus === 'connecting' ? 'bg-yellow-400 animate-pulse'
            : wsStatus === 'error'      ? 'bg-red-500'
            : 'bg-slate-600',
          ].join(' ')}
        />
      </div>
    </header>
  );
}
