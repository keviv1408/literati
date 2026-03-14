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
 * - Inference mode banner (🔍) — always active for spectators; explains badges.
 * - Live scores for both teams (Team 1 / Team 2).
 * - Turn indicator — whose turn it currently is.
 * - Animated turn-timer progress bar (same as the player view).
 * - Last-move description (one line, no history log).
 * - All players arranged in two team rows, each with avatar, name, card count,
 *   team colour, active-turn glow, and inference indicators (🔍/✕ badges).
 * - Declared half-suit badges accumulating in the centre.
 * - WebSocket connection-status dot.
 *
 * ### What is NOT shown
 * - Player's own card hand (spectators have no hand).
 * - Ask-card or declare-suit controls.
 * - Rematch vote panel.
 * - Inference mode toggle button (spectators always have inference mode on).
 * - Historical move log (last move only, per spec).
 *
 * ### Inference mode
 * Spectators automatically have inference mode active (locked on via
 * `InferenceProvider` with `isSpectator=true`).  Card-location data is
 * derived from public ask/declare events via `useCardInference`.  The
 * `SpectatorPlayerRow` reads inference data from `useInferenceContext` and
 * passes each player's inferred card knowledge to `GamePlayerSeat`.
 * Spectators cannot toggle inference mode — no toggle button is rendered.
 *
 * @example
 * // Inside /game/[room-id]/page.tsx when spectator mode is detected:
 * <SpectatorView
 *   wsStatus={wsStatus}
 *   players={players}
 *   gameState={gameState}
 *   variant={variant}
 *   playerCount={playerCount}
 *   turnTimer={turnTimer}
 *   lastAskResult={lastAskResult}
 *   lastDeclareResult={lastDeclareResult}
 *   roomCode={roomCode}
 *   cardRemovalVariant={room.card_removal_variant}
 *   gamePlayerCount={room.player_count}
 *   onGoHome={handleGoHome}
 * />
 */

import React, { useEffect, useRef, useState } from 'react';
import GamePlayerSeat from '@/components/GamePlayerSeat';
import { useCardInference } from '@/hooks/useCardInference';
import { InferenceProvider, useInferenceContext } from '@/contexts/InferenceContext';
import type { GameWsStatus, TurnTimerPayload } from '@/hooks/useGameSocket';
import type {
  GamePlayer,
  PublicGameState,
  AskResultPayload,
  DeclarationResultPayload,
  DeclareProgressPayload,
} from '@/types/game';
import { halfSuitLabel, SUIT_SYMBOLS } from '@/types/game';
import DeclarationProgressBanner from '@/components/DeclarationProgressBanner';
import LastMoveDisplay from '@/components/LastMoveDisplay';

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
  /** Public game state broadcast to all clients (scores, turn, declared suits, etc.). */
  gameState: PublicGameState | null;
  /** Card-removal variant from the socket (`spectator_init`); falls back to `cardRemovalVariant`. */
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s' | null;
  /** Player count from the socket (`spectator_init`); falls back to `gamePlayerCount`. */
  playerCount: 6 | 8 | null;
  /** Server-authoritative turn timer, drives the timer progress bar. */
  turnTimer: TurnTimerPayload | null;
  /** Most recent ask-card result (used for inference tracking and last-move text). */
  lastAskResult: AskResultPayload | null;
  /** Most recent declaration result (used for inference tracking and last-move text). */
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
   * When non-null and halfSuitId is set, a progress banner is shown.
   * Received via `declare_progress` WebSocket broadcast (Sub-AC 21b).
   */
  declareProgress?: DeclareProgressPayload | null;
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
  gameState,
  variant,
  playerCount,
  turnTimer,
  lastAskResult,
  lastDeclareResult,
  declareProgress,
  roomCode,
  cardRemovalVariant,
  gamePlayerCount,
  onGoHome,
}: SpectatorViewProps) {
  // ── Card inference ─────────────────────────────────────────────────────────
  // Spectators derive card-location knowledge from public ask/declare events.
  // Inference mode is always active for spectators (isSpectator=true on the
  // InferenceProvider), so they cannot toggle it off.
  const effectiveVariantForInference = variant ?? (cardRemovalVariant as 'remove_2s' | 'remove_7s' | 'remove_8s');
  const { cardInferences } = useCardInference({
    lastAskResult,
    lastDeclareResult,
    variant: effectiveVariantForInference,
  });

  // ── Last-move display (transient 5-second flash) ───────────────────────────
  const [lastResultMsg, setLastResultMsg] = useState<string | null>(null);
  const lastResultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const msg = lastAskResult?.lastMove ?? null;
    if (!msg) return;
    setLastResultMsg(msg);
    if (lastResultTimer.current) clearTimeout(lastResultTimer.current);
    lastResultTimer.current = setTimeout(() => setLastResultMsg(null), 5_000);
  }, [lastAskResult]);

  useEffect(() => {
    const msg = lastDeclareResult?.lastMove ?? null;
    if (!msg) return;
    setLastResultMsg(msg);
    if (lastResultTimer.current) clearTimeout(lastResultTimer.current);
    lastResultTimer.current = setTimeout(() => setLastResultMsg(null), 5_000);
  }, [lastDeclareResult]);

  // ── Derived values ─────────────────────────────────────────────────────────
  const effectiveVariant    = variant ?? (cardRemovalVariant as 'remove_2s' | 'remove_7s' | 'remove_8s');
  const effectivePlayerCount = playerCount ?? gamePlayerCount;
  const seatsPerTeam        = Math.floor(effectivePlayerCount / 2);

  const team1Players = players.filter((p) => p.teamId === 1);
  const team2Players = players.filter((p) => p.teamId === 2);

  const currentTurnPlayer = gameState?.currentTurnPlayerId
    ? players.find((p) => p.playerId === gameState.currentTurnPlayerId)
    : null;

  const displayedMove = lastResultMsg ?? gameState?.lastMove ?? null;

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
  // Wrapped in InferenceProvider with isSpectator=true so inference mode is
  // permanently on and the toggle is disabled.  SpectatorPlayerRow consumes
  // cardInferences from the context to show per-seat indicators.
  return (
    <InferenceProvider isSpectator={true} cardInferences={cardInferences}>
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
       *  Rendered as a full-width strip directly below the header so spectators
       *  cannot mistake this view for an interactive player view.  The eye icon
       *  and ALL-CAPS "SPECTATING · READ ONLY" text make the mode unambiguous
       *  on both desktop and mobile without requiring a modal or overlay.
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

      {/* ── Inference mode banner ─────────────────────────────────────────────
       *  Explains the 🔍 / ✕ badges shown on player seats.  Always rendered
       *  for spectators since inference mode is locked on.
       *  Must be inside InferenceProvider to read inferenceMode from context.
       */}
      <SpectatorInferenceBanner />

      {/* ── Turn indicator ───────────────────────────────────────────────────
       *  Shows whose turn it is.  Spectators can see this but cannot act.
       *  The banner intentionally omits the "ask a card or declare" prompt.
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

      {/* ── Turn-timer progress bar ──────────────────────────────────────────
       *  Re-mounts on each new expiresAt value via the `key` prop.
       *  Spectators see the same timer as players so they can follow along.
       */}
      {turnTimer && gameState && (
        <SpectatorTimerBar
          key={turnTimer.expiresAt}
          expiresAt={turnTimer.expiresAt}
          durationMs={turnTimer.durationMs}
        />
      )}

      {/* ── Last move display (AC 35) ────────────────────────────────────────
       *  Shows only the single most-recent move (no history log per spec).
       *  Uses the shared LastMoveDisplay component.
       */}
      <LastMoveDisplay message={displayedMove} testId="spectator-last-move" />

      {/* ── Declaration-in-progress banner (Sub-AC 21b) ───────────────────
          Spectators see a live "X is declaring Low Spades (3/6)" banner
          while the active player is filling out the DeclareModal.  Cleared
          automatically when declaration_result or a cancel signal arrives.
      */}
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
        className="relative z-10 flex-1 flex flex-col items-center justify-between px-3 py-3 gap-3 min-h-0 overflow-hidden"
        aria-label="Spectator game table"
      >
        {/* Declared half-suit badges */}
        {gameState && gameState.declaredSuits.length > 0 && (
          <div className="w-full max-w-2xl" data-testid="spectator-declared-suits">
            <div className="flex flex-wrap gap-1 justify-center">
              {gameState.declaredSuits.map((ds) => {
                const [tier, suit] = ds.halfSuitId.split('_');
                const sym = SUIT_SYMBOLS[suit as 's' | 'h' | 'd' | 'c'] ?? suit;
                return (
                  <span
                    key={ds.halfSuitId}
                    className={[
                      'px-2 py-0.5 rounded-full text-xs font-semibold border',
                      ds.teamId === 1
                        ? 'bg-emerald-900/50 border-emerald-700/50 text-emerald-300'
                        : 'bg-violet-900/50 border-violet-700/50 text-violet-300',
                    ].join(' ')}
                    title={`${halfSuitLabel(ds.halfSuitId)} — Team ${ds.teamId}`}
                    data-testid="spectator-declared-badge"
                  >
                    {tier === 'high' ? '▲' : '▽'}{sym}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* Team 2 row — inference data is passed via InferenceContext */}
        <div
          className="w-full max-w-2xl"
          aria-label="Team 2 players"
          data-testid="spectator-team2-row"
        >
          <p className="text-center text-xs text-slate-500 uppercase tracking-widest mb-1">
            Team 2
          </p>
          <SpectatorPlayerRow
            players={team2Players}
            currentTurnPlayerId={gameState?.currentTurnPlayerId ?? null}
            seatsPerTeam={seatsPerTeam}
          />
        </div>

        {/* Centre table */}
        <div
          className="relative flex items-center justify-center w-full max-w-xs"
          aria-hidden="true"
          data-testid="spectator-table-center"
        >
          <div className="w-full aspect-[2/1] rounded-full border-2 border-emerald-800/50 bg-emerald-900/20 flex items-center justify-center shadow-inner shadow-black/40">
            <div className="text-center">
              <div className="text-2xl mb-0.5">👁</div>
              <p className="text-[10px] text-slate-500">
                {effectivePlayerCount === 6 ? '3v3' : '4v4'}
              </p>
            </div>
          </div>
        </div>

        {/* Team 1 row — inference data is passed via InferenceContext */}
        <div
          className="w-full max-w-2xl"
          aria-label="Team 1 players"
          data-testid="spectator-team1-row"
        >
          <SpectatorPlayerRow
            players={team1Players}
            currentTurnPlayerId={gameState?.currentTurnPlayerId ?? null}
            seatsPerTeam={seatsPerTeam}
          />
          <p className="text-center text-xs text-slate-500 uppercase tracking-widest mt-1">
            Team 1
          </p>
        </div>
      </main>

      {/* ── Spectator footer ─────────────────────────────────────────────────
       *  Intentionally shows NO card hand or action buttons.
       *  Only a reminder that this is a read-only view.
       */}
      <footer
        className="relative z-20 border-t border-slate-700/50 bg-slate-900/80 backdrop-blur-sm px-3 py-3"
        data-testid="spectator-footer"
      >
        <p
          className="text-center text-xs text-amber-400/70 font-medium"
          role="note"
          aria-label="Spectator mode — actions disabled"
          data-testid="spectator-readonly-note"
        >
          👁 You are spectating · No actions available
        </p>
      </footer>
    </div>
    </InferenceProvider>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

// ── SpectatorInferenceBanner ──────────────────────────────────────────────────

/**
 * Displays a subtle banner explaining the 🔍/✕ inference badges on player
 * seats.  Always rendered when inference mode is active (always for spectators).
 *
 * Must be rendered inside an `<InferenceProvider>`.
 * Reads `inferenceMode` from `useInferenceContext()` — for spectators this
 * is always `true`, but the conditional guard ensures the component is
 * future-proof if the mode could ever be off.
 */
function SpectatorInferenceBanner() {
  const { inferenceMode } = useInferenceContext();
  if (!inferenceMode) return null;
  return (
    <div
      className="relative z-10 flex items-center justify-center gap-1.5 px-4 py-1 bg-sky-950/60 border-b border-sky-800/30 text-[0.65rem] text-sky-400"
      aria-label="Inference mode active for spectators"
      data-testid="spectator-inference-banner"
    >
      <span aria-hidden="true">🔍</span>
      <span>Inference mode — 🔍 confirmed cards · ✕ excluded cards</span>
    </div>
  );
}

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

/**
 * SpectatorTimerBar — animated progress bar for the current turn timer.
 *
 * Identical to the player view's TurnTimerBar but always uses the neutral
 * (non-"my-timer") colour scheme since spectators have no personal turn.
 */
function SpectatorTimerBar({
  expiresAt,
  durationMs,
}: {
  expiresAt: number;
  durationMs: number;
}) {
  const [remaining, setRemaining] = useState<number>(() =>
    Math.max(0, expiresAt - Date.now())
  );

  useEffect(() => {
    const tick = () => {
      const r = Math.max(0, expiresAt - Date.now());
      setRemaining(r);
      if (r > 0) requestAnimationFrame(tick);
    };
    const raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [expiresAt]);

  const pct  = Math.min(100, (remaining / durationMs) * 100);
  const secs = Math.ceil(remaining / 1000);

  return (
    <div
      className="relative z-10 w-full h-1.5 bg-slate-800"
      role="timer"
      aria-label={`${secs}s remaining`}
      data-testid="spectator-timer-bar"
    >
      <div
        className={['h-full transition-none', pct < 25 ? 'bg-red-500' : 'bg-slate-500'].join(' ')}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/**
 * SpectatorPlayerRow — one team's player seats rendered as a horizontal row.
 *
 * Reads inference mode and card inference data from `useInferenceContext`
 * (provided by the wrapping `InferenceProvider` with `isSpectator=true`).
 * Each seat receives its player's inference data when inference mode is active
 * (always true for spectators), so `GamePlayerSeat` renders the 🔍/✕ badges.
 *
 * Spectators are always `myPlayerId=null` so the "You" pill is never shown.
 * Active-turn glow still animates based on `currentTurnPlayerId` matching.
 */
function SpectatorPlayerRow({
  players,
  currentTurnPlayerId,
  seatsPerTeam,
}: {
  players: GamePlayer[];
  currentTurnPlayerId: string | null;
  seatsPerTeam: number;
}) {
  const { inferenceMode, cardInferences } = useInferenceContext();
  const seats = Array.from({ length: seatsPerTeam }, (_, i) => players[i] ?? null);

  return (
    <div className="flex items-center justify-center gap-2 sm:gap-3 flex-wrap">
      {seats.map((player, i) => (
        <GamePlayerSeat
          key={player ? player.playerId : `empty-${i}`}
          seatIndex={player ? player.seatIndex : i}
          player={player}
          myPlayerId={null}
          currentTurnPlayerId={currentTurnPlayerId}
          // Pass inference data for each occupied seat when inference mode is on.
          // InferenceIndicator inside GamePlayerSeat only renders when the map
          // is non-empty, so passing an empty object {} is safe.
          inference={inferenceMode && player ? (cardInferences[player.playerId] ?? {}) : undefined}
        />
      ))}
    </div>
  );
}
