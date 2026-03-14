-- Migration: 004_add_room_tokens
-- Adds invite_code (player join link token) and spectator_token to the rooms table.
--
-- invite_code   — A secure URL-safe token shared with invited players.
--                 Used as the path param for the /join/{invite_code} player link.
--                 16 hex chars (8 random bytes → 64-bit entropy).
--
-- spectator_token — A separate, longer secure token for the spectator view link.
--                   Used as the path param for /spectate/{spectator_token}.
--                   32 hex chars (16 random bytes → 128-bit entropy).

-- ── Add columns ───────────────────────────────────────────────────────────────

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS invite_code      VARCHAR(16) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS spectator_token  VARCHAR(32) NOT NULL DEFAULT '';

-- ── Back-fill existing rows (dev / test environments) ─────────────────────────
-- Existing rows get deterministic defaults derived from their id so the
-- NOT NULL constraint is satisfied. Real rooms always get tokens from the
-- application layer on insert.

UPDATE rooms
SET
  invite_code     = UPPER(SUBSTRING(REPLACE(id::text, '-', ''), 1, 16)),
  spectator_token = UPPER(REPLACE(id::text, '-', ''))
WHERE invite_code = '' OR spectator_token = '';

-- ── Remove defaults (application layer must supply values on every insert) ─────

ALTER TABLE rooms
  ALTER COLUMN invite_code     DROP DEFAULT,
  ALTER COLUMN spectator_token DROP DEFAULT;

-- ── Unique indexes ────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS rooms_invite_code_unique
  ON rooms (invite_code);

CREATE UNIQUE INDEX IF NOT EXISTS rooms_spectator_token_unique
  ON rooms (spectator_token);
