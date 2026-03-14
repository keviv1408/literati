/**
 * Tests for GET /api/stats/game-summary/:roomCode
 *
 * Verifies that the endpoint correctly:
 *  - Returns 400 for invalid room code format
 *  - Returns 404 when no completed room matches the code
 *  - Returns 404 when room exists but game_state is null
 *  - Returns 200 with correct playerSummaries aggregated from moveHistory
 *  - Counts both 'declaration' and 'forced_failed_declaration' move types
 *  - Handles players with zero declarations
 *  - Handles bots and guests in playerSummaries
 *  - Handles empty moveHistory gracefully
 *  - Handles declarerId not present in players array
 *  - Returns correct winner, scores, and variant
 *  - Accepts lowercase room codes (case-insensitive)
 *  - Returns 500 on Supabase query error
 */

const request = require('supertest');
const { _setSupabaseClient } = require('../db/supabase');

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a minimal fluent Supabase mock.
 * The query chain is: from → select → eq → eq → maybeSingle
 */
function buildMockSupabase() {
  const maybeSingle = jest.fn();
  const eq = jest.fn();
  const select = jest.fn();
  const insert = jest.fn();
  const single = jest.fn();

  const chain = { select, eq, maybeSingle, single, insert };

  select.mockReturnValue(chain);
  eq.mockReturnValue(chain);
  insert.mockReturnValue(chain);

  const from = jest.fn().mockReturnValue(chain);

  return {
    from,
    auth: { getUser: jest.fn() },
    _chain: chain,
  };
}

/** Minimal completed room row with a given game state snapshot. */
function makeRoomRow(overrides = {}) {
  return {
    code: 'ABC123',
    status: 'completed',
    game_state: makeFinalGameState(),
    ...overrides,
  };
}

/** Minimal finalised game state with 6 players (3v3), two declarations. */
function makeFinalGameState(overrides = {}) {
  return {
    variant: 'remove_7s',
    playerCount: 6,
    status: 'completed',
    scores: { team1: 5, team2: 3 },
    winner: 1,
    tiebreakerWinner: null,
    players: [
      { playerId: 'p1', displayName: 'Alice', avatarId: 'av1', teamId: 1, isBot: false, isGuest: false },
      { playerId: 'p2', displayName: 'Bob',   avatarId: 'av2', teamId: 2, isBot: false, isGuest: false },
      { playerId: 'p3', displayName: 'Carol', avatarId: 'av3', teamId: 1, isBot: true,  isGuest: false },
      { playerId: 'p4', displayName: 'Dave',  avatarId: 'av4', teamId: 2, isBot: false, isGuest: true  },
      { playerId: 'p5', displayName: 'Eve',   avatarId: 'av5', teamId: 1, isBot: false, isGuest: false },
      { playerId: 'p6', displayName: 'Frank', avatarId: 'av6', teamId: 2, isBot: true,  isGuest: false },
    ],
    moveHistory: [
      // p1 correct declaration
      { type: 'declaration', declarerId: 'p1', halfSuitId: 'low_s', correct: true,  winningTeam: 1, ts: 1000 },
      // p2 incorrect declaration
      { type: 'declaration', declarerId: 'p2', halfSuitId: 'low_h', correct: false, winningTeam: 1, ts: 2000 },
      // p1 forced-failed (timer expired)
      { type: 'forced_failed_declaration', declarerId: 'p1', halfSuitId: 'high_s', correct: false, winningTeam: 2, ts: 3000 },
      // p3 (bot) correct declaration
      { type: 'declaration', declarerId: 'p3', halfSuitId: 'low_d', correct: true,  winningTeam: 1, ts: 4000 },
      // p5 two correct declarations
      { type: 'declaration', declarerId: 'p5', halfSuitId: 'high_d', correct: true,  winningTeam: 1, ts: 5000 },
      { type: 'declaration', declarerId: 'p5', halfSuitId: 'low_c',  correct: true,  winningTeam: 1, ts: 6000 },
      // ask move (should be ignored)
      { type: 'ask', askerId: 'p1', targetId: 'p2', cardId: '1_s', success: true, ts: 7000 },
    ],
    ...overrides,
  };
}

// ── Test suite ─────────────────────────────────────────────────────────────────

describe('GET /api/stats/game-summary/:roomCode', () => {
  let app;
  let mockSupabase;

  beforeEach(() => {
    mockSupabase = buildMockSupabase();
    _setSupabaseClient(mockSupabase);

    jest.resetModules();

    const { _setSupabaseClient: set } = require('../db/supabase');
    set(mockSupabase);
    app = require('../index');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  it('returns 200 with playerSummaries for a completed game', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow(),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    expect(res.status).toBe(200);
    expect(res.body.roomCode).toBe('ABC123');
    expect(res.body.winner).toBe(1);
    expect(res.body.scores).toEqual({ team1: 5, team2: 3 });
    expect(res.body.variant).toBe('remove_7s');
    expect(Array.isArray(res.body.playerSummaries)).toBe(true);
    expect(res.body.playerSummaries).toHaveLength(6);
  });

  it('correctly aggregates declaration attempts, successes, and failures for p1', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow(),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    const p1 = res.body.playerSummaries.find((p) => p.playerId === 'p1');
    expect(p1).toBeDefined();
    // 1 correct declaration + 1 forced_failed = 2 attempts, 1 success, 1 failure
    expect(p1.declarationAttempts).toBe(2);
    expect(p1.declarationSuccesses).toBe(1);
    expect(p1.declarationFailures).toBe(1);
  });

  it('correctly aggregates stats for p2 (1 incorrect declaration)', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow(),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    const p2 = res.body.playerSummaries.find((p) => p.playerId === 'p2');
    expect(p2.declarationAttempts).toBe(1);
    expect(p2.declarationSuccesses).toBe(0);
    expect(p2.declarationFailures).toBe(1);
  });

  it('correctly aggregates stats for p5 (2 correct declarations)', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow(),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    const p5 = res.body.playerSummaries.find((p) => p.playerId === 'p5');
    expect(p5.declarationAttempts).toBe(2);
    expect(p5.declarationSuccesses).toBe(2);
    expect(p5.declarationFailures).toBe(0);
  });

  it('returns zero declaration counts for players with no declarations (p4, p6)', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow(),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    for (const pid of ['p4', 'p6']) {
      const player = res.body.playerSummaries.find((p) => p.playerId === pid);
      expect(player.declarationAttempts).toBe(0);
      expect(player.declarationSuccesses).toBe(0);
      expect(player.declarationFailures).toBe(0);
    }
  });

  it('counts bot declarations (p3: 1 correct)', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow(),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    const p3 = res.body.playerSummaries.find((p) => p.playerId === 'p3');
    expect(p3.isBot).toBe(true);
    expect(p3.declarationAttempts).toBe(1);
    expect(p3.declarationSuccesses).toBe(1);
    expect(p3.declarationFailures).toBe(0);
  });

  it('preserves player metadata (displayName, avatarId, teamId, isBot, isGuest)', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow(),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    const p4 = res.body.playerSummaries.find((p) => p.playerId === 'p4');
    expect(p4.displayName).toBe('Dave');
    expect(p4.avatarId).toBe('av4');
    expect(p4.teamId).toBe(2);
    expect(p4.isBot).toBe(false);
    expect(p4.isGuest).toBe(true);
  });

  it('preserves seat order in playerSummaries', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow(),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    const ids = res.body.playerSummaries.map((p) => p.playerId);
    expect(ids).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  });

  it('ignores non-declaration moves (type: ask) when tallying stats', async () => {
    // The fixture contains one 'ask' move that should be ignored
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow(),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    // Total declarations across all players: p1(2) + p2(1) + p3(1) + p5(2) = 6
    const total = res.body.playerSummaries.reduce(
      (sum, p) => sum + p.declarationAttempts,
      0
    );
    expect(total).toBe(6);
  });

  it('handles game state with empty moveHistory (all zeros)', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow({
        game_state: makeFinalGameState({ moveHistory: [] }),
      }),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    expect(res.status).toBe(200);
    res.body.playerSummaries.forEach((p) => {
      expect(p.declarationAttempts).toBe(0);
      expect(p.declarationSuccesses).toBe(0);
      expect(p.declarationFailures).toBe(0);
    });
  });

  it('handles declarerId in moveHistory that is not in players array', async () => {
    const gs = makeFinalGameState({
      moveHistory: [
        { type: 'declaration', declarerId: 'ghost-player', correct: true, winningTeam: 1, ts: 1000 },
      ],
    });
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow({ game_state: gs }),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    // Should still return 200 — ghost player does not blow up the endpoint
    expect(res.status).toBe(200);
    // The 6 known players are still returned in order
    expect(res.body.playerSummaries).toHaveLength(6);
  });

  it('accepts a lowercase room code and uppercases it for the query', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow({ code: 'ABC123' }),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/abc123');

    expect(res.status).toBe(200);
    expect(res.body.roomCode).toBe('ABC123');

    // Verify the eq() call was made with the uppercased code
    const eqCalls = mockSupabase._chain.eq.mock.calls;
    const codeCall = eqCalls.find(([field]) => field === 'code');
    expect(codeCall).toBeDefined();
    expect(codeCall[1]).toBe('ABC123');
  });

  it('returns null for winner when game_state has winner: null', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow({
        game_state: makeFinalGameState({ winner: null }),
      }),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    expect(res.status).toBe(200);
    expect(res.body.winner).toBeNull();
  });

  it('returns default scores {team1:0,team2:0} when game_state has no scores', async () => {
    const gs = makeFinalGameState();
    delete gs.scores;
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow({ game_state: gs }),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    expect(res.status).toBe(200);
    expect(res.body.scores).toEqual({ team1: 0, team2: 0 });
  });

  it('counts forced_failed_declaration moves as failures', async () => {
    const gs = makeFinalGameState({
      moveHistory: [
        { type: 'forced_failed_declaration', declarerId: 'p1', correct: false, winningTeam: 2, ts: 1000 },
        { type: 'forced_failed_declaration', declarerId: 'p1', correct: false, winningTeam: 2, ts: 2000 },
      ],
    });
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow({ game_state: gs }),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    const p1 = res.body.playerSummaries.find((p) => p.playerId === 'p1');
    expect(p1.declarationAttempts).toBe(2);
    expect(p1.declarationSuccesses).toBe(0);
    expect(p1.declarationFailures).toBe(2);
  });

  // ── Error paths ──────────────────────────────────────────────────────────────

  it('returns 400 for a room code shorter than 6 characters', async () => {
    const res = await request(app).get('/api/stats/game-summary/AB12');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid room code format/i);
  });

  it('returns 400 for a room code with special characters', async () => {
    const res = await request(app).get('/api/stats/game-summary/AB!@#$');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid room code format/i);
  });

  it('returns 400 for a room code longer than 6 characters', async () => {
    const res = await request(app).get('/api/stats/game-summary/ABCDEFG');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid room code format/i);
  });

  it('returns 404 when no completed game is found for the room code', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ZZZ999');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/completed game not found/i);
  });

  it('returns 404 when room is found but game_state is null', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { code: 'ABC123', status: 'completed', game_state: null },
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/game state not available/i);
  });

  it('returns 500 when Supabase query returns an error', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'DB connection lost' },
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to load game summary/i);
  });

  it('returns 500 when Supabase throws an unexpected exception', async () => {
    mockSupabase._chain.maybeSingle.mockRejectedValueOnce(
      new Error('Unexpected network failure')
    );

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to load game summary/i);
  });

  // ── Variant edge cases ───────────────────────────────────────────────────────

  it('returns the correct variant for remove_2s games', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow({
        game_state: makeFinalGameState({ variant: 'remove_2s' }),
      }),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    expect(res.status).toBe(200);
    expect(res.body.variant).toBe('remove_2s');
  });

  it('returns the correct variant for remove_8s games', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow({
        game_state: makeFinalGameState({ variant: 'remove_8s' }),
      }),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    expect(res.status).toBe(200);
    expect(res.body.variant).toBe('remove_8s');
  });

  // ── 8-player game ────────────────────────────────────────────────────────────

  it('handles 8-player games correctly', async () => {
    const players8 = [
      { playerId: 'p1', displayName: 'A', avatarId: 'a1', teamId: 1, isBot: false, isGuest: false },
      { playerId: 'p2', displayName: 'B', avatarId: 'a2', teamId: 2, isBot: false, isGuest: false },
      { playerId: 'p3', displayName: 'C', avatarId: 'a3', teamId: 1, isBot: false, isGuest: false },
      { playerId: 'p4', displayName: 'D', avatarId: 'a4', teamId: 2, isBot: false, isGuest: false },
      { playerId: 'p5', displayName: 'E', avatarId: 'a5', teamId: 1, isBot: false, isGuest: false },
      { playerId: 'p6', displayName: 'F', avatarId: 'a6', teamId: 2, isBot: false, isGuest: false },
      { playerId: 'p7', displayName: 'G', avatarId: 'a7', teamId: 1, isBot: false, isGuest: false },
      { playerId: 'p8', displayName: 'H', avatarId: 'a8', teamId: 2, isBot: false, isGuest: false },
    ];
    const moveHistory8 = [
      { type: 'declaration', declarerId: 'p7', correct: true,  winningTeam: 1, ts: 1000 },
      { type: 'declaration', declarerId: 'p8', correct: false, winningTeam: 1, ts: 2000 },
    ];

    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: makeRoomRow({
        game_state: makeFinalGameState({ playerCount: 8, players: players8, moveHistory: moveHistory8 }),
      }),
      error: null,
    });

    const res = await request(app).get('/api/stats/game-summary/ABC123');

    expect(res.status).toBe(200);
    expect(res.body.playerSummaries).toHaveLength(8);

    const p7 = res.body.playerSummaries.find((p) => p.playerId === 'p7');
    expect(p7.declarationAttempts).toBe(1);
    expect(p7.declarationSuccesses).toBe(1);

    const p8 = res.body.playerSummaries.find((p) => p.playerId === 'p8');
    expect(p8.declarationAttempts).toBe(1);
    expect(p8.declarationFailures).toBe(1);
  });
});
