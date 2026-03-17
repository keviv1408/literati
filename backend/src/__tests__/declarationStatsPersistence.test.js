'use strict';

/**
 * Declaration stats persistence
 *
 * Verifies that updateStats (called after every completed game) correctly
 * computes and persists declarations_attempted, declarations_correct, and
 * declarations_incorrect for each registered (non-guest, non-bot) player.
 *
 * Coverage:
 *
 * updateStats — declaration counting:
 * 1. Player who never declared has declarations_attempted === 0
 * 2. One correct declaration → attempted=1, correct=1, incorrect=0
 * 3. One incorrect (manual) declaration → attempted=1, correct=0, incorrect=1
 * 4. Timer-expired (forced-failed) declaration counted as incorrect attempt
 * 5. Mixed history: 2 correct + 1 incorrect → attempted=3, correct=2, incorrect=1
 * 6. Only declarations by THIS player are counted (not teammates'/opponents')
 * 7. Guest players are skipped entirely (rpc not called)
 * 8. Bot players are skipped entirely (rpc not called)
 * 9. p_declarations_attempted is passed to the RPC
 * 10. p_declarations_attempted equals p_declarations_correct + p_declarations_incorrect
 *
 * Profile route — declarationsAttempted field:
 * 11. GET /api/stats/profile/:userId returns declarationsAttempted in body
 * 12. declarationsAttempted falls back to correct+incorrect when column is null
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRpc = jest.fn().mockResolvedValue({ data: null, error: null });
// Mutable data bag for profile-route integration tests (tests 11-12).
let mockProfileRow = null;

jest.mock('../db/supabase', () => ({
  getSupabaseClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data:  mockProfileRow,
            error: null,
          }),
        }),
      }),
      update:  () => ({ eq: () => Promise.resolve({ error: null }) }),
      upsert:  () => Promise.resolve({ error: null }),
    }),
    rpc: mockRpc,
    auth: { getUser: async () => ({ data: null, error: new Error('mock') }) },
  }),
}));

jest.mock('../sessions/guestSessionStore', () => ({ getGuestSession: () => null }));
jest.mock('../liveGames/liveGamesStore', () => ({
  addGame:    jest.fn(),
  updateGame: jest.fn(),
  removeGame: jest.fn(),
  get:        jest.fn().mockReturnValue({ scores: { team1: 0, team2: 0 } }),
}));
jest.mock('../game/rematchStore', () => ({
  initRematch:    jest.fn().mockReturnValue({ yesCount: 0, noCount: 0, totalCount: 0 }),
  castVote:       jest.fn(),
  getVoteSummary: jest.fn(),
  hasRematch:     jest.fn().mockReturnValue(false),
  clearRematch:   jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const { updateStats } = require('../game/gameSocketServer');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal completed game state with the given players and
 * a preset moveHistory.
 */
function buildCompletedGs({ players, moveHistory = [] } = {}) {
  return {
    roomCode:            'TEST01',
    status:              'completed',
    winner:              1,
    scores:              { team1: 5, team2: 3 },
    players: players || [
      { playerId: 'p1', teamId: 1, isBot: false, isGuest: false },
      { playerId: 'p2', teamId: 1, isBot: false, isGuest: false },
      { playerId: 'p3', teamId: 1, isBot: false, isGuest: false },
      { playerId: 'p4', teamId: 2, isBot: false, isGuest: false },
      { playerId: 'p5', teamId: 2, isBot: false, isGuest: false },
      { playerId: 'p6', teamId: 2, isBot: false, isGuest: false },
    ],
    moveHistory,
  };
}

/** Build a declaration move entry (as stored by gameEngine). */
function declMove(declarerId, correct, timedOut = false) {
  return {
    type:        'declaration',
    declarerId,
    halfSuitId:  'low_s',
    assignment:  timedOut ? null : { '1_s': declarerId },
    correct,
    timedOut:    timedOut || undefined,
    winningTeam: correct ? 1 : 2,
    ts:          Date.now(),
  };
}

/** Build an ask move entry (should never be counted as a declaration). */
function askMove(askerId) {
  return {
    type:     'ask',
    askerId,
    targetId: 'p4',
    cardId:   '1_s',
    success:  true,
    ts:       Date.now(),
  };
}

/** Extract the RPC call arguments for a given playerId from mockRpc.mock.calls. */
function rpcArgsFor(playerId) {
  const call = mockRpc.mock.calls.find(
    ([, args]) => args && args.p_user_id === playerId
  );
  return call ? call[1] : null;
}

// ---------------------------------------------------------------------------
// Tests 1–10: updateStats declaration counting
// ---------------------------------------------------------------------------

describe('updateStats — declaration stat counting ', () => {
  beforeEach(() => {
    mockRpc.mockClear();
  });

  it('1. player with no declarations has attempted=0, correct=0, incorrect=0', async () => {
    const gs = buildCompletedGs({ moveHistory: [] });
    await updateStats(gs);

    const args = rpcArgsFor('p1');
    expect(args).not.toBeNull();
    expect(args.p_declarations_attempted).toBe(0);
    expect(args.p_declarations_correct).toBe(0);
    expect(args.p_declarations_incorrect).toBe(0);
  });

  it('2. one correct declaration → attempted=1, correct=1, incorrect=0', async () => {
    const gs = buildCompletedGs({
      moveHistory: [declMove('p1', true)],
    });
    await updateStats(gs);

    const args = rpcArgsFor('p1');
    expect(args.p_declarations_attempted).toBe(1);
    expect(args.p_declarations_correct).toBe(1);
    expect(args.p_declarations_incorrect).toBe(0);
  });

  it('3. one incorrect declaration → attempted=1, correct=0, incorrect=1', async () => {
    const gs = buildCompletedGs({
      moveHistory: [declMove('p1', false)],
    });
    await updateStats(gs);

    const args = rpcArgsFor('p1');
    expect(args.p_declarations_attempted).toBe(1);
    expect(args.p_declarations_correct).toBe(0);
    expect(args.p_declarations_incorrect).toBe(1);
  });

  it('4. timer-expired (forced-failed) declaration counted as incorrect attempt', async () => {
    const gs = buildCompletedGs({
      moveHistory: [declMove('p1', false, true)],
    });
    await updateStats(gs);

    const args = rpcArgsFor('p1');
    expect(args.p_declarations_attempted).toBe(1);
    expect(args.p_declarations_correct).toBe(0);
    expect(args.p_declarations_incorrect).toBe(1);
  });

  it('5. mixed history: 2 correct + 1 incorrect → attempted=3, correct=2, incorrect=1', async () => {
    const gs = buildCompletedGs({
      moveHistory: [
        declMove('p1', true),
        declMove('p1', true),
        declMove('p1', false),
      ],
    });
    await updateStats(gs);

    const args = rpcArgsFor('p1');
    expect(args.p_declarations_attempted).toBe(3);
    expect(args.p_declarations_correct).toBe(2);
    expect(args.p_declarations_incorrect).toBe(1);
  });

  it('6. only declarations by THIS player are counted, not teammates or opponents', async () => {
    const gs = buildCompletedGs({
      moveHistory: [
        declMove('p1', true),   // p1: 1 correct
        declMove('p2', false),  // p2: 1 incorrect — must NOT appear in p1's counts
        declMove('p4', true),   // opponent p4: must NOT appear in p1's counts
      ],
    });
    await updateStats(gs);

    const p1Args = rpcArgsFor('p1');
    expect(p1Args.p_declarations_attempted).toBe(1);
    expect(p1Args.p_declarations_correct).toBe(1);
    expect(p1Args.p_declarations_incorrect).toBe(0);

    const p2Args = rpcArgsFor('p2');
    expect(p2Args.p_declarations_attempted).toBe(1);
    expect(p2Args.p_declarations_correct).toBe(0);
    expect(p2Args.p_declarations_incorrect).toBe(1);
  });

  it('7. guest players are skipped — rpc not called for them', async () => {
    const gs = buildCompletedGs({
      players: [
        { playerId: 'p1', teamId: 1, isBot: false, isGuest: true },  // guest
        { playerId: 'p2', teamId: 1, isBot: false, isGuest: false }, // registered
      ],
      moveHistory: [declMove('p1', true)],
    });
    await updateStats(gs);

    // rpc should be called once — only for p2
    expect(mockRpc.mock.calls.length).toBe(1);
    expect(rpcArgsFor('p1')).toBeNull();
    expect(rpcArgsFor('p2')).not.toBeNull();
  });

  it('8. bot players are skipped — rpc not called for them', async () => {
    const gs = buildCompletedGs({
      players: [
        { playerId: 'bot1', teamId: 1, isBot: true,  isGuest: false }, // bot
        { playerId: 'p2',   teamId: 1, isBot: false, isGuest: false }, // registered
      ],
      moveHistory: [declMove('bot1', true)],
    });
    await updateStats(gs);

    expect(mockRpc.mock.calls.length).toBe(1);
    expect(rpcArgsFor('bot1')).toBeNull();
    expect(rpcArgsFor('p2')).not.toBeNull();
  });

  it('9. p_declarations_attempted is passed as a named field to the RPC', async () => {
    const gs = buildCompletedGs({
      moveHistory: [declMove('p1', true), declMove('p1', false)],
    });
    await updateStats(gs);

    const args = rpcArgsFor('p1');
    expect(args).toHaveProperty('p_declarations_attempted');
  });

  it('10. p_declarations_attempted equals p_declarations_correct + p_declarations_incorrect', async () => {
    const gs = buildCompletedGs({
      moveHistory: [
        declMove('p1', true),
        declMove('p1', false),
        declMove('p1', false, true),
      ],
    });
    await updateStats(gs);

    const args = rpcArgsFor('p1');
    expect(args.p_declarations_attempted).toBe(
      args.p_declarations_correct + args.p_declarations_incorrect
    );
  });
});

// ---------------------------------------------------------------------------
// Tests 11–12: Profile route — declarationsAttempted field
// ---------------------------------------------------------------------------

describe('GET /api/stats/profile/:userId — declarationsAttempted ', () => {
  let app;

  beforeAll(() => {
    // Build a minimal Express app with just the stats router
    const express = require('express');
    const statsRouter = require('../routes/stats');
    app = express();
    app.use(express.json());
    app.use('/api/stats', statsRouter);
  });

  afterEach(() => {
    mockProfileRow = null;
  });

  it('11. profile response includes declarationsAttempted field', async () => {
    mockProfileRow = {
      user_id:                 'uuid-abc',
      games_played:            10,
      games_completed:         8,
      wins:                    5,
      losses:                  3,
      declarations_correct:    6,
      declarations_incorrect:  2,
      declarations_attempted:  8,
      user_profiles:           { display_name: 'Alice', avatar_id: null },
    };

    const res = await require('supertest')(app)
      .get('/api/stats/profile/uuid-abc')
      .expect(200);

    expect(res.body.profile).toHaveProperty('declarationsAttempted', 8);
    expect(res.body.profile).toHaveProperty('declarationsCorrect', 6);
    expect(res.body.profile).toHaveProperty('declarationsIncorrect', 2);
  });

  it('12. declarationsAttempted falls back to correct+incorrect when column is null', async () => {
    mockProfileRow = {
      user_id:                 'uuid-def',
      games_played:            4,
      games_completed:         4,
      wins:                    2,
      losses:                  2,
      declarations_correct:    3,
      declarations_incorrect:  1,
      declarations_attempted:  null, // pre-migration row — column added by migration 008
      user_profiles:           { display_name: 'Bob', avatar_id: null },
    };

    const res = await require('supertest')(app)
      .get('/api/stats/profile/uuid-def')
      .expect(200);

    // fallback: 3 correct + 1 incorrect = 4 attempted
    expect(res.body.profile).toHaveProperty('declarationsAttempted', 4);
  });
});
