'use client';

/**
 * Game View — /game/[room-id]
 *
 * Full game interface with real-time card play, ask/declare flows,
 * turn indicators, score tracking, and bot support.
 *
 * Spectator support (Sub-AC 42c):
 *   When the WebSocket server sends `spectator_init` (i.e. the connecting
 *   client's bearer token is not mapped to any player in the game), this page
 *   automatically switches to the read-only `SpectatorView` component.  The
 *   detection is purely reactive: `myPlayerId` stays `null` while `players`
 *   becomes non-empty after `spectator_init` is received.
 *
 *   Spectators connect to /ws/game/<ROOMCODE>?token=<any-valid-bearer> — any
 *   guest or registered token works.  The backend classifies the connection as
 *   a spectator if the playerId is not in the game's player list.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { getRoomByCode, getGuestBearerToken, ApiError } from '@/lib/api';
import { getCachedToken } from '@/lib/backendSession';
import { useGuest } from '@/contexts/GuestContext';
import { useGameSocket } from '@/hooks/useGameSocket';
import { useAudio } from '@/hooks/useAudio';
import { useTurnIndicator } from '@/hooks/useTurnIndicator';
import { useCardInference } from '@/hooks/useCardInference';
import { useInference } from '@/hooks/useInference';
import { GameProvider } from '@/contexts/GameContext';
import CardHand from '@/components/CardHand';
import AskCardModal from '@/components/AskCardModal';
import CardRequestWizard from '@/components/CardRequestWizard';
import DeclareModal from '@/components/DeclareModal';
import FailedDeclarationReveal from '@/components/FailedDeclarationReveal';
import EliminationModal from '@/components/EliminationModal';
import DeclarationProgressBanner from '@/components/DeclarationProgressBanner';
import LastMoveDisplay from '@/components/LastMoveDisplay';
import GamePlayerSeat from '@/components/GamePlayerSeat';
import RematchVotePanel from '@/components/RematchVotePanel';
import GameOverScreen from '@/components/GameOverScreen';
import SpectatorView from '@/components/SpectatorView';
import DealAnimation from '@/components/DealAnimation';
import CardFlightAnimation from '@/components/CardFlightAnimation';
import CountdownTimer from '@/components/CountdownTimer';
import DeclarationTurnPassPrompt from '@/components/DeclarationTurnPassPrompt';
import DeclarationResultOverlay from '@/components/DeclarationResultOverlay';
import { ConnectedScoreboardPanel } from '@/components/ScoreboardPanel';
import MuteToggle from '@/components/MuteToggle';
import type { Room } from '@/types/room';
import type { CardId, HalfSuitId, GameOverPayload, RematchStartPayload } from '@/types/game';
import type { PlayerInference } from '@/hooks/useCardInference';

const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;

const VARIANT_LABELS: Record<string, string> = {
  remove_2s: 'Remove 2s',
  remove_7s: 'Remove 7s (Classic)',
  remove_8s: 'Remove 8s',
};

interface PageProps {
  params: Promise<{ 'room-id': string }>;
}

export default function GamePage({ params }: PageProps) {
  const router = useRouter();
  const { guestSession } = useGuest();

  const [roomCode, setRoomCode]           = useState<string | null>(null);
  const [room, setRoom]                   = useState<Room | null>(null);
  const [loading, setLoading]             = useState(true);
  const [invalidFormat, setInvalidFormat] = useState(false);
  const [notFound, setNotFound]           = useState(false);
  const [bearerToken, setBearerToken]     = useState<string | null>(null);

  const [selectedCard, setSelectedCard]   = useState<CardId | null>(null);
  const [showDeclare, setShowDeclare]     = useState(false);
  const [showAskWizard, setShowAskWizard] = useState(false);
  const [wizardInitialCard, setWizardInitialCard] = useState<CardId | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [gameOver, setGameOver]           = useState<GameOverPayload | null>(null);
  const [rematchStarted, setRematchStarted] = useState(false);
  const [voteStartedAt, setVoteStartedAt]   = useState<number | undefined>(undefined);
  const [lastResultMsg, setLastResultMsg] = useState<string | null>(null);
  const lastResultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Declaration result overlay (Sub-AC 26c) ────────────────────────────────
  //
  // Shown immediately after `declaration_result` arrives.  Auto-dismisses after
  // 3 seconds (with a visible countdown) or earlier if the player presses the
  // explicit "Dismiss" button.  On dismiss, `sendGameAdvance()` is called to
  // notify the server that the client is ready for the next turn.
  const [showDeclarationOverlay, setShowDeclarationOverlay] = useState(false);

  // ── Failed Declaration Reveal (Sub-AC 26b) ────────────────────────────────
  //
  // When declarationFailed arrives from the socket, the overlay is shown.
  // The player (or the auto-dismiss timer inside the component) can dismiss it
  // by setting failedRevealDismissed to true.  The flag resets automatically
  // when declarationFailed changes (new failed declaration in the same game).
  // NOTE: `declarationFailed` is destructured from useGameSocket below.
  // `showFailedReveal` is therefore computed after the useGameSocket call.
  const [failedRevealDismissed, setFailedRevealDismissed] = useState(false);

  // ── Score flash (Sub-AC 25b) ───────────────────────────────────────────────
  //
  // When a declaration_result arrives, briefly highlight the scoring team's
  // score in the header (1 | 2 | null). Cleared after 2 s.
  const [scoreFlash, setScoreFlash]         = useState<1 | 2 | null>(null);
  const scoreFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Deal animation (Sub-AC 10b) ────────────────────────────────────────────
  //
  // `isDealAnimating` controls the DealAnimation overlay.
  // `hasDealtRef` prevents the animation from re-firing on reconnect/refresh:
  //   only the first `game_init` that brings a non-empty hand triggers it.
  const [isDealAnimating, setIsDealAnimating]   = useState(false);
  const hasDealtRef                             = useRef(false);

  // ── Card flip animation (AC 33 Sub-AC 2) ─────────────────────────────────
  //
  // When a successful ask arrives and the current player is the ASKER
  // (i.e. they received the card), `newlyArrivedCardId` is set to that card's
  // ID so that `CardHand` can render it with a CardFlipWrapper (back → face
  // flip animation).  Cleared by `flipTimerRef` after 700 ms (animation
  // duration ~550 ms plus a small buffer).
  const [newlyArrivedCardId, setNewlyArrivedCardId] = useState<CardId | null>(null);
  const flipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Card flight animation (AC 33 Sub-AC 1) ─────────────────────────────────
  //
  // Triggered whenever a successful ask_card result arrives.
  // Stores the viewport-coordinate from/to centres of the two player seats so
  // that `CardFlightAnimation` can render a face-down card flying from the
  // card-giver (target) to the card-receiver (asker).
  //
  // Cleared (set to null) in the onComplete callback once the 600 ms animation
  // finishes, which unmounts the overlay.
  const [cardFlight, setCardFlight] = useState<{
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
  } | null>(null);

  useEffect(() => {
    params.then((resolved) => {
      const raw = resolved['room-id'];
      setRoomCode((raw ?? '').toUpperCase());
    });
  }, [params]);

  useEffect(() => {
    if (!roomCode) return;
    if (guestSession?.displayName) {
      const cached = getCachedToken(guestSession.displayName);
      if (cached) { setBearerToken(cached); return; }
      getGuestBearerToken(guestSession.displayName).then(setBearerToken).catch(() => {});
    }
  }, [roomCode, guestSession]);

  useEffect(() => {
    if (roomCode === null) return;
    if (!ROOM_CODE_RE.test(roomCode)) { setInvalidFormat(true); setLoading(false); return; }
    let cancelled = false;
    getRoomByCode(roomCode)
      .then(({ room: fetched }) => {
        if (cancelled) return;
        if (fetched.status === 'waiting' || fetched.status === 'starting') { router.replace(`/room/${fetched.code}`); return; }
        setRoom(fetched);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [roomCode, router]);

  const isGameActive = room?.status === 'in_progress' || room?.status === 'starting' || room?.status === 'completed';

  const {
    wsStatus, myPlayerId, myHand, players, gameState, variant, playerCount,
    lastAskResult, lastDeclareResult, declarationFailed, turnTimer, declarationTimer,
    botTakeover, rematchVote, rematchDeclined, roomDissolved,
    inferenceMode, sendAsk, sendDeclare, sendRematchVote, sendRematchInitiate, sendToggleInference,
    sendPartialSelection, sendDeclareProgress, sendDeclareSelecting, sendGameAdvance,
    declareProgress,
    eliminationPrompt, sendChooseTurnRecipient,
    eligibleNextTurnPlayerIds,
    postDeclarationHighlight, sendChooseNextTurn,
    postDeclarationTimer, pendingTurnPassAck,
    error: wsError,
  } = useGameSocket({
    roomCode: isGameActive ? roomCode : null,
    bearerToken,
    onGameOver: (payload) => {
      setGameOver(payload);
      setVoteStartedAt(Date.now());
    },
    onRematchStart: (_payload: RematchStartPayload) => {
      setRematchStarted(true);
    },
    onRematchStarting: (_payload) => {
      // Sub-AC 46c: new game spun up server-side with same teams/seats.
      // Clear post-game state so the upcoming game_init seamlessly transitions
      // into the new game without a page reload.
      setGameOver(null);
      setVoteStartedAt(undefined);
      setRematchStarted(false);
    },
  });

  // ── Sub-AC 45a: Host detection for private-room Rematch button ───────────
  //
  // Only registered users can be hosts (guests cannot create rooms).
  // A player is the host when:
  //   1. Their Supabase user ID matches the room's host_user_id.
  //   2. The room is NOT a matchmaking room (private rooms only).
  //
  // This flag gates the "🔄 Rematch" button shown only at game-end.
  // Guest-only mode: host detection not applicable (no Supabase user ID).
  const isHostOfPrivateRoom = false;

  // ── Failed Declaration Reveal visibility guard (Sub-AC 26b) ───────────────
  // Computed here — after useGameSocket — because it depends on `declarationFailed`
  // which is destructured from the hook above.
  const showFailedReveal = Boolean(declarationFailed && !failedRevealDismissed);

  // ── Audio sound callbacks ─────────────────────────────────────────────────
  //
  // `useAudio` provides stable callbacks for all game-event sound cues.
  // Called here (before the game-event effects below) so the callbacks are
  // in scope when the effects' dep arrays are evaluated.
  //
  // Mute is enforced inside audio.ts — the hook always delegates without
  // duplicating the guard.
  const {
    muted,
    toggleMute,
    playDealSound,
    playAskSuccess,
    playAskFail,
    playDeclarationSuccess,
    playDeclarationFail,
  } = useAudio();

  useEffect(() => {
    if (lastAskResult?.lastMove) {
      // ── Card flight animation: trigger on every successful transfer ──────
      // Query the DOM for both seat elements by their data-player-id attribute
      // BEFORE any state reset so the seat elements are still at their current
      // positions. On success the card flies from the target (giver) to the
      // asker (receiver).
      if (lastAskResult.success) {
        const fromEl = document.querySelector<HTMLElement>(
          `[data-player-id="${lastAskResult.targetId}"]`
        );
        const toEl = document.querySelector<HTMLElement>(
          `[data-player-id="${lastAskResult.askerId}"]`
        );
        if (fromEl && toEl) {
          const fromRect = fromEl.getBoundingClientRect();
          const toRect   = toEl.getBoundingClientRect();
          setCardFlight({
            fromX: fromRect.left + fromRect.width  / 2,
            fromY: fromRect.top  + fromRect.height / 2,
            toX:   toRect.left   + toRect.width    / 2,
            toY:   toRect.top    + toRect.height   / 2,
          });
        }

        // ── Card flip animation (Sub-AC 2 of AC 33) ────────────────────────
        // When the CURRENT PLAYER received the card (they were the asker),
        // trigger the flip animation so the newly arrived card reveals itself
        // by flipping from card-back to card-face in their hand.
        //
        // The flight animation (Sub-AC 1) ends at ~600 ms; the flip animation
        // starts immediately when the card appears in the hand (via hand_update
        // which arrives roughly simultaneously with ask_result).  The 700 ms
        // timer provides a small buffer past the 550 ms CSS animation duration.
        if (lastAskResult.askerId === myPlayerId) {
          if (flipTimerRef.current) clearTimeout(flipTimerRef.current);
          setNewlyArrivedCardId(lastAskResult.cardId);
          flipTimerRef.current = setTimeout(() => setNewlyArrivedCardId(null), 700);
        }
      }
      // ── Ask result sound: success vs failure ──────────────────────────
      if (lastAskResult.success) {
        playAskSuccess();
      } else {
        playAskFail();
      }
      setLastResultMsg(lastAskResult.lastMove);
      if (lastResultTimer.current) clearTimeout(lastResultTimer.current);
      lastResultTimer.current = setTimeout(() => setLastResultMsg(null), 5000);
      setActionLoading(false);
      setSelectedCard(null);
      setShowAskWizard(false);
      setWizardInitialCard(null);
    }
  }, [lastAskResult, myPlayerId, playAskSuccess, playAskFail]);

  useEffect(() => {
    if (lastDeclareResult?.lastMove) {
      // ── Declaration result sound: correct vs incorrect ───────────────────
      if (lastDeclareResult.correct) {
        playDeclarationSuccess();
      } else {
        playDeclarationFail();
      }

      setLastResultMsg(lastDeclareResult.lastMove);
      if (lastResultTimer.current) clearTimeout(lastResultTimer.current);
      lastResultTimer.current = setTimeout(() => setLastResultMsg(null), 5000);

      // ── Score flash: briefly highlight the team that just scored ─────────
      if (lastDeclareResult.winningTeam) {
        if (scoreFlashTimer.current) clearTimeout(scoreFlashTimer.current);
        setScoreFlash(lastDeclareResult.winningTeam);
        scoreFlashTimer.current = setTimeout(() => setScoreFlash(null), 2000);
      }

      // ── Declaration result overlay (Sub-AC 26c) ─────────────────────────
      // Show the overlay with a 3-second auto-dismiss countdown.
      // The overlay is closed by handleDeclarationOverlayDismiss which also
      // dispatches game_advance to the server.
      setShowDeclarationOverlay(true);

      setActionLoading(false);
      setShowDeclare(false);
      setSelectedCard(null);
    }
  }, [lastDeclareResult, playDeclarationSuccess, playDeclarationFail]);

  // ── Reset FailedDeclarationReveal dismissed flag on new failure (Sub-AC 26b) ─
  // When a fresh declarationFailed payload arrives (a new failed declaration
  // in the same game), re-show the overlay even if the player dismissed the
  // previous one.  The effect also covers the first arrival (null → payload).
  useEffect(() => {
    if (declarationFailed) {
      setFailedRevealDismissed(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [declarationFailed]);

  // ── Trigger deal animation on first game_init ─────────────────────────────
  //
  // Fire once when `myHand` first arrives with cards (i.e., the player just
  // received their dealt hand for the first time this session).  The
  // `hasDealtRef` guard prevents it from re-triggering on:
  //   • WebSocket reconnect (same session, hand already dealt)
  //   • Page refresh (new session, hasDealtRef resets to false — animation plays again,
  //     which is acceptable since the player sees their hand "arrive" on reconnect)
  useEffect(() => {
    if (myHand.length > 0 && !hasDealtRef.current) {
      hasDealtRef.current = true;
      setIsDealAnimating(true);
      // ── Deal sound: play once when cards first arrive ───────────────────
      playDealSound();
    }
  }, [myHand.length, playDealSound]);

  // Redirect to room lobby when rematch is accepted
  useEffect(() => {
    if (rematchStarted && roomCode) {
      router.replace(`/room/${roomCode}`);
    }
  }, [rematchStarted, roomCode, router]);

  // ── Client-side turn timer expiry guard ────────────────────────────────────
  //
  // When the server-side 30-second turn timer expires, the server auto-executes
  // a move (ask or declare) via bot logic and then sends `ask_result` or
  // `declaration_result`.  Those events are handled by the existing effects
  // above that close the modals via setSelectedCard(null) / setShowDeclare(false).
  //
  // However, there can be a brief gap (network latency + WS send queue) between
  // the server auto-move and the client receiving the result.  This effect
  // mirrors the server expiry on the client: once `turnTimer.expiresAt` passes
  // it proactively closes any open ask/declare modals and resets loading state,
  // so the UI feels instant even before the result arrives from the server.
  //
  // It does NOT send any message to the server — the server is authoritative.
  //
  // Keyed on `turnTimer?.expiresAt` so the timeout is correctly reset whenever
  // a new turn begins (i.e. when the server sends a new `turn_timer` event).
  useEffect(() => {
    if (!turnTimer) return;

    const remaining = Math.max(0, turnTimer.expiresAt - Date.now());

    const t = setTimeout(() => {
      setSelectedCard(null);
      setShowDeclare(false);
      setShowAskWizard(false);
      setWizardInitialCard(null);
      setActionLoading(false);
    }, remaining);

    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnTimer?.expiresAt]);

  const myPlayer          = players.find((p) => p.playerId === myPlayerId) ?? null;
  const myTeamId          = myPlayer?.teamId ?? null;
  const isMyTurn          = Boolean(myPlayerId && gameState?.currentTurnPlayerId === myPlayerId);

  // ── Inference mode (Sub-AC 37c) ───────────────────────────────────────────
  //
  // `inferenceMode` (from useGameSocket) is the authoritative shared flag,
  // synchronised across all connected clients via `inference_mode_changed`
  // broadcasts.  `sendToggleInference` (also from the socket) sends the
  // `toggle_inference` message to the server.
  //
  // `useCardInference` tracks per-card confirmed/excluded knowledge from
  // public ask/declare events.  `useInference` computes uniform-distribution
  // probability percentages based on current card counts.
  const { cardInferences, resetInferences } = useCardInference({
    lastAskResult,
    lastDeclareResult,
    variant,
  });

  // Clear ask/declare inference history on rematch.
  useEffect(() => {
    if (rematchStarted) resetInferences();
  }, [rematchStarted, resetInferences]);

  // Compute uniform-distribution probability percentages.
  // The toggle state comes from the socket (`inferenceMode`); `useInference`
  // only provides the computation helpers.
  const {
    getCardProbabilities,
    getPlayerSharePercent,
  } = useInference({
    myPlayerId,
    myHand,
    players,
    declaredSuits: gameState?.declaredSuits ?? [],
    variant,
  });

  // `useTurnIndicator` manages the glow + turn-start chime:
  //  • plays a single chime on the false → true transition (turn starts)
  //  • `clearIndicator()` immediately suppresses the glow when the player
  //    submits an ask or declaration
  const { indicatorActive, clearIndicator } = useTurnIndicator(isMyTurn ?? false);

  const currentTurnPlayer = gameState?.currentTurnPlayerId
    ? players.find((p) => p.playerId === gameState.currentTurnPlayerId)
    : null;
  const team1Players = players.filter((p) => p.teamId === 1);
  const team2Players = players.filter((p) => p.teamId === 2);

  // ── Sub-AC 28b: Post-declaration seat highlight ───────────────────────────
  //
  // After a correct declaration, `postDeclarationHighlight` carries the set of
  // same-team player IDs eligible to receive the turn.  All clients see the
  // cyan seat rings (informational); only the current turn player gets a click
  // handler to redirect the turn via `choose_next_turn`.
  const highlightedPlayerIds = postDeclarationHighlight
    ? new Set(postDeclarationHighlight.eligibleSameTeamIds)
    : undefined;

  // Only the current turn player (typically the declarant) can click a seat.
  // Other clients see the highlight as read-only visual feedback.
  const handleChooseNextTurnSeat = useCallback(
    (chosenPlayerId: string) => {
      sendChooseNextTurn(chosenPlayerId);
    },
    [sendChooseNextTurn],
  );

  // Pass the click handler only when: highlights are active AND the local
  // player is the one with the current turn (i.e., the declarant).
  const seatClickHandler =
    highlightedPlayerIds &&
    isMyTurn &&
    gameState?.currentTurnPlayerId === myPlayerId
      ? handleChooseNextTurnSeat
      : undefined;

  // ── Sub-AC 56c: Turn-pass mode ────────────────────────────────────────────
  //
  // `isTurnPassMode` is true when the local player is the current turn player
  // AND is in the post-declaration seat-selection window.  This covers two
  // sub-states:
  //   1. `postDeclarationHighlight !== null` — seats are highlighted, waiting
  //      for the player to tap one.
  //   2. `pendingTurnPassAck` — the player tapped a seat (highlight cleared
  //      optimistically) but the server's `post_declaration_turn_selected` ack
  //      hasn't arrived yet.
  //
  // While `isTurnPassMode` is true:
  //   • Ask and Declare buttons are hidden (replaced by a selection prompt).
  //   • The ask-prompt hint is suppressed.
  //   • The turn-indicator banner shows seat-selection guidance.
  const isTurnPassMode = isMyTurn && (postDeclarationHighlight !== null || pendingTurnPassAck);

  function handleAsk(targetId: string, cardId: CardId) {
    setActionLoading(true);
    // Immediately clear the turn indicator so the glow and audio repeat
    // stop as soon as the player submits — before the server responds.
    clearIndicator();
    sendAsk(targetId, cardId);
  }
  function handleDeclare(halfSuitId: HalfSuitId, assignment: Record<CardId, string>) {
    setActionLoading(true);
    clearIndicator();
    sendDeclare(halfSuitId, assignment);
  }

  // ── Declaration result overlay dismiss (Sub-AC 26c) ───────────────────────
  //
  // Called by DeclarationResultOverlay when the player presses "Dismiss" or
  // when the 3-second auto-dismiss countdown expires.
  // 1. Hides the overlay.
  // 2. Dispatches game_advance to the server so the next turn can proceed.
  const handleDeclarationOverlayDismiss = useCallback(() => {
    setShowDeclarationOverlay(false);
    sendGameAdvance();
  }, [sendGameAdvance]);

  const handleGoHome = useCallback(() => router.push('/'), [router]);

  if (invalidFormat) return <GameErrorView testId="invalid-format-view" emoji="🃏" title="Invalid Room Code" body={<>Invalid code: <span className="font-mono text-red-400">{roomCode}</span></>} onPrimary={handleGoHome} primaryLabel="Back to Home" />;
  if (loading) return <LoadingView />;
  if (notFound) return <GameErrorView testId="not-found-view" emoji="🔍" title="Room Not Found" body={<>No room <span className="font-mono text-emerald-400">{roomCode}</span> found.</>} onPrimary={handleGoHome} primaryLabel="Back to Home" />;
  if (!room) return <GameErrorView testId="generic-error-view" emoji="⚠️" title="Something Went Wrong" body="Could not load the game." onPrimary={handleGoHome} primaryLabel="Back to Home" />;
  if (room.status === 'cancelled') return <GameErrorView testId="cancelled-view" emoji="🚫" title="Game Cancelled" body={<>Room <span className="font-mono text-slate-300">{room.code}</span> was cancelled.</>} onPrimary={handleGoHome} primaryLabel="Back to Home" />;

  const finalGameOver = gameOver ?? (gameState?.status === 'completed' ? { type: 'game_over' as const, winner: gameState.winner ?? null, tiebreakerWinner: gameState.tiebreakerWinner ?? null, scores: gameState.scores } : null);

  if (finalGameOver || room.status === 'completed') {
    const { winner, scores, tiebreakerWinner } = finalGameOver ?? { winner: null as 1 | 2 | null, tiebreakerWinner: null as 1 | 2 | null, scores: { team1: 0, team2: 0 } };

    // Show a brief "Rematch starting…" overlay while redirect is in flight
    if (rematchStarted) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4 gap-4" data-testid="rematch-starting-view">
          <span className="text-4xl animate-bounce">🔄</span>
          <p className="text-xl font-bold text-white">Rematch starting…</p>
          <p className="text-sm text-slate-400">Starting the new game…</p>
        </div>
      );
    }

    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4 py-8 gap-6 overflow-y-auto"
        data-testid="game-completed-view"
      >
        {/* ── Game-over summary (Sub-AC 32d) ─────────────────────────────────
         *  Renders the winner announcement, final score, tiebreak reason (if
         *  applicable), and the full half-suit tally.  declaredSuits is drawn
         *  from the most-recent gameState snapshot so the tally is always
         *  complete when the game_over message arrives.
         */}
        <GameOverScreen
          winner={winner ?? null}
          tiebreakerWinner={tiebreakerWinner ?? null}
          scores={scores}
          declaredSuits={gameState?.declaredSuits ?? []}
          myTeamId={myTeamId}
          players={players}
          variant={VARIANT_LABELS[room.card_removal_variant]}
          roomCode={room.code}
          testId="game-over-screen"
        />

        {/* Room dissolved notice — shown when the server permanently closes the room.
         *  Takes priority over the vote panel; once dissolved the vote is moot.
         */}
        {roomDissolved ? (
          <div
            className="flex flex-col items-center gap-3 px-4 py-4 rounded-2xl border border-slate-700/60 bg-slate-800/70 backdrop-blur-sm w-full max-w-sm text-center"
            data-testid="room-dissolved-notice"
            role="status"
            aria-label="Room dissolved"
          >
            <span className="text-3xl" aria-hidden="true">🏚️</span>
            <p className="text-sm font-semibold text-slate-200">Room dissolved</p>
            <p className="text-xs text-slate-400">
              {roomDissolved.reason === 'timeout'
                ? 'The rematch vote timed out and the room has been closed.'
                : 'The majority voted no and the room has been closed.'}
            </p>
          </div>
        ) : (
          /* Rematch voting panel — only shown to actual players (not spectators) */
          myPlayerId && (rematchVote || rematchDeclined) && (
            <RematchVotePanel
              rematchVote={rematchVote}
              rematchDeclined={rematchDeclined}
              myPlayerId={myPlayerId}
              onVote={sendRematchVote}
              voteStartedAt={voteStartedAt}
            />
          )
        )}

        {/* ── Sub-AC 45a: Host Rematch button (private rooms only) ──────────────
         *  Visible only to the registered host of a non-matchmaking room.
         *  Clicking sends `rematch_initiate` to the server; the server validates
         *  host identity via DB lookup and broadcasts `rematch_start` to all
         *  clients, bypassing the vote window.
         *
         *  Not shown when roomDissolved is set (room is permanently closed) or
         *  when rematchStarted is true (redirect is already in flight).
         */}
        {isHostOfPrivateRoom && !roomDissolved && (
          <button
            onClick={() => roomCode && sendRematchInitiate(roomCode)}
            className="py-3 px-6 rounded-xl font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400"
            data-testid="host-rematch-button"
            aria-label="Initiate rematch as host"
          >
            🔄 Rematch
          </button>
        )}

        <button
          onClick={handleGoHome}
          className="py-3 px-6 rounded-xl font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400"
        >
          Back to Home
        </button>
      </div>
    );
  }

  // ── Spectator mode (Sub-AC 42c) ────────────────────────────────────────────
  //
  // When the WebSocket server sends `spectator_init` the hook populates
  // `players` but leaves `myPlayerId` as null.  We detect this combination
  // once the socket is connected AND players have been received: if players are
  // populated but the current client has no assigned player ID, we are a spectator.
  //
  // This must only trigger after `spectator_init` is actually received — NOT
  // during the initial connection phase when both players[] and myPlayerId are
  // still empty (that state is shared with legitimate players pre-game_init).
  const isSpectatorMode = wsStatus === 'connected' && players.length > 0 && !myPlayerId;

  if (isSpectatorMode && room) {
    return (
      <SpectatorView
        wsStatus={wsStatus}
        players={players}
        gameState={gameState}
        variant={variant}
        playerCount={playerCount}
        turnTimer={turnTimer}
        declarationTimer={declarationTimer}
        lastAskResult={lastAskResult}
        lastDeclareResult={lastDeclareResult}
        declareProgress={declareProgress ?? null}
        declarationFailed={declarationFailed}
        postDeclarationTimer={postDeclarationTimer}
        roomCode={room.code}
        cardRemovalVariant={room.card_removal_variant}
        gamePlayerCount={room.player_count}
        onGoHome={handleGoHome}
      />
    );
  }

  const effectiveVariant = variant ?? room.card_removal_variant;
  const effectivePlayerCount = playerCount ?? room.player_count;

  return (
    <GameProvider value={{
      wsStatus, myPlayerId, myHand, players, gameState, variant, playerCount,
      lastAskResult, lastDeclareResult, turnTimer, botTakeover, rematchVote, rematchDeclined,
      inferenceMode, sendAsk, sendDeclare, sendRematchVote, sendToggleInference,
      eligibleNextTurnPlayerIds,
      error: wsError,
    }}>
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 overflow-hidden" data-testid="game-view">
      <div className="pointer-events-none fixed inset-0 overflow-hidden opacity-5 select-none" aria-hidden="true">
        <span className="absolute text-[20rem] -top-16 -right-16 text-white">♦</span>
        <span className="absolute text-[14rem] bottom-0 -left-8 text-white">♣</span>
      </div>

      <header className="relative z-20 flex items-center justify-between px-3 py-2 border-b border-slate-700/50 bg-slate-900/70 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <button onClick={handleGoHome} aria-label="Home" className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-400">←</button>
          <span className="font-mono font-bold text-white text-sm" data-testid="game-room-code">{room.code}</span>
          <span className="text-xs text-slate-500 hidden sm:inline">{VARIANT_LABELS[room.card_removal_variant]} · {effectivePlayerCount === 6 ? '3v3' : '4v4'}</span>
        </div>
        <div className="flex items-center gap-2 text-sm font-semibold" aria-label="Score" data-testid="game-score">
          {/* Team 1 score — flashes yellow briefly after a declaration */}
          <span
            className={[
              'transition-colors duration-300',
              scoreFlash === 1
                ? 'text-yellow-300 scale-110'
                : myTeamId === 1 ? 'text-emerald-300' : 'text-slate-400',
            ].join(' ')}
            data-testid="score-team1"
          >
            T1 <span className="text-white text-base">{gameState?.scores.team1 ?? 0}</span>
          </span>
          <span className="text-slate-600">—</span>
          {/* Team 2 score — flashes yellow briefly after a declaration */}
          <span
            className={[
              'transition-colors duration-300',
              scoreFlash === 2
                ? 'text-yellow-300 scale-110'
                : myTeamId === 2 ? 'text-emerald-300' : 'text-slate-400',
            ].join(' ')}
            data-testid="score-team2"
          >
            <span className="text-white text-base">{gameState?.scores.team2 ?? 0}</span> T2
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Inference mode toggle — shows uniform-distribution probability badges */}
          <button
            onClick={sendToggleInference}
            aria-label={inferenceMode ? 'Disable inference mode' : 'Enable inference mode'}
            aria-pressed={inferenceMode}
            title={inferenceMode ? 'Inference mode: ON — click to disable' : 'Inference mode: OFF — click to enable probability hints'}
            className={[
              'transition-colors p-1 rounded-lg text-base leading-none',
              'focus:outline-none focus:ring-2 focus:ring-cyan-400',
              inferenceMode
                ? 'text-cyan-300 bg-cyan-900/40 ring-1 ring-cyan-700/50'
                : 'text-slate-400 hover:text-slate-200',
            ].join(' ')}
            data-testid="inference-toggle"
          >
            🔍
          </button>
          {/* Mute toggle — persists across page refreshes via localStorage */}
          <MuteToggle />
          <div className="flex items-center gap-1.5" title={`Connection: ${wsStatus}`} data-testid="ws-status-indicator">
            <span className={['w-2 h-2 rounded-full', wsStatus === 'connected' ? 'bg-emerald-400' : wsStatus === 'connecting' ? 'bg-yellow-400 animate-pulse' : wsStatus === 'error' ? 'bg-red-500' : 'bg-slate-600'].join(' ')} />
          </div>
        </div>
      </header>

      {gameState && (
        <div className={['relative z-10 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium', isMyTurn ? 'bg-emerald-700/60 text-emerald-100 border-b border-emerald-600/40' : 'bg-slate-800/50 text-slate-400 border-b border-slate-700/40'].join(' ')} role="status" aria-live="polite" data-testid="turn-indicator">
          {isMyTurn ? (
            isTurnPassMode ? (
              // Sub-AC 56c: turn-pass selection window — guide the declarant
              pendingTurnPassAck
                ? (<><span aria-hidden="true">⏳</span><span data-testid="turn-pass-pending-label">Choosing next turn…</span></>)
                : (<><span aria-hidden="true">👆</span><span data-testid="turn-pass-select-label">Tap a highlighted seat to choose who plays next</span></>)
            ) : (
              <><span aria-hidden="true">🎯</span><span>Your turn — ask for a card or declare</span></>
            )
          ) : currentTurnPlayer ? (<><span aria-hidden="true">⏳</span><span>Waiting for <strong>{currentTurnPlayer.displayName}</strong>{currentTurnPlayer.isBot && ' 🤖'}…</span></>) : (<span>Waiting for game to start…</span>)}
        </div>
      )}
      {turnTimer && gameState && (
        <CountdownTimer
          key={turnTimer.expiresAt}
          expiresAt={turnTimer.expiresAt}
          durationMs={turnTimer.durationMs}
          isMyTimer={turnTimer.playerId === myPlayerId}
          label={turnTimer.playerId === myPlayerId ? 'Your turn' : 'Turn timer'}
        />
      )}

      {/* ── Sub-AC 28c: Post-declaration turn-selection countdown ───────────
       *  Shown to ALL clients for 30 seconds after a human correct declaration
       *  while the declaring team chooses who takes the next turn.
       *  On expiry the server auto-selects a random eligible player.
       */}
      {postDeclarationTimer && gameState && (
        <CountdownTimer
          key={postDeclarationTimer.expiresAt}
          expiresAt={postDeclarationTimer.expiresAt}
          durationMs={postDeclarationTimer.durationMs}
          isMyTimer={
            postDeclarationTimer.eligiblePlayers.includes(myPlayerId ?? '') ||
            myPlayerId === postDeclarationTimer.declarerId
          }
          label="Choose next turn"
          data-testid="post-declaration-timer"
        />
      )}

      {/* ── Sub-AC 56b: Declaration turn-pass prompt ──────────────────────────
       *  Shown to ALL clients while `postDeclarationHighlight` is non-null —
       *  i.e. while the current turn player (the declarant) is choosing which
       *  eligible same-team player receives the next turn.
       *
       *  For the DECLARANT (isMyTurn): cyan banner with instruction to click a
       *  highlighted (cyan-ring) teammate seat.
       *
       *  For ALL OTHER PLAYERS: muted status strip showing the declarant's
       *  name so observers understand why some seats are glowing.
       *
       *  The prompt disappears (unmounts) as soon as `postDeclarationHighlight`
       *  is cleared, which happens when:
       *    a) The declarant clicks a highlighted seat → `sendChooseNextTurn`
       *       immediately sets `postDeclarationHighlight` to null (optimistic).
       *    b) The 30-second timer expires → server sends
       *       `post_declaration_turn_selected` → hook clears the highlight.
       *  In both cases the cyan seat rings disappear simultaneously with the
       *  prompt banner, fulfilling the "clearing highlights when the prompt is
       *  dismissed" requirement.
       */}
      {postDeclarationHighlight && gameState && (
        <DeclarationTurnPassPrompt
          isMyTurn={isMyTurn && gameState.currentTurnPlayerId === myPlayerId}
          chooserName={currentTurnPlayer?.displayName ?? null}
        />
      )}

      {/*
       * Bot-takeover banner (Sub-AC 2 of AC 39)
       *
       * Shown to ALL clients (including the timed-out player) when the server
       * broadcasts `bot_takeover` — indicating the human player's 30-second turn
       * timer expired and the bot is now executing their move automatically.
       *
       * Cleared automatically when the following `ask_result` or
       * `declaration_result` arrives (handled in useGameSocket).
       */}
      {botTakeover && (
        <div
          className="relative z-10 flex items-center justify-center gap-2 px-4 py-1.5 bg-orange-900/60 border-b border-orange-700/40 text-xs text-orange-200 animate-pulse"
          role="status"
          aria-live="polite"
          data-testid="bot-takeover-banner"
        >
          <span aria-hidden="true">🤖</span>
          <span>
            {botTakeover.playerId === myPlayerId
              ? 'Your turn timed out — bot is playing your move…'
              : `${players.find((p) => p.playerId === botTakeover.playerId)?.displayName ?? 'Player'}'s turn timed out — bot is playing their move…`}
          </span>
        </div>
      )}

      {/* ── Last-move display (AC 35) ─────────────────────────────────────────
       *  Shows only the single most-recent move (no running history per spec).
       *  The `lastResultMsg` (5-second flash) takes precedence over the
       *  persisted `gameState.lastMove` so fresh results are visible immediately.
       */}
      <LastMoveDisplay
        message={lastResultMsg ?? gameState?.lastMove}
        players={players}
        myPlayerId={myPlayerId}
      />

      {declareProgress && declareProgress.halfSuitId && declareProgress.declarerId !== myPlayerId && (
        <div className="relative z-10 px-4 py-2 border-b border-amber-800/40">
          <DeclarationProgressBanner
            progress={declareProgress}
            players={players}
            data-testid="declaration-progress-banner-strip"
          />
        </div>
      )}

      <main className="relative z-10 flex-1 flex flex-row items-start px-3 py-3 gap-3 min-h-0 overflow-hidden lg:items-stretch">

        {/*
         * Side scoreboard panel (Sub-AC 34a).
         *
         * Displays each team's name and current book count (0–8) with
         * per-team declared-suit badges.  Hidden on mobile (the compact
         * header score display serves mobile); shown as a fixed-width side
         * column on large screens (≥1024 px).  The `scoreFlash` prop drives
         * the yellow-highlight animation when a team just scored a book.
         */}
        <div className="hidden lg:flex flex-col w-48 xl:w-56 shrink-0 pt-1" data-testid="side-scoreboard-column">
          <ConnectedScoreboardPanel myTeamId={myTeamId} scoreFlash={scoreFlash} />
        </div>

        {/* ── Central game content ──────────────────────────────────────── */}
        <div className="flex flex-col flex-1 items-center justify-between gap-3 min-h-0 overflow-hidden lg:self-stretch lg:justify-center lg:gap-6 xl:gap-8">
          <div className="w-full max-w-2xl" aria-label="Team 2 players" data-testid="team2-row">
            <p className="text-center text-xs text-slate-500 uppercase tracking-widest mb-1">Team 2{myTeamId === 2 && <span className="ml-1 text-emerald-400">(You)</span>}</p>
            <PlayerRow
              players={team2Players}
              myPlayerId={myPlayerId}
              currentTurnPlayerId={gameState?.currentTurnPlayerId ?? null}
              playerCount={effectivePlayerCount}
              indicatorActive={indicatorActive}
              inferenceActive={inferenceMode}
              cardInferences={cardInferences}
              getPlayerSharePercent={getPlayerSharePercent}
              highlightedPlayerIds={highlightedPlayerIds}
              onSeatClick={seatClickHandler}
            />
          </div>

          <div className="relative flex items-center justify-center w-full max-w-xs" aria-hidden="true" data-testid="game-table-center">
            <div className="w-full aspect-[2/1] rounded-full border-2 border-emerald-800/50 bg-emerald-900/20 flex items-center justify-center shadow-inner shadow-black/40">
              <div className="text-center"><div className="text-2xl mb-0.5">🃏</div><p className="text-[10px] text-slate-500">{effectivePlayerCount === 6 ? '3v3' : '4v4'}</p></div>
            </div>
          </div>

          <div className="w-full max-w-2xl" aria-label="Team 1 players" data-testid="team1-row">
            <PlayerRow
              players={team1Players}
              myPlayerId={myPlayerId}
              currentTurnPlayerId={gameState?.currentTurnPlayerId ?? null}
              playerCount={effectivePlayerCount}
              indicatorActive={indicatorActive}
              inferenceActive={inferenceMode}
              cardInferences={cardInferences}
              getPlayerSharePercent={getPlayerSharePercent}
              highlightedPlayerIds={highlightedPlayerIds}
              onSeatClick={seatClickHandler}
            />
            <p className="text-center text-xs text-slate-500 uppercase tracking-widest mt-1">Team 1{myTeamId === 1 && <span className="ml-1 text-emerald-400">(You)</span>}</p>
          </div>
        </div>
      </main>

      {/*
       * Player hand area — ask/declare controls.
       *
       * These controls are gated exclusively on `isMyTurn` (derived from the
       * game socket's game_init / game_state messages).  They are completely
       * independent of matchmaking state: no matchmaking hook, context, or
       * status flag influences the enabled/disabled state of the Declare button
       * or card-selection interaction.  Ask / declare mode is always available
       * once game_init is received, regardless of player count (6 or 8) or
       * whether any seat is occupied by a bot.
       */}
      <footer className="relative z-20 border-t border-slate-700/50 bg-slate-900/80 backdrop-blur-sm px-3 py-3" data-testid="player-hand-area">
        {myPlayer ? (
          <div className="flex flex-col gap-2" data-testid="game-controls">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">Your hand — <strong className="text-white">{myHand.length}</strong> card{myHand.length !== 1 ? 's' : ''}</span>
              {/* Sub-AC 56c: during turn-pass mode the declarant must choose a
               *  teammate seat — Ask/Declare are hidden until the turn advances. */}
              {isMyTurn && !isTurnPassMode && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setShowAskWizard(true);
                      setWizardInitialCard(null);
                      setSelectedCard(null);
                      setShowDeclare(false);
                    }}
                    disabled={actionLoading}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:opacity-50"
                    aria-label="Ask an opponent for a card"
                    data-testid="ask-button"
                  >
                    Ask
                  </button>
                  <button
                    onClick={() => { setShowDeclare(true); setSelectedCard(null); setShowAskWizard(false); }}
                    disabled={actionLoading}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-violet-700 hover:bg-violet-600 text-white transition-colors focus:outline-none focus:ring-2 focus:ring-violet-400 disabled:opacity-50"
                    aria-label="Declare a half-suit"
                    data-testid="declare-button"
                  >
                    Declare
                  </button>
                </div>
              )}
              {/* Sub-AC 56c: seat-selection prompt — replaces Ask/Declare row
               *  while the declarant is choosing who gets the next turn.         */}
              {isTurnPassMode && (
                <span
                  className="text-xs text-cyan-300 font-medium animate-pulse"
                  data-testid="turn-pass-action-prompt"
                  aria-live="polite"
                >
                  {pendingTurnPassAck ? '⏳ Choosing…' : '👆 Tap a highlighted teammate seat above'}
                </span>
              )}
            </div>
            <CardHand
              hand={myHand}
              selectedCard={selectedCard}
              onSelectCard={isMyTurn && !isTurnPassMode ? (card) => {
                // Open the wizard at step 2 with the tapped card pre-selected
                setWizardInitialCard(card);
                setShowAskWizard(true);
                setSelectedCard(card);
                setShowDeclare(false);
              } : undefined}
              isMyTurn={isMyTurn}
              disabled={actionLoading || !isMyTurn || isTurnPassMode}
              variant={effectiveVariant}
              newlyArrivedCardId={newlyArrivedCardId}
            />
            {isMyTurn && !isTurnPassMode && !showAskWizard && !showDeclare && myHand.length > 0 && (
              <p className="text-xs text-slate-500 text-center animate-pulse" data-testid="ask-prompt">Tap a card or click Ask ↑ to ask, or click Declare ↑</p>
            )}
          </div>
        ) : (
          <div className="text-center text-xs text-slate-500 py-2" data-testid="spectator-status">
            {/*
             * Distinguish "truly spectating" (spectator_init was received so
             * players is populated but myPlayerId was never set) from
             * "still connecting / awaiting game_init".  This prevents the
             * "Watching as spectator" label from briefly flashing for
             * legitimate players who connected but haven't yet received
             * their personalised game_init message.
             */}
            {wsStatus === 'connected' && players.length > 0
              ? 'Watching as spectator'
              : (wsStatus === 'connected' || wsStatus === 'connecting')
              ? 'Connecting to game…'
              : wsStatus === 'error'
              ? `Connection error${wsError ? ': ' + wsError : ''} — refresh to retry`
              : 'Not connected to game server'}
          </div>
        )}
      </footer>

      {/* 3-step card request wizard — visible only to the active player (not during turn-pass) */}
      {showAskWizard && isMyTurn && !isTurnPassMode && (
        <CardRequestWizard
          myPlayerId={myPlayerId!}
          myHand={myHand}
          players={players}
          variant={effectiveVariant}
          declaredSuits={gameState?.declaredSuits ?? []}
          onConfirm={handleAsk}
          onCancel={() => {
            setShowAskWizard(false);
            setWizardInitialCard(null);
            setSelectedCard(null);
          }}
          isLoading={actionLoading}
          initialCard={wizardInitialCard ?? undefined}
          getCardProbabilities={inferenceMode ? getCardProbabilities : undefined}
          turnTimer={turnTimer}
          onPartialSelection={sendPartialSelection}
        />
      )}
      {/* Legacy single-step modal kept for backward-compat test coverage */}
      {selectedCard && !showAskWizard && isMyTurn && (
        <AskCardModal
          selectedCard={selectedCard}
          myPlayerId={myPlayerId!}
          players={players}
          variant={effectiveVariant}
          onConfirm={handleAsk}
          onCancel={() => setSelectedCard(null)}
          isLoading={actionLoading}
          getCardProbabilities={inferenceMode ? getCardProbabilities : undefined}
          turnTimer={turnTimer}
        />
      )}
      {showDeclare && isMyTurn && (
        <DeclareModal
          myPlayerId={myPlayerId!}
          myHand={myHand}
          players={players}
          variant={effectiveVariant}
          declaredSuits={gameState?.declaredSuits ?? []}
          onConfirm={handleDeclare}
          onCancel={() => {
            // Clear private server-side suit selection on modal close (Sub-AC 21a)
            sendDeclareSelecting(undefined);
            setShowDeclare(false);
          }}
          isLoading={actionLoading}
          getCardProbabilities={inferenceMode ? getCardProbabilities : undefined}
          turnTimer={turnTimer}
          onDeclareProgress={sendDeclareProgress}
          onSuitSelect={(id) => sendDeclareSelecting(id ?? undefined)}
        />
      )}
      {room.status === 'starting' && !gameState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" role="status" data-testid="starting-overlay">
          <div className="flex flex-col items-center gap-4 text-white">
            <svg className="animate-spin h-10 w-10 text-emerald-400" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" /></svg>
            <p className="text-lg font-semibold">Game starting…</p>
          </div>
        </div>
      )}

      {/* ── Deal animation overlay (Sub-AC 10b) ─────────────────────────── */}
      {isDealAnimating && (
        <DealAnimation
          playerCount={(effectivePlayerCount === 8 ? 8 : 6) as 6 | 8}
          onComplete={() => setIsDealAnimating(false)}
        />
      )}

      {/* ── Card flight animation overlay (AC 33 Sub-AC 1) ─────────────── */}
      {/* Renders a face-down card flying from the card-giver's seat to the  */}
      {/* card-receiver's seat after every successful ask_card result.       */}
      {cardFlight && (
        <CardFlightAnimation
          fromX={cardFlight.fromX}
          fromY={cardFlight.fromY}
          toX={cardFlight.toX}
          toY={cardFlight.toY}
          onComplete={() => setCardFlight(null)}
        />
      )}

      {/* ── Declaration result overlay (Sub-AC 26c) ─────────────────────── */}
      {/* Shown to all players immediately after declaration_result arrives. */}
      {/* Auto-dismisses after 3 s; explicit Dismiss button cancels early.   */}
      {/* On dismiss, dispatches game_advance to the server.                 */}
      {showDeclarationOverlay && lastDeclareResult && (
        <DeclarationResultOverlay
          result={lastDeclareResult}
          players={players}
          myTeamId={myTeamId}
          onDismiss={handleDeclarationOverlayDismiss}
        />
      )}
      {/* ── Failed Declaration Reveal overlay (Sub-AC 26b) ─────────────────
       *  Shown to ALL clients (players + spectators) when the server broadcasts
       *  a declarationFailed event (incorrect declaration only).  Displays each
       *  card in the half-suit with the claimed holder crossed out in red and
       *  the actual holder highlighted in green.
       *  Auto-dismisses after 6 seconds; player can also dismiss manually.
       */}
      {showFailedReveal && declarationFailed && (
        <FailedDeclarationReveal
          payload={declarationFailed}
          players={players}
          variant={effectiveVariant}
          onDismiss={() => setFailedRevealDismissed(true)}
        />
      )}

      {/* ── Elimination modal (Sub-AC 27b) ───────────────────────────────────
       *  Shown ONLY to the human player whose hand was just emptied by a
       *  declaration.  Prompts them to pick a teammate to receive future turns
       *  on their behalf.  The game continues regardless of this choice.
       */}
      {eliminationPrompt && (
        <EliminationModal
          prompt={eliminationPrompt}
          onChoose={sendChooseTurnRecipient}
        />
      )}
    </div>
    </GameProvider>
  );
}

/**
 * PlayerRow — renders one team's players as a row of GamePlayerSeat chips.
 *
 * Uses `GamePlayerSeat` for each slot so the richer avatar, BotBadge, turn
 * ring, and card-count badge are consistently applied in the game view.
 * Empty slots are represented by `null` entries.
 *
 * `indicatorActive` is forwarded as `isActiveTurn` exclusively for the
 * local player's own seat so the amber glow clears the moment they submit
 * an ask or declaration (before the server responds).  All other seats
 * derive their active-turn state from `currentTurnPlayerId` as normal.
 */
function PlayerRow({
  players,
  myPlayerId,
  currentTurnPlayerId,
  playerCount,
  indicatorActive,
  inferenceActive = false,
  cardInferences = {},
  getPlayerSharePercent,
  highlightedPlayerIds,
  onSeatClick,
}: {
  players: import('@/types/game').GamePlayer[];
  myPlayerId: string | null;
  currentTurnPlayerId: string | null;
  playerCount: number;
  /** Value from `useTurnIndicator` — drives the glow override for the local player's seat. */
  indicatorActive: boolean;
  /** When true, inference overlays are rendered on each seat. */
  inferenceActive?: boolean;
  /** Per-player ask/declare inference data (confirmed/excluded cards). */
  cardInferences?: Record<string, PlayerInference>;
  /** Returns uniform-distribution probability % for a player (or undefined if inactive). */
  getPlayerSharePercent?: (player: import('@/types/game').GamePlayer) => number;
  /**
   * Sub-AC 28b: Set of player IDs whose seats should show a cyan highlight
   * ring (eligible to receive the turn after a correct declaration).
   * When undefined, no seats are highlighted.
   */
  highlightedPlayerIds?: Set<string>;
  /**
   * Sub-AC 28b: Called when the local player clicks a highlighted seat.
   * Receives the playerId of the tapped seat.  Only provided to the
   * current turn player (the declarant); other players pass undefined.
   */
  onSeatClick?: (playerId: string) => void;
}) {
  const seatsPerTeam = Math.floor(playerCount / 2);
  const seats = Array.from({ length: seatsPerTeam }, (_, i) => players[i] ?? null);
  return (
    <div className="flex items-center justify-center gap-2 sm:gap-3 flex-wrap">
      {seats.map((player, i) => {
        // Per-player inference data — only passed when inference mode is active
        const playerInference = (inferenceActive && player)
          ? (cardInferences[player.playerId] ?? {})
          : undefined;
        // Uniform distribution share % — only for opponents (not local player)
        const sharePercent = (inferenceActive && player && getPlayerSharePercent)
          ? getPlayerSharePercent(player)
          : undefined;

        // Sub-AC 28b: determine whether this seat should glow cyan
        const isHl = Boolean(player && highlightedPlayerIds?.has(player.playerId));

        return (
          <GamePlayerSeat
            key={player ? player.playerId : `empty-${i}`}
            seatIndex={player ? player.seatIndex : i}
            player={player}
            myPlayerId={myPlayerId}
            currentTurnPlayerId={currentTurnPlayerId}
            // For the local player's own seat: use indicatorActive so the glow
            // clears immediately on action submit (before server round-trip).
            // For all other seats: undefined → seat derives from currentTurnPlayerId.
            isActiveTurn={player?.playerId === myPlayerId ? indicatorActive : undefined}
            inference={playerInference}
            inferencePercent={sharePercent}
            // Sub-AC 28b: highlight eligible seats and wire click handler
            isHighlighted={isHl}
            onHighlightClick={
              isHl && onSeatClick && player
                ? () => onSeatClick(player.playerId)
                : undefined
            }
          />
        );
      })}
    </div>
  );
}

function LoadingView() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950" data-testid="game-loading">
      <div className="flex flex-col items-center gap-4 text-slate-400">
        <svg className="animate-spin h-8 w-8 text-emerald-500" viewBox="0 0 24 24" fill="none" aria-label="Loading game…"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" /></svg>
        <span className="text-sm">Loading game…</span>
      </div>
    </div>
  );
}

function GameErrorView({ emoji, title, body, onPrimary, primaryLabel, testId }: { emoji: string; title: string; body: React.ReactNode; onPrimary: () => void; primaryLabel: string; testId?: string; }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4 gap-6" data-testid={testId}>
      <div className="text-center max-w-sm"><div className="text-5xl mb-4">{emoji}</div><h1 className="text-2xl font-bold text-white mb-3">{title}</h1><p className="text-slate-300 text-sm">{body}</p></div>
      <button onClick={onPrimary} className="py-3 px-6 rounded-xl font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400">{primaryLabel}</button>
    </div>
  );
}
