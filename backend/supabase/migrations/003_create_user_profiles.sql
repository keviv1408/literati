-- Migration: 003_create_user_profiles
-- Stores public-facing profile data for registered users.
--
-- The `user_profiles` table is a one-to-one extension of `auth.users`:
--   - Holds display_name and avatar_id (metadata that changes over time).
--   - Provides a public-readable surface for leaderboards / spectator views
--     without exposing raw Supabase auth metadata.
--
-- Insertion strategy:
--   - A row is created immediately after registration via the backend API.
--   - OAuth sign-ins (Google) create/upsert a row in the /auth/callback handler.
--   - The database trigger below acts as a safety net: if neither of the above
--     writes succeeded (e.g. a future auth method), the trigger ensures a row
--     always exists within the same transaction.

-- ── user_profiles table ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_profiles (
  -- Mirrors auth.users(id) 1:1; deleted when the auth user is deleted.
  id            UUID        PRIMARY KEY
                            REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Human-readable display name shown in game UI and leaderboard.
  -- Constrained to 1–20 characters; server enforces this before insert.
  display_name  VARCHAR(20) NOT NULL,

  -- Avatar identifier (e.g. 'avatar-1' … 'avatar-12').
  -- NULL means the user hasn't chosen yet; the UI should fall back to 'avatar-1'.
  avatar_id     VARCHAR(20) NULL,

  -- Timestamps
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Fast lookup by display name for @mention / name-search features.
CREATE INDEX user_profiles_display_name_idx
  ON user_profiles (lower(display_name));

-- ── Auto-update updated_at ────────────────────────────────────────────────────

CREATE TRIGGER user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Auto-initialize profile on new user creation (safety net) ────────────────
-- This trigger ensures every registered user always has a profile row,
-- regardless of which code path created the auth user.
-- The backend API and /auth/callback both attempt explicit inserts first;
-- this trigger only fires if neither succeeded (ON CONFLICT DO NOTHING below).

CREATE OR REPLACE FUNCTION initialize_user_profile()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_profiles (id, display_name, avatar_id)
  VALUES (
    NEW.id,
    -- Derive a default display name from email (prefix before '@'), truncated.
    COALESCE(
      NULLIF(TRIM(NEW.raw_user_meta_data->>'display_name'), ''),
      NULLIF(SPLIT_PART(NEW.email, '@', 1), ''),
      'Player'
    ),
    COALESCE(NEW.raw_user_meta_data->>'avatar_id', 'avatar-1')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = public;

CREATE TRIGGER on_auth_user_profile_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION initialize_user_profile();

-- ── Row Level Security ────────────────────────────────────────────────────────

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- Public read: anyone can read display names and avatars (leaderboard, game UI).
CREATE POLICY "user_profiles_select_public"
  ON user_profiles FOR SELECT
  USING (true);

-- Users can update their own profile only.
CREATE POLICY "user_profiles_update_own"
  ON user_profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- All inserts go through the backend service role or the trigger above.
-- No INSERT policy for the authenticated role.
