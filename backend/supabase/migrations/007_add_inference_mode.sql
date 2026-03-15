-- Migration 007: Add inference_mode column to rooms table
--
-- inference_mode: when true, bots (and optionally the UI) display inferred
-- knowledge about which cards have been asked for and eliminated, giving
-- all players strategic context.  Defaults to true for all new rooms.
-- Matchmaking rooms always use inference_mode = true (enforced by the server).
-- Private-room hosts can disable it at room-creation time.

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS inference_mode BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN rooms.inference_mode IS
  'When true, inference highlights (bot reasoning / card elimination) are '
  'enabled for the game.  Always true for matchmaking rooms; host-configurable '
  'for private rooms at creation time.  Defaults to true.';
