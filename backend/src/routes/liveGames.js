'use strict';

/**
 * Live Games API routes
 *
 * GET /api/live-games
 *   Returns a snapshot of all currently active matchmaking games.
 *   No auth required — public endpoint for the Live Games browsing page.
 *
 * Each game entry includes:
 *   roomCode       {string}  6-char uppercase code
 *   playerCount    {number}  Maximum player capacity (6 or 8)
 *   currentPlayers {number}  Players currently connected
 *   cardVariant    {string}  Card-removal variant: 'remove_2s' | 'remove_7s' | 'remove_8s'
 *   scores         {object}  { team1: number, team2: number }
 *   status         {string}  'waiting' | 'in_progress'
 *   createdAt      {number}  Epoch ms when the room was created
 *   startedAt      {number|null}  Epoch ms when the game went in_progress (null if still waiting)
 *   elapsedMs      {number}  Ms since startedAt (in_progress) or createdAt (waiting)
 *
 * Real-time updates are delivered via the WebSocket endpoint at /ws/live-games.
 */

const express = require('express');
const router = express.Router();
const liveGamesStore = require('../liveGames/liveGamesStore');

// ---------------------------------------------------------------------------
// GET /api/live-games
// ---------------------------------------------------------------------------

/**
 * Return a snapshot of all currently active matchmaking games.
 *
 * Response 200:
 *   {
 *     games: [
 *       {
 *         roomCode:       string,
 *         playerCount:    number,
 *         currentPlayers: number,
 *         cardVariant:    string,
 *         scores:         { team1: number, team2: number },
 *         status:         'waiting' | 'in_progress',
 *         createdAt:      number,
 *         startedAt:      number | null,
 *         elapsedMs:      number
 *       },
 *       ...
 *     ],
 *     total: number
 *   }
 */
router.get('/', (req, res) => {
  const games = liveGamesStore.getAll();
  return res.status(200).json({ games, total: games.length });
});

module.exports = router;
