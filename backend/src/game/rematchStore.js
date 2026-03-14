'use strict';

/**
 * Rematch vote store — in-memory per-room rematch state.
 *
 * After a game completes the server initiates a rematch vote window.
 * Bots automatically cast yes votes; human players may vote yes or no.
 * When yes-vote count reaches a strict majority of total players the
 * rematch is triggered. If the timeout expires or a majority-no is
 * reached before that, the vote is declined.
 *
 * Majority threshold: Math.floor(totalPlayerCount / 2) + 1
 *   e.g. 6 players → majority = 4
 *        8 players → majority = 5
 */

/** Milliseconds players have to cast a rematch vote before auto-decline. */
const REMATCH_VOTE_TIMEOUT_MS = 60_000;

/**
 * @typedef {Object} RematchState
 * @property {Map<string, boolean>} votes         playerId → true (yes) / false (no)
 * @property {Array<Object>} players              full player roster from the finished game
 * @property {number} totalCount                  total player count (bots + humans)
 * @property {number} humanCount                  human-only player count
 * @property {number} majority                    yes-votes needed to trigger rematch
 * @property {ReturnType<typeof setTimeout>|null} timer  auto-decline timer handle
 */

/** @type {Map<string, RematchState>} roomCode → RematchState */
const _rematchState = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise a rematch vote for a room once the game completes.
 * Bot players are automatically assigned a 'yes' vote.
 * Returns the initial vote summary.
 *
 * @param {string}   roomCode
 * @param {Array}    players          Array of player objects from the finished GameState
 * @param {Function} onTimeout        Called (with roomCode) when the vote window expires
 * @returns {ReturnType<typeof getVoteSummary>}
 */
function initRematch(roomCode, players, onTimeout) {
  // Clear any existing state (e.g. from a previous vote that was never cleaned up)
  clearRematch(roomCode);

  const code = roomCode.toUpperCase();
  const totalCount = players.length;
  const humanPlayers = players.filter((p) => !p.isBot);
  const humanCount   = humanPlayers.length;

  // Strict majority of ALL players (bots count — their auto-yes votes matter)
  const majority = Math.floor(totalCount / 2) + 1;

  const votes = new Map();

  // Auto-cast yes votes for bots
  for (const p of players) {
    if (p.isBot) votes.set(p.playerId, true);
  }

  const timer = setTimeout(() => {
    _rematchState.delete(code);
    onTimeout(code);
  }, REMATCH_VOTE_TIMEOUT_MS);

  _rematchState.set(code, { votes, players, totalCount, humanCount, majority, timer });

  return getVoteSummary(code);
}

/**
 * Record a vote for a player. Only human (non-bot) players may call this;
 * bot votes are set at init time and are immutable.
 *
 * Returns the updated vote summary or null if the room has no active vote.
 *
 * @param {string}  roomCode
 * @param {string}  playerId
 * @param {boolean} vote   true = yes, false = no
 * @returns {ReturnType<typeof getVoteSummary>|null}
 */
function castVote(roomCode, playerId, vote) {
  const code  = roomCode.toUpperCase();
  const state = _rematchState.get(code);
  if (!state) return null;

  // Validate the player is in this game
  const player = state.players.find((p) => p.playerId === playerId);
  if (!player) return null;

  // Bots' votes are fixed — human clients cannot override them
  if (player.isBot) return getVoteSummary(code);

  state.votes.set(playerId, vote);
  return getVoteSummary(code);
}

/**
 * Compute and return the current vote tally for a room.
 * Returns null if no active vote exists.
 *
 * @param {string} roomCode
 * @returns {{
 *   yesCount:         number,
 *   noCount:          number,
 *   totalCount:       number,
 *   humanCount:       number,
 *   majority:         number,
 *   majorityReached:  boolean,
 *   majorityDeclined: boolean,
 *   votes:            Record<string, boolean>,
 *   playerVotes:      Array<{ playerId: string, displayName: string, isBot: boolean, vote: boolean|null }>
 * }|null}
 */
function getVoteSummary(roomCode) {
  const code  = roomCode.toUpperCase();
  const state = _rematchState.get(code);
  if (!state) return null;

  let yesCount = 0;
  let noCount  = 0;

  for (const [, vote] of state.votes) {
    if (vote) yesCount++;
    else       noCount++;
  }

  // Build per-player vote visibility (for broadcast)
  const playerVotes = state.players.map((p) => {
    const vote = state.votes.has(p.playerId) ? state.votes.get(p.playerId) : null;
    return {
      playerId:    p.playerId,
      displayName: p.displayName,
      isBot:       p.isBot,
      vote,
    };
  });

  // Majority is yes-votes >= threshold
  const majorityReached = yesCount >= state.majority;

  // Early decline: remaining unvoted players can never push yes to majority
  const votedCount     = yesCount + noCount;
  const remainingVotes = state.totalCount - votedCount;
  const majorityDeclined = !majorityReached && (yesCount + remainingVotes < state.majority);

  return {
    yesCount,
    noCount,
    totalCount:       state.totalCount,
    humanCount:       state.humanCount,
    majority:         state.majority,
    majorityReached,
    majorityDeclined,
    votes:            Object.fromEntries(state.votes),
    playerVotes,
  };
}

/**
 * Check whether an active rematch vote exists for a room.
 * @param {string} roomCode
 * @returns {boolean}
 */
function hasRematch(roomCode) {
  return _rematchState.has(roomCode.toUpperCase());
}

/**
 * Cancel and remove the rematch state for a room (call after rematch triggers
 * or is declined so the timer is properly cleared).
 * @param {string} roomCode
 */
function clearRematch(roomCode) {
  const code  = roomCode.toUpperCase();
  const state = _rematchState.get(code);
  if (state?.timer) clearTimeout(state.timer);
  _rematchState.delete(code);
}

// ---------------------------------------------------------------------------
// Test helper — resets all state between tests
// ---------------------------------------------------------------------------

function _clearAll() {
  for (const state of _rematchState.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  _rematchState.clear();
}

module.exports = {
  initRematch,
  castVote,
  getVoteSummary,
  hasRematch,
  clearRematch,
  REMATCH_VOTE_TIMEOUT_MS,
  _clearAll,
};
