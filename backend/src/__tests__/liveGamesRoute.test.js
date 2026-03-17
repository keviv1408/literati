'use strict';

/**
 * Tests for GET /api/live-games
 *
 * Covers:
 *  - Empty list when no games registered
 *  - All active games returned with elapsedMs
 *  - No auth required (public endpoint)
 */

const request = require('supertest');
let mockSupabase;

// ── Isolate the live games store before requiring app ──────────────────────
// We require the store singleton, clear it, then set up fixtures.
const liveGamesStore = require('../liveGames/liveGamesStore');

// Stub out Supabase and other heavy services before loading index.js
jest.mock('../db/supabase', () => ({
  getSupabaseClient: jest.fn(() => mockSupabase),
}));
jest.mock('../sessions/guestSessionStore', () => ({
  getGuestSession:   jest.fn(() => null),
  startCleanupTimer: jest.fn(),
  stopCleanupTimer:  jest.fn(),
}));
jest.mock('../matchmaking/matchmakingQueue', () => ({
  startQueueCleanupTimer: jest.fn(),
  stopQueueCleanupTimer:  jest.fn(),
  getQueueSnapshot:       jest.fn(() => ({ queues: {}, totalWaiting: 0 })),
}));
jest.mock('../socket/server', () => ({
  initSocket:         jest.fn(() => ({ on: jest.fn() })),
  getIO:              jest.fn(() => null),
  getConnectedUsers:  jest.fn(() => new Map()),
}));
jest.mock('../ws/wsServer',           () => ({ createWsServer:          jest.fn() }));
jest.mock('../ws/roomSocketServer',    () => ({ attachRoomSocketServer:  jest.fn() }));
jest.mock('../game/gameSocketServer',  () => ({ attachGameSocketServer:  jest.fn() }));
jest.mock('../ws/liveGamesSocketServer', () => ({ attachLiveGamesSocketServer: jest.fn() }));

const app = require('../index');

beforeEach(() => {
  const roomsEq = jest.fn().mockResolvedValue({ data: [], error: null });
  const roomsSelect = jest.fn(() => ({ eq: roomsEq }));
  mockSupabase = {
    from: jest.fn((table) => {
      if (table === 'rooms') {
        return { select: roomsSelect };
      }
      return {
        select: jest.fn(() => ({ eq: jest.fn().mockResolvedValue({ data: null, error: null }) })),
      };
    }),
    auth: { getUser: jest.fn() },
    rpc: jest.fn(),
    _roomsEq: roomsEq,
  };
  liveGamesStore._clearAll();
});

afterEach(() => {
  liveGamesStore._clearAll();
  jest.clearAllMocks();
});

describe('GET /api/live-games', () => {
  it('returns 200 with an empty games array when no games are active', async () => {
    const res = await request(app).get('/api/live-games');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ games: [], total: 0 });
  });

  it('returns all active games with elapsedMs', async () => {
    liveGamesStore.addGame({
      roomCode:       'ABCD12',
      playerCount:    6,
      currentPlayers: 4,
      cardVariant:    'remove_7s',
      spectatorUrl:   '/game/ABCD12?spectatorToken=token-abcd12',
      scores:         { team1: 1, team2: 0 },
      status:         'in_progress',
      createdAt:      Date.now() - 60_000,
      startedAt:      Date.now() - 30_000,
    });
    liveGamesStore.addGame({
      roomCode:       'XY9876',
      playerCount:    8,
      currentPlayers: 2,
      cardVariant:    'remove_2s',
      spectatorUrl:   '/game/XY9876?spectatorToken=token-xy9876',
      status:         'waiting',
      createdAt:      Date.now() - 10_000,
      startedAt:      null,
    });

    const res = await request(app).get('/api/live-games');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.games).toHaveLength(2);

    const abcd = res.body.games.find((g) => g.roomCode === 'ABCD12');
    expect(abcd).toBeDefined();
    expect(abcd.playerCount).toBe(6);
    expect(abcd.currentPlayers).toBe(4);
    expect(abcd.cardVariant).toBe('remove_7s');
    expect(abcd.spectatorUrl).toBe('/game/ABCD12?spectatorToken=token-abcd12');
    expect(abcd.scores).toEqual({ team1: 1, team2: 0 });
    expect(abcd.status).toBe('in_progress');
    expect(abcd.elapsedMs).toBeGreaterThanOrEqual(30_000);

    const xy = res.body.games.find((g) => g.roomCode === 'XY9876');
    expect(xy).toBeDefined();
    expect(xy.spectatorUrl).toBe('/game/XY9876?spectatorToken=token-xy9876');
    expect(xy.status).toBe('waiting');
    expect(xy.elapsedMs).toBeGreaterThanOrEqual(10_000);
  });

  it('does not require authentication (no Authorization header needed)', async () => {
    const res = await request(app).get('/api/live-games');
    expect(res.status).toBe(200); // No 401
  });

  it('removes completed games so they do not appear in the list', async () => {
    liveGamesStore.addGame({
      roomCode: 'DONE01',
      playerCount: 6,
      currentPlayers: 6,
      cardVariant: 'remove_8s',
      spectatorUrl: '/game/DONE01?spectatorToken=token-done01',
    });
    liveGamesStore.removeGame('DONE01');

    const res = await request(app).get('/api/live-games');
    expect(res.body.total).toBe(0);
    const done = res.body.games.find((g) => g.roomCode === 'DONE01');
    expect(done).toBeUndefined();
  });

  it('hydrates missing in-progress rooms from Supabase before responding', async () => {
    mockSupabase._roomsEq.mockResolvedValueOnce({
      data: [{
        code: 'YT66QT',
        player_count: 6,
        card_removal_variant: 'remove_7s',
        status: 'in_progress',
        spectator_token: 'spectator-yt66qt',
        created_at: '2026-03-17T10:00:00.000Z',
        updated_at: '2026-03-17T10:10:00.000Z',
        game_state: {
          variant: 'remove_7s',
          scores: { team1: 1, team2: 0 },
          players: [
            { playerId: 'bot-1', isBot: true },
            { playerId: 'human-1', isBot: false },
            { playerId: 'human-2', isBot: false },
          ],
        },
      }],
      error: null,
    });

    const res = await request(app).get('/api/live-games');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.games[0]).toMatchObject({
      roomCode: 'YT66QT',
      playerCount: 6,
      currentPlayers: 2,
      cardVariant: 'remove_7s',
      status: 'in_progress',
      spectatorUrl: '/game/YT66QT?spectatorToken=spectator-yt66qt',
      scores: { team1: 1, team2: 0 },
    });
  });
});
