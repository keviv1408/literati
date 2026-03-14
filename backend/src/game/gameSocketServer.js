'use strict';

/**
 * Game WebSocket server — /ws/game/<ROOMCODE>
 *
 * Handles all real-time game events: asking cards, declaring half-suits,
 * bot turn processing, and broadcasting state updates.
 *
 * Connection URL format:
 *   ws(s)://host/ws/game/<ROOMCODE>?token=<bearer>
 *
 * ── Client → Server messages ──────────────────────────────────────────────
 *   { type: 'ask_card',          targetPlayerId: string, cardId: string }
 *   { type: 'declare_suit',      halfSuitId: string, assignment: { [cardId]: playerId } }
 *   { type: 'rematch_vote',      vote: boolean }    — cast after game_over
 *   { type: 'toggle_inference' }                 — any player can toggle; broadcast to all
 *   { type: 'partial_selection', flow: 'ask'|'declare', halfSuitId?: string,
 *                                cardId?: string, assignment?: { [cardId]: playerId } }
 *     — fire-and-forget: active player reports wizard progress so the server
 *       can complete the action deterministically on turn timer expiry.
 *   { type: 'declare_selecting', halfSuitId: string|null }
 *     — fire-and-forget (Sub-AC 21a): active player sends the suit they chose
 *       in Step 1 of DeclareModal (suit picker).  PRIVATE — stored server-side
 *       but NEVER broadcast to other players.  halfSuitId === null clears the
 *       stored selection when the player presses "Back" or dismisses the modal.
 *   { type: 'declare_progress',  halfSuitId: string|null,
 *                                assignment: { [cardId]: playerId } }
 *     — fire-and-forget: active player streams in-progress card assignment
 *       from Step 2 of the DeclareModal.  Server broadcasts to all OTHER
 *       connected clients (excluding the declarant) so they can show a live
 *       "declaration in progress" banner.  halfSuitId === null signals that
 *       the declaration was cancelled (back-button or modal close).
 *
 * ── Card-request privacy guarantee ────────────────────────────────────────
 *   The "in-progress selection" phase (player picks a card and selects a
 *   target opponent in the AskCardModal) is LOCAL to the active player's
 *   browser.  The server NEVER learns about partial selections.
 *
 *   Only the final `ask_card` message is processed.  The server guarantees:
 *     • Validation errors (NOT_YOUR_TURN, ALREADY_HELD, SAME_TEAM, …) are
 *       returned ONLY to the sending WebSocket connection — never broadcast.
 *     • Spectator game-action attempts return a SPECTATOR error ONLY to the
 *       spectator's connection — never broadcast to player connections.
 *     • Unrecognised message types (e.g. any "preview" message) are rejected
 *       with UNKNOWN_TYPE ONLY to the sender.
 *     • `ask_result`, `game_state`, `game_players` are broadcast to ALL
 *       connected clients (players + spectators) ONLY after a valid ask.
 *     • `hand_update` is sent ONLY to the two players whose hands changed.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ── Server → Client (targeted) ────────────────────────────────────────────
 *   { type: 'game_init',   roomCode, variant, playerCount, myPlayerId,
 *                          myHand: string[], players: [...], gameState: {...} }
 *   { type: 'hand_update', hand: string[] }   — sent after hand changes
 *   { type: 'error',       message, code }
 *
 * ── Server → Room (broadcast) ─────────────────────────────────────────────
 *   { type: 'game_state',  state: { status, currentTurnPlayerId, scores,
 *                                   lastMove, declaredSuits, winner } }
 *   { type: 'game_players', players: [...] }
 *   { type: 'ask_result',  askerId, targetId, cardId, success, newTurnPlayerId }
 *   { type: 'declaration_result', declarerId, halfSuitId, correct, winningTeam,
 *                                  newTurnPlayerId, assignment }
 *   { type: 'game_over',   winner: 1|2|null, tiebreakerWinner, scores }
 *   { type: 'rematch_vote_update', yesCount, noCount, totalCount, humanCount,
 *                                   majority, majorityReached, majorityDeclined,
 *                                   votes, playerVotes }
 *   { type: 'rematch_start',        roomCode }
 *   { type: 'rematch_declined',     reason: 'timeout'|'majority_no' }
 *   { type: 'inference_mode_changed', enabled: boolean, toggledBy: string }
 *   { type: 'bot_takeover',         playerId: string,
 *                                   partialState: { halfSuitId?: string, cardId?: string } | null }
 *     — broadcast when a human player's turn timer expires; includes any
 *       partial wizard state they reported via `partial_selection` messages.
 *   { type: 'declare_progress',    declarerId: string, halfSuitId: string|null,
 *                                   assignedCount: number, totalCards: number,
 *                                   assignment: { [cardId]: playerId } }
 *     — broadcast to ALL EXCEPT the declarant while they are filling out
 *       the card-assignment form.  halfSuitId === null = cancelled.
 *       Clients use this to render a live "X is declaring Low Spades (3/6)" banner.
 *
 * ── Disconnect / reconnect timer events ───────────────────────────────────
 *   { type: 'player_disconnected',  playerId: string }
 *     — broadcast to all OTHER connected clients when a player loses their
 *       WebSocket connection.  Triggers the concurrent timer sequence.
 *   { type: 'player_reconnected',   playerId: string }
 *     — broadcast to all OTHER connected clients when a previously-disconnected
 *       player successfully re-establishes their WebSocket connection and
 *       cancels the running reconnect window.
 *   { type: 'reconnect_timer',      playerId: string,
 *                                   durationMs: number, expiresAt: number }
 *     — broadcast to ALL when the 60-second reconnect window starts.  Clients
 *       use expiresAt to render a countdown indicator for the absent player.
 *   { type: 'reconnect_tick',       playerId: string,
 *                                   remainingMs: number, expiresAt: number }
 *     — broadcast every TIMER_TICK_INTERVAL_MS (5 s) during the reconnect window
 *       so clients can resync their countdown without relying solely on local
 *       clock drift correction.
 *   { type: 'reconnect_expired',    playerId: string }
 *     — broadcast to ALL when the 60-second reconnect window closes without the
 *       player returning.  The bot now holds the seat permanently.
 *   { type: 'seat_reclaimed',       playerId: string, displayName: string }
 *     — broadcast to ALL when the original human player reconnects AFTER the
 *       60-second window expired and regains control of their seat at the next
 *       turn boundary. (Sub-AC 4)
 *
 * ── Seat reclaim (Sub-AC 4) — targeted to the reconnecting player ──────────
 *   { type: 'reclaim_queued',  playerId: string }
 *     — sent ONLY to the original player who reconnected after permanent bot
 *       assignment.  Tells them they are queued for the next turn boundary.
 * ──────────────────────────────────────────────────────────────────────────
 *   { type: 'turn_timer_tick',      playerId: string,
 *                                   remainingMs: number, expiresAt: number }
 *     — broadcast every TIMER_TICK_INTERVAL_MS (5 s) during an active human
 *       turn timer so clients can resync their turn-countdown display.
 */

const { WebSocketServer, WebSocket } = require('ws');
const url = require('url');
const crypto = require('crypto');

const { getGuestSession } = require('../sessions/guestSessionStore');
const { getSupabaseClient } = require('../db/supabase');
const liveGamesStore = require('../liveGames/liveGamesStore');
const {
  setGame,
  getGame,
  hasGame,
  registerConnection,
  removeConnection,
  getRoomConnections,
} = require('./gameStore');
const {
  createGameState,
  serializePublicState,
  serializePlayers,
  serializeForPlayer,
  persistGameState,
  restoreGameState,
  getPlayerTeam,
  getHand,
} = require('./gameState');
const {
  validateAsk,
  applyAsk,
  validateDeclaration,
  applyDeclaration,
  applyForcedFailedDeclaration,
} = require('./gameEngine');
const {
  decideBotMove,
  completeBotFromPartial,
  updateKnowledgeAfterAsk,
  updateKnowledgeAfterDeclaration,
} = require('./botLogic');
const {
  setPartialSelection,
  getPartialSelection,
  clearPartialSelection,
  clearRoomPartialSelections,
  _partialSelections,
} = require('./partialSelectionStore');
const {
  initRematch,
  castVote,
  getVoteSummary,
  hasRematch,
  clearRematch,
} = require('./rematchStore');
const {
  addToReclaimQueue,
  removeFromReclaimQueue,
  isInReclaimQueue,
  clearRoom: clearDisconnectRoom,
} = require('./disconnectStore');
const timerService = require('./timerService');

// ---------------------------------------------------------------------------
// Turn timer configuration
// ---------------------------------------------------------------------------

/** Delay before a bot takes its turn (ms) — gives human UI time to show the previous move */
const BOT_TURN_DELAY_MS = 1500;

/** Time a human player has to act before the server auto-moves for them (ms) */
const HUMAN_TURN_TIMEOUT_MS = 30_000;

/**
 * Extended timeout for the declaration phase (Step 2 of DeclareModal).
 * When the active player enters Step 2 (card-assignment form), the server
 * extends the turn timer from HUMAN_TURN_TIMEOUT_MS to this value and
 * broadcasts a `declaration_timer` event visible only to the declarant.
 * The new timer still calls `executeTimedOutTurn` on expiry.
 *
 * Sub-AC 23a: 60-second declaration phase countdown with 10-second warning.
 */
const DECLARATION_PHASE_TIMEOUT_MS = 60_000;

/**
 * How long the server waits after broadcasting `bot_takeover` for a
 * declaration before auto-submitting the completed assignment.
 *
 * Sub-AC 3 of AC 41: 30-second server-side countdown timer shown to ALL
 * clients so they can display a "bot is declaring" progress bar.
 * The assignment is pre-computed immediately on takeover; the timer is purely
 * cosmetic from a logic perspective but must fire authoritatively server-side.
 */
const BOT_DECLARATION_TAKEOVER_MS = 30_000;

/**
 * Window after disconnect for a player to reconnect before the server treats
 * them as permanently gone.  Runs concurrently with the turn timer when the
 * disconnected player holds the active turn.
 */
const RECONNECT_WINDOW_MS = 60_000;

/**
 * How often tick events are emitted for both the turn timer and the reconnect
 * window.  Clients use tick events to keep their countdown UI accurate without
 * having to drift-correct the initial expiresAt value on their own.
 */
const TIMER_TICK_INTERVAL_MS = 5_000;

/** Pending bot turn timers: roomCode → timeout ID */
const _botTimers = new Map();

/**
 * Active bot-declaration-takeover countdown timers (Sub-AC 3 of AC 41).
 * roomCode → { timerId, tickId, expiresAt }
 *
 * Set when a human's declaration is taken over by the bot.
 * Cleared when the declaration executes (or the turn changes).
 */
const _botDeclarationTimers = new Map();

/** Pending human turn timeout timers: roomCode → { timerId, tickId } */
const _turnTimers = new Map();

/**
 * Rooms where the declaration-phase timer (Sub-AC 23a) has already been
 * started for the current turn.  Prevents the 60-second extension from
 * firing multiple times when the active player sends several consecutive
 * `partial_selection` messages while filling in the card-assignment form.
 *
 * Cleared when the turn ends (cancelTurnTimer / executeTimedOutTurn /
 * handleAskCard / handleDeclare).
 */
const _declarationPhaseStarted = new Set();

/**
 * Active reconnect windows for disconnected human players.
 *
 * Key:   playerId (the original human player)
 * Value: {
 *   roomCode:            string,
 *   originalDisplayName: string,
 *   originalAvatarId:    string|null,
 *   originalIsGuest:     boolean,
 *   timerId:             NodeJS.Timeout,
 *   expiresAt:           number   // epoch ms
 * }
 */
const _reconnectWindows = new Map();

/**
 * Active concurrent reconnect timers (tick-emitting, per-player).
 * Key:   `${roomCode}:${playerId}`
 * Value: `{ timerId, tickId, expiresAt }`
 */
const _reconnectTimers = new Map();

// Partial selection state is managed by partialSelectionStore (imported above).

/**
 * Private declaration suit-selection state (Sub-AC 21a).
 *
 * Tracks which half-suit the active player has chosen in Step 1 of the
 * DeclareModal BEFORE they click "Declare!".  This selection is:
 *   - stored server-side so bot-takeover logic can continue the same suit
 *   - NEVER broadcast to other players or included in `bot_takeover` payload
 *   - cleared when the turn ends (valid action OR timer expiry)
 *
 * Key:   `${roomCode}:${playerId}`
 * Value: `{ halfSuitId: string }` — the suit selected in Step 1
 */
const _declarationSelections = new Map();

/**
 * Tracks declarations taken over by the bot due to mid-declaration disconnect.
 *
 * When the active declarer disconnects while the DeclareModal is open, the
 * server marks the declaration as bot-controlled and preserves the partial
 * card-assignment state so the bot can continue from where the human left off.
 *
 * Key:   roomCode (upper-cased)
 * Value: {
 *   playerId:   string,                   — the original human declarant
 *   halfSuitId: string|null,              — suit chosen in Step 1 (null if not yet chosen)
 *   assignment: Record<string, string>,   — already-assigned card→player mappings
 * }
 *
 * Lifecycle:
 *   - Set:     handlePlayerDisconnect (when active declarer disconnects mid-declaration)
 *   - Cleared: handleDeclare / handleForcedFailedDeclaration / handleAskCard
 *              (any action that ends the current declaration or supersedes it)
 */
const _botControlledDeclarations = new Map();


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a bearer token to a user identity.
 * @param {string|null} token
 * @returns {Promise<{playerId: string, displayName: string, isGuest: boolean}|null>}
 */
async function resolveUser(token) {
  if (!token) return null;

  // 1. Guest session
  const guestSession = getGuestSession(token);
  if (guestSession) {
    return {
      playerId:    guestSession.sessionId,
      displayName: guestSession.displayName,
      avatarId:    guestSession.avatarId ?? null,
      isGuest:     true,
    };
  }

  // 2. Supabase JWT
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    const { user } = data;
    return {
      playerId:    user.id,
      displayName: user.user_metadata?.display_name || user.email,
      avatarId:    user.user_metadata?.avatar_id || null,
      isGuest:     false,
    };
  } catch {
    return null;
  }
}

/**
 * Validate a spectator token against the room in Supabase.
 *
 * The spectator token is the 32-char hex value stored in rooms.spectator_token.
 * It is included in the spectator link shared by the host:
 *   /spectate/<TOKEN>  →  frontend resolves roomCode  →  WS ?spectatorToken=<TOKEN>
 *
 * Returns the minimal room record { id, code, status } if valid, null otherwise.
 *
 * @param {string} roomCode        The 6-char room code from the WS URL path.
 * @param {string} spectatorToken  The token to validate (case-insensitive).
 * @returns {Promise<{id: string, code: string, status: string}|null>}
 */
async function resolveSpectatorToken(roomCode, spectatorToken) {
  if (!spectatorToken || typeof spectatorToken !== 'string') return null;

  const token = spectatorToken.toUpperCase();

  // Spectator tokens are exactly 32 uppercase hex characters.
  if (!/^[0-9A-F]{32}$/.test(token)) return null;

  try {
    const supabase = getSupabaseClient();
    const { data: room, error } = await supabase
      .from('rooms')
      .select('id, code, status')
      .eq('code', roomCode)
      .eq('spectator_token', token)
      .maybeSingle();

    if (error || !room) return null;
    return room;
  } catch {
    return null;
  }
}

/**
 * Send a JSON message to a single WebSocket if it is OPEN.
 * @param {import('ws').WebSocket} ws
 * @param {Object} data
 */
function sendJson(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      console.error('[game-ws] sendJson error:', err.message);
    }
  }
}

/**
 * Broadcast a message to all connected clients in a room.
 * @param {string} roomCode
 * @param {Object} data
 * @param {string} [excludePlayerId]
 */
function broadcastToGame(roomCode, data, excludePlayerId) {
  const connections = getRoomConnections(roomCode);
  for (const [pid, ws] of connections) {
    if (excludePlayerId && pid === excludePlayerId) continue;
    sendJson(ws, data);
  }
}

/**
 * Send a personalized `game_init` to a specific player, plus the public
 * game state and player list to all connected players.
 * @param {Object} gs
 * @param {string} playerId
 * @param {import('ws').WebSocket} ws
 */
function sendGameInit(gs, playerId, ws) {
  sendJson(ws, serializeForPlayer(gs, playerId));
}

/**
 * Broadcast updated public game state and player list to all connected players.
 * Also sends personalized `hand_update` to each player whose hand changed.
 * @param {Object} gs
 * @param {Set<string>} [changedHands] - Player IDs whose hands changed
 */
function broadcastStateUpdate(gs, changedHands = new Set()) {
  const roomCode    = gs.roomCode;
  const connections = getRoomConnections(roomCode);
  const publicState = serializePublicState(gs);
  const players     = serializePlayers(gs);

  for (const [pid, ws] of connections) {
    // Send public state update
    sendJson(ws, { type: 'game_state', state: publicState });
    sendJson(ws, { type: 'game_players', players });

    // Send personalized hand update if this player's hand changed
    if (changedHands.has(pid)) {
      sendJson(ws, { type: 'hand_update', hand: Array.from(getHand(gs, pid)) });
    }
  }
}

// ---------------------------------------------------------------------------
// Stats persistence
// ---------------------------------------------------------------------------

/**
 * Update user_stats in Supabase for all human (non-guest) players after game end.
 * @param {Object} gs
 */
async function updateStats(gs) {
  if (gs.status !== 'completed') return;

  try {
    const supabase = getSupabaseClient();

    for (const player of gs.players) {
      // Skip bots and guests — stats only for registered users
      if (player.isBot || player.isGuest) continue;

      const won = gs.winner === player.teamId;
      const isWin  = gs.winner !== null && won;
      const isLoss = gs.winner !== null && !won;

      // Count correct/incorrect declarations by this player
      let declarationsCorrect = 0;
      let declarationsIncorrect = 0;
      for (const move of gs.moveHistory) {
        if (move.type === 'declaration' && move.declarerId === player.playerId) {
          if (move.correct) declarationsCorrect++;
          else declarationsIncorrect++;
        }
      }

      await supabase.rpc('increment_user_stats', {
        p_user_id:               player.playerId,
        p_games_played:          1,
        p_games_completed:       1,
        p_wins:                  isWin  ? 1 : 0,
        p_losses:                isLoss ? 1 : 0,
        p_declarations_correct:  declarationsCorrect,
        p_declarations_incorrect: declarationsIncorrect,
      }).catch((err) => {
        console.error('[game] stats RPC failed for player', player.playerId, ':', err.message);
      });
    }
  } catch (err) {
    console.error('[game] updateStats error:', err);
  }
}

// ---------------------------------------------------------------------------
// Bot turn scheduling
// ---------------------------------------------------------------------------

/**
 * Schedule a bot turn if the current-turn player is a bot.
 * @param {Object} gs
 */
function scheduleBotTurnIfNeeded(gs) {
  if (gs.status !== 'active') return;

  const currentPlayer = gs.players.find((p) => p.playerId === gs.currentTurnPlayerId);
  if (!currentPlayer || !currentPlayer.isBot) return;

  // ── Sub-AC 4: Seat reclaim at turn boundary ───────────────────────────────
  // If the original human player reconnected after the 60s grace period expired,
  // they are in the reclaim queue.  Execute the reclaim now (at this turn boundary)
  // instead of scheduling a bot turn.  After _executeReclaim returns:
  //   - player.isBot === false
  //   - The calling action handler will call scheduleTurnTimerIfNeeded(gs) next,
  //     which will detect isBot=false and schedule the 30-second human turn timer.
  if (isInReclaimQueue(gs.roomCode, currentPlayer.playerId)) {
    _executeReclaim(gs, currentPlayer.playerId);
    return; // Do NOT schedule a bot turn — human resumes control.
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Cancel any existing timer for this room (avoid double-fires)
  const existingTimer = _botTimers.get(gs.roomCode);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    _botTimers.delete(gs.roomCode);
    executeBotTurn(gs.roomCode, gs.currentTurnPlayerId);
  }, BOT_TURN_DELAY_MS);

  _botTimers.set(gs.roomCode, timer);
}

/**
 * Schedule a server-side turn timer for a human player.
 *
 * When it fires without action, the server auto-executes a move via bot logic.
 *
 * Broadcasts two event families so clients can display a countdown:
 *   - Legacy `turn_timer` (start event) for backward compatibility with
 *     existing client code that reads { playerId, durationMs, expiresAt }.
 *   - `timer_start` / `timer_tick` / `timer_threshold` (every 1 s, plus a
 *     one-time threshold event at ≤10 s) via timerService — broadcast to ALL
 *     players AND spectators in the room.
 *
 * @param {Object} gs
 */
function scheduleTurnTimerIfNeeded(gs) {
  if (gs.status !== 'active') return;

  const currentPlayer = gs.players.find((p) => p.playerId === gs.currentTurnPlayerId);
  if (!currentPlayer || currentPlayer.isBot) return; // bots handled by _botTimers

  // Cancel any existing turn timer (timerService + metadata map).
  cancelTurnTimer(gs.roomCode);

  const playerId = gs.currentTurnPlayerId;
  const roomCode = gs.roomCode;

  // Start the countdown via timerService.
  // timerService handles: 1-second tick events, ≤10 s threshold event, and
  // the expiry callback — all broadcast to ALL connections (players + spectators).
  const { expiresAt } = timerService.startCountdownTimer(
    roomCode,
    'turn',
    playerId,
    HUMAN_TURN_TIMEOUT_MS,
    broadcastToGame,
    (rc, pid) => {
      _turnTimers.delete(rc);
      executeTimedOutTurn(rc, pid);
    },
  );

  // Also broadcast the legacy `turn_timer` event so existing client handlers
  // that read { type:'turn_timer', playerId, durationMs, expiresAt } continue
  // to work without modification.
  broadcastToGame(roomCode, {
    type:       'turn_timer',
    playerId,
    durationMs: HUMAN_TURN_TIMEOUT_MS,
    expiresAt,
  });

  // Track in _turnTimers so concurrent-timer infrastructure (reconnect window)
  // can detect an active turn timer via _turnTimers.has(roomCode).
  _turnTimers.set(roomCode, { expiresAt });
}

/**
 * Cancel the human turn timer (and its tick interval) for a room.
 * Call when a valid move is made or the room is torn down.
 * Also clears the declaration-phase-started flag (Sub-AC 23a).
 * @param {string} roomCode
 */
function cancelTurnTimer(roomCode) {
  // Delegate actual timer cancellation to timerService (handles tickId + timerId).
  timerService.cancelCountdownTimer(roomCode);
  // Clear the metadata entry used by concurrent-timer infrastructure.
  _turnTimers.delete(roomCode);
  // Clear declaration-phase flag so the next turn gets a fresh 60s extension.
  _declarationPhaseStarted.delete(roomCode);
}

/**
 * Start (or replace) the turn timer with a 60-second declaration-phase timer.
 *
 * Called the FIRST TIME the active player reports a `partial_selection` with
 * `flow: 'declare'` AND a non-empty `assignment` (i.e. they entered Step 2 of
 * the DeclareModal card-assignment form).
 *
 * Behaviour:
 *   1. Cancels the existing 30-second turn timer.
 *   2. Starts a 60-second DECLARATION_PHASE_TIMEOUT_MS timer that calls
 *      `executeTimedOutTurn` on expiry (same as the original turn timer).
 *   3. Emits real-time `timer_tick` events every 1 second AND a `timer_threshold`
 *      event at ≤10 s via timerService — broadcast to ALL players and spectators.
 *      (Only the timer countdown is broadcast; the card-assignment choices remain
 *      private until the player submits or times out.)
 *   4. Broadcasts a `declaration_timer` event to ALL connections (players +
 *      spectators) so the entire table sees the declaration countdown.
 *
 * Sub-AC 23a / 36.1.
 *
 * @param {string} roomCode
 * @param {string} playerId  — The declaring player who entered Step 2.
 */
function startDeclarationPhaseTimer(roomCode, playerId) {
  // Cancel the existing 30-second turn timer (via timerService + metadata map).
  cancelTurnTimer(roomCode);

  // Start the 60-second countdown via timerService.
  // Broadcasts `timer_start`, `timer_tick` (every 1 s), and `timer_threshold`
  // (once at ≤10 s) to ALL connections (players + spectators).
  const { expiresAt } = timerService.startCountdownTimer(
    roomCode,
    'declaration',
    playerId,
    DECLARATION_PHASE_TIMEOUT_MS,
    broadcastToGame,
    (rc, pid) => {
      _turnTimers.delete(rc);
      _declarationPhaseStarted.delete(rc);
      executeTimedOutTurn(rc, pid);
    },
  );

  // Track in _turnTimers with isDeclarationPhase flag so executeTimedOutTurn
  // can detect that a declaration was in progress when the timer fired.
  _turnTimers.set(roomCode, { expiresAt, isDeclarationPhase: true });

  // Broadcast the legacy `declaration_timer` event to ALL connections
  // (players + spectators) so everyone on the table can show the 60-second
  // countdown.  Only the assignment details remain private — this event only
  // carries { playerId, durationMs, expiresAt }.
  broadcastToGame(roomCode, {
    type:       'declaration_timer',
    playerId,
    durationMs: DECLARATION_PHASE_TIMEOUT_MS,
    expiresAt,
  });
}

/**
 * Cancel the pending bot turn timer for a room.
 * Useful for test teardown when the previous test's disconnect handler
 * scheduled a bot turn that would otherwise fire into the next test.
 * @param {string} roomCode
 */
function cancelBotTimer(roomCode) {
  const t = _botTimers.get(roomCode);
  if (t) {
    clearTimeout(t);
    _botTimers.delete(roomCode);
  }
}

/**
 * Cancel an active bot-declaration-takeover countdown timer for a room.
 * Called when the turn ends (ask supersedes the declaration, game ends, etc.)
 * so the delayed auto-submit does not fire into the wrong game state.
 *
 * @param {string} roomCode
 */
function cancelBotDeclarationTimer(roomCode) {
  const entry = _botDeclarationTimers.get(roomCode);
  if (entry) {
    clearTimeout(entry.timerId);
    if (entry.tickId) clearInterval(entry.tickId);
    _botDeclarationTimers.delete(roomCode);
  }
}

/**
 * Sanitize a partial selection for inclusion in a `bot_takeover` broadcast.
 *
 * Privacy guarantee (Sub-AC 21a): The `halfSuitId` and `assignment` chosen
 * during the declaration flow are PRIVATE to the declaring player — they must
 * NOT be broadcast to other players before the final `declare_suit` is sent.
 *
 * For the ASK flow, the half-suit and card are safe to include because the
 * `bot_takeover` event only fires AFTER the turn timer expires and the bot is
 * already auto-executing the move; the card choice is public at that point.
 *
 * @param {Object|null} partialState
 * @returns {Object|null}  Sanitized version safe to broadcast.
 */
function sanitizePartialStateForBroadcast(partialState) {
  if (!partialState) return null;
  // Declaration flow: redact the chosen half-suit and assignment.
  // Other clients should only know that a declaration was in progress.
  if (partialState.flow === 'declare') {
    return { flow: 'declare' };
  }
  // Ask flow: safe to broadcast as-is (half-suit + card choice).
  return partialState;
}

// ---------------------------------------------------------------------------
// Bot-declaration takeover countdown (Sub-AC 3 of AC 41)
// ---------------------------------------------------------------------------

/**
 * Start a 30-second server-side countdown after a bot takes over a
 * declaration from a human player.
 *
 * Sequence:
 *   1. Pre-compute the completed assignment using completeBotFromPartial.
 *   2. Broadcast bot_declaration_timer to ALL players so the UI can show
 *      a visible countdown bar (distinct from the private human declarant timer).
 *   3. Emit bot_declaration_timer_tick every TIMER_TICK_INTERVAL_MS to ALL
 *      players for countdown re-sync.
 *   4. After BOT_DECLARATION_TAKEOVER_MS, auto-submit the declaration via
 *      handleDeclare and broadcast the result to all players.
 *
 * Privacy: The assignment is NOT included in the timer broadcast — only the
 * duration/expiresAt fields are sent.  The result is revealed when handleDeclare
 * emits declaration_result as usual.
 *
 * @param {string}      roomCode
 * @param {string}      playerId       - Original human declarant (now bot-controlled)
 * @param {Object|null} effectivePartial - Partial state to complete from
 */
async function startBotDeclarationCountdown(roomCode, playerId, effectivePartial) {
  // Pre-compute the bot declaration decision right now
  const gs = getGame(roomCode);
  if (!gs || gs.status !== 'active' || gs.currentTurnPlayerId !== playerId) return;

  const decision = completeBotFromPartial(gs, playerId, effectivePartial);
  // If bot cannot declare (e.g., fell back to ask or pass), execute immediately.
  if (decision.action !== 'declare') {
    if (decision.action === 'ask') {
      await handleAskCard(roomCode, playerId, decision.targetId, decision.cardId, null, false);
    }
    return;
  }

  const { halfSuitId, assignment } = decision;
  const expiresAt = Date.now() + BOT_DECLARATION_TAKEOVER_MS;

  // Emit tick events every TIMER_TICK_INTERVAL_MS to ALL connected clients
  const tickId = setInterval(() => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      clearInterval(tickId);
      return;
    }
    broadcastToGame(roomCode, {
      type:        'bot_declaration_timer_tick',
      playerId,
      remainingMs: Math.max(0, remaining),
      expiresAt,
    });
  }, TIMER_TICK_INTERVAL_MS);

  const timerId = setTimeout(async () => {
    const entry = _botDeclarationTimers.get(roomCode);
    if (entry && entry.tickId) clearInterval(entry.tickId);
    _botDeclarationTimers.delete(roomCode);

    // Re-validate that this is still the active turn (game may have ended)
    const currentGs = getGame(roomCode);
    if (!currentGs || currentGs.status !== 'active' || currentGs.currentTurnPlayerId !== playerId) {
      return;
    }

    console.log(
      '[game-ws] Bot declaration timer expired for ' + playerId + ' in room ' + roomCode + ' — auto-submitting'
    );
    await handleDeclare(roomCode, playerId, halfSuitId, assignment, null, false);
  }, BOT_DECLARATION_TAKEOVER_MS);

  _botDeclarationTimers.set(roomCode, { timerId, tickId, expiresAt });

  // Broadcast the timer start to ALL clients (public — bot is visibly declaring)
  broadcastToGame(roomCode, {
    type:       'bot_declaration_timer',
    playerId,
    durationMs: BOT_DECLARATION_TAKEOVER_MS,
    expiresAt,
  });
}

// ---------------------------------------------------------------------------
// Reconnect window helpers
// ---------------------------------------------------------------------------

/**
 * Cancel and remove an existing reconnect window for a player.
 * Safe to call even when no window exists.
 * @param {string} playerId
 */
function _cancelReconnectWindow(playerId) {
  const entry = _reconnectWindows.get(playerId);
  if (entry) {
    clearTimeout(entry.timerId);
    if (entry.tickId) clearInterval(entry.tickId);
    _reconnectWindows.delete(playerId);
  }
}

/**
 * Cancel ALL active reconnect-window timers and clear the map.
 *
 * Exported for test teardown only — not used in production paths.
 * Calling this ensures no 60-second expiry timer fires after a test suite
 * has finished, preventing "Cannot log after tests are done" warnings.
 */
function _clearAllReconnectWindows() {
  for (const [, entry] of _reconnectWindows.entries()) {
    if (entry.timerId) clearTimeout(entry.timerId);
    if (entry.tickId)  clearInterval(entry.tickId);
  }
  _reconnectWindows.clear();
}

/**
 * Execute a seat reclaim for an original human player at a turn boundary.
 *
 * Called from `scheduleBotTurnIfNeeded` when the current-turn player is
 * bot-flagged but has a pending reclaim entry in disconnectStore.
 * Restores the human flag, removes the reclaim entry, broadcasts updates,
 * and persists the change.  After this returns, the calling code falls
 * through to `scheduleTurnTimerIfNeeded` which will see `isBot = false`
 * and start the 30-second human turn timer.
 *
 * Sub-AC 4: Mid-game reclaim at next turn boundary.
 *
 * @param {Object} gs        - Current GameState (mutated in place)
 * @param {string} playerId  - The original human player reclaiming their seat
 */
function _executeReclaim(gs, playerId) {
  const player = gs.players.find((p) => p.playerId === playerId);
  if (!player) return;

  // Restore human seat — flip bot flag back, clear the permanent-replacement marker.
  player.isBot = false;
  delete player.botReplacedAt;

  // Remove from the reclaim queue so this only fires once.
  removeFromReclaimQueue(gs.roomCode, playerId);

  console.log(
    `[game-ws] Player ${playerId} reclaimed permanent bot seat in room ${gs.roomCode} ` +
    `at turn boundary`
  );

  // Notify ALL clients that the human has reclaimed their seat.
  broadcastToGame(gs.roomCode, {
    type:        'seat_reclaimed',
    playerId,
    displayName: player.displayName,
  });

  // Broadcast updated player list so the bot badge disappears from this seat.
  broadcastToGame(gs.roomCode, {
    type:    'game_players',
    players: serializePlayers(gs),
  });

  // Persist the restored human state for crash recovery (fire-and-forget).
  persistGameState(gs, getSupabaseClient()).catch((err) => {
    console.error('[game-ws] Failed to persist game state after seat reclaim:', err.message);
  });
}

/**
 * Start the 60-second reconnect window for a disconnected human player.
 *
 * Immediately marks the player's game slot as bot-controlled so the game can
 * continue.  Broadcasts `player_disconnected` to all remaining connections.
 * Schedules a bot turn if it is currently the disconnected player's turn.
 *
 * After RECONNECT_WINDOW_MS, if the player has not reconnected:
 *   - The reconnect window entry is removed (bot keeps the slot permanently).
 *   - `reconnect_expired` is broadcast to all remaining connections.
 *
 * @param {Object} gs      - Current GameState (mutated in-place)
 * @param {Object} player  - The player entry in gs.players (mutated in-place)
 */
function _startReconnectWindow(gs, player) {
  const playerId = player.playerId;
  const roomCode = gs.roomCode;

  // Cancel any stale window for this player (guard against rapid disconnect/reconnect)
  _cancelReconnectWindow(playerId);

  // Capture original player identity before switching to bot mode.
  const originalDisplayName = player.displayName;
  const originalAvatarId    = player.avatarId;
  const originalIsGuest     = player.isGuest;

  const expiresAt = Date.now() + RECONNECT_WINDOW_MS;

  // ── 30-second turn timer (concurrent) ────────────────────────────────────
  // Start the turn timer BEFORE marking the player as bot so that
  // scheduleTurnTimerIfNeeded sees isBot === false and sets the 30-second
  // timer (rather than skipping it).  This timer runs concurrently with
  // the 60-second reconnect window below.
  if (gs.currentTurnPlayerId === playerId) {
    scheduleTurnTimerIfNeeded(gs);
  }

  // Temporarily mark this seat as bot-controlled so the game can proceed.
  player.isBot = true;

  // ── Expiry timer ───────────────────────────────────────────────────────────
  const timerId = setTimeout(() => {
    const winEntry = _reconnectWindows.get(playerId);
    if (winEntry && winEntry.tickId) clearInterval(winEntry.tickId);
    _reconnectWindows.delete(playerId);
    console.log(
      `[game-ws] Reconnect window expired for player ${playerId} in room ${roomCode} ` +
      '— bot takes over permanently'
    );

    // ── Sub-AC 4: Mark permanent bot assignment ───────────────────────────
    // Stamp the player object so late reconnects can be detected and queued
    // for the next turn boundary reclaim.
    const currentGs = getGame(roomCode);
    if (currentGs && currentGs.status === 'active') {
      const p = currentGs.players.find((pl) => pl.playerId === playerId);
      if (p && p.isBot) {
        p.botReplacedAt = Date.now();
        // Persist the permanent replacement to Supabase so crash recovery
        // can identify formerly-human slots.
        persistGameState(currentGs, getSupabaseClient()).catch((err) => {
          console.error('[game-ws] Failed to persist botReplacedAt stamp:', err.message);
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    // Expiry event: clients remove the reconnect countdown for this player.
    broadcastToGame(roomCode, { type: 'reconnect_expired', playerId });
  }, RECONNECT_WINDOW_MS);

  // ── Tick interval ─────────────────────────────────────────────────────────
  // Emit periodic ticks so clients can resync their countdown without
  // relying solely on the initial expiresAt timestamp.
  const tickId = setInterval(() => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      clearInterval(tickId);
      return;
    }
    broadcastToGame(roomCode, {
      type:        'reconnect_tick',
      playerId,
      remainingMs: Math.max(0, remaining),
      expiresAt,
    });
  }, TIMER_TICK_INTERVAL_MS);

  _reconnectWindows.set(playerId, {
    roomCode,
    originalDisplayName,
    originalAvatarId,
    originalIsGuest,
    timerId,
    tickId,
    expiresAt,
  });

  // ── Broadcast events ───────────────────────────────────────────────────────
  // 1. player_disconnected: existing event (backwards-compat), includes deadline.
  broadcastToGame(roomCode, {
    type:              'player_disconnected',
    playerId,
    reconnectWindowMs: RECONNECT_WINDOW_MS,
    expiresAt,
  }, playerId);

  // 2. reconnect_timer: new canonical start event with standardised shape,
  //    broadcast to ALL clients (including the disconnected one if reconnecting).
  broadcastToGame(roomCode, {
    type:       'reconnect_timer',
    playerId,
    durationMs: RECONNECT_WINDOW_MS,
    expiresAt,
  });

  // Broadcast updated player list so the bot badge appears on the seat.
  broadcastStateUpdate(gs);

  // ── Bot timer ─────────────────────────────────────────────────────────────
  // Schedule the bot to act after the bot-turn delay. This runs alongside the
  // 30-second turn timer (both fire concurrently); whichever fires first wins.
  if (gs.currentTurnPlayerId === playerId) {
    scheduleBotTurnIfNeeded(gs);
  }

  console.log(
    `[game-ws] Player ${playerId} disconnected from room ${roomCode} — ` +
    `concurrent 30s turn timer + ${RECONNECT_WINDOW_MS / 1000}s reconnect window started`
  );
}

// ---------------------------------------------------------------------------
// Public reconnect timer API (exported for external use and testing)
// ---------------------------------------------------------------------------

/**
 * Start the 60-second reconnect window (tick-emitting) for a disconnected player.
 *
 * This is a lightweight public API that emits events via _reconnectTimers (as
 * opposed to the full-featured _startReconnectWindow which also manages player
 * state).  Use this when you only need the timer+event infrastructure without
 * the bot-slot logic.
 *
 * Emits:
 *   `reconnect_timer`  — start event broadcast to all clients
 *   `reconnect_tick`   — every TIMER_TICK_INTERVAL_MS (5 s)
 *   `reconnect_expired`— when window closes without reconnect
 *
 * @param {string} roomCode
 * @param {string} playerId
 */
function startReconnectWindow(roomCode, playerId) {
  const key = `${roomCode}:${playerId}`;

  // Cancel any stale timer entry
  const existing = _reconnectTimers.get(key);
  if (existing) {
    clearTimeout(existing.timerId);
    if (existing.tickId) clearInterval(existing.tickId);
    _reconnectTimers.delete(key);
  }

  const expiresAt = Date.now() + RECONNECT_WINDOW_MS;

  // Start event
  broadcastToGame(roomCode, {
    type:       'reconnect_timer',
    playerId,
    durationMs: RECONNECT_WINDOW_MS,
    expiresAt,
  });

  // Tick events
  const tickId = setInterval(() => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      clearInterval(tickId);
      return;
    }
    broadcastToGame(roomCode, {
      type:        'reconnect_tick',
      playerId,
      remainingMs: Math.max(0, remaining),
      expiresAt,
    });
  }, TIMER_TICK_INTERVAL_MS);

  // Expiry timer
  const timerId = setTimeout(() => {
    const entry = _reconnectTimers.get(key);
    if (entry && entry.tickId) clearInterval(entry.tickId);
    _reconnectTimers.delete(key);
    broadcastToGame(roomCode, { type: 'reconnect_expired', playerId });
    console.log(`[game-ws] reconnect_expired for player ${playerId} in room ${roomCode}`);
  }, RECONNECT_WINDOW_MS);

  _reconnectTimers.set(key, { timerId, tickId, expiresAt });
}

/**
 * Cancel the tick-based reconnect window for a player.
 *
 * Works for both _reconnectTimers (startReconnectWindow) entries and
 * _reconnectWindows (_startReconnectWindow) entries for the given room.
 *
 * @param {string} roomCode
 * @param {string} playerId
 */
function cancelReconnectWindow(roomCode, playerId) {
  // Tick-based timer (_reconnectTimers)
  const key   = `${roomCode}:${playerId}`;
  const entry = _reconnectTimers.get(key);
  if (entry) {
    clearTimeout(entry.timerId);
    if (entry.tickId) clearInterval(entry.tickId);
    _reconnectTimers.delete(key);
  }
  // Full reconnect window (_reconnectWindows) for the same player+room
  const legacyEntry = _reconnectWindows.get(playerId);
  if (legacyEntry && legacyEntry.roomCode === roomCode) {
    _cancelReconnectWindow(playerId);
  }
}

/**
 * Handle a player disconnect — single public entry point for disconnect-triggered
 * timer logic.  Unlike _startReconnectWindow this function does NOT mutate the
 * game state (no bot marking) — it only starts the timer infrastructure and
 * emits events.
 *
 * Orchestrates the concurrent timer sequence:
 *   1. Broadcasts `player_disconnected` to all OTHER connected clients.
 *   2. If the game is active: starts the 60-second reconnect window
 *      (`reconnect_timer` → `reconnect_tick` → `reconnect_expired`).
 *   3. If the disconnected player holds the active turn: ALSO starts the
 *      30-second turn timer concurrently (`turn_timer` → `turn_timer_tick`
 *      → `bot_takeover`).
 *
 * Spectators disconnecting are silently ignored.
 *
 * @param {string}  roomCode
 * @param {string}  playerId
 * @param {boolean} isSpectator
 */
function handlePlayerDisconnect(roomCode, playerId, isSpectator) {
  if (isSpectator) return; // spectator disconnect is silent

  // Notify remaining clients
  broadcastToGame(roomCode, { type: 'player_disconnected', playerId }, playerId);

  const gs = getGame(roomCode);
  if (!gs || gs.status !== 'active') return;

  // ── Detect mid-declaration disconnect ─────────────────────────────────────
  // If the disconnecting player is currently the active turn holder AND they
  // are mid-declaration (DeclareModal open), mark the declaration as bot-
  // controlled and preserve the already-assigned card mappings so the bot
  // can continue from exactly where the human left off.
  if (gs.currentTurnPlayerId === playerId) {
    const partial    = getPartialSelection(roomCode, playerId);
    const declKey    = `${roomCode}:${playerId}`;
    const declSel    = _declarationSelections.get(declKey) ?? null;

    // Three signals that indicate the player is mid-declaration:
    //   1. partialSelectionStore has a 'declare'-flow entry (player reached Step 2)
    //   2. _declarationSelections has an entry (player chose a suit in Step 1)
    //   3. _declarationPhaseStarted has the roomCode (declaration phase timer fired)
    const isMidDeclaration =
      partial?.flow === 'declare' ||
      declSel !== null ||
      _declarationPhaseStarted.has(roomCode);

    if (isMidDeclaration) {
      // Preserve the best available half-suit and assignment data.
      // The partial selection (Step 2) is more complete than declSel (Step 1 only).
      const halfSuitId = partial?.halfSuitId ?? declSel?.halfSuitId ?? null;
      const assignment = (partial?.flow === 'declare' && partial.assignment)
        ? { ...partial.assignment }
        : {};

      _botControlledDeclarations.set(roomCode, {
        playerId,
        halfSuitId,
        assignment,
      });

      console.log(
        `[game-ws] Player ${playerId} disconnected mid-declaration in room ${roomCode} — ` +
        `bot takeover marked (halfSuit=${halfSuitId}, ` +
        `assigned=${Object.keys(assignment).length}/6)`
      );
    }
  }

  // ── Concurrent timers ──────────────────────────────────────────────────────
  // 1. Always start the 60-second reconnect window for any human player
  startReconnectWindow(roomCode, playerId);

  // 2. If this player holds the active turn, also start the 30-second turn timer
  if (gs.currentTurnPlayerId === playerId) {
    scheduleTurnTimerIfNeeded(gs);
  }
}

/**
 * Store a private suit selection for the declaring player (Step 1 of DeclareModal).
 *
 * Called when the active player sends `declare_selecting` — they have picked
 * a half-suit to declare but have not yet confirmed.  This selection is stored
 * server-side so `executeTimedOutTurn` can continue the correct suit if the
 * timer fires.  It is NEVER broadcast to other players.
 *
 * Pass `halfSuitId = null | undefined` to clear the stored selection (player
 * pressed "Back" to return to Step 1 or closed the modal).
 *
 * @param {string}      roomCode
 * @param {string}      playerId
 * @param {string|null} halfSuitId
 */
function handleDeclareSelecting(roomCode, playerId, halfSuitId) {
  const gs = getGame(roomCode);
  if (!gs || gs.status !== 'active') return;
  if (gs.currentTurnPlayerId !== playerId) return; // only active player

  const key = `${roomCode}:${playerId}`;
  if (halfSuitId && typeof halfSuitId === 'string') {
    _declarationSelections.set(key, { halfSuitId });
  } else {
    // Player went back or cancelled — clear the stored suit.
    _declarationSelections.delete(key);
  }
}

/**
 * Auto-execute a move for a human player who timed out.
 * Uses bot logic to pick the best available action.
 *
 * Before executing the move, broadcasts a `bot_takeover` event to all clients
 * in the room so they can display a takeover animation.  The event includes any
 * partial card-selection state the player reported via `partial_selection`
 * messages while navigating the 3-step wizard.
 *
 * ── Privacy boundary (Sub-AC 21a) ───────────────────────────────────────────
 * The `bot_takeover` broadcast uses a SANITIZED version of the partial state:
 *   • For the ask flow: includes halfSuitId/cardId (already-public intent).
 *   • For the declare flow: only `{ flow: 'declare' }` — never the halfSuitId
 *     or assignment, which remain private until `declare_suit` is submitted.
 * The full partial state (with halfSuitId) is passed to `completeBotFromPartial`
 * internally so the bot can continue the correct declaration.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * @param {string} roomCode
 * @param {string} playerId
 */
async function executeTimedOutTurn(roomCode, playerId) {
  const gs = getGame(roomCode);
  if (!gs || gs.status !== 'active' || gs.currentTurnPlayerId !== playerId) return;

  console.log(`[game-ws] Turn timeout for player ${playerId} in room ${roomCode} — auto-moving`);

  // Retrieve any partial selection the player had in progress, then clear it.
  const partialState = getPartialSelection(roomCode, playerId);
  clearPartialSelection(roomCode, playerId);

  // Retrieve private declaration selection (Step 1 suit choice), then clear it.
  const declarationKey       = `${roomCode}:${playerId}`;
  const declarationSelection = _declarationSelections.get(declarationKey) ?? null;
  _declarationSelections.delete(declarationKey);
  // Clear declaration-phase-started flag so the next turn starts fresh (Sub-AC 23a).
  _declarationPhaseStarted.delete(roomCode);

  // Broadcast bot_takeover with SANITIZED partial state — never reveals which
  // half-suit the declaring player had selected before confirmation (Sub-AC 21a).
  broadcastToGame(roomCode, {
    type:         'bot_takeover',
    playerId,
    partialState: sanitizePartialStateForBroadcast(partialState),
  });

  // For bot logic, use the full partial state.  If only a Step-1 suit was
  // chosen (declare_selecting but no Step-2 assignment yet), synthesize a
  // minimal declare partial so the bot continues with the same suit.
  const effectivePartial = partialState
    ?? (declarationSelection
      ? { flow: 'declare', halfSuitId: declarationSelection.halfSuitId }
      : null);

  // ── AC 24: Declaration timer expiry with incomplete assignment → forced failure ──
  //
  // When a CONNECTED human player (not in the reconnect window) times out
  // while mid-declaration with fewer than all 6 cards assigned, the server
  // treats the attempt as a failed declaration and awards the point to the
  // opposing team.
  //
  // A DISCONNECTED player (in `_reconnectWindows`) falls through to the bot-
  // completion path so the seat's bot can finish the declaration instead.
  if (effectivePartial?.flow === 'declare') {
    const isDisconnected = _reconnectWindows.has(playerId);
    if (!isDisconnected) {
      const halfSuitId    = effectivePartial.halfSuitId;
      const assignment    = effectivePartial.assignment ?? {};
      const assignedCount = Object.keys(assignment).length;
      // All half-suits have exactly 6 cards; fewer than 6 means incomplete.
      if (halfSuitId && assignedCount < 6) {
        await handleForcedFailedDeclaration(roomCode, playerId, halfSuitId);
        return;
      }
      // If exactly 6 cards are assigned, fall through to completeBotFromPartial
      // which will validate and execute the complete declaration.
    }
  }

  // ── Sub-AC 3 of AC 41: Bot declaration takeover countdown ────────────────
  // When the human timed out mid-declaration (either with a complete 6-card
  // assignment OR while disconnected), start a 30-second visible countdown
  // before the bot auto-submits.  This gives all clients time to show a
  // "bot is declaring" progress bar.  The assignment is pre-computed now
  // but not revealed until the timer fires and handleDeclare broadcasts the result.
  if (effectivePartial?.flow === 'declare') {
    await startBotDeclarationCountdown(roomCode, playerId, effectivePartial);
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Complete the action: use partial state if available, otherwise full bot logic.
  const decision = completeBotFromPartial(gs, playerId, effectivePartial);
  if (decision.action === 'ask') {
    await handleAskCard(roomCode, playerId, decision.targetId, decision.cardId, null, false);
  } else if (decision.action === 'declare') {
    await handleDeclare(roomCode, playerId, decision.halfSuitId, decision.assignment, null, false);
  }
}

/**
 * Store a partial card-selection state reported by the active player.
 *
 * Only accepted if:
 *   - The game is active.
 *   - The sender is the current-turn player.
 *
 * The stored partial is used by `executeTimedOutTurn` to deterministically
 * complete the move from where the player left off.
 *
 * Partial selection shapes (mirroring partialSelectionStore contract):
 *   Ask step 2 (half-suit chosen):
 *     { flow: 'ask', halfSuitId: string }
 *   Ask step 3 (card also chosen):
 *     { flow: 'ask', halfSuitId: string, cardId: string }
 *   Declare (suit chosen + current assignment):
 *     { flow: 'declare', halfSuitId: string, assignment: Record<string,string> }
 *
 * @param {string} roomCode
 * @param {string} playerId    - The player reporting their partial state.
 * @param {string} flow        - 'ask' or 'declare'
 * @param {string|undefined}  halfSuitId
 * @param {string|undefined}  cardId       - Only for 'ask' flow (step 3)
 * @param {Object|undefined}  assignment   - Only for 'declare' flow
 */
function handlePartialSelection(roomCode, playerId, flow, halfSuitId, cardId, assignment) {
  const gs = getGame(roomCode);
  if (!gs || gs.status !== 'active') return;
  if (gs.currentTurnPlayerId !== playerId) return; // ignore if not their turn
  if (flow !== 'ask' && flow !== 'declare') return; // ignore unknown flows
  if (!halfSuitId) return; // half-suit is the minimum required context

  const partial = { flow, halfSuitId };
  if (flow === 'ask' && typeof cardId === 'string') {
    partial.cardId = cardId;
  }
  if (flow === 'declare' && assignment && typeof assignment === 'object') {
    partial.assignment = assignment;
  }

  setPartialSelection(roomCode, playerId, partial);

  // ── Declaration phase timer extension (Sub-AC 23a) ───────────────────────
  // The first time the active player reports Step 2 of the declaration flow
  // (flow: 'declare' with a non-empty assignment), extend the turn timer to
  // 60 seconds so the player has enough time to assign all 6 cards.
  //
  // We guard with `_declarationPhaseStarted` to avoid re-triggering the
  // extension on every subsequent partial_selection update as the player
  // changes individual card assignments.
  if (
    flow === 'declare' &&
    assignment &&
    typeof assignment === 'object' &&
    Object.keys(assignment).length > 0 &&
    !_declarationPhaseStarted.has(roomCode)
  ) {
    _declarationPhaseStarted.add(roomCode);
    startDeclarationPhaseTimer(roomCode, playerId);
  }
}

/**
 * Execute a bot turn.
 * @param {string} roomCode
 * @param {string} botId
 */
async function executeBotTurn(roomCode, botId) {
  const gs = getGame(roomCode);
  if (!gs || gs.status !== 'active') return;
  if (gs.currentTurnPlayerId !== botId) return; // Turn changed since scheduled

  // Guard: if a disconnected human player reclaimed their seat while this
  // timer was in flight, their isBot flag is now false.  Do not execute.
  const currentPlayer = gs.players.find((p) => p.playerId === botId);
  if (!currentPlayer || !currentPlayer.isBot) return;

  const decision = decideBotMove(gs, botId);

  if (decision.action === 'ask') {
    await handleAskCard(roomCode, botId, decision.targetId, decision.cardId, null, true);
  } else if (decision.action === 'declare') {
    await handleDeclare(roomCode, botId, decision.halfSuitId, decision.assignment, null, true);
  }
  // 'pass' — should not normally happen; just schedule next bot turn if needed
  else {
    scheduleBotTurnIfNeeded(gs);
  }
}

// ---------------------------------------------------------------------------
// Action handlers (shared between human WS messages and bot execution)
// ---------------------------------------------------------------------------

/**
 * Handle an ask-card action.
 *
 * ── Privacy boundary ────────────────────────────────────────────────────────
 * The "in-progress selection" phase (player opens the modal, picks a card,
 * and selects a target) is PURELY LOCAL to the active player's browser.
 * No WebSocket event is emitted until the player explicitly clicks "Ask",
 * at which point a single `ask_card` message is sent here.
 *
 * Server-side enforcement:
 *   1. validateAsk() rejects any message from a non-active player with
 *      NOT_YOUR_TURN — the error is returned ONLY to the sender's WS (`ws`),
 *      not broadcast to the room.  No other player learns about the attempt.
 *   2. If validation fails for any other reason (ALREADY_HELD, SAME_TEAM, etc.)
 *      the error is similarly returned ONLY to `ws` and the function returns
 *      immediately without touching game state or broadcasting anything.
 *   3. Only after a VALID ask is applied does `broadcastToGame` fire for
 *      `ask_result`, `game_state`, and `game_players`.
 *   4. `hand_update` is sent only to the two affected players (asker and
 *      target) via `broadcastStateUpdate(gs, changedHands)`.
 *   5. Spectators are blocked one layer up: the `ws.on('message')` handler
 *      returns a SPECTATOR error to the spectator's WS only if they try to
 *      send any message, never reaching this function.
 *   6. Unrecognised message types (e.g. any future "preview" event) are
 *      rejected with UNKNOWN_TYPE at the switch-default handler — only to
 *      the sender.  They never reach this function.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * @param {string} roomCode
 * @param {string} askerId
 * @param {string} targetId
 * @param {string} cardId
 * @param {import('ws').WebSocket|null} ws  - The asker's WS (null for bots)
 * @param {boolean} isBot
 */
async function handleAskCard(roomCode, askerId, targetId, cardId, ws, isBot = false) {
  const gs = getGame(roomCode);
  if (!gs) {
    if (ws) sendJson(ws, { type: 'error', message: 'Game not found', code: 'GAME_NOT_FOUND' });
    return;
  }

  const validation = validateAsk(gs, askerId, targetId, cardId);
  if (!validation.valid) {
    if (ws) sendJson(ws, { type: 'error', message: validation.error, code: validation.errorCode });
    return;
  }

  // Cancel human turn timer — valid action received
  cancelTurnTimer(roomCode);

  // Clear any stored partial selection for this player (move is complete)
  clearPartialSelection(roomCode, askerId);
  // Clear any stored declaration selection (ask move supersedes any pending declare)
  _declarationSelections.delete(`${roomCode}:${askerId}`);
  // Clear bot-controlled declaration tracking — ask supersedes any mid-declaration state
  _botControlledDeclarations.delete(roomCode);
  // Cancel any active bot-declaration countdown — ask supersedes the pending declaration
  cancelBotDeclarationTimer(roomCode);

  // Track which hands changed
  const changedHands = new Set([askerId, targetId]);

  // Apply the ask (mutates gs)
  const { success, newTurnPlayerId, lastMove } = applyAsk(gs, askerId, targetId, cardId);

  // Update bot knowledge
  updateKnowledgeAfterAsk(gs, askerId, targetId, cardId, success);

  // Broadcast ask result to all players
  broadcastToGame(roomCode, {
    type:            'ask_result',
    askerId,
    targetId,
    cardId,
    success,
    newTurnPlayerId,
    lastMove,
  });

  // Broadcast updated state + personalized hands
  broadcastStateUpdate(gs, changedHands);

  // Persist to Supabase
  const supabase = getSupabaseClient();
  await persistGameState(gs, supabase);

  // Schedule next bot turn or human turn timer as needed
  scheduleBotTurnIfNeeded(gs);
  scheduleTurnTimerIfNeeded(gs);
}

// ---------------------------------------------------------------------------
// Forced-failed declaration handler (AC 24)
// ---------------------------------------------------------------------------

/**
 * Execute a forced-failed declaration when the turn timer fires while a
 * connected human player has an incomplete card assignment.
 *
 * Awards the point to the opposing team unconditionally, removes all 6
 * half-suit cards from play, and broadcasts `declaration_result` with
 * `correct: false, timedOut: true`.
 *
 * Only called for CONNECTED players whose timer expired mid-declaration
 * (i.e. player is NOT in `_reconnectWindows`).  Disconnected players in
 * the reconnect window fall through to the bot-completion path instead
 * (handled by the disconnect-midgame AC).
 *
 * @param {string} roomCode
 * @param {string} declarerId
 * @param {string} halfSuitId
 */
async function handleForcedFailedDeclaration(roomCode, declarerId, halfSuitId) {
  const gs = getGame(roomCode);
  if (!gs || gs.status !== 'active') return;

  // Clear bot-controlled declaration tracking — forced failure resolves the declaration
  _botControlledDeclarations.delete(roomCode);
  // Cancel any active bot-declaration countdown (forced failure supersedes it)
  cancelBotDeclarationTimer(roomCode);

  // All hands may change (6 cards removed)
  const changedHands = new Set(gs.players.map((p) => p.playerId));

  // Apply forced failure (mutates gs)
  const { winningTeam, newTurnPlayerId, lastMove } = applyForcedFailedDeclaration(
    gs, declarerId, halfSuitId
  );

  // Update bot knowledge — cards are gone; no assignment to record
  updateKnowledgeAfterDeclaration(gs, halfSuitId, {}, false);

  // Broadcast declaration result
  broadcastToGame(roomCode, {
    type:            'declaration_result',
    declarerId,
    halfSuitId,
    correct:         false,
    timedOut:        true,
    winningTeam,
    newTurnPlayerId,
    assignment:      null,
    lastMove,
  });

  // Broadcast updated state + personalized hands
  broadcastStateUpdate(gs, changedHands);

  // Update live games store with new scores
  if (liveGamesStore.get(roomCode)) {
    liveGamesStore.updateGame(roomCode, { scores: { ...gs.scores } });
  }

  // Handle game over
  if (gs.status === 'completed') {
    broadcastToGame(roomCode, {
      type:             'game_over',
      winner:           gs.winner,
      tiebreakerWinner: gs.tiebreakerWinner,
      scores:           { ...gs.scores },
    });
    liveGamesStore.removeGame(roomCode);
    clearDisconnectRoom(roomCode);
    const supabase = getSupabaseClient();
    await persistGameState(gs, supabase);
    await updateStats(gs);
    const initialSummary = initRematch(roomCode, gs.players, _handleRematchTimeout);
    broadcastToGame(roomCode, {
      type: 'rematch_vote_update',
      ...initialSummary,
    });
    return;
  }

  // Persist to Supabase
  const supabase = getSupabaseClient();
  await persistGameState(gs, supabase);

  // Schedule next bot or human turn timer
  scheduleBotTurnIfNeeded(gs);
  scheduleTurnTimerIfNeeded(gs);
}

/**
 * Handle a declaration action.
 *
 * @param {string} roomCode
 * @param {string} declarerId
 * @param {string} halfSuitId
 * @param {Object} assignment  - { [cardId]: playerId }
 * @param {import('ws').WebSocket|null} ws
 * @param {boolean} isBot
 */
async function handleDeclare(roomCode, declarerId, halfSuitId, assignment, ws, isBot = false) {
  const gs = getGame(roomCode);
  if (!gs) {
    if (ws) sendJson(ws, { type: 'error', message: 'Game not found', code: 'GAME_NOT_FOUND' });
    return;
  }

  const validation = validateDeclaration(gs, declarerId, halfSuitId, assignment);
  if (!validation.valid) {
    if (ws) sendJson(ws, { type: 'error', message: validation.error, code: validation.errorCode });
    return;
  }

  // Cancel human turn timer — valid action received
  cancelTurnTimer(roomCode);

  // Clear any stored partial selection and declaration selection (move is complete)
  clearPartialSelection(roomCode, declarerId);
  _declarationSelections.delete(`${roomCode}:${declarerId}`);
  // Clear bot-controlled declaration tracking (if any) — declaration is resolved
  _botControlledDeclarations.delete(roomCode);
  // Cancel any active bot-declaration countdown (declaration is now executing)
  cancelBotDeclarationTimer(roomCode);

  // All hands may change (cards get removed from everyone)
  const changedHands = new Set(gs.players.map((p) => p.playerId));

  // Apply declaration (mutates gs)
  const { correct, winningTeam, newTurnPlayerId, lastMove } = applyDeclaration(
    gs, declarerId, halfSuitId, assignment
  );

  // Update bot knowledge
  updateKnowledgeAfterDeclaration(gs, halfSuitId, assignment, correct);

  // Broadcast declaration result
  broadcastToGame(roomCode, {
    type:            'declaration_result',
    declarerId,
    halfSuitId,
    correct,
    winningTeam,
    newTurnPlayerId,
    assignment,
    lastMove,
  });

  // Broadcast updated state + personalized hands
  broadcastStateUpdate(gs, changedHands);

  // ── Update live games store with new scores ──────────────────────────────
  if (liveGamesStore.get(roomCode)) {
    liveGamesStore.updateGame(roomCode, { scores: { ...gs.scores } });
  }

  // Handle game over
  if (gs.status === 'completed') {
    broadcastToGame(roomCode, {
      type:             'game_over',
      winner:           gs.winner,
      tiebreakerWinner: gs.tiebreakerWinner,
      scores:           { ...gs.scores },
    });

    // ── Remove game from live games store (game has ended) ─────────────────
    liveGamesStore.removeGame(roomCode);

    // ── Sub-AC 4: Clean up all pending disconnect timers and reclaim queue ──
    // Cancel any outstanding reconnect windows (avoids dangling setTimeout
    // references after the game completes).
    clearDisconnectRoom(roomCode);

    // Persist final state
    const supabase = getSupabaseClient();
    await persistGameState(gs, supabase);

    // Update player stats
    await updateStats(gs);

    // Initiate rematch vote — bots auto-vote yes, humans vote within timeout
    const initialSummary = initRematch(roomCode, gs.players, _handleRematchTimeout);
    broadcastToGame(roomCode, {
      type:        'rematch_vote_update',
      ...initialSummary,
    });

    return;
  }

  // Persist to Supabase
  const supabase = getSupabaseClient();
  await persistGameState(gs, supabase);

  // Schedule next bot or human turn timer as needed
  scheduleBotTurnIfNeeded(gs);
  scheduleTurnTimerIfNeeded(gs);
}

// ---------------------------------------------------------------------------
// Declaration progress streaming
// ---------------------------------------------------------------------------

/**
 * Broadcast live card-assignment progress from the declarant to all other
 * connected clients (players + spectators).
 *
 * This is a fire-and-forget operation: no game state is mutated, no
 * persistence occurs, and no response is sent back to the sender.
 *
 * ── Why we broadcast to spectators ──────────────────────────────────────────
 * In physical Literature the declaration is announced aloud for everyone in
 * the room to hear.  Spectators therefore have the same right to observe the
 * declaration in progress as the opposing team does.  The assignment being
 * streamed here is the SAME information that will appear in the final
 * `declaration_result` broadcast, so no extra information is leaked.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * @param {string}      roomCode    The room the game is running in.
 * @param {string}      declarerId  Player ID of the sender.
 * @param {string|null} halfSuitId  Half-suit being declared, or null if cancelled.
 * @param {Object}      assignment  Partial { cardId: playerId } map.
 */
function handleDeclareProgress(roomCode, declarerId, halfSuitId, assignment) {
  const gs = getGame(roomCode);
  if (!gs || gs.status !== 'active') return;

  // Only the current-turn player may send declaration progress.
  if (gs.currentTurnPlayerId !== declarerId) return;

  const safeAssignment = (assignment && typeof assignment === 'object') ? assignment : {};
  const assignedCount  = Object.keys(safeAssignment).length;
  const totalCards     = 6;

  // Broadcast to every connection in the room EXCEPT the declarant.
  // The declarant is driving the form; they don't need to receive their
  // own progress back.
  broadcastToGame(roomCode, {
    type:          'declare_progress',
    declarerId,
    halfSuitId:    halfSuitId ?? null,
    assignedCount,
    totalCards,
    assignment:    safeAssignment,
  }, declarerId);
}

// ---------------------------------------------------------------------------
// Inference mode toggle
// ---------------------------------------------------------------------------

/**
 * Toggle the shared inference-mode flag for a room.
 * Any in-game player (not spectator) can call this.
 * Broadcasts `inference_mode_changed` to ALL connections (players + spectators).
 *
 * @param {string} roomCode
 * @param {string} playerId - The player who sent the toggle message
 */
function handleToggleInference(roomCode, playerId) {
  const gs = getGame(roomCode);
  if (!gs) return;

  // Toggle the flag on the in-memory game state
  gs.inferenceMode = !gs.inferenceMode;

  console.log(
    `[game-ws] Inference mode ${gs.inferenceMode ? 'enabled' : 'disabled'} ` +
    `in room ${roomCode} by player ${playerId}`
  );

  // Broadcast to all connections in the room (players and spectators)
  broadcastToGame(roomCode, {
    type:       'inference_mode_changed',
    enabled:    gs.inferenceMode,
    toggledBy:  playerId,
  });
}

// ---------------------------------------------------------------------------
// Rematch vote handling
// ---------------------------------------------------------------------------

/**
 * Called when the 60-second rematch vote window expires without a majority yes.
 * Broadcasts `rematch_declined` and cleans up vote state.
 * @param {string} roomCode
 */
function _handleRematchTimeout(roomCode) {
  console.log(`[game-ws] Rematch vote timed out for room ${roomCode} — declining`);
  broadcastToGame(roomCode, { type: 'rematch_declined', reason: 'timeout' });
}

/**
 * Handle a `rematch_vote` message from a human player.
 * Casts the vote, broadcasts the updated tally, and if majority is reached
 * triggers the rematch by resetting the room back to 'waiting' status.
 *
 * @param {string} roomCode
 * @param {string} playerId
 * @param {boolean} vote
 * @param {import('ws').WebSocket|null} ws
 */
async function handleRematchVote(roomCode, playerId, vote, ws) {
  if (!hasRematch(roomCode)) {
    if (ws) sendJson(ws, { type: 'error', message: 'No active rematch vote', code: 'NO_REMATCH_VOTE' });
    return;
  }

  const summary = castVote(roomCode, playerId, vote);
  if (!summary) {
    if (ws) sendJson(ws, { type: 'error', message: 'Could not cast vote', code: 'VOTE_FAILED' });
    return;
  }

  // Broadcast updated tally to everyone in the game
  broadcastToGame(roomCode, {
    type: 'rematch_vote_update',
    ...summary,
  });

  if (summary.majorityReached) {
    // Clear rematch state (stops the timeout)
    clearRematch(roomCode);

    // Reset room to 'waiting' in Supabase so a new game can start
    try {
      const supabase = getSupabaseClient();
      await supabase
        .from('rooms')
        .update({ status: 'waiting', game_state: null })
        .eq('code', roomCode);
    } catch (err) {
      console.error('[game-ws] Failed to reset room for rematch:', err.message);
    }

    broadcastToGame(roomCode, { type: 'rematch_start', roomCode });
    return;
  }

  if (summary.majorityDeclined) {
    clearRematch(roomCode);
    broadcastToGame(roomCode, { type: 'rematch_declined', reason: 'majority_no' });
  }
}

// ---------------------------------------------------------------------------
// Game creation (called from lobby when game starts)
// ---------------------------------------------------------------------------

/**
 * Create and store a new game from a lobby seat snapshot.
 * Called by wsServer._handleGameStart after 'starting' status is set.
 *
 * @param {{
 *   roomCode:    string,
 *   roomId:      string,
 *   variant:     string,
 *   playerCount: number,
 *   seats:       Array<Object>,
 * }} options
 * @returns {Object} The created GameState
 */
function createGame(options) {
  const gs = createGameState(options);
  setGame(options.roomCode, gs);

  // ── Register in live games store ──────────────────────────────────────────
  // Computes currentPlayers from the seat list (human + bot seats).
  try {
    const humanSeats = Array.isArray(options.seats)
      ? options.seats.filter((s) => !s.isBot).length
      : 0;
    liveGamesStore.addGame({
      roomCode:       options.roomCode,
      playerCount:    options.playerCount,
      currentPlayers: humanSeats,
      cardVariant:    options.variant,
      scores:         { team1: 0, team2: 0 },
      status:         'in_progress',
      createdAt:      Date.now(),
      startedAt:      Date.now(),
    });
  } catch (err) {
    console.warn('[game] liveGamesStore.addGame failed for room', options.roomCode, ':', err.message);
  }

  return gs;
}

/**
 * Recover a game from Supabase snapshot after a server crash.
 * @param {string} roomCode
 * @param {string} roomId
 * @param {Object} snapshot
 * @returns {Object} Restored GameState
 */
function recoverGame(roomCode, roomId, snapshot) {
  const gs = restoreGameState(snapshot, roomCode, roomId);
  setGame(roomCode, gs);
  return gs;
}

// ---------------------------------------------------------------------------
// WebSocket server factory
// ---------------------------------------------------------------------------

/**
 * Attach the game WebSocket server to the HTTP server.
 * Listens at /ws/game/<ROOMCODE>?token=<bearer>.
 *
 * @param {import('http').Server} httpServer
 * @returns {WebSocketServer}
 */
function attachGameSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  // Route HTTP upgrade requests for game paths
  httpServer.on('upgrade', (req, socket, head) => {
    const parsed = url.parse(req.url || '', true);
    const match = parsed.pathname.match(/^\/ws\/game\/([A-Za-z0-9]{6})$/);
    if (!match) return; // Not a game path — let other handlers deal with it

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', async (ws, req) => {
    const parsed         = url.parse(req.url || '', true);
    const match          = parsed.pathname.match(/^\/ws\/game\/([A-Za-z0-9]{6})$/);
    const roomCode       = match ? match[1].toUpperCase() : null;
    const token          = typeof parsed.query.token === 'string' ? parsed.query.token : null;
    const spectatorToken = typeof parsed.query.spectatorToken === 'string' ? parsed.query.spectatorToken : null;

    // Validate room code format
    if (!roomCode || !/^[A-Z0-9]{6}$/.test(roomCode)) {
      sendJson(ws, { type: 'error', code: 'INVALID_ROOM_CODE', message: 'Invalid room code' });
      ws.close(4000, 'Invalid room code');
      return;
    }

    // ── Authentication ──────────────────────────────────────────────────────
    // Priority:
    //   1. Bearer token (registered user or guest) — full identity resolution.
    //   2. Spectator token — anonymous read-only access via the spectator link.
    // If neither is present/valid the connection is rejected with 4001.

    let user = await resolveUser(token);

    if (!user && spectatorToken) {
      // Anonymous spectator arriving via the spectator link (/spectate/<TOKEN>).
      // Validate the 32-char hex token against rooms.spectator_token in Supabase.
      const spectatorRoom = await resolveSpectatorToken(roomCode, spectatorToken);
      if (!spectatorRoom) {
        sendJson(ws, {
          type:    'error',
          code:    'INVALID_SPECTATOR_TOKEN',
          message: 'Invalid or expired spectator token',
        });
        ws.close(4001, 'Invalid spectator token');
        return;
      }

      // Assign a read-only, synthetic spectator identity.
      // The 'spectator_' prefix ensures this ID never collides with a real
      // player or guest session ID, so isSpectator is always true below.
      const syntheticId = `spectator_${crypto.randomBytes(8).toString('hex')}`;
      user = {
        playerId:    syntheticId,
        displayName: 'Spectator',
        avatarId:    null,
        isGuest:     false,
      };
    } else if (!user) {
      sendJson(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Authentication required' });
      ws.close(4001, 'Unauthorized');
      return;
    }

    const { playerId, displayName } = user;

    // Find game state — try in-memory first, then Supabase
    let gs = getGame(roomCode);

    if (!gs) {
      // Try to recover from Supabase
      try {
        const supabase = getSupabaseClient();
        const { data: room, error } = await supabase
          .from('rooms')
          .select('id, status, game_state')
          .eq('code', roomCode)
          .maybeSingle();

        if (error || !room) {
          sendJson(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found' });
          ws.close(4004, 'Room not found');
          return;
        }

        if (room.status !== 'in_progress' && room.status !== 'completed') {
          sendJson(ws, { type: 'error', code: 'GAME_NOT_STARTED', message: 'Game has not started yet' });
          ws.close(4005, 'Game not started');
          return;
        }

        if (room.game_state) {
          gs = recoverGame(roomCode, room.id, room.game_state);
          console.log(`[game-ws] Recovered game state for room ${roomCode} from Supabase`);
        } else {
          sendJson(ws, { type: 'error', code: 'GAME_NOT_FOUND', message: 'Game state not available' });
          ws.close(4005, 'Game state not available');
          return;
        }
      } catch (err) {
        console.error('[game-ws] Recovery error:', err);
        sendJson(ws, { type: 'error', code: 'SERVER_ERROR', message: 'Server error' });
        ws.close(4500, 'Server error');
        return;
      }
    }

    // Verify this player is in the game (or is a spectator)
    const playerInGame = gs.players.find((p) => p.playerId === playerId);
    const isSpectator  = !playerInGame;

    // ── Seat reclaim (Sub-AC 3 of AC 39) ──────────────────────────────────
    // If this player has an active reconnect window, they are reclaiming their
    // seat from the temporary bot that filled in while they were disconnected.
    const reconnectEntry = _reconnectWindows.get(playerId);
    if (!isSpectator && reconnectEntry && reconnectEntry.roomCode === roomCode) {
      _cancelReconnectWindow(playerId);
      // Also cancel the tick-based reconnect timer if one was started via
      // startReconnectWindow (Sub-AC 1 of AC 39 concurrent timer infrastructure).
      cancelReconnectWindow(roomCode, playerId);

      // Restore the player's human identity in the game state.
      const botPlayer = gs.players.find((p) => p.playerId === playerId);
      if (botPlayer) {
        botPlayer.isBot        = false;
        botPlayer.displayName  = reconnectEntry.originalDisplayName;
        botPlayer.avatarId     = reconnectEntry.originalAvatarId;
        botPlayer.isGuest      = reconnectEntry.originalIsGuest;

        // Cancel a pending bot turn scheduled for this player's seat so it
        // doesn't fire after the human has already reconnected.
        if (gs.currentTurnPlayerId === playerId) {
          const botTimer = _botTimers.get(roomCode);
          if (botTimer) {
            clearTimeout(botTimer);
            _botTimers.delete(roomCode);
          }
        }
      }

      console.log(`[game-ws] Player ${playerId} reclaimed seat in room ${roomCode}`);

      // Notify all OTHER clients that the human has returned.
      broadcastToGame(roomCode, {
        type:        'player_reconnected',
        playerId,
        displayName: reconnectEntry.originalDisplayName,
      }, playerId);

      // Broadcast updated player list (bot badge disappears from this seat).
      broadcastStateUpdate(gs);

      // Persist the restored human state to Supabase for crash recovery.
      try {
        const supabase = getSupabaseClient();
        await persistGameState(gs, supabase);
      } catch (err) {
        console.warn('[game-ws] Failed to persist after seat reclaim:', err.message);
      }
    }
    // ── Sub-AC 4: Late reconnect after permanent bot assignment ──────────────
    // If the reconnect window has already expired (no _reconnectWindows entry)
    // but the player slot is stamped with `botReplacedAt`, the original human
    // is reconnecting after permanent bot assignment.  Add them to the reclaim
    // queue so they regain their seat at the next turn boundary.
    //
    // This also handles crash recovery: if the server restarted after permanent
    // bot assignment, `_reconnectWindows` is empty but `botReplacedAt` survives
    // in the Supabase snapshot, so the reclaim queue is properly re-populated.
    else if (
      !isSpectator &&
      playerInGame &&
      playerInGame.isBot &&
      playerInGame.botReplacedAt
    ) {
      // Only add to queue if not already queued (guard against duplicate connections).
      if (!isInReclaimQueue(roomCode, playerId)) {
        addToReclaimQueue(roomCode, playerId);
        console.log(
          `[game-ws] Late reconnect: player ${playerId} queued for seat reclaim ` +
          `in room ${roomCode} — will regain control at next turn boundary`
        );
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Register the connection
    registerConnection(roomCode, playerId, ws);

    // Send game init to this player
    if (isSpectator) {
      // Spectators receive only the current public snapshot — no player hands,
      // no full move history. serializePublicState() includes only:
      //   status, currentTurnPlayerId, scores, lastMove, winner,
      //   tiebreakerWinner, declaredSuits.
      // moveHistory is intentionally excluded.
      sendJson(ws, {
        type:          'spectator_init',
        roomCode:      gs.roomCode,
        variant:       gs.variant,
        playerCount:   gs.playerCount,
        players:       serializePlayers(gs),
        gameState:     serializePublicState(gs),
        inferenceMode: gs.inferenceMode ?? false,
      });
    } else {
      sendGameInit(gs, playerId, ws);

      // ── Sub-AC 4: Notify a reclaim-queued player that they are waiting ──────
      // If this player is now in the reclaim queue (just added above, or was
      // already queued from a previous connection attempt), send them a targeted
      // `reclaim_queued` message so the UI can show a "Waiting to reclaim" banner
      // instead of the normal game controls.
      if (isInReclaimQueue(roomCode, playerId)) {
        sendJson(ws, { type: 'reclaim_queued', playerId });
      }

      // On reconnect: resume the turn timer / bot timer for whoever's turn it is.
      // NOTE: scheduleBotTurnIfNeeded will execute the reclaim immediately if it
      // is currently this player's turn (since they are in the reclaim queue).
      scheduleBotTurnIfNeeded(gs);
      scheduleTurnTimerIfNeeded(gs);
    }

    // If a human player reconnects and game is active, reschedule timers so
    // they can see the countdown and bots don't stall.
    // Spectators do NOT trigger timer rescheduling — they are observers only,
    // and broadcasting turn_timer on spectator connect would race with the
    // spectator SPECTATOR-error response when they try to send a message.
    if (gs.status === 'active' && !isSpectator) {
      scheduleBotTurnIfNeeded(gs);
      scheduleTurnTimerIfNeeded(gs);
    }

    // ── Message handler ──────────────────────────────────────────────────────
    ws.on('message', async (data) => {
      if (isSpectator) {
        // Spectators cannot send game messages
        sendJson(ws, { type: 'error', message: 'Spectators cannot interact with the game', code: 'SPECTATOR' });
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        sendJson(ws, { type: 'error', message: 'Invalid JSON', code: 'INVALID_JSON' });
        return;
      }

      if (!msg || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'ask_card': {
          const { targetPlayerId, cardId } = msg;
          if (!targetPlayerId || !cardId) {
            sendJson(ws, { type: 'error', message: 'targetPlayerId and cardId are required', code: 'MISSING_FIELDS' });
            return;
          }
          await handleAskCard(roomCode, playerId, targetPlayerId, cardId, ws, false);
          break;
        }

        case 'declare_suit': {
          const { halfSuitId, assignment } = msg;
          if (!halfSuitId || !assignment || typeof assignment !== 'object') {
            sendJson(ws, { type: 'error', message: 'halfSuitId and assignment are required', code: 'MISSING_FIELDS' });
            return;
          }
          await handleDeclare(roomCode, playerId, halfSuitId, assignment, ws, false);
          break;
        }

        case 'rematch_vote': {
          const { vote } = msg;
          if (typeof vote !== 'boolean') {
            sendJson(ws, { type: 'error', message: 'vote must be a boolean', code: 'MISSING_FIELDS' });
            return;
          }
          await handleRematchVote(roomCode, playerId, vote, ws);
          break;
        }

        case 'toggle_inference': {
          handleToggleInference(roomCode, playerId);
          break;
        }

        case 'partial_selection': {
          // The active player reports their current wizard step so the server
          // can complete the action deterministically if the turn timer fires.
          // No response is sent back — this is fire-and-forget.
          const {
            flow:       psFlow,
            halfSuitId: psHalfSuit,
            cardId:     psCard,
            assignment: psAssignment,
          } = msg;
          handlePartialSelection(
            roomCode,
            playerId,
            typeof psFlow     === 'string' ? psFlow     : undefined,
            typeof psHalfSuit === 'string' ? psHalfSuit : undefined,
            typeof psCard     === 'string' ? psCard     : undefined,
            psAssignment && typeof psAssignment === 'object' ? psAssignment : undefined,
          );
          break;
        }

        case 'declare_progress': {
          // The active player streams their in-progress card assignment from
          // Step 2 of DeclareModal.  The server re-broadcasts to all OTHER
          // connected clients (players + spectators) so they can show a live
          // "declaration in progress" banner.
          // halfSuitId === null means the player cancelled (went back to
          // Step 1 or closed the modal) — clients clear their progress banner.
          // No response is sent back — this is fire-and-forget.
          const { halfSuitId: dpHalfSuit, assignment: dpAssignment } = msg;
          handleDeclareProgress(
            roomCode,
            playerId,
            typeof dpHalfSuit === 'string' ? dpHalfSuit : null,
            dpAssignment && typeof dpAssignment === 'object' ? dpAssignment : {},
          );
          break;
        }

        case 'declare_selecting': {
          // ── Sub-AC 21a: Private half-suit selection ────────────────────────
          // The active player sends this when they pick a half-suit in Step 1
          // of the DeclareModal (suit picker).  The selected suit is stored
          // server-side ONLY — it is NEVER broadcast to other players.
          //
          // This gives `executeTimedOutTurn` the information it needs to
          // continue the correct declaration if the turn timer fires before
          // the player clicks "Declare!".
          //
          // Send halfSuitId: null (or omit it) to clear the stored selection
          // when the player presses "Back" or dismisses the modal.
          // No response is sent back — this is fire-and-forget.
          const { halfSuitId: dsHalfSuit } = msg;
          handleDeclareSelecting(
            roomCode,
            playerId,
            typeof dsHalfSuit === 'string' ? dsHalfSuit : null,
          );
          break;
        }

        default:
          sendJson(ws, { type: 'error', message: `Unknown message type: ${msg.type}`, code: 'UNKNOWN_TYPE' });
      }
    });

    // ── Disconnect handler ───────────────────────────────────────────────────
    ws.on('close', () => {
      removeConnection(roomCode, playerId);

      // Only human players in active games get the reconnect window treatment.
      // Bots and spectators are excluded.
      if (!isSpectator) {
        const currentGs = getGame(roomCode);
        if (currentGs && currentGs.status === 'active') {
          const player = currentGs.players.find((p) => p.playerId === playerId);
          if (player && !player.isBot) {
            // Start the concurrent timer sequence: 30s turn timer + 60s reconnect window.
            // _startReconnectWindow handles both — it starts the turn timer BEFORE
            // marking the seat as bot, ensuring both timers run simultaneously.
            _startReconnectWindow(currentGs, player);
            return; // _startReconnectWindow logs the disconnect
          }
        }
      }

      console.log(`[game-ws] Player ${playerId} disconnected from game ${roomCode}`);
    });

    ws.on('error', (err) => {
      console.error(`[game-ws] Error for player ${playerId} in room ${roomCode}:`, err.message);
    });
  });

  return wss;
}

module.exports = {
  attachGameSocketServer,
  createGame,
  recoverGame,
  handleAskCard,
  handleDeclare,
  handleRematchVote,
  handleToggleInference,
  handlePartialSelection,
  handleDeclareProgress,
  /**
   * Store the declaring player's Step-1 suit selection privately.
   * Never broadcast to other players (Sub-AC 21a).
   */
  handleDeclareSelecting,
  scheduleBotTurnIfNeeded,
  scheduleTurnTimerIfNeeded,
  cancelTurnTimer,
  broadcastStateUpdate,
  sendGameInit,
  _handleRematchTimeout,
  cancelBotTimer,
  // Exported for unit testing:
  resolveSpectatorToken,
  executeTimedOutTurn,
  sanitizePartialStateForBroadcast,
  // Seat reclaim (Sub-AC 3 of AC 39):
  _startReconnectWindow,
  _cancelReconnectWindow,
  _clearAllReconnectWindows,
  // Concurrent timer infrastructure (Sub-AC 1 of AC 39):
  startReconnectWindow,
  cancelReconnectWindow,
  handlePlayerDisconnect,
  // Permanent bot seat + mid-game reclaim (Sub-AC 4 of AC 39):
  _executeReclaim,
  // Forced-failed declaration (AC 24):
  handleForcedFailedDeclaration,
  // Declaration phase timer (Sub-AC 23a):
  startDeclarationPhaseTimer,
  // Bot declaration takeover countdown (Sub-AC 3 of AC 41):
  startBotDeclarationCountdown,
  cancelBotDeclarationTimer,
  // Countdown timer service (Sub-AC 36.1): 1-second ticks + threshold events
  timerService,
  // Exposed for test inspection only — do NOT mutate from outside this module:
  _declarationSelections,
  _declarationPhaseStarted,
  _botControlledDeclarations,
  _botDeclarationTimers,
  _reconnectWindows,
  _reconnectTimers,
  _turnTimers,
  RECONNECT_WINDOW_MS,
  TIMER_TICK_INTERVAL_MS,
  DECLARATION_PHASE_TIMEOUT_MS,
  BOT_DECLARATION_TAKEOVER_MS,
};
