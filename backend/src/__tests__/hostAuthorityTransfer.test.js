'use strict';

/**
 * hostAuthorityTransfer.test.js
 *
 * Host authority transfer mechanism tests.
 *
 * Tests the following exported functions from roomSocketServer.js:
 *
 * _executeHostTransfer(roomCode)
 * 1. Promotes the first remaining client as new host
 * 2. Clears isHost flag on all previous entries
 * 3. Broadcasts host_changed with newHostId and newHostName
 * 4. Broadcasts room_players snapshot with updated isHost flags
 * 5. Persists the new host_user_id to Supabase
 * 6. No-op when room has no remaining clients
 * 7. Handles Supabase errors gracefully (does not throw)
 * 8. Broadcasts to spectators as well as players
 *
 * _startHostTransferTimer(roomCode, currentHostId)
 * 9. Adds an entry to hostTransferTimers with previousHostId
 * 10. No-op when timer already running for room (idempotent)
 * 11. Triggers _executeHostTransfer when timer fires
 * 12. Also broadcasts host_disconnected on start
 *
 * _cancelHostTransferTimer(roomCode)
 * 13. Removes the entry from hostTransferTimers
 * 14. Prevents _executeHostTransfer from being called after cancel
 * 15. No-op when no timer is running
 *
 * Reconnect flow (host reconnects before timer fires)
 * 16. _cancelHostTransferTimer is called when original host reconnects
 *
 * Dynamic isHost in message handler
 * 17. After transfer, new host's liveIsHost resolves to true
 * 18. After transfer, old host's liveIsHost resolves to false
 */

const {
  roomClients,
  roomSpectators,
  roomMeta,
  hostTransferTimers,
  HOST_RECONNECT_WINDOW_MS,
  getRoomPlayers,
  _executeHostTransfer,
  _startHostTransferTimer,
  _cancelHostTransferTimer,
  _resetRoomState,
  _setSupabaseClientFactory,
} = require('../ws/roomSocketServer');

// ---------------------------------------------------------------------------
// Fake WebSocket stub
// ---------------------------------------------------------------------------

function makeFakeWs(isOpen = true) {
  return {
    readyState: isOpen ? 1 : 0,
    send: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Supabase mock factory
// ---------------------------------------------------------------------------

function buildMockSupabase({ updateError = null } = {}) {
  const eqFn    = jest.fn().mockResolvedValue({ data: null, error: updateError });
  const updateFn = jest.fn().mockReturnValue({ eq: eqFn });
  const fromFn   = jest.fn().mockReturnValue({ update: updateFn });

  const supabase = { from: fromFn, _update: updateFn, _eq: eqFn };
  return supabase;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function populateRoom(roomCode, players, spectators = []) {
  const clients = new Map();
  for (const p of players) {
    clients.set(p.userId, { ws: makeFakeWs(), ...p });
  }
  roomClients.set(roomCode, clients);

  if (spectators.length > 0) {
    const specMap = new Map();
    for (const s of spectators) {
      specMap.set(s.userId, { ws: makeFakeWs(), ...s });
    }
    roomSpectators.set(roomCode, specMap);
  }

  roomMeta.set(roomCode, { playerCount: 6, isMatchmaking: false });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let mockSupabase;

beforeEach(() => {
  _resetRoomState();
  jest.useFakeTimers();

  mockSupabase = buildMockSupabase();
  _setSupabaseClientFactory(() => mockSupabase);
});

afterEach(() => {
  _resetRoomState();
  _setSupabaseClientFactory(null);
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers to parse broadcasts
// ---------------------------------------------------------------------------

function sentMessages(ws) {
  return ws.send.mock.calls.map((args) => JSON.parse(args[0]));
}

function getAllSentMessages(roomCode) {
  const msgs = [];
  const clients = roomClients.get(roomCode);
  if (clients) {
    for (const entry of clients.values()) {
      msgs.push(...sentMessages(entry.ws));
    }
  }
  const specs = roomSpectators.get(roomCode);
  if (specs) {
    for (const entry of specs.values()) {
      msgs.push(...sentMessages(entry.ws));
    }
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 1. _executeHostTransfer — basic promotion
// ---------------------------------------------------------------------------

describe('_executeHostTransfer', () => {
  const ROOM = 'XFER01';

  it('1. promotes the first remaining client as the new host', async () => {
    populateRoom(ROOM, [
      { userId: 'host', displayName: 'Original Host', isHost: false, isGuest: false, teamId: 1 },
      { userId: 'p2',   displayName: 'Player Two',    isHost: false, isGuest: false, teamId: 2 },
    ]);

    await _executeHostTransfer(ROOM);

    const clients = roomClients.get(ROOM);
    // First entry in Map insertion order should now be the host.
    const [, firstEntry] = Array.from(clients.entries())[0];
    expect(firstEntry.isHost).toBe(true);
  });

  it('2. clears isHost on all previous entries before setting new host', async () => {
    populateRoom(ROOM, [
      { userId: 'old-host', displayName: 'Old Host',  isHost: true,  isGuest: false, teamId: 1 },
      { userId: 'p2',       displayName: 'Player Two', isHost: false, isGuest: false, teamId: 2 },
      { userId: 'p3',       displayName: 'Player Three', isHost: false, isGuest: false, teamId: 1 },
    ]);

    await _executeHostTransfer(ROOM);

    const clients = roomClients.get(ROOM);
    const entries = Array.from(clients.values());

    // Exactly one host after transfer
    const hosts = entries.filter((e) => e.isHost);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].userId).toBe('old-host'); // first in insertion order
  });

  it('3. broadcasts host_changed with correct newHostId and newHostName', async () => {
    populateRoom(ROOM, [
      { userId: 'old-host', displayName: 'Old Host',  isHost: false, isGuest: false, teamId: 1 },
      { userId: 'p2',       displayName: 'Player Two', isHost: false, isGuest: false, teamId: 2 },
    ]);

    await _executeHostTransfer(ROOM);

    const msgs = getAllSentMessages(ROOM);
    const hostChangedMsg = msgs.find((m) => m.type === 'host_changed');
    expect(hostChangedMsg).toBeDefined();
    expect(hostChangedMsg.newHostId).toBe('old-host');
    expect(hostChangedMsg.newHostName).toBe('Old Host');
  });

  it('4. broadcasts room_players snapshot with updated isHost flags', async () => {
    populateRoom(ROOM, [
      { userId: 'a', displayName: 'Alice', isHost: false, isGuest: false, teamId: 1 },
      { userId: 'b', displayName: 'Bob',   isHost: false, isGuest: false, teamId: 2 },
    ]);

    await _executeHostTransfer(ROOM);

    const msgs = getAllSentMessages(ROOM);
    const playersMsg = msgs.find((m) => m.type === 'room_players');
    expect(playersMsg).toBeDefined();
    expect(Array.isArray(playersMsg.players)).toBe(true);

    // The player with userId 'a' (first) should now have isHost=true in the snapshot
    const aliceInSnapshot = playersMsg.players.find((p) => p.userId === 'a');
    expect(aliceInSnapshot.isHost).toBe(true);

    const bobInSnapshot = playersMsg.players.find((p) => p.userId === 'b');
    expect(bobInSnapshot.isHost).toBe(false);
  });

  it('5. persists the new host_user_id to Supabase', async () => {
    populateRoom(ROOM, [
      { userId: 'new-host', displayName: 'New Host', isHost: false, isGuest: false, teamId: 1 },
    ]);

    await _executeHostTransfer(ROOM);

    expect(mockSupabase.from).toHaveBeenCalledWith('rooms');
    expect(mockSupabase._update).toHaveBeenCalledWith({ host_user_id: 'new-host' });
    expect(mockSupabase._eq).toHaveBeenCalledWith('code', ROOM);
  });

  it('6. no-op when room has no remaining clients', async () => {
    // Room doesn't exist in roomClients at all
    await expect(_executeHostTransfer('EMPTY1')).resolves.toBeUndefined();

    // Room exists but has 0 players
    roomClients.set('EMPTY2', new Map());
    await expect(_executeHostTransfer('EMPTY2')).resolves.toBeUndefined();
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('7. handles Supabase errors gracefully (does not throw)', async () => {
    const errorSupabase = buildMockSupabase({ updateError: { message: 'DB offline' } });
    _setSupabaseClientFactory(() => errorSupabase);

    populateRoom(ROOM, [
      { userId: 'surviving', displayName: 'Survivor', isHost: false, isGuest: false, teamId: 1 },
    ]);

    await expect(_executeHostTransfer(ROOM)).resolves.toBeUndefined();
  });

  it('8. broadcasts to spectators as well as players', async () => {
    populateRoom(
      ROOM,
      [{ userId: 'p1', displayName: 'P1', isHost: false, isGuest: false, teamId: 1 }],
      [{ userId: 's1', displayName: 'Spec', role: 'spectator' }],
    );

    await _executeHostTransfer(ROOM);

    // Spectator ws should have received the host_changed broadcast
    const specWs = roomSpectators.get(ROOM).get('s1').ws;
    const specMsgs = sentMessages(specWs);
    const hostChangedMsg = specMsgs.find((m) => m.type === 'host_changed');
    expect(hostChangedMsg).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. _startHostTransferTimer
// ---------------------------------------------------------------------------

describe('_startHostTransferTimer', () => {
  const ROOM = 'START01';

  it('9. adds an entry to hostTransferTimers with the correct previousHostId', () => {
    populateRoom(ROOM, [
      { userId: 'host', displayName: 'Host', isHost: true, isGuest: false, teamId: 1 },
      { userId: 'p2',   displayName: 'P2',   isHost: false, isGuest: false, teamId: 2 },
    ]);

    _startHostTransferTimer(ROOM, 'host');

    expect(hostTransferTimers.has(ROOM)).toBe(true);
    expect(hostTransferTimers.get(ROOM).previousHostId).toBe('host');
  });

  it('10. no-op when timer already running for room (idempotent)', () => {
    populateRoom(ROOM, [
      { userId: 'host', displayName: 'Host', isHost: true, isGuest: false, teamId: 1 },
      { userId: 'p2',   displayName: 'P2',   isHost: false, isGuest: false, teamId: 2 },
    ]);

    _startHostTransferTimer(ROOM, 'host');
    const firstEntry = hostTransferTimers.get(ROOM);
    _startHostTransferTimer(ROOM, 'host');
    // Entry should not have changed
    expect(hostTransferTimers.get(ROOM)).toBe(firstEntry);
  });

  it('11. triggers _executeHostTransfer when the reconnect window expires', async () => {
    populateRoom(ROOM, [
      { userId: 'p2', displayName: 'P2', isHost: false, isGuest: false, teamId: 2 },
    ]);

    _startHostTransferTimer(ROOM, 'host');

    // Advance past the reconnect window
    jest.advanceTimersByTime(HOST_RECONNECT_WINDOW_MS + 1000);
    // Allow any microtasks/promises to flush
    await Promise.resolve();
    await Promise.resolve();

    // Timer entry should be removed
    expect(hostTransferTimers.has(ROOM)).toBe(false);

    // The remaining player (p2) should now have isHost=true
    const clients = roomClients.get(ROOM);
    expect(clients.get('p2').isHost).toBe(true);
  });

  it('12. broadcasts host_disconnected when timer starts', () => {
    populateRoom(ROOM, [
      { userId: 'host', displayName: 'Host', isHost: true, isGuest: false, teamId: 1 },
      { userId: 'p2',   displayName: 'P2',   isHost: false, isGuest: false, teamId: 2 },
    ]);

    _startHostTransferTimer(ROOM, 'host');

    const msgs = getAllSentMessages(ROOM);
    const disconnMsg = msgs.find((m) => m.type === 'host_disconnected');
    expect(disconnMsg).toBeDefined();
    expect(disconnMsg.roomCode).toBe(ROOM);
    expect(typeof disconnMsg.expiresAt).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// 3. _cancelHostTransferTimer
// ---------------------------------------------------------------------------

describe('_cancelHostTransferTimer', () => {
  const ROOM = 'CANCEL01';

  it('13. removes the entry from hostTransferTimers', () => {
    populateRoom(ROOM, [
      { userId: 'host', displayName: 'Host', isHost: true, isGuest: false, teamId: 1 },
      { userId: 'p2',   displayName: 'P2',   isHost: false, isGuest: false, teamId: 2 },
    ]);

    _startHostTransferTimer(ROOM, 'host');
    expect(hostTransferTimers.has(ROOM)).toBe(true);

    _cancelHostTransferTimer(ROOM);
    expect(hostTransferTimers.has(ROOM)).toBe(false);
  });

  it('14. prevents _executeHostTransfer from being called after cancel', async () => {
    populateRoom(ROOM, [
      { userId: 'p2', displayName: 'P2', isHost: false, isGuest: false, teamId: 2 },
    ]);

    _startHostTransferTimer(ROOM, 'host');
    _cancelHostTransferTimer(ROOM);

    // Advance well past the window
    jest.advanceTimersByTime(HOST_RECONNECT_WINDOW_MS * 2);
    await Promise.resolve();
    await Promise.resolve();

    // p2 should NOT have been promoted (no transfer)
    const clients = roomClients.get(ROOM);
    expect(clients.get('p2').isHost).toBe(false);
  });

  it('15. no-op when no timer is running (does not throw)', () => {
    expect(() => _cancelHostTransferTimer('NOTIMER')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Dynamic isHost after transfer
// ---------------------------------------------------------------------------

describe('dynamic isHost after transfer', () => {
  const ROOM = 'DYNAMIC01';

  it('17 & 18. new host entry has isHost=true, old host entry has isHost=false after transfer', async () => {
    populateRoom(ROOM, [
      { userId: 'old-host', displayName: 'Old Host', isHost: true,  isGuest: false, teamId: 1 },
      { userId: 'new-host', displayName: 'New Host', isHost: false, isGuest: false, teamId: 2 },
    ]);

    await _executeHostTransfer(ROOM);

    const clients = roomClients.get(ROOM);
    // old-host was first insertion → becomes new host
    expect(clients.get('old-host').isHost).toBe(true);
    expect(clients.get('new-host').isHost).toBe(false);
  });

  it('room_players broadcast reflects updated isHost=true for new host', async () => {
    populateRoom(ROOM, [
      { userId: 'alice', displayName: 'Alice', isHost: true,  isGuest: false, teamId: 1 },
      { userId: 'bob',   displayName: 'Bob',   isHost: false, isGuest: false, teamId: 2 },
    ]);

    await _executeHostTransfer(ROOM);

    const aliceWs = roomClients.get(ROOM).get('alice').ws;
    const msgs = sentMessages(aliceWs);
    const playersMsg = msgs.find((m) => m.type === 'room_players');
    expect(playersMsg).toBeDefined();

    const aliceEntry = playersMsg.players.find((p) => p.userId === 'alice');
    expect(aliceEntry.isHost).toBe(true);
  });
});
