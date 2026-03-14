-- Migration: 008_add_declarations_attempted
-- Adds declarations_attempted column to user_stats and updates the
-- increment_user_stats RPC to atomically track total declaration attempts
-- (correct + incorrect + timer-expired) per registered player.
--
-- declarations_attempted = the total number of times a player initiated a
-- declaration (regardless of outcome).  This allows computing a
-- "declaration success rate" = declarations_correct / declarations_attempted.

-- ── Add declarations_attempted column ────────────────────────────────────────

ALTER TABLE user_stats
  ADD COLUMN IF NOT EXISTS declarations_attempted
    INTEGER NOT NULL DEFAULT 0 CHECK (declarations_attempted >= 0);

-- ── Update increment_user_stats RPC ──────────────────────────────────────────
-- Re-creates the function with the new p_declarations_attempted parameter.
-- Existing callers that omit the parameter will receive DEFAULT 0, so this
-- is fully backward-compatible.

CREATE OR REPLACE FUNCTION increment_user_stats(
  p_user_id                UUID,
  p_games_played           INTEGER DEFAULT 0,
  p_games_completed        INTEGER DEFAULT 0,
  p_wins                   INTEGER DEFAULT 0,
  p_losses                 INTEGER DEFAULT 0,
  p_declarations_correct   INTEGER DEFAULT 0,
  p_declarations_incorrect INTEGER DEFAULT 0,
  p_declarations_attempted INTEGER DEFAULT 0
)
RETURNS VOID AS $$
BEGIN
  UPDATE public.user_stats
  SET
    games_played             = games_played             + p_games_played,
    games_completed          = games_completed          + p_games_completed,
    wins                     = wins                     + p_wins,
    losses                   = losses                   + p_losses,
    declarations_correct     = declarations_correct     + p_declarations_correct,
    declarations_incorrect   = declarations_incorrect   + p_declarations_incorrect,
    declarations_attempted   = declarations_attempted   + p_declarations_attempted,
    updated_at               = NOW()
  WHERE user_id = p_user_id;

  -- Insert a new stats row if the user somehow doesn't have one yet
  IF NOT FOUND THEN
    INSERT INTO public.user_stats (
      user_id, games_played, games_completed, wins, losses,
      declarations_correct, declarations_incorrect, declarations_attempted
    ) VALUES (
      p_user_id, p_games_played, p_games_completed, p_wins, p_losses,
      p_declarations_correct, p_declarations_incorrect, p_declarations_attempted
    ) ON CONFLICT (user_id) DO NOTHING;
  END IF;
END;
$$ LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = public;
