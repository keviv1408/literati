-- Migration: 003_oauth_auto_profile
--
-- Adds a database trigger that automatically creates a user_profiles row
-- when a new auth user is created via any sign-up method (Google OAuth,
-- email/password, magic link, etc.).
--
-- This complements the callback-route best-effort upsert: even if the
-- application-layer upsert is skipped (e.g. on a token refresh instead of
-- a new sign-in), the trigger ensures the profile row exists.
--
-- The trigger uses INSERT … ON CONFLICT DO NOTHING so it is fully idempotent.
-- The display name is derived from the identity provider metadata:
--   1. full_name  (set by Google OAuth)
--   2. name       (fallback for other providers)
--   3. email prefix (e.g. "alice" from "alice@example.com")
--   4. 'Player'   (last-resort default)
-- The value is truncated to 20 characters to match the VARCHAR(20) constraint.

-- ── Trigger function ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION initialize_user_profile()
RETURNS TRIGGER AS $$
DECLARE
  v_display_name VARCHAR(20);
  v_raw_name     TEXT;
BEGIN
  -- Prefer identity-provider metadata fields in priority order.
  v_raw_name :=
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      CASE
        WHEN NEW.email IS NOT NULL AND position('@' IN NEW.email) > 1
        THEN split_part(NEW.email, '@', 1)
        ELSE NULL
      END,
      'Player'
    );

  -- Truncate to 20 chars and strip surrounding whitespace.
  v_display_name := trim(substring(v_raw_name FROM 1 FOR 20));
  IF v_display_name = '' THEN
    v_display_name := 'Player';
  END IF;

  INSERT INTO public.user_profiles (id, display_name, avatar_id)
  VALUES (NEW.id, v_display_name, 'avatar-1')
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = public;

-- ── Attach the trigger to auth.users ─────────────────────────────────────────
-- Fires AFTER INSERT for every new registered account, regardless of how
-- the account was created (email, OAuth, magic link, etc.).

DROP TRIGGER IF EXISTS on_auth_user_created_profile ON auth.users;

CREATE TRIGGER on_auth_user_created_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION initialize_user_profile();

-- ── Back-fill existing users who don't have a profile yet ────────────────────
-- This handles users who were created before this migration was applied.
-- It inserts a minimal profile row (display_name = email prefix, avatar-1)
-- for any auth.users row that lacks a corresponding user_profiles entry.

INSERT INTO public.user_profiles (id, display_name, avatar_id)
SELECT
  u.id,
  trim(substring(
    COALESCE(
      u.raw_user_meta_data->>'full_name',
      u.raw_user_meta_data->>'name',
      CASE
        WHEN u.email IS NOT NULL AND position('@' IN u.email) > 1
        THEN split_part(u.email, '@', 1)
        ELSE 'Player'
      END
    )
  FROM 1 FOR 20)),
  'avatar-1'
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_profiles p WHERE p.id = u.id
);
