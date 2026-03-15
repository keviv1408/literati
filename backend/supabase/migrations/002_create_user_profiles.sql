-- Migration: 002_create_user_profiles
-- Creates the user_profiles table that stores public profile data and
-- per-user preferences for registered accounts.
--
-- Each row is keyed to auth.users so the profile is automatically cleaned up
-- when an account is deleted.  The backend creates this row immediately after
-- a successful registration via the service-role key (bypasses RLS).

-- ── user_profiles table ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_profiles (
  -- One-to-one with auth.users; cascades on delete.
  id            UUID         PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Chosen display name (same constraints as guest display names).
  display_name  VARCHAR(20)  NOT NULL,

  -- Avatar identifier (matches the avatar-1 … avatar-12 set).
  avatar_id     VARCHAR(20)  NOT NULL DEFAULT 'avatar-1',

  -- Timestamps
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Leaderboard and search: case-insensitive display-name lookup.
CREATE INDEX user_profiles_display_name_idx
  ON user_profiles (lower(display_name));

-- ── Auto-update updated_at ────────────────────────────────────────────────────

-- Reuse the trigger function created in 001 if it exists; if this migration is
-- applied to a fresh schema (e.g. in CI) we define it here too.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Row Level Security ────────────────────────────────────────────────────────
-- The backend always uses the service-role key and bypasses RLS.
-- These policies protect direct client-side access if it is ever enabled.

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read any profile (needed for opponent info during games).
CREATE POLICY "user_profiles_select_authenticated"
  ON user_profiles FOR SELECT
  TO authenticated
  USING (true);

-- Users can only update their own profile.
CREATE POLICY "user_profiles_update_own"
  ON user_profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id);

-- Inserts are handled exclusively by the backend service role after registration.
-- No INSERT policy for the authenticated role is intentional.
