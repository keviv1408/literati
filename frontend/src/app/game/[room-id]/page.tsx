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
import { advanceAskMoveBatch, buildAskMoveSummaryMessage, type AskMoveBatch } from '@/lib/askMoveSummary';
import {
  buildDeclarationSeatRevealMap,
  buildSuccessfulDeclarationSeatRevealMap,
  FAILED_DECLARATION_SEAT_REVEAL_MS,
} from '@/lib/declarationSeatReveal';
import { loadRoomMembership, saveRoomMembership } from '@/lib/roomMembership';
import { useGuest } from '@/contexts/GuestContext';
import { useReconnect } from '@/hooks/useReconnect';
import { useGameSocket } from '@/hooks/useGameSocket';
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
  TouchSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import { DeclareDropSeat } from '@/components/InlineDeclare';
import InlineDeclareTray from '@/components/InlineDeclareTray';
import DeclarationProgressBanner from '@/components/DeclarationProgressBanner';
import LastMoveDisplay from '@/components/LastMoveDisplay';
import CircularGameTable from '@/components/CircularGameTable';
import RematchVotePanel from '@/components/RematchVotePanel';
import GameOverScreen from '@/components/GameOverScreen';
import SpectatorView from '@/components/SpectatorView';
import DealAnimation from '@/components/DealAnimation';
import CardFlightAnimation from '@/components/CardFlightAnimation';
import AskDeniedAnimation from '@/components/AskDeniedAnimation';
import AskSpeechBubbleOverlay from '@/components/AskSpeechBubbleOverlay';
import DeclaredBooksTable from '@/components/DeclaredBooksTable';
import CountdownTimer from '@/components/CountdownTimer';
import DeclarationTurnPassPrompt from '@/components/DeclarationTurnPassPrompt';
import MuteToggle from '@/components/MuteToggle';
import VoiceAudioLayer from '@/components/VoiceAudioLayer';
import { useAskResultAnimations } from '@/hooks/useAskResultAnimations';
import type { Room } from '@/types/room';
import { cardLabel, getCardHalfSuit, getHalfSuitCards } from '@/types/game';
import type { CardId, HalfSuitId, GameOverPayload, GameSummaryResponse, DeclaredSuit } from '@/types/game';

const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;

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
  const router = useRouter();
  const searchParams = useSearchParams();
  const { guestSession } = useGuest();
  const { status: reconnectStatus, bearerToken: reconnectBearerToken } = useReconnect();

  const [roomCode, setRoomCode]           = useState<string | null>(null);
  const [room, setRoom]                   = useState<Room | null>(null);
  const [loading, setLoading]             = useState(true);
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

  // ── Declaration Seat Reveal ──────────────────────────────────
  //
  // Both successful and failed declarations can briefly reveal the declared
  // half-suit directly on seats. Failed reveals include red wrong markers;
  // successful reveals are all green.
  const [declarationSeatRevealByPlayerId, setDeclarationSeatRevealByPlayerId] =
    useState<Map<string, import('@/lib/declarationSeatReveal').DeclarationSeatRevealCard[]> | null>(null);
  const declarationSeatRevealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processedDeclarationFailedKeyRef = useRef<string | null>(null);

  // ── Score flash ───────────────────────────────────────────────
  //
  // When a declaration_result arrives, briefly highlight the scoring team's
  // score in the header (1 | 2 | null). Cleared after 2 s.
  const [scoreFlash, setScoreFlash]         = useState<1 | 2 | null>(null);
  const scoreFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Deal animation ────────────────────────────────────────────
  //
  // `isDealAnimating` controls the DealAnimation overlay.
  // `hasDealtRef` prevents the animation from re-firing on reconnect/refresh:
  // only the first `game_init` that brings a non-empty hand triggers it.
  const [isDealAnimating, setIsDealAnimating]   = useState(false);
  const hasDealtRef                             = useRef(false);

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

  useEffect(() => {
    setGameSummary(null);
    setSyntheticLastMoveMsg(null);
    observedAskBatchRef.current = null;
    processedAskResultKeyRef.current = null;
  }, [roomCode]);

  const isGameActive = room?.status === 'in_progress' || room?.status === 'starting' || room?.status === 'completed';

  const {
    wsStatus, myPlayerId, myHand, spectatorHands, spectatorMoveHistory, players, gameState, variant, playerCount,
    lastAskResult, lastDeclareResult, declarationFailed, turnTimer, declarationTimer,
    botTakeover, rematchVote, rematchDeclined, roomDissolved,
    sendAsk, sendDeclare, sendRematchVote, sendRematchInitiate,
    sendPartialSelection, sendDeclareProgress, sendDeclareSelecting,
    declareProgress,
    eligibleNextTurnPlayerIds,
    postDeclarationHighlight, sendChooseNextTurn,
    postDeclarationTimer, pendingTurnPassAck,
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
    onRematchStarting: () => {
      // new game spun up server-side with same teams/seats.
      // Clear post-game state so the upcoming game_init seamlessly transitions
      // into the new game without a page reload.
      setGameOver(null);
      setGameSummary(null);
      setVoteStartedAt(undefined);
      setRematchStarted(false);
      setRoom((prev) => prev ? { ...prev, status: 'in_progress' } : prev);
      hasDealtRef.current = false;
    },
  });

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

      if (lastDeclareResult.correct) {
        const revealVariant = (variant ?? room?.card_removal_variant ?? 'remove_7s') as
          'remove_2s' | 'remove_7s' | 'remove_8s';
        setDeclarationSeatRevealByPlayerId(
          buildSuccessfulDeclarationSeatRevealMap(lastDeclareResult, revealVariant),
        );
        if (declarationSeatRevealTimerRef.current) {
          clearTimeout(declarationSeatRevealTimerRef.current);
        }
        declarationSeatRevealTimerRef.current = setTimeout(() => {
          setDeclarationSeatRevealByPlayerId(null);
        }, FAILED_DECLARATION_SEAT_REVEAL_MS);
      }

      publishMoveMessage(lastDeclareResult.lastMove, null);

      // ── Score flash: briefly highlight the team that just scored ─────────
      if (lastDeclareResult.winningTeam) {
        if (scoreFlashTimer.current) clearTimeout(scoreFlashTimer.current);
        setScoreFlash(lastDeclareResult.winningTeam);
        scoreFlashTimer.current = setTimeout(() => setScoreFlash(null), 2000);
      }

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

  // ── Reset / auto-dismiss failed declaration seat reveal ──────
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
    const revealVariant = (variant ?? room?.card_removal_variant ?? 'remove_7s') as
      'remove_2s' | 'remove_7s' | 'remove_8s';
    setDeclarationSeatRevealByPlayerId(
      buildDeclarationSeatRevealMap(declarationFailed, players, revealVariant),
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
  }, [declarationFailed]);

  useEffect(() => {
    return () => {
      if (declarationSeatRevealTimerRef.current) {
        clearTimeout(declarationSeatRevealTimerRef.current);
      }
    };
  }, []);

  // ── Trigger deal animation on first game_init ─────────────────────────────
  //
  // Fire once when `myHand` first arrives with cards (i.e., the player just
  // received their dealt hand for the first time this session). The
  // `hasDealtRef` guard prevents it from re-triggering on:
  // • WebSocket reconnect (same session, hand already dealt)
  // • Page refresh (new session, hasDealtRef resets to false — animation plays again,
  // which is acceptable since the player sees their hand "arrive" on reconnect)
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
    if (!turnTimer) return;

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
  }, [turnTimer?.expiresAt]);

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
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  // ── Inline declare: DnD handlers ────────────────────────────
  const handleDeclareDragStart = useCallback((event: DragStartEvent) => {
    setDeclareActiveDragId(String(event.active.id));
    setDeclareSelectedCard(null);
  }, []);

  const handleDeclareDragEnd = useCallback((event: DragEndEvent) => {
    setDeclareActiveDragId(null);
    const rawId = String(event.active.id);
    // Draggable IDs are prefixed with "declare-"
    const cardId = rawId.replace(/^declare-/, '') as CardId;
    const overId = event.over?.id;
    if (!overId) return;
    // Never allow moving hand cards
    if (myHand.includes(cardId)) return;

    const overStr = String(overId);
    // Verify the target is a teammate
    const teammates = players.filter((p) => p.teamId === myTeamId && p.playerId !== myPlayerId);
    if (teammates.some((t) => t.playerId === overStr)) {
      setDeclareAssignment((prev) => {
        const next = { ...prev, [cardId]: overStr };
        if (declareSelectedSuit) sendDeclareProgress(declareSelectedSuit, next);
        return next;
      });
    }
  }, [myHand, players, myTeamId, myPlayerId, declareSelectedSuit, sendDeclareProgress]);

  // ── Inline declare: tap-to-assign ────────────────────────────
  const handleDeclareTapCard = useCallback((cardId: CardId) => {
    if (myHand.includes(cardId)) return;
    setDeclareSelectedCard((prev) => (prev === cardId ? null : cardId));
  }, [myHand]);

  const handleDeclareTapZone = useCallback((playerId: string) => {
    if (!declareSelectedCard || playerId === myPlayerId) return;
    setDeclareAssignment((prev) => {
      const next = { ...prev, [declareSelectedCard]: playerId };
      if (declareSelectedSuit) sendDeclareProgress(declareSelectedSuit, next);
      return next;
    });
    setDeclareSelectedCard(null);
  }, [declareSelectedCard, myPlayerId, declareSelectedSuit, sendDeclareProgress]);

  const handleDeclareRemoveCard = useCallback((cardId: CardId) => {
    if (myHand.includes(cardId)) return;
    setDeclareAssignment((prev) => {
      const next = { ...prev };
      delete next[cardId];
      if (declareSelectedSuit) sendDeclareProgress(declareSelectedSuit, next);
      return next;
    });
  }, [myHand, declareSelectedSuit, sendDeclareProgress]);

  // ── Inline declare: confirm ──────────────────────────────────
  const handleDeclareConfirm = useCallback(() => {
    if (!declareSelectedSuit || actionLoading) return;
    const suitCards = getHalfSuitCards(declareSelectedSuit, resolvedVariant);
    const isComplete = suitCards.length > 0 && suitCards.every((c: CardId) => declareAssignment[c]);
    if (!isComplete) return;
    setActionLoading(true);
    clearIndicator();
    sendDeclare(declareSelectedSuit, declareAssignment);
  }, [declareSelectedSuit, actionLoading, resolvedVariant, declareAssignment, clearIndicator, sendDeclare]);

  // ── Inline declare: timer expiry auto-fill ───────────────────
  const handleDeclareTimerExpiry = useCallback(() => {
    if (!declareSelectedSuit || actionLoading) return;
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
  }, [declareSelectedSuit, actionLoading, resolvedVariant, players, myTeamId, myPlayerId, declareAssignment, clearIndicator, sendDeclare]);

  // ── Inline declare: derived data ─────────────────────────────
  const declareSuitCards = declareSelectedSuit ? getHalfSuitCards(declareSelectedSuit, resolvedVariant) : [];
  const declareUnassignedCards = declareSuitCards.filter((c) => !declareAssignment[c]);
  const declareIsComplete = declareSuitCards.length > 0 && declareSuitCards.every((c) => declareAssignment[c]);
  const declareAssignedCount = declareSuitCards.length - declareUnassignedCards.length;

  /** Cards assigned to a specific teammate. */
  const getDeclareTeammateCards = useCallback((playerId: string): CardId[] =>
    declareSuitCards.filter((c) => declareAssignment[c] === playerId),
  [declareSuitCards, declareAssignment]);

  const handleAskCardToggle = useCallback((cardId: CardId) => {
    if (!selectedAskHalfSuit) return;
    const next = selectedAskCardIds.includes(cardId)
      ? selectedAskCardIds.filter((id) => id !== cardId)
      : [...selectedAskCardIds, cardId];
    setSelectedAskCardIds(next);

    const lastSelectedCardId = next[next.length - 1];
    if (lastSelectedCardId) {
      sendPartialSelection({ flow: 'ask', halfSuitId: selectedAskHalfSuit, cardId: lastSelectedCardId });
    } else {
      sendPartialSelection({ flow: 'ask', halfSuitId: selectedAskHalfSuit });
    }
  }, [selectedAskCardIds, selectedAskHalfSuit, sendPartialSelection]);

  useEffect(() => {
    if (!showAskInline || !selectedAskHalfSuit) return;

    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (askTrayRef.current?.contains(target)) return;
      if (selectedAskCardIds.length > 0 && target.closest('[data-ask-targetable="true"]')) return;
      resetAskMode();
    };

    document.addEventListener('click', handleOutsideClick, true);
    return () => {
      document.removeEventListener('click', handleOutsideClick, true);
    };
  }, [resetAskMode, selectedAskCardIds.length, selectedAskHalfSuit, showAskInline]);

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
    gameState?.currentTurnPlayerId === myPlayerId
      ? handleChooseNextTurnSeat
      : undefined;

  // ── Turn-pass mode ────────────────────────────────────────────
  //
  // `isTurnPassMode` is true when the local player is the current turn player
  // AND is in the post-declaration seat-selection window. This covers two
  // sub-states:
  // 1. `postDeclarationHighlight !== null` — seats are highlighted, waiting
  // for the player to tap one.
  // 2. `pendingTurnPassAck` — the player tapped a seat (highlight cleared
  // optimistically) but the server's `post_declaration_turn_selected` ack
  // hasn't arrived yet.
  //
  // While `isTurnPassMode` is true:
  // • Ask and Declare buttons are hidden (replaced by a selection prompt).
  // • The ask-prompt hint is suppressed.
  // • The turn-indicator banner shows seat-selection guidance.
  const isTurnPassMode = isMyTurn && (postDeclarationHighlight !== null || pendingTurnPassAck);
  const showDeclareTray = declareMode && !!declareSelectedSuit && isMyTurn && !isTurnPassMode;

  useEffect(() => {
    if (!showDeclareTray) return;

    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (declareTrayRef.current?.contains(target)) return;
      if (target.closest('[data-testid="declare-drop-seat"]')) return;
      resetDeclareMode();
    };

    document.addEventListener('click', handleOutsideClick, true);
    return () => {
      document.removeEventListener('click', handleOutsideClick, true);
    };
  }, [resetDeclareMode, showDeclareTray]);

  const handleAsk = useCallback((targetId: string, cardId: CardId, batchCardIds?: CardId[]) => {
    setActionLoading(true);
    // Immediately clear the turn indicator so the glow and audio repeat
    // stop as soon as the player submits — before the server responds.
    clearIndicator();
    sendAsk(targetId, cardId, batchCardIds);
  }, [clearIndicator, sendAsk]);

  const handleAskTargetSeat = useCallback((targetPlayerId: string) => {
    if (selectedAskCardIds.length === 0 || actionLoading) return;
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
  }, [actionLoading, handleAsk, players, resetAskMode, selectedAskCardIds, updatePendingAskBatch]);

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
  if (loading) return <LoadingView />;
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
        {/* ── Game-over summary ─────────────────────────────────
         * Renders the winner announcement, final score, tiebreak reason (if
         * applicable), and the full half-suit tally. declaredSuits is drawn
         * from the most-recent gameState snapshot so the tally is always
         * complete when the game_over message arrives.
         */}
        <GameOverScreen
          winner={winner ?? null}
          tiebreakerWinner={tiebreakerWinner ?? null}
          scores={scores}
          declaredSuits={finalDeclaredSuits}
          myTeamId={myTeamId}
          myPlayerId={myPlayerId}
          players={players}
          playerSummaries={gameSummary?.playerSummaries}
          mvpPlayerId={gameSummary?.mvpPlayerId ?? null}
          variant={VARIANT_LABELS[room.card_removal_variant]}
          roomCode={room.code}
          testId="game-over-screen"
        />

        {/* Room dissolved notice — shown when the server permanently closes the room.
         * Takes priority over the vote panel; once dissolved the vote is moot.
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
            />
          )
        )}

        {/* ── Host Rematch button (private rooms only) ──────────────
         * Visible only to the registered host of a non-matchmaking room.
         * Clicking sends `rematch_initiate` to the server; the server validates
         * host identity via DB lookup and broadcasts `rematch_start` to all
         * clients, bypassing the vote window.
         *
         * Not shown when roomDissolved is set (room is permanently closed) or
         * when rematchStarted is true (redirect is already in flight).
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

  // ── Spectator mode ────────────────────────────────────────────
  //
  // When the WebSocket server sends `spectator_init` the hook populates
  // `players` but leaves `myPlayerId` as null. We detect this combination
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
        declarationFailed={declarationFailed}
        postDeclarationTimer={postDeclarationTimer}
        roomCode={room.code}
        cardRemovalVariant={room.card_removal_variant}
        gamePlayerCount={room.player_count}
        onGoHome={handleGoHome}
      />
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
      canJoin={Boolean(myPlayerId)}
    >
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
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {/* VoiceControls intentionally hidden to avoid production voice API costs.
              Uncomment the line below when you want to re-enable voice chat. */}
          {/* <VoiceControls /> */}
          {/* Mute toggle — persists across page refreshes via localStorage */}
          <MuteToggle muted={muted} onToggle={toggleMute} />
          <div className="flex items-center gap-1.5" title={`Connection: ${wsStatus}`} data-testid="ws-status-indicator">
            <span className={['w-2 h-2 rounded-full', wsStatus === 'connected' ? 'bg-emerald-400' : wsStatus === 'connecting' ? 'bg-yellow-400 animate-pulse' : wsStatus === 'error' ? 'bg-red-500' : 'bg-slate-600'].join(' ')} />
          </div>
        </div>
      </header>

      {gameState && isMyTurn && isTurnPassMode && (
        <div className="relative z-10 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-emerald-700/60 text-emerald-100 border-b border-emerald-600/40" role="status" aria-live="polite" data-testid="turn-indicator">
          {pendingTurnPassAck
            ? (<><span aria-hidden="true">⏳</span><span data-testid="turn-pass-pending-label">Choosing next turn…</span></>)
            : (<><span aria-hidden="true">👆</span><span data-testid="turn-pass-select-label">Tap a highlighted seat to choose who plays next</span></>)}
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

      {/* ── Post-declaration turn-selection countdown ───────────
       * Shown to ALL clients for 30 seconds after a human correct declaration
       * while the declaring team chooses who takes the next turn.
       * On expiry the server auto-selects a random eligible player.
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

      {/* ── Declaration turn-pass prompt ──────────────────────────
       * Shown to ALL clients while `postDeclarationHighlight` is non-null —
       * i.e. while the current turn player (the declarant) is choosing which
       * eligible same-team player receives the next turn.
       *
       * For the DECLARANT (isMyTurn): cyan banner with instruction to click a
       * highlighted (cyan-ring) teammate seat.
       *
       * For ALL OTHER PLAYERS: muted status strip showing the declarant's
       * name so observers understand why some seats are glowing.
       *
       * The prompt disappears (unmounts) as soon as `postDeclarationHighlight`
       * is cleared, which happens when:
       * a) The declarant clicks a highlighted seat → `sendChooseNextTurn`
       * immediately sets `postDeclarationHighlight` to null (optimistic).
       * b) The 30-second timer expires → server sends
       * `post_declaration_turn_selected` → hook clears the highlight.
       * In both cases the cyan seat rings disappear simultaneously with the
       * prompt banner, fulfilling the "clearing highlights when the prompt is
       * dismissed" requirement.
       */}
      {postDeclarationHighlight && gameState && (
        <DeclarationTurnPassPrompt
          isMyTurn={isMyTurn && gameState.currentTurnPlayerId === myPlayerId}
          chooserName={currentTurnPlayer?.displayName ?? null}
          declarerIsBot={postDeclarationHighlight.declarerIsBot}
        />
      )}

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

      {/* Render function that wraps teammate seats with DeclareDropSeat during inline declare */}
      {(() => {
        const declareSeatWrapper = declareMode && declareSelectedSuit
          ? (player: import('@/types/game').GamePlayer, seatElement: React.ReactNode) => {
              if (player.teamId === myTeamId) {
                return (
                  <DeclareDropSeat
                    playerId={player.playerId}
                    assignedCards={getDeclareTeammateCards(player.playerId)}
                    myHand={myHand}
                    hasSelectedCard={!!declareSelectedCard}
                    onTapZone={() => handleDeclareTapZone(player.playerId)}
                    onRemoveCard={handleDeclareRemoveCard}
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
          <main className="relative z-10 flex min-h-0 flex-1 items-center justify-center overflow-hidden px-2 py-2 sm:px-3 sm:py-3 lg:px-5 xl:px-6">
            {isDealAnimating && (
              <DealAnimation
                playerCount={(effectivePlayerCount === 8 ? 8 : 6) as 6 | 8}
                onComplete={() => setIsDealAnimating(false)}
              />
            )}
            <div className="w-full max-w-[82rem] xl:max-w-[90rem] 2xl:max-w-[98rem]">
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
                declarationSeatRevealByPlayerId={declarationSeatRevealByPlayerId}
                renderSeatWrapper={declareSeatWrapper}
              >
                <DeclaredBooksTable
                  declaredSuits={declaredSuits}
                  playerCount={effectivePlayerCount === 8 ? 8 : 6}
                />
              </CircularGameTable>
            </div>
          </main>
          </>
        );

        const footerContent = (
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
          <footer className="relative z-20 border-t border-slate-700/50 bg-slate-900/80 px-3 py-2.5 backdrop-blur-sm lg:px-5 lg:py-3" data-testid="player-hand-area">
            {myPlayer ? (
              <div className="mx-auto flex w-full max-w-[82rem] flex-col gap-2 xl:max-w-[90rem] 2xl:max-w-[98rem]" data-testid="game-controls">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">Your hand — <strong className="text-white">{myHand.length}</strong> card{myHand.length !== 1 ? 's' : ''}</span>
                  {/* during turn-pass mode the declarant must choose a
                   * teammate seat -- Ask/Declare are hidden until the turn advances. */}
                  {isMyTurn && !isTurnPassMode && (
                    <div className="flex items-center gap-2">
                      {/* Ask / Declare toggle */}
                      <div
                        className="relative flex items-center rounded-full bg-slate-700/70 p-0.5"
                        role="radiogroup"
                        aria-label="Action mode"
                        data-testid="ask-declare-toggle"
                      >
                        <button
                          role="radio"
                          aria-checked={!declareMode}
                          onClick={() => {
                            if (declareMode) {
                              resetDeclareMode();
                            } else if (showAskInline) {
                              // Tapping Ask while ask tray is open cancels the current ask
                              resetAskMode();
                            }
                          }}
                          disabled={actionLoading}
                          className={[
                            'relative z-10 px-3 py-1 text-xs font-semibold rounded-full transition-all duration-200',
                            !declareMode
                              ? 'bg-emerald-600 text-white shadow-sm'
                              : 'text-slate-400 hover:text-white',
                            actionLoading ? 'opacity-50' : '',
                          ].join(' ')}
                          data-testid="toggle-ask"
                        >
                          Ask
                        </button>
                        <button
                          role="radio"
                          aria-checked={declareMode}
                          onClick={() => {
                            if (!declareMode) {
                              resetAskMode();
                              setDeclareMode(true);
                            }
                          }}
                          disabled={actionLoading}
                          className={[
                            'relative z-10 px-3 py-1 text-xs font-semibold rounded-full transition-all duration-200',
                            declareMode
                              ? 'bg-violet-600 text-white shadow-sm'
                              : 'text-slate-400 hover:text-white',
                            actionLoading ? 'opacity-50' : '',
                          ].join(' ')}
                          data-testid="toggle-declare"
                        >
                          Declare
                        </button>
                      </div>
                    </div>
                  )}
                  {/* seat-selection prompt -- replaces Ask/Declare row
                   * while the declarant is choosing who gets the next turn. */}
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
                {showAskInline && isMyTurn && !isTurnPassMode && (
                  selectedAskHalfSuit && (
                    <div ref={askTrayRef}>
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
                  <div ref={declareTrayRef}>
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
                      onConfirm={handleDeclareConfirm}
                    />
                  </div>
                )}
                <div className={[
                  'transition-opacity',
                  showAskInline || showDeclareTray ? 'hidden sm:block opacity-45' : 'opacity-100',
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
                    disabled={actionLoading || !isMyTurn || isTurnPassMode || showAskInline || (declareMode && !!declareSelectedSuit)}
                    variant={effectiveVariant}
                    newlyArrivedCardId={newlyArrivedCardId}
                  />
                </div>
                {isMyTurn && !isTurnPassMode && !showAskInline && !declareMode && myHand.length > 0 && (
                  <p className="text-xs text-slate-500 text-center animate-pulse" data-testid="ask-prompt">Tap a card to ask, or switch to Declare mode</p>
                )}
                {isMyTurn && !isTurnPassMode && declareMode && !declareSelectedSuit && (
                  <p className="text-xs text-violet-300 text-center animate-pulse" data-testid="declare-card-prompt">
                    Tap a card in your hand to select which half-suit to declare
                  </p>
                )}
                {isMyTurn && !isTurnPassMode && showAskInline && selectedAskCardIds.length > 0 && (
                  <p className="text-xs text-emerald-300 text-center" data-testid="ask-seat-prompt">
                    Tap an opponent avatar above for{' '}
                    {selectedAskCardIds.length === 1
                      ? cardLabel(selectedAskCardIds[0])
                      : `${selectedAskCardIds.length} selected cards`}.
                  </p>
                )}
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
          </>
        );

        if (declareMode && declareSelectedSuit) {
          return (
            <DndContext
              sensors={declareSensors}
              collisionDetection={closestCenter}
              onDragStart={handleDeclareDragStart}
              onDragEnd={handleDeclareDragEnd}
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

      {/* ── Card flight animation overlay (AC 33) ─────────────── */}
      {/* Renders a face-up card flying from the card-giver's seat to the */}
      {/* card-receiver's seat after every successful ask_card result. */}
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
    </VoiceProvider>
    </GameProvider>
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
