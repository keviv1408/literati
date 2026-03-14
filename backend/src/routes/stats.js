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

    const profile = {
      userId: data.user_id,
      displayName: data.user_profiles ? data.user_profiles.display_name : null,
      avatarId: data.user_profiles ? data.user_profiles.avatar_id : null,
      wins,
      losses: data.losses || 0,
      gamesCompleted,
      gamesPlayed: data.games_played || 0,
      declarationsCorrect: data.declarations_correct || 0,
      declarationsIncorrect: data.declarations_incorrect || 0,
      winRate,
    };

    return res.status(200).json({ profile });
  } catch (err) {
    console.error('Unexpected error fetching user profile stats:', err);
    return res.status(500).json({ error: 'Failed to load profile' });
  }
});

module.exports = router;
