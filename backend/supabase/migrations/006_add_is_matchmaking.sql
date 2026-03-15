-- Migration: 006_add_is_matchmaking
-- Adds an is_matchmaking flag to the rooms table to distinguish hostless
-- matchmaking rooms (created by the matchmaking queue auto-assembly) from
-- private rooms created by a specific host.
--
-- Matchmaking rooms:
--   • No designated host — all players are equal peers.
--   • Teams are auto-assigned by the server (balanced alternation).
--   • Game starts automatically when all matched players join.
--   • Kick / drag-and-drop team reassignment are disabled.
--
-- Private rooms (default, is_matchmaking = false):
--   • The creating user is the host and manages the lobby.
--   • Teams can be drag-and-drop reassigned by the host.
--   • Game starts when the host sends start_game or the 2-minute timer fires.

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS is_matchmaking BOOLEAN NOT NULL DEFAULT false;

-- Partial index to quickly find active matchmaking rooms
CREATE INDEX IF NOT EXISTS rooms_matchmaking_active_idx
  ON rooms (is_matchmaking, status)
  WHERE is_matchmaking = true AND status IN ('waiting', 'starting');

COMMENT ON COLUMN rooms.is_matchmaking IS
  'True for rooms created by the matchmaking queue (no host, auto-start).';
