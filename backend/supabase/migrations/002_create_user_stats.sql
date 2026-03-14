-- Migration: 002_create_user_stats
-- Creates the user_stats table and an auto-initialization trigger.
--
-- Stats rows are created automatically when a new Supabase auth user is
-- inserted, regardless of the sign-up method (email/password, OAuth, etc.).
-- This guarantees that every registered account always has a stats row
-- ready to receive game results the moment it is created.

-- ── user_stats table ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_stats (
  -- One row per registered user; deleted automatically if the auth user is deleted.
  user_id                UUID        PRIMARY KEY
                                     REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Game outcome counters.
  -- IMPORTANT: Only fully completed games increment these counters; abandoned or
  -- cancelled games must NOT touch this table.
  games_played           INTEGER     NOT NULL DEFAULT 0 CHECK (games_played >= 0),
  games_completed        INTEGER     NOT NULL DEFAULT 0 CHECK (games_completed >= 0),
  wins                   INTEGER     NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses                 INTEGER     NOT NULL DEFAULT 0 CHECK (losses >= 0),

  -- In-game declaration counters (correct = your team keeps the half-suit,
  -- incorrect = opposing team gets it).
  declarations_correct   INTEGER     NOT NULL DEFAULT 0 CHECK (declarations_correct >= 0),
  declarations_incorrect INTEGER     NOT NULL DEFAULT 0 CHECK (declarations_incorrect >= 0),

  -- Timestamps
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Leaderboard: primary sort wins DESC, secondary games_completed DESC.
-- Partial index only includes accounts with at least 5 completed games
-- (matches the minimum-game threshold enforced by the leaderboard query).
CREATE INDEX user_stats_leaderboard_idx
  ON user_stats (wins DESC, games_completed DESC)
  WHERE games_completed >= 5;

-- ── Auto-update updated_at ────────────────────────────────────────────────────
-- Reuses the trigger function created in migration 001.

CREATE TRIGGER user_stats_updated_at
  BEFORE UPDATE ON user_stats
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Auto-initialize stats on new user creation ────────────────────────────────
-- This trigger fires immediately after a row is inserted into auth.users,
-- which happens for ALL sign-up methods:
--   • email/password  (via backend admin.createUser or Supabase Auth API)
--   • OAuth providers (Google, GitHub, etc.)
--   • magic-link / OTP
--
-- Using ON CONFLICT DO NOTHING makes the trigger idempotent — safe to call
-- multiple times without duplicating the row.

CREATE OR REPLACE FUNCTION initialize_user_stats()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_stats (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = public;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION initialize_user_stats();

-- ── Row Level Security ────────────────────────────────────────────────────────
-- The backend uses the service-role key and bypasses RLS.
-- These policies protect direct client access if ever enabled in the future.

ALTER TABLE user_stats ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read their own stats (for profile pages)
CREATE POLICY "user_stats_select_own"
  ON user_stats FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Public leaderboard reads: any visitor can read stats rows
-- (The backend may opt for the service-role key instead, bypassing this policy.)
CREATE POLICY "user_stats_select_public"
  ON user_stats FOR SELECT
  TO anon
  USING (true);

-- All mutations go through the backend service role only.
-- No INSERT/UPDATE/DELETE policies for the authenticated or anon roles.
