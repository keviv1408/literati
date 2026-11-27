'use strict';

const { getGame } = require('../game/gameStore');
const _startingRooms = new Set();
const _pendingReleases = new Map();

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
  if (data) _forgetRelease(code);
  return Boolean(data);
}

async function _claimRoomStart(db, code, previousStatus, hostColumn, hostId) {
  try {
    let query = db.from('rooms').update({ status: 'starting' }).eq('code', code).eq('status', previousStatus);
    if (previousStatus === 'waiting') query = query.eq('is_matchmaking', false);
    if (hostColumn) query = query.eq(hostColumn, hostId);
    const { data, error } = await query.select('code').maybeSingle();
    if (error) throw error;
    if (data) _forgetRelease(code);
    return Boolean(data);
  } catch (err) {
    // A lost response can leave our write committed; the room lock keeps other deals out during recovery.
    if (getGame(code)?.status !== 'active') await _releaseFailedStart(db, code, previousStatus, hostColumn, hostId);
    throw err;
  }
}

function _forgetRelease(code) {
  clearTimeout(_pendingReleases.get(code)?.timer);
  _pendingReleases.delete(code);
}

async function _restoreStartingRoom({ db, code, previousStatus, hostColumn, hostId }) {
  let query = db.from('rooms').update({ status: previousStatus })
    .eq('code', code).eq('status', 'starting');
  if (previousStatus === 'waiting') query = query.eq('is_matchmaking', false);
  if (hostColumn) query = query.eq(hostColumn, hostId);
  const { error } = await query;
  if (error) throw error;
}

function _scheduleRelease(release, delay) {
  const { code } = release;
  release.timer = setTimeout(async () => {
    if (_pendingReleases.get(code) !== release) return;
    if (getGame(code)?.status === 'active') {
      _forgetRelease(code);
      return;
    }
    if (!_startingRooms.has(code)) {
      _startingRooms.add(code);
      try {
        await _restoreStartingRoom(release);
        _forgetRelease(code);
        return;
      } catch (err) {
        console.error('[rooms/start] Could not retry starting room release:', code, err);
      } finally {
        _startingRooms.delete(code);
      }
    }
    if (_pendingReleases.get(code) === release) _scheduleRelease(release, Math.min(delay * 2, 30_000));
  }, delay);
  release.timer.unref?.();
}

async function _releaseFailedStart(db, code, previousStatus = 'waiting', hostColumn, hostId) {
  const release = { db, code, previousStatus, hostColumn, hostId };
  try {
    await _restoreStartingRoom(release);
    _forgetRelease(code);
  } catch (err) {
    console.error('[rooms/start] Could not release starting room:', code, err);
    _forgetRelease(code);
    _pendingReleases.set(code, release);
    _scheduleRelease(release, 1000);
  }
}

module.exports = { _startingRooms, _releaseFailedStart, _claimRoomStart, _cancelWaitingRoom, isRoomHost, hostColumns, storedHostId };
