'use strict';

/**
 * In-memory matchmaking queue.
 *
 * Players can join a queue with filters:
 *   - cardVariant  : 'remove_2s' | 'remove_7s' | 'remove_8s'
 *   - playerCount  : 6 | 7 | 8
 *
 * Queues are grouped by filter combination (the "queue key"), e.g.:
 *   "remove_7s:6"  — classic 6-player game
 *   "remove_2s:8"  — 8-player game with 2s removed
 *
 * Each player can appear in at most ONE queue at a time.  Attempting to
 * join a second queue first removes the player from the previous one.
 *
 * Queue entries expire after ENTRY_TTL_MS to prevent stale players from
 * blocking matchmaking.  Expired entries are removed lazily on access and
 * eagerly by the periodic cleanup timer.
 *
 * Shape of a queue entry:
 * {
 *   playerId    : string  — user.id for registered users, sessionId for guests
 *   isGuest     : boolean
 *   displayName : string
 *   avatarId    : string
 *   cardVariant : string  — one of VALID_CARD_VARIANTS
 *   playerCount : number  — one of VALID_PLAYER_COUNTS
 *   joinedAt    : number  — Unix timestamp (ms)
 *   expiresAt   : number  — Unix timestamp (ms)
 * }
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long a player stays in the queue without activity. */
const ENTRY_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** How often to sweep expired entries from all queues. */
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/** Valid card-removal variants (mirrors rooms.js). */
const VALID_CARD_VARIANTS = ['remove_2s', 'remove_7s', 'remove_8s'];

/** Valid player counts for matchmaking. */
const VALID_PLAYER_COUNTS = [6, 7, 8];

// ---------------------------------------------------------------------------
// Internal store
// ---------------------------------------------------------------------------

/**
 * Primary queue store.
 * Map<queueKey, QueueEntry[]>
 * queueKey = `${cardVariant}:${playerCount}`
 *
 * @type {Map<string, Array<Object>>}
 */
const _queues = new Map();

/**
 * Reverse index: playerId → queueKey.
 * Allows O(1) lookup when a player wants to leave or re-join.
 *
 * @type {Map<string, string>}
 */
const _playerIndex = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the canonical queue key for a filter combination.
 *
 * @param {string} cardVariant
 * @param {number} playerCount
 * @returns {string}
 */
function _makeKey(cardVariant, playerCount) {
  return `${cardVariant}:${playerCount}`;
}

/**
 * Derive the stable player identifier from a resolved req.user object.
 * Mirrors the logic in roomBlocklist.js for consistency.
 *
 * @param {Object} user
 * @returns {string}
 */
function getPlayerIdentifier(user) {
  return user.isGuest ? user.sessionId : user.id;
}

/**
 * Return true iff the entry has not yet expired.
 *
 * @param {Object} entry
 * @returns {boolean}
 */
function _isLive(entry) {
  return Date.now() <= entry.expiresAt;
}

/**
 * Get the live (non-expired) entries for a queue key.
 * Purges expired entries in place.
 *
 * @param {string} key
 * @returns {Array<Object>}
 */
function _getLiveEntries(key) {
  const entries = _queues.get(key);
  if (!entries) return [];

  const live = entries.filter(_isLive);

  // Sync the reverse index: remove any stale player IDs
  const stale = entries.filter((e) => !_isLive(e));
  for (const e of stale) {
    // Only remove from index if the entry still points to THIS key
    if (_playerIndex.get(e.playerId) === key) {
      _playerIndex.delete(e.playerId);
    }
  }

  if (live.length === 0) {
    _queues.delete(key);
  } else if (live.length !== entries.length) {
    _queues.set(key, live);
  }

  return live;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add a player to the matchmaking queue for the given filter combination.
 *
 * If the player is already queued (even for a different filter), they are
 * first removed from that queue before being added to the new one.
 *
 * @param {Object} user          - Resolved req.user from auth middleware
 * @param {string} cardVariant   - One of VALID_CARD_VARIANTS
 * @param {number} playerCount   - One of VALID_PLAYER_COUNTS
 * @returns {{ entry: Object, alreadyQueued: boolean }}
 *   entry         — the new queue entry
 *   alreadyQueued — true when the player was already in THIS exact queue
 *                   (entry was refreshed / TTL reset)
 * @throws {Error} on invalid cardVariant or playerCount
 */
function joinQueue(user, cardVariant, playerCount) {
  if (!VALID_CARD_VARIANTS.includes(cardVariant)) {
    throw new Error(
      `Invalid cardVariant "${cardVariant}". Must be one of: ${VALID_CARD_VARIANTS.join(', ')}`
    );
  }

  const count = Number(playerCount);
  if (!VALID_PLAYER_COUNTS.includes(count)) {
    throw new Error(
      `Invalid playerCount "${playerCount}". Must be one of: ${VALID_PLAYER_COUNTS.join(', ')}`
    );
  }

  const playerId = getPlayerIdentifier(user);
  const newKey = _makeKey(cardVariant, count);

  // --- Check if already in a queue ---
  const existingKey = _playerIndex.get(playerId);
  let alreadyQueued = false;

  if (existingKey) {
    if (existingKey === newKey) {
      // Same queue — refresh TTL instead of creating a duplicate entry
      const entries = _getLiveEntries(existingKey);
      const existing = entries.find((e) => e.playerId === playerId);
      if (existing) {
        existing.expiresAt = Date.now() + ENTRY_TTL_MS;
        existing.joinedAt = existing.joinedAt; // preserve original join time
        alreadyQueued = true;
        return { entry: { ...existing }, alreadyQueued };
      }
      // Entry expired between index hit and array scan — fall through to add
    } else {
      // Different queue — remove from old queue first
      _removeFromQueue(playerId, existingKey);
    }
  }

  // --- Add to new queue ---
  const now = Date.now();
  const entry = {
    playerId,
    isGuest: user.isGuest,
    displayName: user.displayName,
    avatarId: user.avatarId || 'avatar-1',
    cardVariant,
    playerCount: count,
    joinedAt: now,
    expiresAt: now + ENTRY_TTL_MS,
  };

  if (!_queues.has(newKey)) {
    _queues.set(newKey, []);
  }
  _queues.get(newKey).push(entry);
  _playerIndex.set(playerId, newKey);

  return { entry: { ...entry }, alreadyQueued: false };
}

/**
 * Remove a player from the matchmaking queue.
 *
 * If cardVariant + playerCount are provided, only removes from that specific
 * queue; otherwise removes from whichever queue the player is currently in.
 *
 * @param {Object} user
 * @param {string} [cardVariant]
 * @param {number} [playerCount]
 * @returns {boolean} true if the player was found and removed
 */
function leaveQueue(user, cardVariant, playerCount) {
  const playerId = getPlayerIdentifier(user);

  if (cardVariant !== undefined && playerCount !== undefined) {
    const count = Number(playerCount);
    const key = _makeKey(cardVariant, count);
    return _removeFromQueue(playerId, key);
  }

  // Remove from whichever queue the player is currently in
  const key = _playerIndex.get(playerId);
  if (!key) return false;
  return _removeFromQueue(playerId, key);
}

/**
 * Internal: remove a player from a specific queue by key.
 *
 * Only removes the player index entry when it still points to THIS key —
 * this prevents accidentally clearing the index when the player has already
 * switched to a different queue.
 *
 * @param {string} playerId
 * @param {string} key
 * @returns {boolean}
 */
function _removeFromQueue(playerId, key) {
  const entries = _queues.get(key);
  if (!entries) {
    // Only clear index if it points to this key (prevents cross-queue clobber)
    if (_playerIndex.get(playerId) === key) {
      _playerIndex.delete(playerId);
    }
    return false;
  }

  const idx = entries.findIndex((e) => e.playerId === playerId);
  if (idx === -1) {
    // Only clear index if it still points to this key
    if (_playerIndex.get(playerId) === key) {
      _playerIndex.delete(playerId);
    }
    return false;
  }

  entries.splice(idx, 1);
  if (entries.length === 0) {
    _queues.delete(key);
  }
  _playerIndex.delete(playerId);
  return true;
}

/**
 * Look up the current queue entry for a player.
 *
 * @param {Object} user
 * @returns {Object|null} The entry, or null if not queued / expired
 */
function getQueueEntry(user) {
  const playerId = getPlayerIdentifier(user);
  const key = _playerIndex.get(playerId);
  if (!key) return null;

  const entries = _getLiveEntries(key);
  return entries.find((e) => e.playerId === playerId) || null;
}

/**
 * Return the live entries for a specific filter combination.
 *
 * @param {string} cardVariant
 * @param {number} playerCount
 * @returns {Array<Object>} Shallow copies of live entries (no mutation risk)
 */
function getQueueForFilter(cardVariant, playerCount) {
  const key = _makeKey(cardVariant, Number(playerCount));
  return _getLiveEntries(key).map((e) => ({ ...e }));
}

/**
 * Return a snapshot of all non-empty queues.
 *
 * Shape:
 * {
 *   queues: {
 *     [queueKey]: {
 *       cardVariant: string,
 *       playerCount: number,
 *       count: number,
 *       players: Array<{ playerId, isGuest, displayName, avatarId, joinedAt, expiresAt }>
 *     }
 *   },
 *   totalWaiting: number
 * }
 *
 * @returns {Object}
 */
function getQueueSnapshot() {
  const snapshot = { queues: {}, totalWaiting: 0 };

  for (const key of [..._queues.keys()]) {
    const live = _getLiveEntries(key);
    if (live.length === 0) continue;

    const first = live[0];
    snapshot.queues[key] = {
      cardVariant: first.cardVariant,
      playerCount: first.playerCount,
      count: live.length,
      players: live.map((e) => ({ ...e })),
    };
    snapshot.totalWaiting += live.length;
  }

  return snapshot;
}

/**
 * Return the queue position (1-based) of a player within their current queue,
 * or null if the player is not queued.
 *
 * @param {Object} user
 * @returns {{ position: number, queueSize: number, queueKey: string } | null}
 */
function getQueuePosition(user) {
  const playerId = getPlayerIdentifier(user);
  const key = _playerIndex.get(playerId);
  if (!key) return null;

  const entries = _getLiveEntries(key);
  const idx = entries.findIndex((e) => e.playerId === playerId);
  if (idx === -1) return null;

  return {
    position: idx + 1,
    queueSize: entries.length,
    queueKey: key,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Remove all expired entries from every queue.
 * Called automatically on a timer; can also be invoked manually in tests.
 */
function cleanupExpiredEntries() {
  for (const key of [..._queues.keys()]) {
    _getLiveEntries(key); // side-effect: purges expired entries
  }
}

let _cleanupTimer = null;

/** Start the background cleanup interval. Call once at application startup. */
function startQueueCleanupTimer() {
  if (_cleanupTimer) return;
  _cleanupTimer = setInterval(cleanupExpiredEntries, CLEANUP_INTERVAL_MS);
  if (_cleanupTimer.unref) _cleanupTimer.unref();
}

/** Stop the background cleanup interval. Call during graceful shutdown or test teardown. */
function stopQueueCleanupTimer() {
  if (_cleanupTimer) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Wipe all queues and the player index — use in tests between cases. */
function _clearQueue() {
  _queues.clear();
  _playerIndex.clear();
}

/** Directly expose internal maps for inspection in tests. */
function _getRawQueues() {
  return _queues;
}
function _getRawPlayerIndex() {
  return _playerIndex;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Core operations
  joinQueue,
  leaveQueue,
  getQueueEntry,
  getQueueForFilter,
  getQueueSnapshot,
  getQueuePosition,

  // Cleanup
  cleanupExpiredEntries,
  startQueueCleanupTimer,
  stopQueueCleanupTimer,

  // Helpers (exported for use in routes)
  getPlayerIdentifier,

  // Constants
  VALID_CARD_VARIANTS,
  VALID_PLAYER_COUNTS,
  ENTRY_TTL_MS,
  CLEANUP_INTERVAL_MS,

  // Test helpers
  _clearQueue,
  _getRawQueues,
  _getRawPlayerIndex,
};
