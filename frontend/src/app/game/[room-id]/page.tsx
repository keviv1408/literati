'use client';

/**
 * Game View — /game/[room-id]
 *
 * Full game interface with real-time card play, ask/declare flows,
 * turn indicators, score tracking, and bot support.
 *
 * Spectator support:
 * When the WebSocket server sends `spectator_init` (i.e. the connecting
 * client's bearer token is not mapped to any player in the game), this page
 * automatically switches to the read-only `SpectatorView` component. The
 * detection is purely reactive: `myPlayerId` stays `null` while `players`
 * becomes non-empty after `spectator_init` is received.
 *
 * Spectators connect to /ws/game/<ROOMCODE>?token=<any-valid-bearer> — any
 * guest or registered token works. The backend classifies the connection as
 * a spectator if the playerId is not in the game's player list.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getRoomByCode, getGameSummary, ApiError } from '@/lib/api';
import { backoffDelayMs, retryWithBackoff } from '@/lib/backoff';
import { advanceAskMoveBatch, buildAskMoveSummaryMessage, type AskMoveBatch } from '@/lib/askMoveSummary';
import { loadRoomMembership, saveRoomMembership } from '@/lib/roomMembership';
import { useGuest } from '@/contexts/GuestContext';
import { useCardDeck } from '@/hooks/useCardDeck';
import { useReconnect } from '@/hooks/useReconnect';
import { useGameSocket, type PartialSelectionPayload } from '@/hooks/useGameSocket';
import { useAudio } from '@/hooks/useAudio';
import { useTurnIndicator } from '@/hooks/useTurnIndicator';
import { GameProvider } from '@/contexts/GameContext';
import { VoiceProvider } from '@/contexts/VoiceContext';
import CardHand from '@/components/CardHand';
import PlayingCard from '@/components/PlayingCard';
import InlineAskTray, { getAvailableAskHalfSuits } from '@/components/InlineAskTray';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  pointerWithin,
} from '@dnd-kit/core';
import { DeclareDropSeat } from '@/components/InlineDeclare';
import InlineDeclareTray from '@/components/InlineDeclareTray';
import DeclarationProgressBanner from '@/components/DeclarationProgressBanner';
import LastMoveDisplay from '@/components/LastMoveDisplay';
import DeclarationCardReveal from '@/components/DeclarationCardReveal';
import CircularGameTable from '@/components/CircularGameTable';
import RematchVotePanel from '@/components/RematchVotePanel';
import ReconnectBar from '@/components/ReconnectBar';
import GameOverScreen from '@/components/GameOverScreen';
import SpectatorView from '@/components/SpectatorView';
import { takeOpeningDeal } from '@/lib/openingDeal';
import CardFlightAnimation from '@/components/CardFlightAnimation';
import AskDeniedAnimation from '@/components/AskDeniedAnimation';
import AskSpeechBubbleOverlay from '@/components/AskSpeechBubbleOverlay';
import DeclaredBooksTable from '@/components/DeclaredBooksTable';
import CountdownTimer from '@/components/CountdownTimer';
import DeclarationTurnPassPrompt from '@/components/DeclarationTurnPassPrompt';
import GameHeader from '@/components/GameHeader';
import ActionModeToggle from '@/components/ActionModeToggle';
import VoiceAudioLayer from '@/components/VoiceAudioLayer';
import { useAskResultAnimations } from '@/hooks/useAskResultAnimations';
import { useReactionBubble } from '@/hooks/useReactionBubble';
import type { Room } from '@/types/room';
import { cardLabel, getCardHalfSuit, getHalfSuitCards, halfSuitLabel } from '@/types/game';
import type { CardId, HalfSuitId, GameOverPayload, GameSummaryResponse, DeclaredSuit } from '@/types/game';

const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;
// apiFetch has no deadline, so a stalled request would otherwise hold up the retries.
const _ROOM_LOAD_ATTEMPT_MS = 15_000;
const _SERVER_UNREACHABLE_MS = 60_000;

const VARIANT_LABELS: Record<string, string> = {
  remove_2s: 'Remove 2s',
  remove_7s: 'Remove 7s (Classic)',
  remove_8s: 'Remove 8s',
};

interface PageProps {
  params: Promise<{ 'room-id': string }>;
}

interface PendingAskBatch {
  targetPlayerId: string;
  requestedCardIds: CardId[];
  successfulCardIds: CardId[];
  deniedCardIds: CardId[];
  remainingCardIds: CardId[];
  awaitingResultFor: CardId | null;
  waitingForStateSync: boolean;
  lastKnownTargetCardCount: number;
}

function formatNaturalList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function _askPartial(halfSuitId: HalfSuitId, cardIds: CardId[]): PartialSelectionPayload {
  const cardId = cardIds[cardIds.length - 1];
  return cardId ? { flow: 'ask', halfSuitId, cardId } : { flow: 'ask', halfSuitId };
}

function buildAskBatchSummary(
  batch: PendingAskBatch,
  askerName: string,
  targetName: string,
): string | null {
  const successfulIds = new Set(batch.successfulCardIds);
  const deniedIds = new Set(batch.deniedCardIds);
  const attemptedCardIds = batch.requestedCardIds.filter(
    (cardId) => successfulIds.has(cardId) || deniedIds.has(cardId),
  );

  if (attemptedCardIds.length <= 1) return null;

  const attemptedLabels = attemptedCardIds.map((cardId) => cardLabel(cardId));
  const successfulLabels = attemptedCardIds
    .filter((cardId) => successfulIds.has(cardId))
    .map((cardId) => cardLabel(cardId));
  const deniedLabels = attemptedCardIds
    .filter((cardId) => deniedIds.has(cardId))
    .map((cardId) => cardLabel(cardId));

  if (deniedLabels.length === 0) {
    return `${askerName} asked ${targetName} for ${formatNaturalList(attemptedLabels)} — got them`;
  }

  if (successfulLabels.length === 0) {
    return `${askerName} asked ${targetName} for ${formatNaturalList(attemptedLabels)} — denied`;
  }

  return `${askerName} asked ${targetName} for ${formatNaturalList(attemptedLabels)} — got ${formatNaturalList(successfulLabels)}; denied ${formatNaturalList(deniedLabels)}`;
}

export default function GamePage({ params }: PageProps) {
  const canShowCards = useCardDeck();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { guestSession } = useGuest();
  const { status: reconnectStatus, bearerToken: reconnectBearerToken, isGuest, retry: retrySession } = useReconnect();
  const sessionRetriesRef = useRef(0);

  // Only from error: a retry from any other state would drop the game token and close the socket.
  useEffect(() => {
    if (reconnectStatus === 'ready') sessionRetriesRef.current = 0;
    if (reconnectStatus !== 'error') return;
    const timer = setTimeout(() => {
      sessionRetriesRef.current += 1;
      retrySession();
    }, backoffDelayMs(sessionRetriesRef.current));
    return () => clearTimeout(timer);
  }, [reconnectStatus, retrySession]);

  const [roomCode, setRoomCode]           = useState<string | null>(null);
  const [room, setRoom]                   = useState<Room | null>(null);
  const [loading, setLoading]             = useState(true);
  const [roomRetrying, setRoomRetrying]   = useState(false);
  const [serverUnreachable, setServerUnreachable] = useState(false);
  const [invalidFormat, setInvalidFormat] = useState(false);
  const [notFound, setNotFound]           = useState(false);
  const [gameBearerToken, setGameBearerToken] = useState<string | null>(null);
  const spectatorToken                    = searchParams.get('spectatorToken');

  // Prefer the room-specific token that originally joined this game.
  // This prevents refresh from drifting to a new backend identity.
  useEffect(() => {
    if (!roomCode || reconnectStatus !== 'ready') {
      setGameBearerToken(null);
      return;
    }

    const membership = loadRoomMembership(roomCode);
    if (membership?.bearerToken) {
      setGameBearerToken(membership.bearerToken);
      return;
    }

    setGameBearerToken(reconnectBearerToken);
  }, [roomCode, reconnectStatus, reconnectBearerToken]);

  const [declareMode, setDeclareMode]     = useState(false);
  const [declareSelectedSuit, setDeclareSelectedSuit] = useState<HalfSuitId | null>(null);
  const [declareAssignment, setDeclareAssignment] = useState<Record<CardId, string>>({});
  const [declareActiveDragId, setDeclareActiveDragId] = useState<string | null>(null);
  const [declareSelectedCard, setDeclareSelectedCard] = useState<CardId | null>(null);
  const declareTrayRef = useRef<HTMLDivElement | null>(null);
  const [showAskInline, setShowAskInline] = useState(false);
  const askTrayRef = useRef<HTMLDivElement | null>(null);
  const [selectedAskHalfSuit, setSelectedAskHalfSuit] = useState<HalfSuitId | null>(null);
  const [selectedAskCardIds, setSelectedAskCardIds] = useState<CardId[]>([]);
  const [actionLoading, setActionLoading] = useState(false);
  const [pendingAskBatch, setPendingAskBatch] = useState<PendingAskBatch | null>(null);
  const pendingAskBatchRef = useRef<PendingAskBatch | null>(null);
  const observedAskBatchRef = useRef<AskMoveBatch | null>(null);
  const processedAskResultKeyRef = useRef<string | null>(null);
  const [gameOver, setGameOver]           = useState<GameOverPayload | null>(null);
  const [gameSummary, setGameSummary]     = useState<GameSummaryResponse | null>(null);
  const [rematchStarted, setRematchStarted] = useState(false);
  const [voteStartedAt, setVoteStartedAt]   = useState<number | undefined>(undefined);
  const [lastResultMsg, setLastResultMsg] = useState<string | null>(null);
  const [syntheticLastMoveMsg, setSyntheticLastMoveMsg] = useState<string | null>(null);
  const lastResultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Score flash ───────────────────────────────────────────────
  //
  // When a declaration_result arrives, briefly highlight the scoring team's
  // score in the header (1 | 2 | null). Cleared after 2 s.

  const [isDealAnimating, setIsDealAnimating] = useState(false);
  const finishOpeningDeal = useCallback(() => setIsDealAnimating(false), []);

  // ── Card flip animation (AC 33) ─────────────────────────────────
  //
  // When a successful ask arrives and the current player is the ASKER
  // (i.e. they received the card), `newlyArrivedCardId` is set to that card's
  // ID so that `CardHand` can render it with a CardFlipWrapper (back → face
  // flip animation). Cleared by `flipTimerRef` after 700 ms (animation
  // duration ~550 ms plus a small buffer).
  const [newlyArrivedCardId, setNewlyArrivedCardId] = useState<CardId | null>(null);
  const flipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    params.then((resolved) => {
      const raw = resolved['room-id'];
      setRoomCode((raw ?? '').toUpperCase());
    });
  }, [params]);

  useEffect(() => {
    if (roomCode === null) return;
    if (!ROOM_CODE_RE.test(roomCode)) { setInvalidFormat(true); setLoading(false); return; }
    let attempt = 0;
    const unreachableTimer = setTimeout(() => setServerUnreachable(true), _SERVER_UNREACHABLE_MS);
    const cancel = retryWithBackoff(async (signal) => {
      attempt += 1;
      if (attempt > 1) setRoomRetrying(true);
      try {
        const { room: fetched } = await getRoomByCode(roomCode, signal);
        if (signal.aborted) return false;
        clearTimeout(unreachableTimer);
        if (fetched.status === 'waiting' || fetched.status === 'starting') { router.replace(`/room/${fetched.code}`); return true; }
        setRoom(fetched);
        setLoading(false);
        return true;
      } catch (err: unknown) {
        if (signal.aborted || !(err instanceof ApiError && err.status === 404)) return false;
        clearTimeout(unreachableTimer);
        setNotFound(true);
        setLoading(false);
        return true;
      }
    }, { attemptTimeoutMs: _ROOM_LOAD_ATTEMPT_MS });
    return () => {
      cancel();
      clearTimeout(unreachableTimer);
    };
  }, [roomCode, router]);

  useEffect(() => {
    setGameSummary(null);
    setSyntheticLastMoveMsg(null);
    observedAskBatchRef.current = null;
    processedAskResultKeyRef.current = null;
  }, [roomCode]);

  const isGameActive = room?.status === 'in_progress' || room?.status === 'starting' || room?.status === 'completed';

  // A new game spun up server-side with the same seats, so its game_init takes over without a reload.
  function clearPostGameState() {
    setGameOver(null);
    setGameSummary(null);
    setVoteStartedAt(undefined);
    setRematchStarted(false);
    setRoom((prev) => prev ? { ...prev, status: 'in_progress' } : prev);
    setIsDealAnimating(false);
  }

  const {
    wsStatus, myPlayerId, myHand, spectatorHands, spectatorMoveHistory, askHistory, players, gameState, variant, playerCount,
    lastAskResult, lastDeclareResult, declarationReveal, turnTimer, declarationTimer,
    botTakeover, reclaimQueued, rematchVote, rematchDeclined, roomDissolved,
    sendAsk, sendDeclare, sendRematchVote, sendRematchInitiate,
    sendPartialSelection, sendDeclareProgress, sendDeclareSelecting,
    declareProgress,
    eligibleNextTurnPlayerIds,
    postDeclarationHighlight, sendChooseNextTurn, sendBotSpeed,
    postDeclarationTimer, pendingTurnPassAck,
    retryNow,
    error: wsError,
  } = useGameSocket({
    roomCode: isGameActive ? roomCode : null,
    bearerToken: gameBearerToken,
    guestRecoveryKey: guestSession?.sessionId ?? null,
    spectatorToken,
    onGameOver: (payload) => {
      setGameOver(payload);
      setVoteStartedAt(Date.now());
    },
    onRematchStart: () => {
      setRematchStarted(true);
    },
    onRematchStarting: clearPostGameState,
    onGameInit: (status) => {
      // A client that was away for rematch_starting learns of the rematch from this init alone.
      if (status === 'active' && (gameOver || gameSummary || room?.status === 'completed')) clearPostGameState();
    },
  });

  const canSend = wsStatus === 'connected';

  // Persist the exact token that was accepted by the game WS server.
  // On refresh this lets us reconnect as the same player identity.
  useEffect(() => {
    if (!roomCode || !myPlayerId || !gameBearerToken) return;
    saveRoomMembership(roomCode, gameBearerToken, myPlayerId, 'player');
  }, [roomCode, myPlayerId, gameBearerToken]);

  // ── Host detection for private-room Rematch button ───────────
  //
  // Only registered users can be hosts (guests cannot create rooms).
  // A player is the host when:
  // 1. Their Supabase user ID matches the room's host_user_id.
  // 2. The room is NOT a matchmaking room (private rooms only).
  //
  // This flag gates the "🔄 Rematch" button shown only at game-end.
  // Guest-only mode: host detection not applicable (no Supabase user ID).
  const isHostOfPrivateRoom = false;

  const shouldLoadGameSummary = Boolean(
    roomCode &&
    (room?.status === 'completed' || gameState?.status === 'completed' || gameOver),
  );

  useEffect(() => {
    if (!roomCode || !shouldLoadGameSummary) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const loadSummary = async () => {
      attempt += 1;
      try {
        const summary = await getGameSummary(roomCode);
        if (!cancelled) {
          setGameSummary(summary);
        }
      } catch {
        if (cancelled || attempt >= 5) return;
        retryTimer = setTimeout(loadSummary, attempt === 1 ? 300 : 1000);
      }
    };

    loadSummary();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [roomCode, shouldLoadGameSummary]);

  // ── Audio sound callbacks ─────────────────────────────────────────────────
  //
  // `useAudio` provides stable callbacks for all game-event sound cues.
  // Called here (before the game-event effects below) so the callbacks are
  // in scope when the effects' dep arrays are evaluated.
  const {
    muted,
    toggleMute,
    preload,
    playDealSound,
    playAskSuccess,
    playAskFail,
    playDeclarationSuccess,
    playDeclarationFail,
  } = useAudio();

  const getAskBubbleCardIds = useCallback((result: { targetId: string; cardId: CardId }) => {
    const activeBatch = pendingAskBatchRef.current;
    if (
      !activeBatch ||
      activeBatch.targetPlayerId !== result.targetId ||
      activeBatch.awaitingResultFor !== result.cardId
    ) {
      return undefined;
    }

    return activeBatch.requestedCardIds;
  }, []);

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
    getAskBubbleCardIds,
    getPlayerDisplayName,
  });
  const reactionBubble = useReactionBubble(lastAskResult, lastDeclareResult, players);
  const speechBubble = reactionBubble ?? askSpeechBubble;

  const publishMoveMessage = useCallback((message: string, persistentMessage: string | null = null) => {
    setLastResultMsg(message);
    setSyntheticLastMoveMsg(persistentMessage);
    if (lastResultTimer.current) clearTimeout(lastResultTimer.current);
    lastResultTimer.current = setTimeout(() => setLastResultMsg(null), 5000);
  }, []);

  const updatePendingAskBatch = useCallback((nextBatch: PendingAskBatch | null) => {
    pendingAskBatchRef.current = nextBatch;
    setPendingAskBatch(nextBatch);
  }, []);

  useEffect(() => {
    // The hook nulls the result on a reconnect, so an identical next result is a new ask, not a replay.
    if (!lastAskResult) processedAskResultKeyRef.current = null;
    if (lastAskResult?.lastMove) {
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

      if (lastAskResult.success) {
        // ── Card flip animation ────────────────────────
        // When the CURRENT PLAYER received the card (they were the asker),
        // trigger the flip animation so the newly arrived card reveals itself
        // by flipping from card-back to card-face in their hand.
        //
        // The flight animation ends at ~1.5 s; the flip animation
        // starts immediately when the card appears in the hand (via hand_update
        // which arrives roughly simultaneously with ask_result). The 700 ms
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
      const observedBatch = advanceAskMoveBatch(observedAskBatchRef.current, lastAskResult);
      observedAskBatchRef.current = observedBatch;
      const observedAskerName =
        players.find((player) => player.playerId === lastAskResult.askerId)?.displayName ?? 'Player';
      const observedTargetName =
        players.find((player) => player.playerId === lastAskResult.targetId)?.displayName ?? 'Player';
      const observedSummaryMessage = buildAskMoveSummaryMessage(
        observedBatch,
        lastAskResult,
        observedAskerName,
        observedTargetName,
      );
      setSelectedAskCardIds([]);
      setSelectedAskHalfSuit(null);
      setShowAskInline(false);

      const activeBatch = pendingAskBatchRef.current;
      const isMatchingBatch = Boolean(
        activeBatch &&
        lastAskResult.askerId === myPlayerId &&
        lastAskResult.targetId === activeBatch.targetPlayerId &&
        lastAskResult.cardId === activeBatch.awaitingResultFor,
      );

      if (!isMatchingBatch || !activeBatch) {
        publishMoveMessage(
          observedSummaryMessage ?? lastAskResult.lastMove,
          observedSummaryMessage ?? null,
        );
        updatePendingAskBatch(null);
        setActionLoading(false);
        return;
      }

      const nextBatch: PendingAskBatch = {
        ...activeBatch,
        successfulCardIds: lastAskResult.success
          ? [...activeBatch.successfulCardIds, lastAskResult.cardId]
          : activeBatch.successfulCardIds,
        deniedCardIds: lastAskResult.success
          ? activeBatch.deniedCardIds
          : [...activeBatch.deniedCardIds, lastAskResult.cardId],
      };

      const shouldContinue =
        lastAskResult.success &&
        lastAskResult.newTurnPlayerId === myPlayerId &&
        activeBatch.remainingCardIds.length > 0;

      if (shouldContinue) {
        publishMoveMessage(
          observedSummaryMessage ?? lastAskResult.lastMove,
          observedSummaryMessage ?? null,
        );
        updatePendingAskBatch({
          ...nextBatch,
          awaitingResultFor: null,
          waitingForStateSync: true,
          lastKnownTargetCardCount: Math.max(0, activeBatch.lastKnownTargetCardCount - 1),
        });
        return;
      }

      const askerName =
        players.find((player) => player.playerId === lastAskResult.askerId)?.displayName ?? 'Player';
      const targetName =
        players.find((player) => player.playerId === lastAskResult.targetId)?.displayName ?? 'Player';
      const summaryMessage = buildAskBatchSummary(nextBatch, askerName, targetName);

      publishMoveMessage(
        observedSummaryMessage ?? summaryMessage ?? lastAskResult.lastMove,
        observedSummaryMessage ?? summaryMessage ?? null,
      );
      updatePendingAskBatch(null);
      setActionLoading(false);
    }
  }, [lastAskResult, myPlayerId, playAskSuccess, playAskFail, players, publishMoveMessage, updatePendingAskBatch]);

  useEffect(() => {
    if (lastDeclareResult?.lastMove) {
      observedAskBatchRef.current = null;
      // ── Declaration result sound: correct vs incorrect ───────────────────
      if (lastDeclareResult.correct) {
        playDeclarationSuccess();
      } else {
        playDeclarationFail();
      }

      publishMoveMessage(lastDeclareResult.lastMove, null);

      updatePendingAskBatch(null);
      setActionLoading(false);
      setDeclareMode(false);
      setDeclareSelectedSuit(null);
      setDeclareAssignment({});
      setDeclareActiveDragId(null);
      setDeclareSelectedCard(null);
      setSelectedAskCardIds([]);
      setSelectedAskHalfSuit(null);
      setShowAskInline(false);
    }
  }, [lastDeclareResult, playDeclarationSuccess, playDeclarationFail, publishMoveMessage, updatePendingAskBatch]);

  useEffect(() => {
    if (!roomCode || !canShowCards || !myPlayerId || !myHand.length || !takeOpeningDeal(roomCode)) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    setIsDealAnimating(true);
    playDealSound();
  }, [roomCode, canShowCards, myPlayerId, myHand.length, playDealSound]);

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
  // `declaration_result`. Those events are handled by the existing effects
  // above that close the modals via setSelectedCard(null) / setDeclareMode(false).
  //
  // However, there can be a brief gap (network latency + WS send queue) between
  // the server auto-move and the client receiving the result. This effect
  // mirrors the server expiry on the client: once `turnTimer.expiresAt` passes
  // it proactively closes any open ask/declare modals and resets loading state,
  // so the UI feels instant even before the result arrives from the server.
  //
  // It does NOT send any message to the server — the server is authoritative.
  //
  // Keyed on `turnTimer?.expiresAt` so the timeout is correctly reset whenever
  // a new turn begins (i.e. when the server sends a new `turn_timer` event).
  useEffect(() => {
    // A backend restart gives the turn a fresh deadline, so the old one must not close trays during a drop.
    if (!turnTimer || !canSend) return;

    const remaining = Math.max(0, turnTimer.expiresAt - Date.now());

    const t = setTimeout(() => {
      setSelectedAskCardIds([]);
      setSelectedAskHalfSuit(null);
      setDeclareMode(false);
      setDeclareSelectedSuit(null);
      setDeclareAssignment({});
      setDeclareActiveDragId(null);
      setDeclareSelectedCard(null);
      setShowAskInline(false);
      updatePendingAskBatch(null);
      setActionLoading(false);
    }, remaining);

    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnTimer?.expiresAt, canSend]);

  const myPlayer          = players.find((p) => p.playerId === myPlayerId) ?? null;
  const myTeamId          = myPlayer?.teamId ?? null;
  const isMyTurn          = Boolean(myPlayerId && gameState?.currentTurnPlayerId === myPlayerId);

  // `useTurnIndicator` manages the glow + turn-start chime:
  // • plays a single chime on the false → true transition (turn starts)
  // • `clearIndicator()` immediately suppresses the glow when the player
  // submits an ask or declaration
  const { indicatorActive, clearIndicator } = useTurnIndicator(isMyTurn ?? false);

  const currentTurnPlayer = gameState?.currentTurnPlayerId
    ? players.find((p) => p.playerId === gameState.currentTurnPlayerId)
    : null;
  const currentLastMoveMessage = lastResultMsg ?? syntheticLastMoveMsg ?? gameState?.lastMove;
  const resolvedVariant = variant ?? room?.card_removal_variant ?? 'remove_7s';
  const declaredSuits = gameState?.declaredSuits ?? [];
  const availableAskHalfSuits = getAvailableAskHalfSuits(myHand, declaredSuits, resolvedVariant);
  const validAskTargetIds = new Set(
    players
      .filter((player) => player.teamId !== myTeamId && player.cardCount > 0 && !player.isEliminated)
      .map((player) => player.playerId),
  );

  const resetAskMode = useCallback(() => {
    setShowAskInline(false);
    setSelectedAskHalfSuit(null);
    setSelectedAskCardIds([]);
  }, []);

  const resetDeclareMode = useCallback(() => {
    if (declareSelectedSuit) {
      sendDeclareSelecting(undefined);
      sendDeclareProgress(null, {});
    }
    setDeclareMode(false);
    setDeclareSelectedSuit(null);
    setDeclareAssignment({});
    setDeclareActiveDragId(null);
    setDeclareSelectedCard(null);
  }, [declareSelectedSuit, sendDeclareSelecting, sendDeclareProgress]);

  const handKey = [...myHand].sort().join(',');
  const declaredKey = declaredSuits.map((d) => d.halfSuitId).sort().join(',');
  const lastWsStatusRef = useRef(wsStatus);
  const beforeDropRef = useRef<{ isMyTurn: boolean; handKey: string; declaredKey: string } | null>(null);

  useEffect(() => {
    const previous = lastWsStatusRef.current;
    lastWsStatusRef.current = wsStatus;
    if (previous === wsStatus) return;

    if (previous === 'connected') {
      beforeDropRef.current = { isMyTurn, handKey, declaredKey };
      // A send in flight may never get its result; the next game_init shows whether it landed.
      updatePendingAskBatch(null);
      setActionLoading(false);
      return;
    }

    const beforeDrop = beforeDropRef.current;
    if (wsStatus !== 'connected' || !beforeDrop) return;
    beforeDropRef.current = null;
    // A reload starts with no ask batch, so the summary from before the drop must not outlive it.
    setSyntheticLastMoveMsg(null);
    observedAskBatchRef.current = null;
    // Nobody else can act on the player's own turn, so the same hand on that turn keeps every selection valid.
    if (beforeDrop.isMyTurn && isMyTurn && beforeDrop.handKey === handKey && beforeDrop.declaredKey === declaredKey) {
      // The server's timeout move plays the stored selection, which a backend restart loses.
      if (selectedAskHalfSuit) sendPartialSelection(_askPartial(selectedAskHalfSuit, selectedAskCardIds));
      if (declareSelectedSuit) {
        sendDeclareSelecting(declareSelectedSuit);
        sendDeclareProgress(declareSelectedSuit, declareAssignment);
      }
      return;
    }
    resetAskMode();
    resetDeclareMode();
  }, [
    wsStatus, isMyTurn, handKey, declaredKey, resetAskMode, resetDeclareMode, updatePendingAskBatch,
    selectedAskHalfSuit, selectedAskCardIds, declareSelectedSuit, declareAssignment,
    sendPartialSelection, sendDeclareSelecting, sendDeclareProgress,
  ]);

  const handleAskHalfSuitSelect = useCallback((halfSuitId: HalfSuitId) => {
    if (!availableAskHalfSuits.includes(halfSuitId)) return;
    setShowAskInline(true);
    setSelectedAskHalfSuit(halfSuitId);
    setSelectedAskCardIds([]);
    resetDeclareMode();
    sendPartialSelection({ flow: 'ask', halfSuitId });
  }, [availableAskHalfSuits, sendPartialSelection, resetDeclareMode]);

  const handleAskHandCardSelect = useCallback((cardId: CardId) => {
    const halfSuitId = getCardHalfSuit(cardId, resolvedVariant);
    if (!halfSuitId) return;
    handleAskHalfSuitSelect(halfSuitId);
  }, [resolvedVariant, handleAskHalfSuitSelect]);

  // ── Inline declare: clicking a card in hand to select half-suit ──────────
  const handleDeclareHandCardSelect = useCallback((cardId: CardId) => {
    const halfSuitId = getCardHalfSuit(cardId, resolvedVariant);
    if (!halfSuitId) return;

    // Check this suit hasn't already been declared
    const declaredIds = new Set(declaredSuits.map((d: DeclaredSuit) => d.halfSuitId));
    if (declaredIds.has(halfSuitId)) return;

    // Check we hold at least 1 card from this half-suit
    const suitCards = getHalfSuitCards(halfSuitId, resolvedVariant);
    const myCardsInSuit = suitCards.filter((c: CardId) => myHand.includes(c));
    if (myCardsInSuit.length === 0) return;

    // Initialize assignment — hand cards auto-assigned to self
    const initial: Record<CardId, string> = {};
    for (const card of suitCards) {
      if (myHand.includes(card)) {
        initial[card] = myPlayerId!;
      }
    }

    setDeclareSelectedSuit(halfSuitId);
    setDeclareAssignment(initial);
    setDeclareSelectedCard(null);
    setDeclareActiveDragId(null);

    sendDeclareSelecting(halfSuitId);
    sendDeclareProgress(halfSuitId, initial);
  }, [resolvedVariant, declaredSuits, myHand, myPlayerId, sendDeclareSelecting, sendDeclareProgress]);

  // ── Inline declare: DnD sensors ──────────────────────────────
  const declareSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  // ── Inline declare: DnD handlers ────────────────────────────
  const handleDeclareDragStart = useCallback((event: DragStartEvent) => {
    if (!canSend) return;
    setDeclareActiveDragId(String(event.active.id));
    setDeclareSelectedCard(null);
  }, [canSend]);

  const assignDeclareCard = useCallback((cardId: CardId, playerId: string) => {
    if (!canSend || actionLoading || !declareSelectedSuit || myHand.includes(cardId)) return;
    if (playerId === myPlayerId || !players.some(p => p.playerId === playerId && p.teamId === myTeamId)) return;
    if (declareAssignment[cardId] !== playerId) {
      const next = { ...declareAssignment, [cardId]: playerId };
      setDeclareAssignment(next);
      sendDeclareProgress(declareSelectedSuit, next);
    }
    setDeclareSelectedCard(null);
  }, [canSend, actionLoading, declareSelectedSuit, myHand, myPlayerId, players, myTeamId, declareAssignment, sendDeclareProgress]);

  const handleDeclareDragEnd = useCallback(({ active, over }: DragEndEvent) => {
    setDeclareActiveDragId(null);
    if (over) assignDeclareCard(String(active.id).replace(/^declare-/, ''), String(over.id));
  }, [assignDeclareCard]);

  const handleDeclareTapCard = useCallback((cardId: CardId) => {
    if (!canSend || actionLoading || myHand.includes(cardId)) return;
    setDeclareSelectedCard((prev) => (prev === cardId ? null : cardId));
  }, [canSend, actionLoading, myHand]);

  const handleDeclareRemoveCard = useCallback((cardId: CardId) => {
    if (!canSend || actionLoading || !declareSelectedSuit || myHand.includes(cardId)) return;
    const next = { ...declareAssignment };
    delete next[cardId];
    setDeclareAssignment(next);
    sendDeclareProgress(declareSelectedSuit, next);
  }, [canSend, actionLoading, declareSelectedSuit, myHand, declareAssignment, sendDeclareProgress]);

  const handleDeclareConfirm = useCallback(() => {
    if (!canSend || !declareSelectedSuit || actionLoading) return;
    const suitCards = getHalfSuitCards(declareSelectedSuit, resolvedVariant);
    const isComplete = suitCards.length > 0 && suitCards.every((c: CardId) => declareAssignment[c]);
    if (!isComplete) return;
    setActionLoading(true);
    clearIndicator();
    sendDeclare(declareSelectedSuit, declareAssignment);
  }, [canSend, declareSelectedSuit, actionLoading, resolvedVariant, declareAssignment, clearIndicator, sendDeclare]);

  // ── Inline declare: timer expiry auto-fill ───────────────────
  const handleDeclareTimerExpiry = useCallback(() => {
    if (!canSend || !declareSelectedSuit || actionLoading) return;
    const suitCards = getHalfSuitCards(declareSelectedSuit, resolvedVariant);
    const teammates = players.filter((p) => p.teamId === myTeamId).sort((a, b) => a.seatIndex - b.seatIndex);
    const firstOther = teammates.find((p) => p.playerId !== myPlayerId);
    const filled = { ...declareAssignment };
    for (const card of suitCards) {
      if (!filled[card]) {
        filled[card] = firstOther?.playerId ?? myPlayerId!;
      }
    }
    setActionLoading(true);
    clearIndicator();
    sendDeclare(declareSelectedSuit, filled);
  }, [canSend, declareSelectedSuit, actionLoading, resolvedVariant, players, myTeamId, myPlayerId, declareAssignment, clearIndicator, sendDeclare]);

  // ── Inline declare: derived data ─────────────────────────────
  const declareSuitCards = declareSelectedSuit ? getHalfSuitCards(declareSelectedSuit, resolvedVariant) : [];
  const declareUnassignedCards = declareSuitCards.filter((c) => !declareAssignment[c]);
  const declareIsComplete = declareSuitCards.length > 0 && declareSuitCards.every((c) => declareAssignment[c]);
  const declareAssignedCount = declareSuitCards.length - declareUnassignedCards.length;

  const handleAskCardToggle = useCallback((cardId: CardId) => {
    if (!canSend || !selectedAskHalfSuit) return;
    const next = selectedAskCardIds.includes(cardId)
      ? selectedAskCardIds.filter((id) => id !== cardId)
      : [...selectedAskCardIds, cardId];
    setSelectedAskCardIds(next);
    sendPartialSelection(_askPartial(selectedAskHalfSuit, next));
  }, [canSend, selectedAskCardIds, selectedAskHalfSuit, sendPartialSelection]);

  useEffect(() => {
    if (!canSend || !showAskInline || !selectedAskHalfSuit) return;

    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (askTrayRef.current?.contains(target)) return;
      if (target.closest('[data-testid="ws-reconnecting-banner"]')) return;
      if (selectedAskCardIds.length > 0 && target.closest('[data-ask-targetable="true"]')) return;
      resetAskMode();
    };

    document.addEventListener('click', handleOutsideClick, true);
    return () => {
      document.removeEventListener('click', handleOutsideClick, true);
    };
  }, [canSend, resetAskMode, selectedAskCardIds.length, selectedAskHalfSuit, showAskInline]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const unlockAudio = () => preload();

    const options: AddEventListenerOptions = { once: true, passive: true };
    window.addEventListener('pointerdown', unlockAudio, options);
    window.addEventListener('keydown', unlockAudio, { once: true });
    window.addEventListener('touchstart', unlockAudio, options);

    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
    };
  }, [preload]);

  // ── Post-declaration seat highlight ───────────────────────────
  //
  // After a correct declaration, `postDeclarationHighlight` carries the set of
  // same-team player IDs eligible to receive the turn. All clients see the
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
    canSend &&
    gameState?.currentTurnPlayerId === myPlayerId
      ? handleChooseNextTurnSeat
      : undefined;

  const isSelectingNextTurn = postDeclarationHighlight !== null || pendingTurnPassAck;
  const isTurnPassMode = isMyTurn && isSelectingNextTurn;
  const showDeclareTray = declareMode && !!declareSelectedSuit && isMyTurn && !isTurnPassMode;

  useEffect(() => {
    if (!canSend || !showDeclareTray) return;

    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (declareTrayRef.current?.contains(target)) return;
      if (target.closest('[data-testid="declare-drop-seat"]')) return;
      if (target.closest('[data-testid="ws-reconnecting-banner"]')) return;
      resetDeclareMode();
    };

    document.addEventListener('click', handleOutsideClick, true);
    return () => {
      document.removeEventListener('click', handleOutsideClick, true);
    };
  }, [canSend, resetDeclareMode, showDeclareTray]);

  const handleAsk = useCallback((targetId: string, cardId: CardId, batchCardIds?: CardId[]) => {
    setActionLoading(true);
    // Immediately clear the turn indicator so the glow and audio repeat
    // stop as soon as the player submits — before the server responds.
    clearIndicator();
    sendAsk(targetId, cardId, batchCardIds);
  }, [clearIndicator, sendAsk]);

  const handleAskTargetSeat = useCallback((targetPlayerId: string) => {
    if (!canSend || selectedAskCardIds.length === 0 || actionLoading) return;
    const targetPlayer = players.find((player) => player.playerId === targetPlayerId);
    const [firstCardId, ...remainingCardIds] = selectedAskCardIds;
    if (!firstCardId || !targetPlayer) return;

    resetAskMode();
    updatePendingAskBatch({
      targetPlayerId,
      requestedCardIds: [firstCardId, ...remainingCardIds],
      successfulCardIds: [],
      deniedCardIds: [],
      remainingCardIds,
      awaitingResultFor: firstCardId,
      waitingForStateSync: false,
      lastKnownTargetCardCount: targetPlayer.cardCount,
    });
    handleAsk(targetPlayerId, firstCardId, [firstCardId, ...remainingCardIds]);
  }, [canSend, actionLoading, handleAsk, players, resetAskMode, selectedAskCardIds, updatePendingAskBatch]);

  useEffect(() => {
    if (!pendingAskBatch?.waitingForStateSync || pendingAskBatch.awaitingResultFor) return;
    if (gameState?.currentTurnPlayerId !== myPlayerId) {
      updatePendingAskBatch(null);
      setActionLoading(false);
      return;
    }

    const targetPlayer = players.find((player) => player.playerId === pendingAskBatch.targetPlayerId);
    if (!targetPlayer) {
      updatePendingAskBatch(null);
      setActionLoading(false);
      return;
    }

    if (targetPlayer.cardCount !== pendingAskBatch.lastKnownTargetCardCount) return;
    if (targetPlayer.cardCount <= 0) {
      updatePendingAskBatch(null);
      setActionLoading(false);
      return;
    }

    const nextCardId = pendingAskBatch.remainingCardIds.find((cardId) => !myHand.includes(cardId));
    if (!nextCardId) {
      updatePendingAskBatch(null);
      setActionLoading(false);
      return;
    }

    const remainingCardIds = pendingAskBatch.remainingCardIds.filter((cardId) => cardId !== nextCardId);
    updatePendingAskBatch({
      targetPlayerId: pendingAskBatch.targetPlayerId,
      requestedCardIds: pendingAskBatch.requestedCardIds,
      successfulCardIds: pendingAskBatch.successfulCardIds,
      deniedCardIds: pendingAskBatch.deniedCardIds,
      remainingCardIds,
      awaitingResultFor: nextCardId,
      waitingForStateSync: false,
      lastKnownTargetCardCount: targetPlayer.cardCount,
    });
    handleAsk(pendingAskBatch.targetPlayerId, nextCardId, pendingAskBatch.requestedCardIds);
  }, [gameState?.currentTurnPlayerId, handleAsk, myHand, myPlayerId, pendingAskBatch, players, updatePendingAskBatch]);

  const handleGoHome = useCallback(() => router.push('/'), [router]);

  if (invalidFormat) return <GameErrorView testId="invalid-format-view" emoji="🃏" title="Invalid Room Code" body={<>Invalid code: <span className="font-mono text-red-400">{roomCode}</span></>} onPrimary={handleGoHome} primaryLabel="Back to Home" />;
  if (loading && serverUnreachable) return <GameErrorView testId="server-unreachable-view" emoji="📡" title="Can't Reach the Server" body="Still trying. The game opens as soon as the server is back." onPrimary={handleGoHome} primaryLabel="Back to Home" />;
  if (loading) return <LoadingView wakingUp={roomRetrying} />;
  if (notFound) return <GameErrorView testId="not-found-view" emoji="🔍" title="Room Not Found" body={<>No room <span className="font-mono text-emerald-400">{roomCode}</span> found.</>} onPrimary={handleGoHome} primaryLabel="Back to Home" />;
  if (!room) return <GameErrorView testId="generic-error-view" emoji="⚠️" title="Something Went Wrong" body="Could not load the game." onPrimary={handleGoHome} primaryLabel="Back to Home" />;
  if (room.status === 'cancelled') return <GameErrorView testId="cancelled-view" emoji="🚫" title="Game Cancelled" body={<>Room <span className="font-mono text-slate-300">{room.code}</span> was cancelled.</>} onPrimary={handleGoHome} primaryLabel="Back to Home" />;
  if (room.status === 'abandoned' || roomDissolved?.reason === 'all_bots') {
    return (
      <GameErrorView
        testId="abandoned-view"
        emoji="🤖"
        title="Game Abandoned"
        body={<>All human players left room <span className="font-mono text-slate-300">{room.code}</span>, so the bot-only game was ended automatically.</>}
        onPrimary={handleGoHome}
        primaryLabel="Back to Home"
      />
    );
  }

  const finalGameOver =
    gameOver ??
    (gameState?.status === 'completed'
      ? {
          type: 'game_over' as const,
          winner: gameState.winner ?? null,
          tiebreakerWinner: gameState.tiebreakerWinner ?? null,
          scores: gameState.scores,
        }
      : gameSummary
        ? {
            type: 'game_over' as const,
            winner: gameSummary.winner ?? null,
            tiebreakerWinner: gameSummary.tiebreakerWinner ?? null,
            scores: gameSummary.scores,
          }
        : null);

  const finalDeclaredSuits =
    gameState?.declaredSuits && gameState.declaredSuits.length > 0
      ? gameState.declaredSuits
      : (gameSummary?.declaredSuits ?? []);

  // Only a seated player has controls that a stopped socket disables.
  const wsErrorBanner = wsStatus === 'error' && wsError && myPlayerId ? (
    <div
      className="relative z-10 flex items-center justify-center gap-2 px-4 py-1.5 bg-rose-900/60 border-b border-rose-700/40 text-xs text-rose-200"
      role="alert"
      data-testid="ws-error-banner"
    >
      <span aria-hidden="true">⚠️</span>
      <span>{wsError}</span>
    </div>
  ) : null;

  const gameFinished = Boolean(finalGameOver || room.status === 'completed');
  if (gameFinished && !declarationReveal) {
    // Show a brief "Rematch starting…" overlay while redirect is in flight
    if (rematchStarted) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4 gap-4" data-testid="rematch-starting-view">
          <span className="text-4xl animate-spin" style={{ animationDuration: '1s' }}>🔄</span>
          <p className="text-xl font-bold text-white">Rematch starting…</p>
          <p className="text-sm text-slate-400">Starting the new game…</p>
        </div>
      );
    }

    const resultActions = (
      <div className="flex w-full max-w-sm flex-col items-center gap-2">
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
                : roomDissolved.reason === 'majority_no'
                ? 'The majority voted no and the room has been closed.'
                : 'All human players left, so the bot-only game was ended automatically.'}
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
              disabled={!canSend}
            />
          )
        )}

        {isHostOfPrivateRoom && !roomDissolved && (
          <button
            onClick={() => roomCode && sendRematchInitiate(roomCode)}
            disabled={!canSend}
            className="py-3 px-6 rounded-xl font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400"
            data-testid="host-rematch-button"
            aria-label="Initiate rematch as host"
          >
            🔄 Rematch
          </button>
        )}

        <button
          onClick={handleGoHome}
          className="min-h-11 px-5 rounded-xl font-semibold text-slate-300 hover:text-white hover:bg-slate-800 transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400"
        >
          Back to Home
        </button>
      </div>
    );

    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4 py-8 gap-6 overflow-y-auto"
        data-testid="game-completed-view"
      >
        {wsStatus === 'reconnecting' && (
          <div className="fixed inset-x-0 top-0 z-50">
            <ReconnectBar onRetry={retryNow} />
          </div>
        )}
        {wsErrorBanner && <div className="fixed inset-x-0 top-0 z-50">{wsErrorBanner}</div>}

        {finalGameOver ? (
          <GameOverScreen
            winner={finalGameOver.winner ?? null}
            tiebreakerWinner={finalGameOver.tiebreakerWinner ?? null}
            scores={finalGameOver.scores}
            declaredSuits={finalDeclaredSuits}
            myTeamId={myTeamId}
            myPlayerId={myPlayerId}
            players={players}
            playerSummaries={gameSummary?.playerSummaries}
            mvpPlayerId={gameSummary?.mvpPlayerId ?? null}
            variant={VARIANT_LABELS[room.card_removal_variant]}
            roomCode={room.code}
          >
            {resultActions}
          </GameOverScreen>
        ) : (
          <>
            <h1 className="text-2xl font-bold text-white">Game Over</h1>
            <p role="status" className="text-slate-300">Waiting for the final score…</p>
            {resultActions}
          </>
        )}
      </div>
    );
  }

  // ── Spectator mode ────────────────────────────────────────────
  //
  // When the WebSocket server sends `spectator_init` the hook populates
  // `players` but leaves `myPlayerId` as null. We detect this combination
  // once the socket is connected (or reconnecting after a drop) AND players have
  // been received: if players are populated but the current client has no
  // assigned player ID, we are a spectator.
  //
  // This must only trigger after `spectator_init` is actually received — NOT
  // during the initial connection phase when both players[] and myPlayerId are
  // still empty (that state is shared with legitimate players pre-game_init).
  if (!canShowCards) return <LoadingView label="Loading card art…" />;
  const isSpectatorMode =
    (wsStatus === 'connected' || wsStatus === 'reconnecting') && players.length > 0 && !myPlayerId;

  if (isSpectatorMode && room) {
    return (
      <VoiceProvider
        roomCode={room.code}
        bearerToken={gameBearerToken}
        isGuest={isGuest}
        canJoin={false}
      >
        <SpectatorView
          wsStatus={wsStatus}
          players={players}
          spectatorHands={spectatorHands}
          spectatorMoveHistory={spectatorMoveHistory}
          gameState={gameState}
          variant={variant}
          playerCount={playerCount}
          turnTimer={turnTimer}
          declarationTimer={declarationTimer}
          lastAskResult={lastAskResult}
          lastDeclareResult={lastDeclareResult}
          declareProgress={declareProgress ?? null}
          declarationReveal={declarationReveal}
          postDeclarationTimer={postDeclarationTimer}
          roomCode={room.code}
          cardRemovalVariant={room.card_removal_variant}
          gamePlayerCount={room.player_count}
          onGoHome={handleGoHome}
          onRetry={retryNow}
        />
      </VoiceProvider>
    );
  }

  const effectiveVariant = resolvedVariant;
  const effectivePlayerCount = playerCount ?? room.player_count;

  return (
    <GameProvider value={{
      wsStatus, myPlayerId, myHand, players, gameState, variant, playerCount,
      lastAskResult, lastDeclareResult, turnTimer, botTakeover, rematchVote, rematchDeclined,
      sendAsk, sendDeclare, sendRematchVote,
      eligibleNextTurnPlayerIds,
      error: wsError,
    }}>
    <VoiceProvider
      roomCode={room.code}
      bearerToken={gameBearerToken}
      isGuest={isGuest}
      canJoin={Boolean(myPlayerId)}
    >
    <div className="flex h-[100dvh] flex-col bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 overflow-hidden" data-testid="game-view">
      <div className="pointer-events-none fixed inset-0 overflow-hidden opacity-5 select-none" aria-hidden="true">
        <span className="absolute text-[20rem] -top-16 -right-16 text-white">♦</span>
        <span className="absolute text-[14rem] bottom-0 -left-8 text-white">♣</span>
      </div>

      <GameHeader
        gameState={gameState}
        myTeamId={myTeamId}
        wsStatus={wsStatus}
        muted={muted}
        onToggleMute={toggleMute}
        onGoHome={handleGoHome}
        onBotSpeed={sendBotSpeed}
        knowledge={{
          players,
          myPlayerId,
          askHistory,
          declaredSuits: declaredSuits.map((suit) => suit.halfSuitId),
          variant: effectiveVariant,
        }}
      />

      <VoiceAudioLayer />

      {/*
       * Bot-takeover banner
       *
       * Shown to ALL clients (including the timed-out player) when the server
       * broadcasts `bot_takeover` — indicating the human player's 30-second turn
       * timer expired and the bot is now executing their move automatically.
       *
       * Cleared automatically when the following `ask_result` or
       * `declaration_result` arrives (handled in useGameSocket).
       */}
      {wsErrorBanner}

      {wsStatus === 'reconnecting' && <ReconnectBar onRetry={retryNow} />}

      {reclaimQueued && (
        <div
          className="relative z-10 flex items-center justify-center gap-2 px-4 py-1.5 bg-sky-900/60 border-b border-sky-700/40 text-xs text-sky-200"
          role="status"
          aria-live="polite"
          data-testid="reclaim-queued-banner"
        >
          <span aria-hidden="true">⏳</span>
          <span>You&apos;re back. A bot holds your seat until your next turn, then you take over.</span>
        </div>
      )}

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
       * Shows only the single most-recent move (no running history per spec).
       * The `lastResultMsg` (5-second flash) takes precedence over the
       * persisted `gameState.lastMove` so fresh results are visible immediately.
       */}
      <LastMoveDisplay
        message={currentLastMoveMessage}
        players={players}
      />
      <DeclarationCardReveal
        reveal={declarationReveal}
        players={players}
        variant={effectiveVariant}
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

      {/* Render function that wraps teammate seats with DeclareDropSeat during inline declare */}
      {(() => {
        const declareSeatWrapper = declareMode && declareSelectedSuit
          ? (player: import('@/types/game').GamePlayer, seatElement: React.ReactNode) => {
              if (player.teamId === myTeamId) {
                return (
                  <DeclareDropSeat
                    playerId={player.playerId}
                    name={player.displayName}
                    assignedCards={declareSuitCards.filter(card => declareAssignment[card] === player.playerId)}
                    onRemoveCard={handleDeclareRemoveCard}
                    disabled={!canSend || actionLoading}
                    hasSelectedCard={!!declareSelectedCard}
                    onTapZone={() => { if (declareSelectedCard) assignDeclareCard(declareSelectedCard, player.playerId); }}
                    isMe={player.playerId === myPlayerId}
                  >
                    {seatElement}
                  </DeclareDropSeat>
                );
              }
              return seatElement;
            }
          : undefined;

        const mainContent = (
          <>
          <main className="relative z-10 flex min-h-0 flex-1 items-stretch justify-center overflow-hidden px-2 py-2 sm:px-3 sm:py-3 lg:px-5 xl:px-6">
            <div className="game-table-space h-full w-full">
              <CircularGameTable
                players={players}
                myPlayerId={myPlayerId}
                playerCount={effectivePlayerCount as 6 | 8}
                currentTurnPlayerId={gameState?.currentTurnPlayerId ?? null}
                indicatorActive={indicatorActive}
                highlightedPlayerIds={highlightedPlayerIds}
                onSeatClick={seatClickHandler}
                askTargetPlayerIds={selectedAskCardIds.length > 0 ? validAskTargetIds : undefined}
                onAskTargetClick={selectedAskCardIds.length > 0 ? handleAskTargetSeat : undefined}
                onOpeningDealComplete={isDealAnimating ? finishOpeningDeal : undefined}
                renderSeatWrapper={declareSeatWrapper}
              >
                <DeclaredBooksTable
                  declaredSuits={declaredSuits}
                  playerCount={effectivePlayerCount === 8 ? 8 : 6}
                />
              </CircularGameTable>
              {cardFlight && <CardFlightAnimation {...cardFlight} onComplete={clearCardFlight} />}
            </div>
          </main>
          </>
        );

        let handPrompt: React.ReactNode = 'Tap a card to ask.';
        if (!isMyTurn) {
          const currentPlayer = players.find((player) => player.playerId === gameState?.currentTurnPlayerId);
          handPrompt = currentPlayer ? `${currentPlayer.displayName}’s turn` : 'Waiting for the next turn.';
        } else if (declareMode) {
          if (!declareSelectedSuit) handPrompt = 'Tap a card to declare.';
          else if (declareIsComplete) handPrompt = 'Review and confirm.';
          else handPrompt = declareSelectedCard ? 'Tap a teammate to assign.' : 'Drag or tap a card to assign.';
        } else if (selectedAskCardIds.length) {
          const request = selectedAskCardIds.length === 1 ? cardLabel(selectedAskCardIds[0]) : `${selectedAskCardIds.length} cards`;
          handPrompt = `Tap an opponent for ${request}.`;
        } else if (showAskInline && selectedAskHalfSuit) {
          handPrompt = (
            <>Pick one or more missing cards from <strong>{halfSuitLabel(selectedAskHalfSuit)}</strong>. Click anywhere outside to cancel.</>
          );
        }

        const handTimer = postDeclarationTimer ?? (isSelectingNextTurn ? null : turnTimer);
        const isMyTimer = postDeclarationTimer ? isMyTurn : turnTimer?.playerId === myPlayerId;

        const footerContent = !gameFinished && (
          <>
          {/*
           * Player hand area -- ask/declare controls.
           *
           * These controls are gated exclusively on `isMyTurn` (derived from the
           * game socket's game_init / game_state messages). They are completely
           * independent of matchmaking state: no matchmaking hook, context, or
           * status flag influences the enabled/disabled state of the Declare button
           * or card-selection interaction. Ask / declare mode is always available
           * once game_init is received, regardless of player count (6 or 8) or
           * whether any seat is occupied by a bot.
           */}
          <footer className="relative z-20 border-t hand-tray px-3 py-2.5 lg:px-5 lg:py-3" data-testid="player-hand-area">
            {myPlayer ? (
              <div className="mx-auto flex w-full max-w-[82rem] flex-col gap-2 xl:max-w-[90rem] 2xl:max-w-[98rem]" data-testid="game-controls">
                <div className="hand-status">
                  {isSelectingNextTurn ? (
                    <DeclarationTurnPassPrompt
                      isMyTurn={isMyTurn}
                      chooserName={currentTurnPlayer?.displayName ?? null}
                      pending={pendingTurnPassAck}
                    />
                  ) : (
                    <span className="text-sm font-medium text-slate-200" role="status" data-testid={
                      !isMyTurn ? 'waiting-prompt' : declareMode ? 'declare-card-prompt' : selectedAskCardIds.length ? 'ask-seat-prompt' : 'ask-prompt'
                    }>
                      {handPrompt}
                    </span>
                  )}
                  {handTimer && gameState && (
                    <CountdownTimer
                      className="tray-timer"
                      key={handTimer.expiresAt}
                      expiresAt={handTimer.expiresAt}
                      durationMs={handTimer.durationMs}
                      isMyTimer={isMyTimer}
                      label={postDeclarationTimer ? 'Choose next turn' : isMyTimer ? 'Your turn' : 'Turn timer'}
                    />
                  )}
                  {isMyTurn && !isTurnPassMode && !showAskInline && (
                    <div className="flex items-center gap-2">
                      <ActionModeToggle
                        declareMode={declareMode}
                        disabled={actionLoading || !canSend}
                        onChange={(declare) => {
                          if (declare) {
                            resetAskMode();
                            setDeclareMode(true);
                          } else {
                            resetDeclareMode();
                          }
                        }}
                      />
                    </div>
                  )}
                </div>
                {showAskInline && isMyTurn && !isTurnPassMode && (
                  selectedAskHalfSuit && (
                    <div ref={askTrayRef} role="dialog" aria-modal="true" aria-label="Ask for a card">
                      <InlineAskTray
                        myHand={myHand}
                        variant={effectiveVariant}
                        halfSuitId={selectedAskHalfSuit}
                        selectedCardIds={selectedAskCardIds}
                        onToggleCard={handleAskCardToggle}
                        isLoading={actionLoading}
                      />
                    </div>
                  )
                )}
                {showDeclareTray && (
                  <div ref={declareTrayRef} role="dialog" aria-modal="true" aria-label="Declare a half-suit">
                    <InlineDeclareTray
                      halfSuitId={declareSelectedSuit!}
                      unassignedCards={declareUnassignedCards}
                      selectedCard={declareSelectedCard}
                      onTapCard={handleDeclareTapCard}
                      totalCards={declareSuitCards.length}
                      assignedCount={declareAssignedCount}
                      declarationTimer={declarationTimer}
                      onTimerExpiry={handleDeclareTimerExpiry}
                      isComplete={declareIsComplete}
                      isLoading={actionLoading}
                      disabled={!canSend}
                      onConfirm={handleDeclareConfirm}
                    />
                  </div>
                )}
                <div className={[
                  'transition-opacity',
                  showAskInline || showDeclareTray ? 'hidden' : 'opacity-100',
                  declareMode && !declareSelectedSuit ? 'ring-2 ring-violet-500/70 rounded-xl shadow-lg shadow-violet-500/20' : '',
                ].join(' ')}>
                  <CardHand
                    hand={myHand}
                    selectedCard={null}
                    onSelectCard={
                      isMyTurn && !isTurnPassMode
                        ? (declareMode && !declareSelectedSuit ? handleDeclareHandCardSelect : handleAskHandCardSelect)
                        : undefined
                    }
                    isMyTurn={isMyTurn}
                    disabled={actionLoading || !canSend || !isMyTurn || isTurnPassMode || showAskInline || (declareMode && !!declareSelectedSuit)}
                    variant={effectiveVariant}
                    newlyArrivedCardId={newlyArrivedCardId}
                  />
                </div>
              </div>
            ) : (
              <div className="text-center text-xs text-slate-500 py-2" data-testid="spectator-status">
                {/*
                 * Distinguish "truly spectating" (spectator_init was received so
                 * players is populated but myPlayerId was never set) from
                 * "still connecting / awaiting game_init". This prevents the
                 * "Watching as spectator" label from briefly flashing for
                 * legitimate players who connected but haven't yet received
                 * their personalised game_init message.
                 */}
                {wsStatus === 'reconnecting'
                  ? 'Reconnecting…'
                  : wsStatus === 'connected' && players.length > 0
                  ? 'Watching as spectator'
                  : (wsStatus === 'connected' || wsStatus === 'connecting')
                  ? 'Connecting to game…'
                  : wsStatus === 'error'
                  ? `Connection error${wsError ? ': ' + wsError : ''} — refresh to retry`
                  : 'Not connected to game server'}
              </div>
            )}
          </footer>
          </>
        );

        if (declareMode && declareSelectedSuit) {
          return (
            <DndContext
              sensors={declareSensors}
              collisionDetection={pointerWithin}
              onDragStart={handleDeclareDragStart}
              onDragEnd={handleDeclareDragEnd}
              onDragCancel={() => setDeclareActiveDragId(null)}
            >
              {mainContent}
              {footerContent}
              <DragOverlay dropAnimation={null}>
                {declareActiveDragId ? (
                  <div className="opacity-90 scale-110 rotate-3 pointer-events-none">
                    <PlayingCard cardId={declareActiveDragId.replace(/^declare-/, '')} size="md" selected />
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          );
        }

        return <>{mainContent}{footerContent}</>;
      })()}
      {room.status === 'starting' && !gameState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" role="status" data-testid="starting-overlay">
          <div className="flex flex-col items-center gap-4 text-white">
            <svg className="animate-spin h-10 w-10 text-emerald-400" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" /></svg>
            <p className="text-lg font-semibold">Game starting…</p>
          </div>
        </div>
      )}

      {speechBubble && <AskSpeechBubbleOverlay bubble={speechBubble} />}

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
    </GameProvider>
  );
}

function LoadingView({ wakingUp = false, label = 'Loading game…' }: { wakingUp?: boolean; label?: string }) {
  return (
    <div
      className="animate-delayed-reveal flex min-h-screen items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950"
      data-testid="game-loading"
      role="status"
      aria-label={label}
    >
      <div className="flex flex-col items-center gap-5 text-slate-400">
        <div className="flex gap-2" aria-hidden="true">
          <span
            className="animate-loading-dot h-2.5 w-2.5 rounded-full bg-emerald-500"
            style={{ animationDelay: '0ms' }}
          />
          <span
            className="animate-loading-dot h-2.5 w-2.5 rounded-full bg-emerald-500"
            style={{ animationDelay: '180ms' }}
          />
          <span
            className="animate-loading-dot h-2.5 w-2.5 rounded-full bg-emerald-500"
            style={{ animationDelay: '360ms' }}
          />
        </div>
        <span className="text-sm tracking-wide">{label}</span>
        {wakingUp && <span className="text-sm text-amber-200">Waking up the table… this can take up to a minute.</span>}
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
