'use client';

/**
 * useGameSocket — manages the WebSocket connection to /ws/game/<ROOMCODE>.
 *
 * Provides:
 *   - myHand: CardId[]  (personalized, from game_init / hand_update)
 *   - myPlayerId: string | null
 *   - players: GamePlayer[]
 *   - gameState: PublicGameState | null
 *   - wsStatus: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'
 *   - sendAsk(targetId, cardId): void
 *   - sendDeclare(halfSuitId, assignment): void
 *   - lastAskResult / lastDeclareResult: for animations
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { API_URL } from '@/lib/api';
import type {
  CardId,
  GamePlayer,
  PublicGameState,
  HalfSuitId,
  AskResultPayload,
  DeclarationResultPayload,
  DeclareProgressPayload,
  GameOverPayload,
  RematchVoteUpdatePayload,
  RematchStartPayload,
  RematchDeclinedPayload,
  InferenceModeChangedPayload,
  BotTakeoverPayload,
  PlayerDisconnectedPayload,
  PlayerReconnectedPayload,
  ReconnectExpiredPayload,
} from '@/types/game';
import { sortHandByHalfSuit, type CardVariant } from '@/utils/cardSort';

export type GameWsStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

function toWsUrl(roomCode: string, token: string): string {
  const wsBase = API_URL.replace(/^https?/, (p) => (p === 'https' ? 'wss' : 'ws'));
  return `${wsBase}/ws/game/${roomCode}?token=${encodeURIComponent(token)}`;
}

interface UseGameSocketOptions {
  roomCode: string | null;
  bearerToken: string | null;
  onGameOver?: (payload: GameOverPayload) => void;
  onRematchStart?: (payload: RematchStartPayload) => void;
}

export interface TurnTimerPayload {
  type: 'turn_timer';
  playerId: string;
  durationMs: number;
  expiresAt: number; // epoch ms
}

/**
 * Partial wizard state the active player reports mid-flow so the server
 * can complete the action deterministically if the turn timer fires.
 */
export type PartialSelectionPayload =
  | { flow: 'ask'; halfSuitId: string; cardId?: string }
  | { flow: 'declare'; halfSuitId: string; assignment?: Record<string, string> };

export interface UseGameSocketReturn {
  wsStatus: GameWsStatus;
  myPlayerId: string | null;
  myHand: CardId[];
  players: GamePlayer[];
  gameState: PublicGameState | null;
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s' | null;
  playerCount: 6 | 8 | null;
  lastAskResult: AskResultPayload | null;
  lastDeclareResult: DeclarationResultPayload | null;
  turnTimer: TurnTimerPayload | null;
  rematchVote: RematchVoteUpdatePayload | null;
  rematchDeclined: RematchDeclinedPayload | null;
  /**
   * Shared inference-mode flag. When true, clients should show deduction
   * highlights. Kept in sync with all other clients via `inference_mode_changed`
   * WebSocket broadcasts; also included in the public game state on reconnect.
   */
  inferenceMode: boolean;
  /**
   * Non-null when a bot takeover event was received for the current room.
   * Cleared automatically when a new turn starts (ask_result / declaration_result).
   * Components can use this to animate a takeover indicator.
   */
  botTakeover: BotTakeoverPayload | null;
  /**
   * Map of currently-active reconnect windows keyed by playerId.
   * Non-empty while one or more human players have disconnected and the server
   * is waiting for them to reconnect within the 60-second window.
   *
   * Value shape: { expiresAt: number, reconnectWindowMs: number }
   *   - expiresAt: epoch ms timestamp when the window closes
   *   - reconnectWindowMs: total window duration (always 60 000)
   *
   * Populated on `player_disconnected`, cleared on `player_reconnected` or
   * `reconnect_expired`.  Components use this to render a "disconnected" badge
   * with a countdown on the affected seat.
   */
  reconnectWindows: Record<string, { expiresAt: number; reconnectWindowMs: number }>;
  /**
   * Live card-assignment progress from another player's in-progress declaration.
   * Non-null while someone else is filling out the DeclareModal Step 2 form.
   * Cleared automatically when declaration_result or a cancel (halfSuitId: null)
   * arrives.  Components render a live "X is declaring Low Spades (3/6)" banner.
   */
  declareProgress: DeclareProgressPayload | null;
  sendAsk: (targetPlayerId: string, cardId: CardId) => void;
  sendDeclare: (halfSuitId: HalfSuitId, assignment: Record<CardId, string>) => void;
  /**
   * Stream in-progress card assignment progress to all other connected clients
   * while the DeclareModal Step 2 form is being filled out.
   *
   * Call this every time a card assignment changes in the DeclareModal.
   * Pass `halfSuitId: null` when the player cancels (back button or close).
   * The server re-broadcasts to all OTHER clients as a `declare_progress` event.
   * This is fire-and-forget — no response is sent back.
   */
  sendDeclareProgress: (halfSuitId: HalfSuitId | null, assignment: Record<CardId, string>) => void;
  sendRematchVote: (vote: boolean) => void;
  /**
   * Toggle the shared inference mode on/off. Sends `toggle_inference` to the
   * server, which broadcasts the new state to all connected clients.
   * Only in-game players (not spectators) should call this.
   */
  sendToggleInference: () => void;
  /**
   * Report partial wizard selection progress to the server (fire-and-forget).
   * The server stores this transiently and uses it to deterministically
   * complete the player's action if the turn timer expires.
   *
   * For the ask flow, call after:
   *   • Step 1 completion (half-suit chosen): { flow: 'ask', halfSuitId }
   *   • Step 2 completion (card chosen):      { flow: 'ask', halfSuitId, cardId }
   *
   * For the declare flow, call after:
   *   • Suit selection (and on each assignment change):
   *     { flow: 'declare', halfSuitId, assignment }
   *
   * Only valid for the active player — the server silently ignores messages
   * from non-active players.
   */
  sendPartialSelection: (partial: PartialSelectionPayload) => void;
  /**
   * Notify the server of the half-suit chosen in Step 1 of the DeclareModal
   * suit picker (private — Sub-AC 21a).  Fire-and-forget.
   *
   * The server stores this privately for bot-takeover purposes only.
   * It is NEVER broadcast to other players.
   *
   * Pass `undefined` to clear (player pressed "Back" or closed the modal).
   */
  sendDeclareSelecting: (halfSuitId?: string) => void;
  error: string | null;
}

export function useGameSocket({
  roomCode,
  bearerToken,
  onGameOver,
  onRematchStart,
}: UseGameSocketOptions): UseGameSocketReturn {
  const [wsStatus, setWsStatus]         = useState<GameWsStatus>('idle');
  const [myPlayerId, setMyPlayerId]      = useState<string | null>(null);
  const [myHand, setMyHand]              = useState<CardId[]>([]);
  const [players, setPlayers]            = useState<GamePlayer[]>([]);
  const [gameState, setGameState]        = useState<PublicGameState | null>(null);
  const [variant, setVariant]            = useState<'remove_2s' | 'remove_7s' | 'remove_8s' | null>(null);
  const [playerCount, setPlayerCount]    = useState<6 | 8 | null>(null);
  const [lastAskResult, setLastAskResult] = useState<AskResultPayload | null>(null);
  const [lastDeclareResult, setLastDeclareResult] = useState<DeclarationResultPayload | null>(null);
  const [turnTimer, setTurnTimer]        = useState<TurnTimerPayload | null>(null);
  const [rematchVote, setRematchVote]    = useState<RematchVoteUpdatePayload | null>(null);
  const [rematchDeclined, setRematchDeclined] = useState<RematchDeclinedPayload | null>(null);
  const [inferenceMode, setInferenceMode]   = useState<boolean>(false);
  const [botTakeover, setBotTakeover]       = useState<BotTakeoverPayload | null>(null);
  const [declareProgress, setDeclareProgress] = useState<DeclareProgressPayload | null>(null);
  const [reconnectWindows, setReconnectWindows] = useState<
    Record<string, { expiresAt: number; reconnectWindowMs: number }>
  >({});
  const [error, setError]                   = useState<string | null>(null);

  const wsRef      = useRef<WebSocket | null>(null);
  const statusRef  = useRef<GameWsStatus>('idle');
  // Persist the variant across message handlers so hand_update (which only
  // carries the new hand array) can still apply the half-suit sort.
  const variantRef = useRef<CardVariant | null>(null);

  function setStatus(s: GameWsStatus) {
    statusRef.current = s;
    setWsStatus(s);
  }

  // ── Connect / reconnect when roomCode and token are ready ─────────────────
  useEffect(() => {
    if (!roomCode || !bearerToken) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(toWsUrl(roomCode, bearerToken));
    } catch {
      setStatus('error');
      setError('Failed to create WebSocket connection');
      return;
    }

    wsRef.current = ws;
    setStatus('connecting');
    setError(null);

    ws.onopen = () => {
      setStatus('connected');
    };

    ws.onclose = (e) => {
      wsRef.current = null;
      setStatus(statusRef.current === 'error' ? 'error' : 'disconnected');
      if (e.code === 4001) setError('Authentication failed');
      else if (e.code === 4004) setError('Room not found');
      else if (e.code === 4005) setError('Game has not started yet');
    };

    ws.onerror = () => {
      setStatus('error');
    };

    ws.onmessage = (event: MessageEvent) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return;
      }

      switch (msg.type) {
        case 'game_init': {
          const payload = msg as unknown as {
            myPlayerId: string;
            myHand: CardId[];
            players: GamePlayer[];
            gameState: PublicGameState;
            variant: 'remove_2s' | 'remove_7s' | 'remove_8s';
            playerCount: 6 | 8;
          };
          // Cache the variant so subsequent hand_update messages can sort too
          const initVariant = payload.variant ?? null;
          variantRef.current = initVariant;

          setMyPlayerId(payload.myPlayerId);
          // Auto-sort hand by half-suit on initial deal
          const initHand = payload.myHand ?? [];
          setMyHand(initVariant ? sortHandByHalfSuit(initHand, initVariant) : initHand);
          setPlayers(payload.players ?? []);
          setGameState(payload.gameState ?? null);
          setVariant(initVariant);
          setPlayerCount(payload.playerCount ?? null);
          // Sync inference mode from server state on (re)connect
          setInferenceMode(payload.gameState?.inferenceMode ?? false);
          break;
        }

        case 'spectator_init': {
          const payload = msg as unknown as {
            players: GamePlayer[];
            gameState: PublicGameState;
            variant: 'remove_2s' | 'remove_7s' | 'remove_8s';
            playerCount: 6 | 8;
          };
          setPlayers(payload.players ?? []);
          setGameState(payload.gameState ?? null);
          setVariant(payload.variant ?? null);
          setPlayerCount(payload.playerCount ?? null);
          // Sync inference mode from server state on spectator connect
          setInferenceMode(payload.gameState?.inferenceMode ?? false);
          break;
        }

        case 'hand_update': {
          const { hand } = msg as { hand: CardId[] };
          if (Array.isArray(hand)) {
            // Auto-sort hand by half-suit whenever the server sends an update
            const v = variantRef.current;
            setMyHand(v ? sortHandByHalfSuit(hand, v) : hand);
          }
          break;
        }

        case 'game_players': {
          const { players: pl } = msg as { players: GamePlayer[] };
          if (Array.isArray(pl)) setPlayers(pl);
          break;
        }

        case 'game_state': {
          const { state } = msg as { state: PublicGameState };
          if (state) {
            setGameState(state);
            // Keep inference mode in sync with game_state broadcasts
            // (covers the case where a client missed inference_mode_changed)
            setInferenceMode(state.inferenceMode ?? false);
          }
          break;
        }

        case 'ask_result': {
          const payload = msg as unknown as AskResultPayload;
          setLastAskResult(payload);
          // The bot executed the timed-out player's turn — clear takeover indicator
          setBotTakeover(null);
          break;
        }

        case 'declaration_result': {
          const payload = msg as unknown as DeclarationResultPayload;
          setLastDeclareResult(payload);
          // The bot executed the timed-out player's turn — clear takeover indicator
          setBotTakeover(null);
          // Declaration is now complete — clear any in-progress declaration banner
          setDeclareProgress(null);
          break;
        }

        case 'declare_progress': {
          const payload = msg as unknown as DeclareProgressPayload;
          if (payload.halfSuitId === null) {
            // Declarant cancelled — clear the progress banner
            setDeclareProgress(null);
          } else {
            setDeclareProgress(payload);
          }
          break;
        }

        case 'bot_takeover': {
          const payload = msg as unknown as BotTakeoverPayload;
          setBotTakeover(payload);
          break;
        }

        case 'turn_timer': {
          const payload = msg as unknown as TurnTimerPayload;
          setTurnTimer(payload);
          break;
        }

        case 'game_over': {
          const payload = msg as unknown as GameOverPayload;
          onGameOver?.(payload);
          break;
        }

        case 'rematch_vote_update': {
          const payload = msg as unknown as RematchVoteUpdatePayload;
          setRematchVote(payload);
          break;
        }

        case 'rematch_start': {
          const payload = msg as unknown as RematchStartPayload;
          setRematchVote(null);
          setRematchDeclined(null);
          onRematchStart?.(payload);
          break;
        }

        case 'rematch_declined': {
          const payload = msg as unknown as RematchDeclinedPayload;
          setRematchDeclined(payload);
          setRematchVote(null);
          break;
        }

        case 'inference_mode_changed': {
          const payload = msg as unknown as InferenceModeChangedPayload;
          setInferenceMode(payload.enabled);
          break;
        }

        // ── Reconnect window events (Sub-AC 3 of AC 39) ──────────────────────
        case 'player_disconnected': {
          const payload = msg as unknown as PlayerDisconnectedPayload;
          setReconnectWindows((prev) => ({
            ...prev,
            [payload.playerId]: {
              expiresAt:         payload.expiresAt,
              reconnectWindowMs: payload.reconnectWindowMs,
            },
          }));
          break;
        }

        case 'player_reconnected': {
          const payload = msg as unknown as PlayerReconnectedPayload;
          setReconnectWindows((prev) => {
            const next = { ...prev };
            delete next[payload.playerId];
            return next;
          });
          break;
        }

        case 'reconnect_expired': {
          const payload = msg as unknown as ReconnectExpiredPayload;
          setReconnectWindows((prev) => {
            const next = { ...prev };
            delete next[payload.playerId];
            return next;
          });
          break;
        }
        // ─────────────────────────────────────────────────────────────────────

        case 'error': {
          const { message: errMsg, code } = msg as { message: string; code?: string };
          console.warn('[game-ws] Server error:', code, errMsg);
          setError(errMsg ?? 'Unknown error');
          break;
        }

        default:
          break;
      }
    };

    return () => {
      ws.close(1000, 'unmount');
      wsRef.current = null;
    };
  }, [roomCode, bearerToken]);

  // ── Send helpers ──────────────────────────────────────────────────────────

  const sendAsk = useCallback((targetPlayerId: string, cardId: CardId) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'ask_card', targetPlayerId, cardId }));
  }, []);

  const sendDeclare = useCallback((
    halfSuitId: HalfSuitId,
    assignment: Record<CardId, string>
  ) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'declare_suit', halfSuitId, assignment }));
  }, []);

  const sendRematchVote = useCallback((vote: boolean) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'rematch_vote', vote }));
  }, []);

  const sendToggleInference = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'toggle_inference' }));
  }, []);

  /**
   * Report the current wizard step to the server (fire-and-forget).
   * Called by CardRequestWizard and DeclareModal on each step transition
   * so the server can deterministically complete the action if the turn
   * timer fires before the player clicks Confirm.
   */
  const sendPartialSelection = useCallback((partial: PartialSelectionPayload) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'partial_selection', ...partial }));
  }, []);

  /**
   * Stream declaration card-assignment progress to the server (fire-and-forget).
   * The server re-broadcasts to all OTHER connected clients as `declare_progress`
   * so they can show a live "X is declaring Low Spades (3/6)" banner.
   *
   * Call on every card assignment change in DeclareModal Step 2.
   * Pass `halfSuitId: null` when cancelling (back button or modal close).
   */
  const sendDeclareProgress = useCallback((
    halfSuitId: HalfSuitId | null,
    assignment: Record<CardId, string>,
  ) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type:       'declare_progress',
      halfSuitId: halfSuitId ?? null,
      assignment,
    }));
  }, []);

  /**
   * Notify the server of the half-suit chosen in Step 1 of the DeclareModal
   * suit picker — fire-and-forget (Sub-AC 21a).
   *
   * The server stores this PRIVATELY and NEVER broadcasts it to other players.
   * It is used exclusively by bot-takeover logic if the turn timer fires before
   * the player clicks "Declare!".
   *
   * Call with the chosen `halfSuitId` string after Step 1 suit selection.
   * Pass `undefined` (or call with no argument) to clear the stored selection
   * when the player presses "Back" or dismisses the modal.
   *
   * Only valid for the active player — the server silently ignores messages
   * from non-active players.
   */
  const sendDeclareSelecting = useCallback((halfSuitId?: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'declare_selecting',
      ...(halfSuitId ? { halfSuitId } : {}),
    }));
  }, []);

  return {
    wsStatus,
    myPlayerId,
    myHand,
    players,
    gameState,
    variant,
    playerCount,
    lastAskResult,
    lastDeclareResult,
    declareProgress,
    turnTimer,
    rematchVote,
    rematchDeclined,
    inferenceMode,
    botTakeover,
    reconnectWindows,
    sendAsk,
    sendDeclare,
    sendDeclareProgress,
    sendRematchVote,
    sendToggleInference,
    sendPartialSelection,
    sendDeclareSelecting,
    error,
  };
}
