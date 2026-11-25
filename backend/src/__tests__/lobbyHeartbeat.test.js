'use strict';

/**
 * The lobby socket server sends { type: 'heartbeat' } to every open socket on
 * connect and every 15 seconds, so a client can tell a quiet lobby from a dead
 * connection.
 */

const http      = require('http');
const WebSocket = require('ws');

const HEARTBEAT = '{"type":"heartbeat"}';

describe('lobby heartbeat', () => {
  let room;

  beforeAll(() => {
    jest.resetModules();
    const chain = {};
    chain.select      = jest.fn(() => chain);
    chain.eq          = jest.fn(() => chain);
    chain.maybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: 'room-id-beat01', code: 'BEAT01', host_user_id: null, status: 'waiting',
        player_count: 6, is_matchmaking: false,
      },
      error: null,
    });
    const supabase = {
      from: jest.fn(() => chain),
      auth: { getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: 'no-user' }) },
    };
    require('../db/supabase')._setSupabaseClient(supabase);
    room = require('../ws/roomSocketServer');
    room._setSupabaseClientFactory(() => supabase);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    room._resetRoomState();
  });

  it('sends the heartbeat to open sockets only', () => {
    const open   = { readyState: 1, send: jest.fn() };
    const closed = { readyState: 3, send: jest.fn() };

    room._broadcastHeartbeat({ clients: new Set([open, closed]) });

    expect(open.send).toHaveBeenCalledTimes(1);
    expect(open.send).toHaveBeenCalledWith(HEARTBEAT);
    expect(closed.send).not.toHaveBeenCalled();
  });

  it('sends a heartbeat every 15 seconds and stops when the server closes', () => {
    jest.useFakeTimers();
    const wss  = room.attachRoomSocketServer({ on: jest.fn() });
    const stub = { readyState: 1, send: jest.fn() };
    wss.clients.add(stub);

    jest.advanceTimersByTime(15000);
    expect(stub.send).toHaveBeenCalledTimes(1);
    expect(stub.send).toHaveBeenCalledWith(HEARTBEAT);

    wss.clients.delete(stub); // a stub never reports closed, so close() would wait on it
    wss.close();
    jest.runAllTicks();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('sends a heartbeat to a player as soon as they connect', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const { token } = require('../sessions/guestSessionStore').createGuestSession('Host');
    const httpServer = http.createServer();
    const wss = room.attachRoomSocketServer(httpServer);
    await new Promise((r) => httpServer.listen(0, r));

    const ws = new WebSocket(`ws://127.0.0.1:${httpServer.address().port}/ws/room/BEAT01?token=${token}`);
    const types = [];
    await new Promise((resolve) => {
      ws.on('message', (d) => {
        types.push(JSON.parse(d.toString()).type);
        if (types.includes('room_players')) resolve();
      });
    });

    ws.terminate();
    wss.close();
    await new Promise((r) => httpServer.close(r));

    expect(types).toContain('heartbeat');
  });
});
