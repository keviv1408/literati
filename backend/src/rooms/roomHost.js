'use strict';

function isRoomHost(room, playerId) {
  if (typeof playerId !== 'string' || playerId === '') return false;
  return playerId === room.host_user_id || playerId === room.host_guest_id;
}

// host_user_id has a foreign key to users, so a guest id must never land there.
function hostColumns(playerId, isGuest) {
  return isGuest
    ? { host_user_id: null, host_guest_id: playerId }
    : { host_user_id: playerId, host_guest_id: null };
}

function storedHostId(room) {
  return room.host_user_id || room.host_guest_id || null;
}

async function _transitionWaitingRoom(db, code, nextStatus, hostColumn, hostId) {
  let query = db.from('rooms').update({ status: nextStatus })
    .eq('code', code).eq('status', 'waiting').eq('is_matchmaking', false);
  if (hostColumn) query = query.eq(hostColumn, hostId);
  const { data, error } = await query.select('code').maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function _releaseFailedStart(db, code) {
  try {
    const { error } = await db.from('rooms').update({ status: 'waiting' })
      .eq('code', code).eq('status', 'starting');
    if (error) throw error;
  } catch (err) {
    console.error('[rooms/start] Could not release starting room:', code, err);
  }
}

module.exports = { _releaseFailedStart, _transitionWaitingRoom, isRoomHost, hostColumns, storedHostId };
