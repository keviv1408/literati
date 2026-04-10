'use client';

/**
 * useGameSocket — manages the WebSocket connection to /ws/game/<ROOMCODE>.
 *
 * Provides:
 * - myHand: CardId[] (personalized, from game_init / hand_update)
 * - myPlayerId: string | null
 * - players: GamePlayer[]
 * - gameState: PublicGameState | null
 * - wsStatus: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'
 * - sendAsk(targetId, cardId): void
 * - sendDeclare(halfSuitId, assignment): void
 * - lastAskResult / lastDeclareResult: for animations
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { API_URL } from '@/lib/api';
import { FAILED_DECLARATION_SEAT_REVEAL_MS } from '@/lib/declarationSeatReveal';
import type {
  CardId,
  GamePlayer,
  PublicGameState,
  HalfSuitId,
  SpectatorHands,
  SpectatorMoveEntry,
  AskResultPayload,
  DeclarationResultPayload,
  DeclarationFailedPayload,
  DeclareProgressPayload,
  GameOverPayload,
  RematchVoteUpdatePayload,
  RematchStartPayload,
  RematchStartingPayload,
  RematchDeclinedPayload,
  RoomDissolvedPayload,
  BotTakeoverPayload,
  PlayerDisconnectedPayload,
  PlayerReconnectedPayload,
  ReconnectExpiredPayload,
  PlayerEliminatedPayload,
} from '@/types/game';
import { sortHandByHalfSuit, type CardVariant } from '@/utils/cardSort';

export type GameWsStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

function toWsUrl(
  roomCode: string,
  token: string | null,
  spectatorToken: string | null,
  guestRecoveryKey: string | null,
): string {
  const wsBase = API_URL.replace(/^https?/, (p) => (p === 'https' ? 'wss' : 'ws'));
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  if (spectatorToken) params.set('spectatorToken', spectatorToken);
  if (guestRecoveryKey) params.set('guestRecoveryKey', guestRecoveryKey);
  return `${wsBase}/ws/game/${roomCode}?${params.toString()}`;
}

interface UseGameSocketOptions {
  roomCode: string | null;
  bearerToken: string | null;
  spectatorToken?: string | null;
  guestRecoveryKey?: string | null;
  onGameOver?: (payload: GameOverPayload) => void;
  onRematchStart?: (payload: RematchStartPayload) => void;
  /** called when a new game is spun up in-place after a rematch vote. */
  onRematchStarting?: (payload: RematchStartingPayload) => void;
}

export interface TurnTimerPayload {
  type: 'turn_timer';
  playerId: string;
  durationMs: number;
  expiresAt: number; // epoch ms
}

/**
 * Payload for the declaration-phase timer.
 *
 * Sent by the server directly to the declaring player only (not broadcast to
 * the room) when they enter Step 2 of the DeclareModal card-assignment form.
 * The client renders a dedicated DeclarationTimerBar with a 60-second
 * countdown and a 10-second warning threshold.
 */
export interface DeclarationTimerPayload {
  type: 'declaration_timer';
  /** The declaring player's ID (same as myPlayerId when received). */
  playerId: string;
  /** Total duration of the declaration phase timer in ms (60 000). */
  durationMs: number;
  /** Server epoch ms when the declaration phase timer fires. */
  expiresAt: number;
}

/**
 * Post-declaration turn-selection timer (AC 28).
 *
 * Broadcast to ALL clients after a human player makes a CORRECT declaration.
 * The declaring team has 30 seconds to choose which eligible teammate takes
 * the next turn. On expiry the server auto-selects a random eligible player
 * and broadcasts `post_declaration_turn_selected`.
 */
export interface PostDeclarationTimerPayload {
  type: 'post_declaration_timer';
  /** The player who made the correct declaration. */
  declarerId: string;
  /** Player IDs on the declaring team who still have cards. */
  eligiblePlayers: string[];
  /** Total duration in ms (30 000). */
  durationMs: number;
  /** Server epoch ms when the selection window closes. */
  expiresAt: number;
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
  spectatorHands: SpectatorHands;
  spectatorMoveHistory: SpectatorMoveEntry[];
  players: GamePlayer[];
  gameState: PublicGameState | null;
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s' | null;
  playerCount: 6 | 8 | null;
  lastAskResult: AskResultPayload | null;
  lastDeclareResult: DeclarationResultPayload | null;
  /**
   * Non-null after a failed declaration broadcast.
   * Carries the per-card diff payload so the FailedDeclarationReveal overlay
   * can show which cards were assigned incorrectly and who actually held them.
   * Cleared when a new turn starts (next ask_result or declaration_result).
   */
  declarationFailed: DeclarationFailedPayload | null;
  turnTimer: TurnTimerPayload | null;
  /**
   * Active declaration-phase timer for the local player.
   * Non-null when the server has started a 60-second declaration phase timer
   * for the current player (they entered Step 2 of DeclareModal).
   * Cleared when the turn ends (ask_result / declaration_result / bot_takeover).
   */
  declarationTimer: DeclarationTimerPayload | null;
  rematchVote: RematchVoteUpdatePayload | null;
  rematchDeclined: RematchDeclinedPayload | null;
  /**
   * Non-null once the server has broadcast `room_dissolved`.
   * After dissolution the room is permanently gone — clients should show a
   * notice and offer a "Back to Home" link. Emitted shortly after
   * `rematch_declined` so the timeline is: game_over → rematch vote →
   * rematch_declined → room_dissolved.
   */
  roomDissolved: RoomDissolvedPayload | null;
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
   * - expiresAt: epoch ms timestamp when the window closes
   * - reconnectWindowMs: total window duration (always 60 000)
   *
   * Populated on `player_disconnected`, cleared on `player_reconnected` or
   * `reconnect_expired`. Components use this to render a "disconnected" badge
   * with a countdown on the affected seat.
   */
  reconnectWindows: Record<string, { expiresAt: number; reconnectWindowMs: number }>;
  /**
   * Live card-assignment progress from another player's in-progress declaration.
   * Non-null while someone else is filling out the DeclareModal Step 2 form.
   * Cleared automatically when declaration_result or a cancel (halfSuitId: null)
   * arrives. Components render a live "X is declaring Low Spades (3/6)" banner.
   */
  declareProgress: DeclareProgressPayload | null;
  sendAsk: (targetPlayerId: string, cardId: CardId, batchCardIds?: CardId[]) => void;
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
   * Host-only rematch initiation for private rooms.
   *
   * Sends `rematch_initiate` to the server with the current room code.
   * Only visible and callable for the registered host of a non-matchmaking room.
   * The server validates host identity via DB lookup and immediately broadcasts
   * `rematch_start` to all connected clients without requiring a majority vote.
   *
   * @param roomCode The current room code (6-char upper-case).
   */
  sendRematchInitiate: (roomCode: string) => void;
  /**
   * Report partial wizard selection progress to the server (fire-and-forget).
   * The server stores this transiently and uses it to deterministically
   * complete the player's action if the turn timer expires.
   *
   * For the ask flow, call after:
   * • Step 1 completion (half-suit chosen): { flow: 'ask', halfSuitId }
   * • Step 2 completion (card chosen): { flow: 'ask', halfSuitId, cardId }
   *
   * For the declare flow, call after:
   * • Suit selection (and on each assignment change):
   * { flow: 'declare', halfSuitId, assignment }
   *
   * Only valid for the active player — the server silently ignores messages
   * from non-active players.
   */
  sendPartialSelection: (partial: PartialSelectionPayload) => void;
  /**
   * Notify the server of the half-suit chosen in Step 1 of the DeclareModal
   * suit picker (private). Fire-and-forget.
   *
   * The server stores this privately for bot-takeover purposes only.
   * It is NEVER broadcast to other players.
   *
   * Pass `undefined` to clear (player pressed "Back" or closed the modal).
   */
  sendDeclareSelecting: (halfSuitId?: string) => void;
  /**
   * Notify the server that the local player has dismissed the declaration
   * result overlay and is ready to continue to the next turn.
   *
   * Fire-and-forget — the server does not respond. The turn has already
   * advanced on the server when `declaration_result` was broadcast; this
   * message is a lightweight acknowledgement that allows the client UI to
   * cleanly transition away from the overlay and render the new turn state.
   */
  sendGameAdvance: () => void;
  /**
   * IDs of all non-eliminated players with at least one card
   * remaining, as of the most recent declaration.
   *
   * Updated on every `declaration_result` message. The list is ordered by
   * seatIndex (matching the server's player list order). Empty array until
   * the first declaration is processed.
   *
   * Components use this to immediately reflect eligibility changes in the UI
   * before the subsequent `game_players` broadcast arrives.
   */
  eligibleNextTurnPlayerIds: string[];
  /**
   * Non-null after a CORRECT declaration.
   *
   * Indicates that the current turn player (the declarant or whoever
   * `_resolveValidTurn` assigned) may redirect the turn to a same-team
   * teammate by clicking a highlighted seat.
   *
   * `eligibleSameTeamIds` contains only the declarant's team members with
   * cards (a client-side subset of `eligibleNextTurnPlayerIds`).
   *
   * Cleared when:
   * - `sendChooseNextTurn` is called (player made a choice), or
   * - A new `ask_result` arrives (turn was taken without choosing), or
   * - A new `declaration_result` arrives (next declaration).
   */
  postDeclarationHighlight: PostDeclarationHighlight | null;
  /**
   * Redirect the current turn to a same-team teammate after a
   * correct declaration. Sends `choose_next_turn` to the server and
   * immediately clears `postDeclarationHighlight`.
   *
   * Only callable when `postDeclarationHighlight` is non-null and the local
   * player is the current turn player.
   *
   * @param chosenPlayerId - ID of the same-team player to receive the turn.
   */
  sendChooseNextTurn: (chosenPlayerId: string) => void;
  /**
   * Non-null while the 30-second post-declaration turn-selection
   * window is active (after a human made a correct declaration).
   *
   * Cleared when `post_declaration_turn_selected` arrives (either because a
   * player chose, or the 30-second timer expired and the server auto-selected).
   *
   * Components use this to render a countdown bar visible to all players and
   * spectators so everyone sees the selection window expiring.
   */
  postDeclarationTimer: PostDeclarationTimerPayload | null;
  /**
   * True after `sendChooseNextTurn` is called and before the
   * server sends `post_declaration_turn_selected` acknowledging the selection.
   *
   * While true, all Ask/Declare controls should be disabled so the declarant
   * cannot take any additional action until the server confirms the turn has
   * been passed to the chosen player.
   *
   * Cleared when:
   * - `post_declaration_turn_selected` arrives (server acked the choice), or
   * - `ask_result` arrives (safety reset — turn moved on), or
   * - `declaration_result` arrives (safety reset — new declaration happened).
   */
  pendingTurnPassAck: boolean;
  error: string | null;
}

/**
 * State set after a correct declaration.
 *
 * Drives the seat-highlight overlay on the game table so the current turn
 * player (the declarant, or whoever `_resolveValidTurn` assigned) can tap a
 * highlighted seat to redirect the turn to any same-team teammate with cards.
 *
 * `eligibleSameTeamIds` is filtered client-side from the server's
 * `eligibleNextTurnPlayerIds` to include only same-team players.
 */
export interface PostDeclarationHighlight {
  /** Player ID of the declarant who made the correct declaration. */
  declarerId: string;
  /** Team of the declarant (1 or 2). */
  declarerTeamId: 1 | 2;
  /**
   * Player IDs on the declarant's team who still have cards and can receive
   * the turn. Subset of the server's `eligibleNextTurnPlayerIds` filtered to
   * the declarant's team only.
   */
  eligibleSameTeamIds: string[];
  /** True when a bot declared and a human teammate is choosing the next turn. */
  declarerIsBot?: boolean;
}

function sortSpectatorHands(
  hands: SpectatorHands | null | undefined,
  variant: CardVariant | null,
): SpectatorHands {
  if (!hands) return {};

  return Object.fromEntries(
    Object.entries(hands).map(([playerId, hand]) => [
      playerId,
      variant ? sortHandByHalfSuit(hand, variant) : hand,
    ]),
  );
}

export function useGameSocket({
  roomCode,
  bearerToken,
  spectatorToken = null,
  guestRecoveryKey = null,
  onGameOver,
  onRematchStart,
  onRematchStarting,
}: UseGameSocketOptions): UseGameSocketReturn {
  const [wsStatus, setWsStatus]         = useState<GameWsStatus>('idle');
  const [myPlayerId, setMyPlayerId]      = useState<string | null>(null);
  const [myHand, setMyHand]              = useState<CardId[]>([]);
  const [spectatorHands, setSpectatorHands] = useState<SpectatorHands>({});
  const [spectatorMoveHistory, setSpectatorMoveHistory] = useState<SpectatorMoveEntry[]>([]);
  const [players, setPlayers]            = useState<GamePlayer[]>([]);
  const [gameState, setGameState]        = useState<PublicGameState | null>(null);
  const [variant, setVariant]            = useState<'remove_2s' | 'remove_7s' | 'remove_8s' | null>(null);
  const [playerCount, setPlayerCount]    = useState<6 | 8 | null>(null);
  const [lastAskResult, setLastAskResult] = useState<AskResultPayload | null>(null);
  const [lastDeclareResult, setLastDeclareResult] = useState<DeclarationResultPayload | null>(null);
  const [declarationFailed, setDeclarationFailed] = useState<DeclarationFailedPayload | null>(null);
  const [turnTimer, setTurnTimer]        = useState<TurnTimerPayload | null>(null);
  const [declarationTimer, setDeclarationTimer] = useState<DeclarationTimerPayload | null>(null);
  const [rematchVote, setRematchVote]    = useState<RematchVoteUpdatePayload | null>(null);
  const [rematchDeclined, setRematchDeclined] = useState<RematchDeclinedPayload | null>(null);
  const [roomDissolved, setRoomDissolved]   = useState<RoomDissolvedPayload | null>(null);
  const [botTakeover, setBotTakeover]       = useState<BotTakeoverPayload | null>(null);
  const [declareProgress, setDeclareProgress] = useState<DeclareProgressPayload | null>(null);
  const [reconnectWindows, setReconnectWindows] = useState<
    Record<string, { expiresAt: number; reconnectWindowMs: number }>
  >({});
  // IDs of all non-eliminated players with cards remaining (updated on declaration_result)
  const [eligibleNextTurnPlayerIds, setEligibleNextTurnPlayerIds] = useState<string[]>([]);
  // non-null after a correct declaration — lets the turn player click a seat to redirect
  const [postDeclarationHighlight, setPostDeclarationHighlight] = useState<PostDeclarationHighlight | null>(null);
  // non-null while the 30-second post-declaration turn-selection window is active
  const [postDeclarationTimer, setPostDeclarationTimer] = useState<PostDeclarationTimerPayload | null>(null);
  // true between sendChooseNextTurn and the server's post_declaration_turn_selected ack
  const [pendingTurnPassAck, setPendingTurnPassAck] = useState<boolean>(false);
  const [error, setError]                   = useState<string | null>(null);

  const wsRef      = useRef<WebSocket | null>(null);
  const statusRef  = useRef<GameWsStatus>('idle');
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const declarationFailedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Persist the variant across message handlers so hand_update (which only
  // carries the new hand array) can still apply the half-suit sort.
  const variantRef = useRef<CardVariant | null>(null);

  function setStatus(s: GameWsStatus) {
    statusRef.current = s;
    setWsStatus(s);
  }

  // ── Connect / reconnect when roomCode and token are ready ─────────────────
  useEffect(() => {
    if (!roomCode || (!bearerToken && !spectatorToken)) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(toWsUrl(roomCode, bearerToken, spectatorToken, guestRecoveryKey));
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
      else if (e.code === 4003) setError('You are no longer recognized as a player in this game. Please rejoin from the room page.');
      else if (e.code === 4004) setError('Room not found');
      else if (e.code === 4005) setError('Game has not started yet');

      // Auto-reload on unexpected disconnect (e.g. backend redeploy).
      // Code 1000 = intentional close (unmount), 4xxx = known errors.
      const isIntentional = e.code === 1000;
      const isKnownError = e.code >= 4001 && e.code <= 4005;
      if (!isIntentional && !isKnownError) {
        reloadTimerRef.current = setTimeout(() => {
          window.location.reload();
        }, 3000);
      }
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
          setSpectatorHands({});
          setSpectatorMoveHistory([]);
          setPlayers(payload.players ?? []);
          setGameState(payload.gameState ?? null);
          setVariant(initVariant);
          setPlayerCount(payload.playerCount ?? null);
          // Reset ephemeral timer state on fresh init to avoid stale countdowns
          // from a previous turn/room before the next timer event arrives.
          setTurnTimer(null);
          break;
        }

        case 'spectator_init': {
          const payload = msg as unknown as {
            players: GamePlayer[];
            hands: SpectatorHands;
            moveHistory: SpectatorMoveEntry[];
            gameState: PublicGameState;
            variant: 'remove_2s' | 'remove_7s' | 'remove_8s';
            playerCount: 6 | 8;
          };
          const spectatorVariant = payload.variant ?? null;
          variantRef.current = spectatorVariant;
          setMyPlayerId(null);
          setMyHand([]);
          setPlayers(payload.players ?? []);
          setSpectatorHands(sortSpectatorHands(payload.hands, spectatorVariant));
          setSpectatorMoveHistory(payload.moveHistory ?? []);
          setGameState(payload.gameState ?? null);
          setVariant(spectatorVariant);
          setPlayerCount(payload.playerCount ?? null);
          // Spectators should not carry over a player's previous turn timer.
          setTurnTimer(null);
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

        case 'spectator_hands': {
          const { hands, moveHistory } = msg as {
            hands: SpectatorHands;
            moveHistory?: SpectatorMoveEntry[];
          };
          setSpectatorHands(sortSpectatorHands(hands, variantRef.current));
          if (Array.isArray(moveHistory)) setSpectatorMoveHistory(moveHistory);
          break;
        }

        case 'game_state': {
          const { state } = msg as { state: PublicGameState };
          if (state) {
            setGameState(state);
          }
          break;
        }

        case 'ask_result': {
          const payload = msg as unknown as AskResultPayload;
          setLastAskResult(payload);
          // The active turn action completed; old turn timer is no longer valid.
          // A fresh timer (if needed) will arrive via a new `turn_timer` event.
          setTurnTimer(null);
          // The bot executed the timed-out player's turn — clear takeover indicator
          setBotTakeover(null);
          // Turn ended — clear any active declaration phase timer
          setDeclarationTimer(null);
          // New turn started — clear any lingering failed-declaration overlay
          setDeclarationFailed(null);
          // a player took an ask action — clear the post-declaration highlight
          setPostDeclarationHighlight(null);
          // clear post-declaration timer (turn is now in progress)
          setPostDeclarationTimer(null);
          // safety reset — turn moved on, no longer waiting for ack
          setPendingTurnPassAck(false);
          break;
        }

        case 'declaration_result': {
          const payload = msg as unknown as DeclarationResultPayload;
          setLastDeclareResult(payload);
          // Clear the last ask result so its animation doesn't replay when
          // game_players arrives and invalidates the callback dependencies.
          setLastAskResult(null);
          // Declaration completed; clear the previous turn timer immediately.
          setTurnTimer(null);
          // update eligible next-turn players list from the server payload
          if (Array.isArray(payload.eligibleNextTurnPlayerIds)) {
            setEligibleNextTurnPlayerIds(payload.eligibleNextTurnPlayerIds);
          }
          // The bot executed the timed-out player's turn — clear takeover indicator
          setBotTakeover(null);
          // Declaration is now complete — clear any in-progress declaration banner
          setDeclareProgress(null);
          // Turn ended — clear declaration phase timer
          setDeclarationTimer(null);
          // If the declaration was correct, there will be no `declarationFailed`
          // event — proactively clear any stale diff from a previous round.
          if (payload.correct) setDeclarationFailed(null);
          // safety reset — a new declaration result means any previous
          // pending ack is moot (another declaration happened in the meantime).
          setPendingTurnPassAck(false);

          // after a CORRECT declaration, compute the same-team
          // eligible players so the declarant can choose who gets the turn.
          // Skip for timed-out forced failures (timedOut: true) and incorrect
          // declarations — in those cases we clear any stale highlight instead.
          if (payload.correct && !payload.timedOut && Array.isArray(payload.eligibleNextTurnPlayerIds)) {
            // We need the declarant's team to filter eligible IDs.
            // Defer the update so `players` state is current (React batching
            // ensures this runs in the same flush, after setPlayers if it was
            // co-batched, but we resolve from the already-settled players ref).
            // Use a functional update to access the latest players snapshot.
            setPlayers((currentPlayers) => {
              const declarant = currentPlayers.find((p) => p.playerId === payload.declarerId);
              if (declarant) {
                const sameTeamIds = new Set(
                  currentPlayers
                    .filter((p) => p.teamId === declarant.teamId)
                    .map((p) => p.playerId)
                );
                const eligibleSameTeam = (payload.eligibleNextTurnPlayerIds ?? []).filter(
                  (id) => sameTeamIds.has(id)
                );
                if (eligibleSameTeam.length > 1) {
                  setPostDeclarationHighlight({
                    declarerId:          payload.declarerId,
                    declarerTeamId:      declarant.teamId,
                    eligibleSameTeamIds: eligibleSameTeam,
                    declarerIsBot:       !!declarant.isBot,
                  });
                } else {
                  setPostDeclarationHighlight(null);
                }
              }
              return currentPlayers; // no change to players
            });
          } else {
            // Incorrect or timed-out declaration: clear any stale highlight
            setPostDeclarationHighlight(null);
          }
          break;
        }

        case 'declarationFailed': {
          // Broadcast sent only for incorrect declarations (correct === false).
          // Carries the per-card diff so clients can render FailedDeclarationReveal.
          const payload = msg as unknown as DeclarationFailedPayload;
          setDeclarationFailed(payload);
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
          // Turn timer has already expired once takeover begins.
          setTurnTimer(null);
          // Bot is taking over — clear the declaration phase timer so the
          // UI doesn't show a stale countdown
          setDeclarationTimer(null);
          break;
        }

        case 'turn_timer': {
          const payload = msg as unknown as TurnTimerPayload;
          setTurnTimer(payload);
          break;
        }

        case 'declaration_timer': {
          // 36: 60-second declaration phase timer broadcast to ALL
          // connected clients (players + spectators) so the entire table can follow
          // the declarant's countdown. Drives DeclarationTimerBar in DeclareModal
          // (for the declaring player) and in SpectatorView (for spectators).
          const payload = msg as unknown as DeclarationTimerPayload;
          setDeclarationTimer(payload);
          break;
        }

        case 'declaration_timer_tick': {
          // Periodic resync tick — update expiresAt so the client bar stays
          // accurate even if the page was backgrounded briefly.
          const { expiresAt: dtExpiresAt, playerId: dtPlayerId } = msg as {
            expiresAt: number;
            playerId: string;
            remainingMs: number;
          };
          setDeclarationTimer((prev) =>
            prev ? { ...prev, expiresAt: dtExpiresAt, playerId: dtPlayerId } : prev,
          );
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

        case 'rematch_starting': {
          // majority yes — new game created server-side with same
          // teams/seats. Clear vote state and notify the page so it can clear
          // the post-game screen before the incoming game_init arrives.
          const payload = msg as unknown as RematchStartingPayload;
          setRematchVote(null);
          setRematchDeclined(null);
          onRematchStarting?.(payload);
          break;
        }

        case 'rematch_declined': {
          const payload = msg as unknown as RematchDeclinedPayload;
          setRematchDeclined(payload);
          setRematchVote(null);
          break;
        }

        case 'room_dissolved': {
          const payload = msg as unknown as RoomDissolvedPayload;
          setRoomDissolved(payload);
          // Keep rematchDeclined set so the decline reason remains visible
          // until the dissolution notice takes over.
          break;
        }

        // ── Reconnect window events ──────────────────────
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

        // ── Player elimination events ────────────────────────────
        case 'player_eliminated': {
          // Broadcast to all: a player's hand just reached 0 cards.
          // The `game_players` broadcast that follows this message will also
          // carry the updated `isEliminated: true` flag on the affected player.
          // This explicit event lets the client show a toast or animate immediately.
          // For now we just log; the game_players update handles the visual state.
          const payload = msg as unknown as PlayerEliminatedPayload;
          console.info(
            `[game-ws] ${payload.displayName} has been eliminated (team ${payload.teamId})`
          );
          break;
        }

        case 'choose_turn_recipient_prompt': {
          // Eliminated players no longer see a chooser in the frontend.
          // The server can still fall back to its default turn resolution when
          // no preferred recipient is selected.
          break;
        }
        // ─────────────────────────────────────────────────────────────────────

        case 'post_declaration_timer': {
          // Broadcast to ALL after a human makes a correct declaration.
          // Gives the declaring team 30 seconds to choose who takes the next turn.
          // Renders a countdown bar visible to all players and spectators.
          const payload = msg as unknown as PostDeclarationTimerPayload;
          setPostDeclarationTimer(payload);
          break;
        }

        case 'post_declaration_turn_selected': {
          // Sent to ALL when the declaring team's choice is made
          // (either manually via choose_next_turn or by server auto-selection on expiry).
          // Clears the countdown bar and any seat-highlight overlay.
          setPostDeclarationTimer(null);
          setPostDeclarationHighlight(null);
          // server has acknowledged the turn-pass selection —
          // re-enable normal Ask/Declare interaction for the new turn player.
          setPendingTurnPassAck(false);
          break;
        }

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
      if (reloadTimerRef.current) {
        clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
      ws.close(1000, 'unmount');
      wsRef.current = null;
    };
  }, [roomCode, bearerToken, spectatorToken, guestRecoveryKey]);

  useEffect(() => {
    if (declarationFailedTimerRef.current) {
      clearTimeout(declarationFailedTimerRef.current);
      declarationFailedTimerRef.current = null;
    }

    if (!declarationFailed) return;

    declarationFailedTimerRef.current = setTimeout(() => {
      setDeclarationFailed(null);
    }, FAILED_DECLARATION_SEAT_REVEAL_MS);

    return () => {
      if (declarationFailedTimerRef.current) {
        clearTimeout(declarationFailedTimerRef.current);
        declarationFailedTimerRef.current = null;
      }
    };
  }, [declarationFailed]);

  // ── Send helpers ──────────────────────────────────────────────────────────

  const sendAsk = useCallback((targetPlayerId: string, cardId: CardId, batchCardIds?: CardId[]) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'ask_card',
      targetPlayerId,
      cardId,
      ...(batchCardIds && batchCardIds.length > 1 ? { batchCardIds } : {}),
    }));
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

  /**
   * Host-only rematch initiation for private rooms.
   * Sends `rematch_initiate` with the room code so the server can
   * validate host identity and immediately trigger rematch_start.
   */
  const sendRematchInitiate = useCallback((roomCode: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'rematch_initiate', roomCode }));
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
   * suit picker — fire-and-forget.
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

  /**
   * Acknowledge the declaration result overlay has been dismissed.
   * Fire-and-forget — the server ignores this message but it signals the client
   * is ready for the next turn.
   */
  const sendGameAdvance = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'game_advance' }));
  }, []);

  /**
   * 56c: Redirect the current turn to a same-team teammate after
   * a correct declaration. Sends `choose_next_turn` to the server,
   * immediately clears the post-declaration highlight so the seat glow
   * disappears without waiting for a server round-trip, and sets
   * `pendingTurnPassAck` to block further Ask/Declare interaction until the
   * server confirms the selection via `post_declaration_turn_selected`.
   */
  const sendChooseNextTurn = useCallback((chosenPlayerId: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'choose_next_turn', chosenPlayerId }));
    // Optimistically clear the highlight so the UI responds immediately
    setPostDeclarationHighlight(null);
    // block further interaction until server ack arrives
    setPendingTurnPassAck(true);
  }, []);

  return {
    wsStatus,
    myPlayerId,
    myHand,
    spectatorHands,
    spectatorMoveHistory,
    players,
    gameState,
    variant,
    playerCount,
    lastAskResult,
    lastDeclareResult,
    declarationFailed,
    declareProgress,
    turnTimer,
    declarationTimer,
    rematchVote,
    rematchDeclined,
    roomDissolved,
    botTakeover,
    reconnectWindows,
    eligibleNextTurnPlayerIds,
    postDeclarationHighlight,
    postDeclarationTimer,
    pendingTurnPassAck,
    sendAsk,
    sendDeclare,
    sendDeclareProgress,
    sendRematchVote,
    sendRematchInitiate,
    sendPartialSelection,
    sendDeclareSelecting,
    sendGameAdvance,
    sendChooseNextTurn,
    error,
  };
}
