'use strict';

/**
 * Matchmaking API routes
 *
 * POST /api/matchmaking/join — Join the matchmaking queue (REST — legacy)
 * DELETE /api/matchmaking/leave — Leave the matchmaking queue (REST — legacy)
 * GET /api/matchmaking/status — Current queue status for the caller (REST — legacy)
 * GET /api/matchmaking/queues — Public overview of active WebSocket queues
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const {
  joinQueue,
  leaveQueue,
  getQueueEntry,
  getQueuePosition,
  VALID_CARD_VARIANTS,
  VALID_PLAYER_COUNTS,
} = require('../matchmaking/matchmakingQueue');

// WebSocket-based queue store (used for real-time matchmaking via )
const {
  getAllQueueStats,
  parseFilterKey,
} = require('../matchmaking/matchmakingStore');

// ---------------------------------------------------------------------------
// POST /api/matchmaking/join
// ---------------------------------------------------------------------------

/**
 * Add the authenticated player to the matchmaking queue.
 *
 * Request body:
 * cardVariant {string} 'remove_2s' | 'remove_7s' | 'remove_8s'
 * playerCount {number} 6 | 7 | 8
 *
 * Response 200 (already in queue, TTL refreshed):
 * {
 * queued: true,
 * refreshed: true,
 * entry: { playerId, isGuest, displayName, avatarId, cardVariant, playerCount, joinedAt, expiresAt },
 * position: number,
 * queueSize: number
 * }
 *
 * Response 201 (newly joined):
 * {
 * queued: true,
 * refreshed: false,
 * entry: { ... },
 * position: number,
 * queueSize: number
 * }
 *
 * Response 400: validation error
 * Response 401: unauthenticated
 */
router.post('/join', requireAuth, (req, res) => {
  const { cardVariant, playerCount } = req.body;

  // ── Validation ─────────────────────────────────────────────────────────────

  const validationErrors = [];

  if (!cardVariant) {
    validationErrors.push('cardVariant is required');
  } else if (!VALID_CARD_VARIANTS.includes(cardVariant)) {
    validationErrors.push(
      `cardVariant must be one of: ${VALID_CARD_VARIANTS.join(', ')}`
    );
  }

  if (playerCount === undefined || playerCount === null) {
    validationErrors.push('playerCount is required');
  } else if (!VALID_PLAYER_COUNTS.includes(Number(playerCount))) {
    validationErrors.push(
      `playerCount must be one of: ${VALID_PLAYER_COUNTS.join(', ')}`
    );
  }

  if (validationErrors.length > 0) {
    return res.status(400).json({
      error: 'Validation failed',
      details: validationErrors,
    });
  }

  // ── Enqueue ────────────────────────────────────────────────────────────────

  try {
    const { entry, alreadyQueued } = joinQueue(req.user, cardVariant, Number(playerCount));

    const posInfo = getQueuePosition(req.user);

    const statusCode = alreadyQueued ? 200 : 201;
    return res.status(statusCode).json({
      queued: true,
      refreshed: alreadyQueued,
      entry,
      position: posInfo ? posInfo.position : 1,
      queueSize: posInfo ? posInfo.queueSize : 1,
    });
  } catch (err) {
    // joinQueue throws on invalid input — should not happen after validation,
    // but guard anyway.
    console.error('[matchmaking] joinQueue error:', err.message);
    return res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/matchmaking/leave
// ---------------------------------------------------------------------------

/**
 * Remove the authenticated player from the matchmaking queue.
 *
 * Optional request body (to target a specific queue):
 * cardVariant {string}
 * playerCount {number}
 *
 * Response 200: { left: true }
 * Response 200: { left: false, message: 'Not currently in any queue' }
 * Response 401: unauthenticated
 */
router.delete('/leave', requireAuth, (req, res) => {
  const { cardVariant, playerCount } = req.body || {};

  // If both filters provided, validate them
  if (cardVariant !== undefined || playerCount !== undefined) {
    const validationErrors = [];

    if (cardVariant !== undefined && !VALID_CARD_VARIANTS.includes(cardVariant)) {
      validationErrors.push(
        `cardVariant must be one of: ${VALID_CARD_VARIANTS.join(', ')}`
      );
    }
    if (playerCount !== undefined && !VALID_PLAYER_COUNTS.includes(Number(playerCount))) {
      validationErrors.push(
        `playerCount must be one of: ${VALID_PLAYER_COUNTS.join(', ')}`
      );
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validationErrors,
      });
    }
  }

  const removed = leaveQueue(
    req.user,
    cardVariant,
    playerCount !== undefined ? Number(playerCount) : undefined
  );

  if (removed) {
    return res.status(200).json({ left: true });
  } else {
    return res.status(200).json({ left: false, message: 'Not currently in any queue' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/matchmaking/status
// ---------------------------------------------------------------------------

/**
 * Return the caller's current queue status.
 *
 * Response 200 (in queue):
 * {
 * inQueue: true,
 * entry: { playerId, isGuest, displayName, avatarId, cardVariant, playerCount, joinedAt, expiresAt },
 * position: number,
 * queueSize: number,
 * queueKey: string
 * }
 *
 * Response 200 (not in queue):
 * { inQueue: false }
 *
 * Response 401: unauthenticated
 */
router.get('/status', requireAuth, (req, res) => {
  const entry = getQueueEntry(req.user);

  if (!entry) {
    return res.status(200).json({ inQueue: false });
  }

  const posInfo = getQueuePosition(req.user);

  return res.status(200).json({
    inQueue: true,
    entry,
    position: posInfo ? posInfo.position : null,
    queueSize: posInfo ? posInfo.queueSize : null,
    queueKey: posInfo ? posInfo.queueKey : null,
  });
});

// ---------------------------------------------------------------------------
// GET /api/matchmaking/queues
// ---------------------------------------------------------------------------

/**
 * Return a public overview of all active WebSocket matchmaking queues.
 *
 * Reads from the WebSocket-backed matchmakingStore which holds
 * live connections. Only non-empty queues are returned.
 *
 * No auth required — spectators and prospective players can see queue sizes.
 *
 * Response 200:
 * {
 * queues: [
 * {
 * filterKey: string, // "{playerCount}:{cardRemovalVariant}"
 * playerCount: number,
 * cardRemovalVariant: string,
 * queueSize: number
 * },
 * ...
 * ],
 * totalWaiting: number
 * }
 */
router.get('/queues', (req, res) => {
  /** @type {Record<string, { count: number, cardVariant: string, playerCount: number }>} */
  const queues = {};

  // 1. Legacy REST queue (getQueueSnapshot returns { queues: {...}, totalWaiting })
  const mqModule = require('../matchmaking/matchmakingQueue');
  if (typeof mqModule.getQueueSnapshot === 'function') {
    const snap = mqModule.getQueueSnapshot();
    for (const [key, data] of Object.entries(snap.queues ?? {})) {
      if (!queues[key]) queues[key] = { count: 0, cardVariant: data.cardVariant, playerCount: data.playerCount };
      queues[key].count += data.count ?? 0;
    }
  }

  // 2. WS matchmakingStore (live WebSocket connections)
  const wsStats = getAllQueueStats();
  for (const { filterKey, queueSize } of wsStats) {
    const { playerCount, cardRemovalVariant } = parseFilterKey(filterKey);
    const legacyKey = `${cardRemovalVariant}:${playerCount}`;
    if (!queues[legacyKey]) queues[legacyKey] = { count: 0, cardVariant: cardRemovalVariant, playerCount };
    queues[legacyKey].count += queueSize;
  }

  // Remove empty queues
  for (const key of Object.keys(queues)) {
    if (queues[key].count <= 0) delete queues[key];
  }

  const totalWaiting = Object.values(queues).reduce((sum, q) => sum + q.count, 0);

  return res.status(200).json({ queues, totalWaiting });
});

module.exports = router;
