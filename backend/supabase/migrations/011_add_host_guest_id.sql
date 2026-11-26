-- Migration: 011_add_host_guest_id
-- Lets a guest host a room. Guests have no auth.users row, so their id gets
-- its own column and host_user_id (with its foreign key) stays for
-- registered users only. A room has at most one kind of host.
--
-- The open read policy is dropped because the backend reads rooms with the
-- service role and a signed-in client should not list every room.
--
-- The stale sweep now also catches lobbies left in 'waiting' or 'starting',
-- so a host who walks away is not stuck behind the one-active-room check.
--
-- The sweep is SECURITY DEFINER and takes its interval from the caller, so
-- only the service role may run it. Otherwise anyone holding the public anon
-- key could abandon every active room.

ALTER TABLE rooms ALTER COLUMN host_user_id DROP NOT NULL;

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS host_guest_id UUID;

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_one_host_kind;
ALTER TABLE rooms ADD CONSTRAINT rooms_one_host_kind
  CHECK (host_user_id IS NULL OR host_guest_id IS NULL);

CREATE INDEX IF NOT EXISTS rooms_host_guest_status_idx
  ON rooms (host_guest_id, status)
  WHERE status IN ('waiting', 'starting', 'in_progress');

DROP POLICY IF EXISTS rooms_select_authenticated ON rooms;

CREATE OR REPLACE FUNCTION mark_stale_games_abandoned(
  stale_after INTERVAL DEFAULT '2 hours'
)
RETURNS INTEGER AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE public.rooms
  SET    status = 'abandoned'
  WHERE  status IN ('in_progress', 'waiting', 'starting')
    AND  updated_at < (NOW() - stale_after);

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = public;

REVOKE EXECUTE ON FUNCTION public.mark_stale_games_abandoned(INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_stale_games_abandoned(INTERVAL) TO service_role;
