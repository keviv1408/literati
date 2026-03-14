-- Migration: 005_add_game_state
-- Adds game_state JSONB column to the rooms table for crash recovery
-- and adds an increment_user_stats RPC for atomic stat updates.

-- ── Add game_state column ────────────────────────────────────────────────────

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS game_state JSONB DEFAULT NULL;

-- ── increment_user_stats function ────────────────────────────────────────────
-- Atomically increments multiple user_stats counters in a single call.
-- Called by the game server at the end of each completed game.

CREATE OR REPLACE FUNCTION increment_user_stats(
  p_user_id                UUID,
  p_games_played           INTEGER DEFAULT 0,
  p_games_completed        INTEGER DEFAULT 0,
  p_wins                   INTEGER DEFAULT 0,
  p_losses                 INTEGER DEFAULT 0,
  p_declarations_correct   INTEGER DEFAULT 0,
  p_declarations_incorrect INTEGER DEFAULT 0
)
RETURNS VOID AS $$
BEGIN
  UPDATE public.user_stats
  SET
    games_played           = games_played           + p_games_played,
    games_completed        = games_completed        + p_games_completed,
    wins                   = wins                   + p_wins,
    losses                 = losses                 + p_losses,
    declarations_correct   = declarations_correct   + p_declarations_correct,
    declarations_incorrect = declarations_incorrect + p_declarations_incorrect,
    updated_at             = NOW()
  WHERE user_id = p_user_id;

  -- Insert a new stats row if the user somehow doesn't have one
  IF NOT FOUND THEN
    INSERT INTO public.user_stats (
      user_id, games_played, games_completed, wins, losses,
      declarations_correct, declarations_incorrect
    ) VALUES (
      p_user_id, p_games_played, p_games_completed, p_wins, p_losses,
      p_declarations_correct, p_declarations_incorrect
    ) ON CONFLICT (user_id) DO NOTHING;
  END IF;
END;
$$ LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = public;
