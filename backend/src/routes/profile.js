'use strict';

/**
 * Public profile API routes
 *
 * GET /api/profile/:username
 * Returns aggregated stats for a registered player looked up by display name.
 * This is the public-facing profile endpoint used by the frontend profile pages
 * and the leaderboard deep-link flow.
 *
 * The endpoint performs a two-step Supabase query:
 * 1. Resolve the display name to a userId via user_profiles (case-insensitive).
 * 2. Fetch aggregated stats from user_stats for that userId.
 *
 * Response shape (200):
 * {
 * profile: {
 * userId,
 * username, // display_name as stored in DB
 * avatarId,
 * gamesPlayed, // total games joined (may include abandoned games)
 * gamesCompleted, // fully completed games only
 * wins,
 * losses,
 * winPercentage, // wins / gamesCompleted, rounded to 4 decimal places (0–1)
 * declarationsMade, // declarations_attempted (total initiations)
 * declarationsCorrect,
 * declarationsIncorrect,
 * declarationSuccessRate // declarationsCorrect / declarationsMade (0–1), or 0 if none
 * }
 * }
 *
 * Errors:
 * 400 — Username parameter is empty or too long (> 20 chars)
 * 404 — No registered user found with this display name
 * 500 — Internal / Supabase error
 */

const express = require('express');
const router = express.Router();
const { getSupabaseClient } = require('../db/supabase');

/** Maximum display-name length enforced by the user_profiles schema. */
const MAX_DISPLAY_NAME_LENGTH = 20;

/**
 * GET /api/profile/:username
 *
 * Public endpoint — no authentication required.
 */
router.get('/:username', async (req, res) => {
  const { username } = req.params;

  // ── Input validation ───────────────────────────────────────────────────────
  if (!username || username.trim().length === 0) {
    return res.status(400).json({ error: 'Username is required' });
  }

  if (username.length > MAX_DISPLAY_NAME_LENGTH) {
    return res
      .status(400)
      .json({ error: `Username must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer` });
  }

  const supabase = getSupabaseClient();

  try {
    // ── Step 1: Resolve display name → userId (case-insensitive) ─────────────
    const { data: profileRow, error: profileError } = await supabase
      .from('user_profiles')
      .select('id, display_name, avatar_id')
      .ilike('display_name', username)
      .maybeSingle();

    if (profileError) {
      console.error('[profile] Error resolving username:', profileError);
      return res.status(500).json({ error: 'Failed to load profile' });
    }

    if (!profileRow) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // ── Step 2: Fetch stats row for the resolved userId ───────────────────────
    const { data: statsRow, error: statsError } = await supabase
      .from('user_stats')
      .select(
        'games_played, games_completed, wins, losses, ' +
          'declarations_correct, declarations_incorrect, declarations_attempted'
      )
      .eq('user_id', profileRow.id)
      .maybeSingle();

    if (statsError) {
      console.error('[profile] Error fetching stats for userId:', profileRow.id, statsError);
      return res.status(500).json({ error: 'Failed to load profile' });
    }

    // ── Aggregate & compute derived metrics ───────────────────────────────────
    const gamesCompleted = (statsRow && statsRow.games_completed) || 0;
    const wins = (statsRow && statsRow.wins) || 0;
    const losses = (statsRow && statsRow.losses) || 0;
    const gamesPlayed = (statsRow && statsRow.games_played) || 0;

    // Win percentage: wins / gamesCompleted; 0 when no completed games.
    const winPercentage =
      gamesCompleted > 0
        ? Math.round((wins / gamesCompleted) * 10000) / 10000
        : 0;

    const declarationsCorrect = (statsRow && statsRow.declarations_correct) || 0;
    const declarationsIncorrect = (statsRow && statsRow.declarations_incorrect) || 0;

    // declarations_attempted was added in migration 008; fall back to
    // correct + incorrect for rows that pre-date that column.
    const declarationsMade =
      statsRow && statsRow.declarations_attempted != null
        ? statsRow.declarations_attempted
        : declarationsCorrect + declarationsIncorrect;

    // Declaration success rate: correct / attempted; 0 when no attempts.
    const declarationSuccessRate =
      declarationsMade > 0
        ? Math.round((declarationsCorrect / declarationsMade) * 10000) / 10000
        : 0;

    return res.status(200).json({
      profile: {
        userId: profileRow.id,
        username: profileRow.display_name,
        avatarId: profileRow.avatar_id || null,
        gamesPlayed,
        gamesCompleted,
        wins,
        losses,
        winPercentage,
        declarationsMade,
        declarationsCorrect,
        declarationsIncorrect,
        declarationSuccessRate,
      },
    });
  } catch (err) {
    console.error('[profile] Unexpected error:', err);
    return res.status(500).json({ error: 'Failed to load profile' });
  }
});

module.exports = router;
