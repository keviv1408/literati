'use strict';

/**
 * Voice join endpoint for Daily-backed in-game calls.
 *
 * POST /api/rooms/:roomCode/voice/join
 *
 * Validates the caller via the existing Bearer-token session model, confirms
 * they are an actual human player in the active game, lazily creates the Daily
 * room if needed, and returns a short-lived meeting token.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const { getGame } = require('../game/gameStore');
const { joinRoom } = require('../lib/daily');

const router = express.Router();

const voiceJoinLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many voice join attempts, please wait' },
  skip: () => process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development',
});

function normalizeRoomCode(roomCode) {
  return String(roomCode || '').trim().toUpperCase();
}

function getRequesterPlayerId(user) {
  return user.isGuest ? user.sessionId : user.id;
}

router.post('/:roomCode/voice/join', voiceJoinLimiter, requireAuth, async (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomCode);

  if (!/^[A-Z0-9]{6}$/.test(roomCode)) {
    return res.status(400).json({ error: 'Invalid room code format' });
  }

  const game = getGame(roomCode);
  if (!game) {
    return res.status(409).json({
      error: 'Voice unavailable',
      message: 'Voice is only available while this game is active.',
    });
  }

  const requesterPlayerId = getRequesterPlayerId(req.user);
  const player = game.players.find(
    (candidate) => candidate.playerId === requesterPlayerId && !candidate.isBot,
  );

  if (!player) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Voice is only available to players in this room.',
    });
  }

  try {
    const voiceSession = await joinRoom({
      roomCode,
      userId: player.playerId,
      userName: player.displayName,
    });

    return res.status(200).json(voiceSession);
  } catch (error) {
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;

    if (statusCode >= 500) {
      console.error('[voice] Failed to create Daily join session:', error);
    }

    return res.status(statusCode).json({
      error: statusCode === 503 ? 'Voice unavailable' : 'Failed to join voice',
      message:
        statusCode === 503
          ? error.message
          : 'Could not create a voice session right now.',
    });
  }
});

module.exports = router;
