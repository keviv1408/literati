/**
 * Stats API routes
 *
 * GET /api/stats/leaderboard   — Public leaderboard (players with >= 5 games completed)
 * GET /api/stats/profile/:userId — Public player stats profile
 */

const express = require('express');
const router = express.Router();
const { getSupabaseClient } = require('../db/supabase');

/**
 * GET /api/stats/leaderboard
 *
 * Returns paginated leaderboard of players with at least 5 completed games.
 * Sorted by wins DESC, then games_completed DESC, then id ASC for stability.
 *
 * Query params:
 *   limit  {number}  Max results to return (default 20)
 *   offset {number}  Pagination offset (default 0)
 *
 * Response 200:
 *   {
 *     leaderboard: [ { rank, userId, displayName, avatarId, wins, losses, gamesCompleted, winRate } ],
 *     total,
 *     limit,
 *     offset
 *   }
 *
 * Errors:
 *   500 — Failed to load leaderboard
 */
router.get('/leaderboard', async (req, res) => {
  const limit = Math.max(1, parseInt(req.query.limit, 10) || 20);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  const supabase = getSupabaseClient();

  try {
    const { data, error, count } = await supabase
      .from('user_stats')
      .select('*, user_profiles!inner(display_name, avatar_id)', { count: 'exact' })
      .gte('games_completed', 5)
      .order('wins', { ascending: false })
      .order('games_completed', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('Error fetching leaderboard:', error);
      return res.status(500).json({ error: 'Failed to load leaderboard' });
    }

    const leaderboard = (data || []).map((row, index) => {
      const gamesCompleted = row.games_completed || 0;
      const wins = row.wins || 0;
      const winRate = gamesCompleted > 0
        ? Math.round((wins / gamesCompleted) * 100) / 100
        : 0;

      return {
        rank: offset + index + 1,
        userId: row.user_id,
        displayName: row.user_profiles ? row.user_profiles.display_name : null,
        avatarId: row.user_profiles ? row.user_profiles.avatar_id : null,
        wins,
        losses: row.losses || 0,
        gamesCompleted,
        winRate,
      };
    });

    return res.status(200).json({
      leaderboard,
      total: count || 0,
      limit,
      offset,
    });
  } catch (err) {
    console.error('Unexpected error fetching leaderboard:', err);
    return res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

/**
 * GET /api/stats/profile/:userId
 *
 * Returns stats and profile info for a single player.
 *
 * Response 200:
 *   {
 *     profile: {
 *       userId, displayName, avatarId,
 *       wins, losses, gamesCompleted, gamesPlayed,
 *       declarationsCorrect, declarationsIncorrect,
 *       winRate
 *     }
 *   }
 *
 * Errors:
 *   404 — Profile not found
 *   500 — Internal error
 */
router.get('/profile/:userId', async (req, res) => {
  const { userId } = req.params;

  const supabase = getSupabaseClient();

  try {
    const { data, error } = await supabase
      .from('user_stats')
      .select('*, user_profiles!inner(display_name, avatar_id)')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.error('Error fetching user profile stats:', error);
      return res.status(500).json({ error: 'Failed to load profile' });
    }

    if (!data) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const gamesCompleted = data.games_completed || 0;
    const wins = data.wins || 0;
    const winRate = gamesCompleted > 0
      ? Math.round((wins / gamesCompleted) * 100) / 100
      : 0;

    const declarationsCorrect   = data.declarations_correct   || 0;
    const declarationsIncorrect = data.declarations_incorrect || 0;
    // declarations_attempted was added in migration 008; fall back to
    // correct + incorrect for rows that pre-date the column migration.
    const declarationsAttempted = data.declarations_attempted != null
      ? data.declarations_attempted
      : declarationsCorrect + declarationsIncorrect;

    const profile = {
      userId: data.user_id,
      displayName: data.user_profiles ? data.user_profiles.display_name : null,
      avatarId: data.user_profiles ? data.user_profiles.avatar_id : null,
      wins,
      losses: data.losses || 0,
      gamesCompleted,
      gamesPlayed: data.games_played || 0,
      declarationsCorrect,
      declarationsIncorrect,
      declarationsAttempted,
      winRate,
    };

    return res.status(200).json({ profile });
  } catch (err) {
    console.error('Unexpected error fetching user profile stats:', err);
    return res.status(500).json({ error: 'Failed to load profile' });
  }
});

/**
 * GET /api/stats/profile/by-username/:username
 *
 * Returns stats and profile info for a player identified by their display name.
 * Case-insensitive lookup.
 *
 * Response 200:  { profile: { userId, displayName, avatarId, ... } }
 * Errors:
 *   404 — Profile not found
 *   500 — Internal error
 */
router.get('/profile/by-username/:username', async (req, res) => {
  const { username } = req.params;

  if (!username || username.trim().length === 0) {
    return res.status(400).json({ error: 'Username is required' });
  }

  const supabase = getSupabaseClient();

  try {
    // Look up the user_profile row by display_name (case-insensitive)
    const { data: profileRow, error: profileError } = await supabase
      .from('user_profiles')
      .select('id, display_name, avatar_id')
      .ilike('display_name', username.trim())
      .maybeSingle();

    if (profileError) {
      console.error('Error looking up profile by username:', profileError);
      return res.status(500).json({ error: 'Failed to load profile' });
    }

    if (!profileRow) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // Now fetch stats for this user_id
    const { data: statsRow, error: statsError } = await supabase
      .from('user_stats')
      .select('*')
      .eq('user_id', profileRow.id)
      .maybeSingle();

    if (statsError) {
      console.error('Error fetching stats for user:', statsError);
      return res.status(500).json({ error: 'Failed to load profile' });
    }

    const gamesCompleted = (statsRow && statsRow.games_completed) || 0;
    const wins = (statsRow && statsRow.wins) || 0;
    const winRate = gamesCompleted > 0
      ? Math.round((wins / gamesCompleted) * 100) / 100
      : 0;

    const declarationsCorrect   = (statsRow && statsRow.declarations_correct)   || 0;
    const declarationsIncorrect = (statsRow && statsRow.declarations_incorrect) || 0;
    const declarationsAttempted = statsRow && statsRow.declarations_attempted != null
      ? statsRow.declarations_attempted
      : declarationsCorrect + declarationsIncorrect;

    const profile = {
      userId: profileRow.id,
      displayName: profileRow.display_name,
      avatarId: profileRow.avatar_id || null,
      wins,
      losses: (statsRow && statsRow.losses) || 0,
      gamesCompleted,
      gamesPlayed: (statsRow && statsRow.games_played) || 0,
      declarationsCorrect,
      declarationsIncorrect,
      declarationsAttempted,
      winRate,
    };

    return res.status(200).json({ profile });
  } catch (err) {
    console.error('Unexpected error fetching profile by username:', err);
    return res.status(500).json({ error: 'Failed to load profile' });
  }
});

/**
 * GET /api/stats/game-summary/:roomCode
 *
 * Returns a post-game summary for a completed game, aggregating declaration
 * attempts, successes, and failures per player from the persisted game_state.
 *
 * Path params:
 *   roomCode  {string}  6-character room code
 *
 * Response 200:
 *   {
 *     roomCode,
 *     winner: 1 | 2 | null,
 *     scores: { team1, team2 },
 *     variant: 'remove_2s' | 'remove_7s' | 'remove_8s',
 *     playerSummaries: [
 *       {
 *         playerId, displayName, avatarId, teamId,
 *         isBot, isGuest,
 *         declarationAttempts, declarationSuccesses, declarationFailures
 *       }
 *     ]
 *   }
 *
 * Errors:
 *   400 — Invalid room code format
 *   404 — Game not found or not completed
 *   500 — Internal error
 */
router.get('/game-summary/:roomCode', async (req, res) => {
  const { roomCode } = req.params;

  // Basic format validation: 6 alphanumeric characters
  if (!roomCode || !/^[A-Z0-9]{6}$/i.test(roomCode)) {
    return res.status(400).json({ error: 'Invalid room code format' });
  }

  const supabase = getSupabaseClient();

  try {
    // Fetch the completed room record with its persisted game state
    const { data, error } = await supabase
      .from('rooms')
      .select('code, status, game_state')
      .eq('code', roomCode.toUpperCase())
      .eq('status', 'completed')
      .maybeSingle();

    if (error) {
      console.error('Error fetching game summary:', error);
      return res.status(500).json({ error: 'Failed to load game summary' });
    }

    if (!data) {
      return res.status(404).json({ error: 'Completed game not found for this room code' });
    }

    const gs = data.game_state;

    if (!gs) {
      return res.status(404).json({ error: 'Game state not available for this room' });
    }

    // Build a lookup map of playerId → player info from the players array
    const players = Array.isArray(gs.players) ? gs.players : [];
    const playerMap = {};
    for (const p of players) {
      playerMap[p.playerId] = {
        playerId: p.playerId,
        displayName: p.displayName || null,
        avatarId: p.avatarId || null,
        teamId: p.teamId,
        isBot: p.isBot === true,
        isGuest: p.isGuest === true,
        declarationAttempts: 0,
        declarationSuccesses: 0,
        declarationFailures: 0,
      };
    }

    // Walk the move history and accumulate declaration stats per player
    const moveHistory = Array.isArray(gs.moveHistory) ? gs.moveHistory : [];
    for (const move of moveHistory) {
      if (move.type !== 'declaration' && move.type !== 'forced_failed_declaration') {
        continue;
      }

      const declarerId = move.declarerId;
      if (!declarerId) continue;

      // Include declarers who may have been eliminated / are bots (they exist in playerMap)
      if (!playerMap[declarerId]) {
        // Player not in the players list (unlikely but guard anyway)
        playerMap[declarerId] = {
          playerId: declarerId,
          displayName: null,
          avatarId: null,
          teamId: null,
          isBot: false,
          isGuest: false,
          declarationAttempts: 0,
          declarationSuccesses: 0,
          declarationFailures: 0,
        };
      }

      playerMap[declarerId].declarationAttempts += 1;
      if (move.correct === true) {
        playerMap[declarerId].declarationSuccesses += 1;
      } else {
        playerMap[declarerId].declarationFailures += 1;
      }
    }

    // Convert the map to an array preserving original seat order
    const playerSummaries = players.map((p) => playerMap[p.playerId]);

    return res.status(200).json({
      roomCode: data.code,
      winner: gs.winner !== undefined ? gs.winner : null,
      scores: gs.scores || { team1: 0, team2: 0 },
      variant: gs.variant || null,
      playerSummaries,
    });
  } catch (err) {
    console.error('Unexpected error fetching game summary:', err);
    return res.status(500).json({ error: 'Failed to load game summary' });
  }
});

module.exports = router;
