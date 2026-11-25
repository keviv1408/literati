'use strict';

/**
 * Lobby socket lifecycle at the WebSocket layer (real ws clients against the
 * attached room socket server):
 *
 * 1. A close that arrives late from a replaced socket must not unregister the
 *    lobby the same player has since rejoined.
 * 2. A socket that closes while the handler awaits the room row is not
 *    registered, and does not evict the player's live socket.
 * 3. A spectator's earlier socket closing does not unsubscribe their newer one.
 * 4. Every join and leave is logged with the room size.
 * 5. The host flag comes from the room row, and a reconnecting player keeps
 *    the crown they hold in the lobby.
 */

const http      = require('http');
const WebSocket = require('ws');

const ROOM_CODE = 'LOBBY1';
const MEMBER_TOKEN = 'registered-member-token';
const MEMBER_ID    = 'registered-member-id';
const ROOM_ROW  = {
  id: 'room-id-lobby1', code: ROOM_CODE, host_user_id: null, status: 'waiting',
  player_count: 6, is_matchmaking: false, spectator_token: 'SPECTOK',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(cond, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(5);
  }
  return false;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

describe('lobby socket lifecycle', () => {
  let httpServer, port, wss, room, logSpy;
  let hostToken, hostId, friendToken;
  let lookups = 0;
  let chain;
  let nextLookup = null;
  const sockets = [];

  function connect(token, query = '') {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/room/${ROOM_CODE}?token=${token}${query}`);
    const client = { ws, messages: [] };
    ws.on('message', (d) => client.messages.push(JSON.parse(d.toString())));
    ws.on('error', () => {});
    sockets.push(ws);
    return client;
  }

  const has = (client, type) => client.messages.some((m) => m.type === type);
  const received = (client, type) => until(() => has(client, type));
  const players = (client) => {
    const snapshots = client.messages.filter((m) => m.type === 'room_players');
    return snapshots.length ? snapshots[snapshots.length - 1].players : [];
  };
  const hostFlags = (client) => Object.fromEntries(players(client).map((p) => [p.displayName, p.isHost]));
  const serveRow = (row) => { nextLookup = () => Promise.resolve({ data: row, error: null }); };
  const roster = (client) => {
    const snapshots = client.messages.filter((m) => m.type === 'room_players');
    return snapshots.length ? snapshots[snapshots.length - 1].players.map((p) => p.displayName) : null;
  };

  beforeAll((done) => {
    jest.resetModules();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    chain = {};
    chain.select      = jest.fn(() => chain);
    chain.eq          = jest.fn(() => chain);
    chain.maybeSingle = jest.fn(() => {
      lookups += 1;
      return nextLookup ? nextLookup() : Promise.resolve({ data: ROOM_ROW, error: null });
    });
    const supabase = {
      from: jest.fn(() => chain),
      auth: {
        getUser: jest.fn(async (token) => (token === MEMBER_TOKEN
          ? { data: { user: { id: MEMBER_ID, user_metadata: { display_name: 'Member' } } }, error: null }
          : { data: { user: null }, error: 'no-user' })),
      },
    };
    require('../db/supabase')._setSupabaseClient(supabase);

    const guests = require('../sessions/guestSessionStore');
    const host   = guests.createGuestSession('Host');
    hostToken    = host.token;
    hostId       = host.session.sessionId;
    friendToken  = guests.createGuestSession('Friend').token;
    ROOM_ROW.host_guest_id = hostId;

    room = require('../ws/roomSocketServer');
    room._setSupabaseClientFactory(() => supabase);

    httpServer = http.createServer();
    wss = room.attachRoomSocketServer(httpServer);
    httpServer.listen(0, () => {
      port = httpServer.address().port;
      done();
    });
  });

  afterEach(async () => {
    nextLookup = null;
    for (const ws of sockets.splice(0)) ws.terminate();
    await until(() => wss.clients.size === 0);
    room._resetRoomState();
    logSpy.mockClear();
  });

  afterAll((done) => {
    logSpy.mockRestore();
    wss.close();
    httpServer.close(done);
  });

  it('keeps the lobby registered when a replaced socket closes late', async () => {
    const first = connect(hostToken);
    await received(first, 'connected');
    first.ws._socket.pause(); // a client that has gone quiet never answers the server's close

    const second = connect(hostToken); // the host comes back; the server replaces the first socket
    await received(second, 'connected');
    second.ws.close();                 // and leaves again, which empties the lobby
    await until(() => !room.roomClients.has(ROOM_CODE));

    const third = connect(hostToken);
    await received(third, 'connected');

    first.ws._socket.resume();         // the first socket's close reaches the server only now
    await until(() => wss.clients.size === 1);

    const friend = connect(friendToken);
    await received(friend, 'room_players');

    expect(roster(friend)).toEqual(['Host', 'Friend']);
    await until(() => roster(third).length === 2, 300);
    expect(roster(third)).toEqual(['Host', 'Friend']);
  });

  it('does not register a socket that closed during the room lookup', async () => {
    const gate = deferred();
    nextLookup = () => gate.promise;
    const before = lookups;

    const early = connect(friendToken);
    await until(() => lookups === before + 1); // handler is parked on the room row
    early.ws.close();
    await until(() => wss.clients.size === 0);

    gate.resolve({ data: ROOM_ROW, error: null });
    await sleep(30);

    expect(room.getRoomPlayers(ROOM_CODE)).toEqual([]);
  });

  it('does not let a socket that closed during the room lookup evict the live one', async () => {
    const live = connect(hostToken);
    await received(live, 'connected');

    const gate = deferred();
    nextLookup = () => gate.promise;
    const before = lookups;
    const stale = connect(hostToken);
    await until(() => lookups === before + 1);
    stale.ws.close();
    await until(() => wss.clients.size === 1);

    nextLookup = null;
    gate.resolve({ data: ROOM_ROW, error: null });
    await sleep(30);

    const friend = connect(friendToken);
    await received(friend, 'room_players');

    expect(has(live, 'closing')).toBe(false);
    await until(() => roster(live).length === 2, 300);
    expect(roster(live)).toEqual(['Host', 'Friend']);
  });

  it('keeps a spectator subscribed when their earlier socket closes', async () => {
    const watch = '&role=spectator&spectator_token=SPECTOK';
    const first = connect(friendToken, watch);
    await received(first, 'connected');
    const second = connect(friendToken, watch);
    await received(second, 'connected');
    first.ws.close();
    await until(() => wss.clients.size === 1);

    const host = connect(hostToken);
    await received(host, 'connected');

    await until(() => roster(second).length === 1, 300);
    expect(roster(second)).toEqual(['Host']);
  });

  it('logs each join and leave with the room size', async () => {
    const host = connect(hostToken);
    await received(host, 'connected');
    host.ws.close();
    await until(() => wss.clients.size === 0);

    const lines = logSpy.mock.calls.map((args) => args.join(' '));
    expect(lines).toContain(`[RoomWS] join room=${ROOM_CODE} user=${hostId} players=1`);
    expect(lines).toContain(`[RoomWS] leave room=${ROOM_CODE} user=${hostId} players=0`);
  });

  it('flags the guest named in host_guest_id as host', async () => {
    const host = connect(hostToken);
    await received(host, 'room_players');

    expect(hostFlags(host)).toEqual({ Host: true });
    expect(chain.select.mock.calls.some(([cols]) => cols.includes('host_guest_id'))).toBe(true);
  });

  it('flags the registered user named in host_user_id as host', async () => {
    serveRow({ ...ROOM_ROW, host_user_id: MEMBER_ID, host_guest_id: null });
    const member = connect(MEMBER_TOKEN);
    await received(member, 'room_players');

    expect(hostFlags(member)).toEqual({ Member: true });
  });

  it('does not flag a second player the room row names while the host is connected', async () => {
    const host = connect(hostToken);
    await received(host, 'connected');

    serveRow({ ...ROOM_ROW, host_user_id: MEMBER_ID });
    const member = connect(MEMBER_TOKEN);
    await received(member, 'room_players');

    expect(hostFlags(member)).toEqual({ Host: true, Member: false });
  });

  it('keeps the crown a transfer gave when that player reconnects', async () => {
    const first = connect(friendToken);
    await received(first, 'connected');
    const friendId = first.messages.find((m) => m.type === 'connected').userId;
    room.roomClients.get(ROOM_CODE).get(friendId).isHost = true;

    const second = connect(friendToken);
    await received(second, 'room_players');
    await received(first, 'closing');
    await until(() => wss.clients.size === 1);
    await sleep(30);

    expect(hostFlags(second)).toEqual({ Friend: true });
    expect(has(second, 'host_disconnected')).toBe(false);
  });

  it('keeps the host flagged when the host opens a second socket', async () => {
    const first = connect(hostToken);
    await received(first, 'connected');

    const second = connect(hostToken);
    await received(second, 'room_players');
    await received(first, 'closing');
    await until(() => wss.clients.size === 1);
    await sleep(30);

    expect(first.messages.find((m) => m.type === 'closing').code).toBe(4006);
    expect(hostFlags(second)).toEqual({ Host: true });
    expect(has(second, 'host_disconnected')).toBe(false);
  });
});
