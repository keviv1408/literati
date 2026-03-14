-- Migration: 009_add_abandoned_room_status
-- Adds 'abandoned' to the room_status enum so games that started but were
-- never completed (server crash, all players disconnected, dissolution before
-- all 8 half-suits declared) can be marked explicitly in the DB.
--
-- Guarantees:
--   • Only rooms with status 'completed' ever produce stat updates.
--   • Stale 'in_progress' rooms (e.g. from a server restart) are swept to
--     'abandoned' by the startup cleanup helper markStaleGamesAbandoned().
--   • 'abandoned' rows are excluded from leaderboard/stats queries by the
--     existing guards in updateStats() (gs.status !== 'completed') and the
--     increment_user_stats RPC (called only after game_over).
--
-- The ALTER TYPE … ADD VALUE approach is the canonical Postgres way to extend
-- an existing enum.  This is safe on Supabase/Postgres >= 12 (no table rewrite).

ALTER TYPE room_status ADD VALUE IF NOT EXISTS 'abandoned';

-- ── Cleanup helper function ───────────────────────────────────────────────────
-- mark_stale_games_abandoned() sweeps all rooms whose status is 'in_progress'
-- and whose updated_at is older than the supplied interval.
-- Called by the Node.js server at startup to clean up games that were never
-- completed before the server last restarted.
--
-- Parameters:
--   stale_after  INTERVAL  – how long a room must be idle before it is
--                            considered abandoned (default: 2 hours)
--
-- Returns: the number of rooms updated.

CREATE OR REPLACE FUNCTION mark_stale_games_abandoned(
  stale_after INTERVAL DEFAULT '2 hours'
)
RETURNS INTEGER AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE public.rooms
  SET    status = 'abandoned'
  WHERE  status = 'in_progress'
    AND  updated_at < (NOW() - stale_after);

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = public;
