'use strict';

const liveGamesStore = require('./liveGamesStore');

function buildSpectatorUrl(roomCode, spectatorToken) {
  return `/game/${roomCode}?spectatorToken=${encodeURIComponent(spectatorToken)}`;
}

/**
 * Rehydrate the in-memory live-games registry from Supabase.
 *
 * This keeps the public live-games feed in sync after backend restarts, where
 * the DB still knows about `in_progress` rooms but the in-memory store starts
 * empty. Scores and human-player counts are recovered from the persisted
 * `game_state` snapshot when available.
 *
 * @param {Object} supabase
 * @returns {Promise<Object[]>} The rows returned from Supabase
 */
async function syncInProgressRoomsToLiveGamesStore(supabase) {
  const { data: rooms, error } = await supabase
    .from('rooms')
    .select('code, player_count, card_removal_variant, status, created_at, updated_at, game_state, spectator_token')
    .eq('status', 'in_progress');

  if (error) {
    throw error;
  }

  const activeRooms = Array.isArray(rooms) ? rooms : [];
  const activeRoomCodes = new Set(activeRooms.map((room) => room.code.toUpperCase()));

  // Evict stale in-progress entries that no longer exist in the DB snapshot.
  // This covers cases where the in-memory store missed a completion/removal
  // event and would otherwise keep serving a finished game forever.
  for (const game of liveGamesStore.getAll()) {
    if (game.status === 'in_progress' && !activeRoomCodes.has(game.roomCode.toUpperCase())) {
      liveGamesStore.removeGame(game.roomCode);
    }
  }

  for (const room of activeRooms) {
    const snapshot = room.game_state ?? {};
    const players = Array.isArray(snapshot.players) ? snapshot.players : [];
    const scores = snapshot.scores ?? { team1: 0, team2: 0 };
    const createdAt = Date.parse(room.created_at ?? '') || Date.now();
    const startedAt = Date.parse(room.updated_at ?? room.created_at ?? '') || createdAt;
    const currentPlayers = players.length > 0
      ? players.filter((player) => !player.isBot).length
      : room.player_count;

    if (!room.spectator_token) {
      continue;
    }

    const payload = {
      roomCode:       room.code,
      playerCount:    room.player_count,
      currentPlayers,
      cardVariant:    snapshot.variant ?? room.card_removal_variant,
      spectatorUrl:   buildSpectatorUrl(room.code, room.spectator_token),
      scores,
      status:         'in_progress',
      createdAt,
      startedAt,
    };

    const existing = liveGamesStore.get(room.code);
    if (existing) {
      // Preserve the in-memory startedAt so the elapsed timer doesn't reset on
      // each client reconnect. updated_at changes with every game action, so
      // using it here would make the timer restart on every page refresh.
      liveGamesStore.updateGame(room.code, { ...payload, startedAt: existing.startedAt });
    } else {
      liveGamesStore.addGame(payload);
    }
  }

  return activeRooms;
}

module.exports = { syncInProgressRoomsToLiveGamesStore };
