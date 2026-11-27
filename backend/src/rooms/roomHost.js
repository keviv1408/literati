'use strict';

const { getGame } = require('../game/gameStore');
const _startingRooms = new Set();

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

async function _cancelWaitingRoom(db, code, hostColumn, hostId) {
  const { data, error } = await db.from('rooms').update({ status: 'cancelled' })
    .eq('code', code).eq('is_matchmaking', false)
    .in('status', ['waiting', 'cancelled']).eq(hostColumn, hostId).select('code').maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function _claimRoomStart(db, code, previousStatus, hostColumn, hostId) {
  try {
    let query = db.from('rooms').update({ status: 'starting' }).eq('code', code).eq('status', previousStatus);
    if (previousStatus === 'waiting') query = query.eq('is_matchmaking', false);
    if (hostColumn) query = query.eq(hostColumn, hostId);
    const { data, error } = await query.select('code').maybeSingle();
    if (error) throw error;
    return Boolean(data);
  } catch (err) {
    // A lost response can leave our write committed; the room lock keeps other deals out during recovery.
    if (getGame(code)?.status !== 'active') await _releaseFailedStart(db, code, previousStatus, hostColumn, hostId);
    throw err;
  }
}

async function _releaseFailedStart(db, code, previousStatus = 'waiting', hostColumn, hostId) {
  try {
    let query = db.from('rooms').update({ status: previousStatus })
      .eq('code', code).eq('status', 'starting');
    if (hostColumn) query = query.eq(hostColumn, hostId);
    const { error } = await query;
    if (error) throw error;
  } catch (err) {
    console.error('[rooms/start] Could not release starting room:', code, err);
  }
}

module.exports = { _startingRooms, _releaseFailedStart, _claimRoomStart, _cancelWaitingRoom, isRoomHost, hostColumns, storedHostId };
