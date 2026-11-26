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

module.exports = { isRoomHost, hostColumns, storedHostId };
