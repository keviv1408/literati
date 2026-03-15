-- Migration: 001_create_rooms_table
-- Creates the rooms table used to persist private game room configurations.

-- Enable pgcrypto for gen_random_uuid() (available in Supabase by default)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Enum types ────────────────────────────────────────────────────────────────

CREATE TYPE room_status AS ENUM (
  'waiting',       -- Room created, waiting for players to join
  'starting',      -- All seats filled, countdown underway
  'in_progress',   -- Game is active
  'completed',     -- Game finished normally
  'cancelled'      -- Room was cancelled before game start
);

CREATE TYPE card_removal_variant AS ENUM (
  'remove_2s',   -- Remove all four 2s from the deck
  'remove_7s',   -- Remove all four 7s from the deck (classic)
  'remove_8s'    -- Remove all four 8s from the deck
);

-- ── rooms table ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rooms (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The unique 6-character alphanumeric room code players use to join
  code                 CHAR(6)      NOT NULL,

  -- The user who created the room (and sets game options)
  host_user_id         UUID         NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,

  -- Number of human + bot seats (6 or 8)
  player_count         SMALLINT     NOT NULL CHECK (player_count IN (6, 8)),

  -- Which rank is removed to create the 48-card Literature deck
  card_removal_variant card_removal_variant NOT NULL,

  -- Lifecycle state
  status               room_status  NOT NULL DEFAULT 'waiting',

  -- Timestamps
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Fast lookup by room code (unique — only one active room per code at a time)
CREATE UNIQUE INDEX rooms_code_unique
  ON rooms (code);

-- Allow efficient "does this host have an active room?" check
CREATE INDEX rooms_host_status_idx
  ON rooms (host_user_id, status)
  WHERE status IN ('waiting', 'starting', 'in_progress');

-- ── Auto-update updated_at ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rooms_updated_at
  BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Row Level Security ────────────────────────────────────────────────────────
-- The backend uses the service-role key and bypasses RLS entirely.
-- RLS policies below protect direct client access if ever enabled.

ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read any room (for spectating / joining by code)
CREATE POLICY "rooms_select_authenticated"
  ON rooms FOR SELECT
  TO authenticated
  USING (true);

-- Only the host can update their own room
CREATE POLICY "rooms_update_own"
  ON rooms FOR UPDATE
  TO authenticated
  USING (auth.uid() = host_user_id);

-- Only the backend service role can insert rooms (enforced by using service key)
-- No INSERT policy for authenticated role — all inserts go through the backend.
