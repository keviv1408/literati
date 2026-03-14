'use strict';

/**
 * In-memory matchmaking queue store.
 *
 * Queues are keyed by a "filter key" string:
 *   "{playerCount}:{cardRemovalVariant}"
 *   e.g. "6:remove_7s", "8:remove_2s", "6:remove_8s"
 *
 * Shape of a stored QueuedPlayer:
 * {
 *   playerId     : string  — registered userId or guest sessionId
 *   displayName  : string
 *   avatarId     : string | null
 *   isGuest      : boolean
 *   connectionId : string  — UUID unique to this WebSocket connection
 *   ws           : WebSocket  — the live socket object
 *   filterKey    : string  — the filter key they queued under
 *   joinedAt     : number  — Date.now() when they joined (for FIFO ordering)
 * }
 */

// ---------------------------------------------------------------------------
// Internal stores
// ---------------------------------------------------------------------------

/** @type {Map<string, Map<string, Object>>} filterKey → Map<playerId, QueuedPlayer> */
const _queues = new Map();

/**
 * Reverse index: playerId → filterKey
 * Allows O(1) cleanup on player disconnect.
 * @type {Map<string, string>}
 */
const _playerQueue = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the canonical filter key from its components.
 *
 * @param {number} playerCount - 6 or 8
 * @param {string} cardRemovalVariant - 'remove_2s' | 'remove_7s' | 'remove_8s'
 * @returns {string}
 */
function makeFilterKey(playerCount, cardRemovalVariant) {
  return `${playerCount}:${cardRemovalVariant}`;
}

/**
 * Parse a filter key back into its components.
 *
 * @param {string} filterKey
 * @returns {{ playerCount: number, cardRemovalVariant: string }}
 */
function parseFilterKey(filterKey) {
  const [countStr, variant] = filterKey.split(':');
  return { playerCount: Number(countStr), cardRemovalVariant: variant };
}

/**
 * Add a player to the specified queue.
 *
 * If the player is already in a different queue they are removed from it first.
 * If they are already in the same queue their entry is updated (e.g. new ws).
 *
 * @param {string} filterKey
 * @param {Object} player - Must include: playerId, displayName, avatarId, isGuest, connectionId, ws
 * @returns {{ position: number, queueSize: number }}
 */
function joinQueue(filterKey, player) {
  // Remove from previous queue if it differs from the target queue
  const previousKey = _playerQueue.get(player.playerId);
  if (previousKey && previousKey !== filterKey) {
    const prevQueue = _queues.get(previousKey);
    if (prevQueue) {
      prevQueue.delete(player.playerId);
      if (prevQueue.size === 0) {
        _queues.delete(previousKey);
      }
    }
  }

  // Ensure the target queue exists
  if (!_queues.has(filterKey)) {
    _queues.set(filterKey, new Map());
  }

  const queue = _queues.get(filterKey);
  queue.set(player.playerId, {
    ...player,
    filterKey,
    // Preserve original joinedAt if re-queueing after a failed room creation
    joinedAt: player.joinedAt ?? Date.now(),
  });
  _playerQueue.set(player.playerId, filterKey);

  return { position: queue.size, queueSize: queue.size };
}

/**
 * Remove a player from whichever queue they are currently in.
 *
 * @param {string} playerId
 * @returns {{ removed: boolean, filterKey: string|null }}
 */
function leaveQueue(playerId) {
  const filterKey = _playerQueue.get(playerId);
  if (!filterKey) {
    return { removed: false, filterKey: null };
  }

  const queue = _queues.get(filterKey);
  if (queue) {
    queue.delete(playerId);
    if (queue.size === 0) {
      _queues.delete(filterKey);
    }
  }
  _playerQueue.delete(playerId);

  return { removed: true, filterKey };
}

/**
 * Get all players in a queue as an array.
 *
 * @param {string} filterKey
 * @returns {Object[]} QueuedPlayer array
 */
function getQueuePlayers(filterKey) {
  const queue = _queues.get(filterKey);
  if (!queue) return [];
  return Array.from(queue.values());
}

/**
 * Get the current number of players in a queue.
 *
 * @param {string} filterKey
 * @returns {number}
 */
function getQueueSize(filterKey) {
  return _queues.get(filterKey)?.size ?? 0;
}

/**
 * Return the filter key the player is currently queued under, or null.
 *
 * @param {string} playerId
 * @returns {string|null}
 */
function getPlayerFilterKey(playerId) {
  return _playerQueue.get(playerId) ?? null;
}

/**
 * Atomically remove and return the first `count` players from a queue.
 * Players are ordered by joinedAt (FIFO — first in, first matched).
 *
 * Returns null if the queue currently has fewer than `count` players.
 *
 * @param {string} filterKey
 * @param {number} count
 * @returns {Object[]|null} matched QueuedPlayers, or null if not enough
 */
function dequeueGroup(filterKey, count) {
  const queue = _queues.get(filterKey);
  if (!queue || queue.size < count) {
    return null;
  }

  // Sort by joinedAt (ascending) for fair FIFO ordering
  const sorted = Array.from(queue.values()).sort((a, b) => a.joinedAt - b.joinedAt);
  const group = sorted.slice(0, count);

  for (const player of group) {
    queue.delete(player.playerId);
    _playerQueue.delete(player.playerId);
  }

  if (queue.size === 0) {
    _queues.delete(filterKey);
  }

  return group;
}

/**
 * Return a stats snapshot of all non-empty queues.
 * Used by the REST /api/matchmaking/queues endpoint.
 *
 * @returns {{ filterKey: string, queueSize: number }[]}
 */
function getAllQueueStats() {
  const stats = [];
  for (const [filterKey, queue] of _queues.entries()) {
    if (queue.size > 0) {
      stats.push({ filterKey, queueSize: queue.size });
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Test helpers (never import outside of test files)
// ---------------------------------------------------------------------------

/** Reset all queues and the player index. */
function _clearAll() {
  _queues.clear();
  _playerQueue.clear();
}

/** Direct read of the internal queues map — for assertions only. */
function _getQueues() {
  return _queues;
}

/** Direct read of the player→filterKey index — for assertions only. */
function _getPlayerQueue() {
  return _playerQueue;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Key helpers
  makeFilterKey,
  parseFilterKey,

  // Core queue operations
  joinQueue,
  leaveQueue,
  getQueuePlayers,
  getQueueSize,
  getPlayerFilterKey,
  dequeueGroup,

  // Stats
  getAllQueueStats,

  // Test helpers
  _clearAll,
  _getQueues,
  _getPlayerQueue,
};
