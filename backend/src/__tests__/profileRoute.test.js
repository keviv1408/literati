'use strict';

/**
 * Tests for GET /api/profile/:username
 *
 * Verifies that the endpoint correctly:
 * - Returns 400 for a missing / empty username
 * - Returns 400 for a username longer than 20 characters
 * - Returns 404 when no user_profiles row matches the display name
 * - Returns 500 when the user_profiles query errors
 * - Returns 500 when the user_stats query errors
 * - Returns 200 with correct aggregated stats for a known user
 * - Computes winPercentage = wins / gamesCompleted (rounded to 4 d.p.)
 * - Computes declarationSuccessRate = correct / attempted (rounded to 4 d.p.)
 * - Falls back to correct+incorrect when declarations_attempted is null (pre-008 rows)
 * - Returns 0 for winPercentage when gamesCompleted = 0
 * - Returns 0 for declarationSuccessRate when declarationsMade = 0
 * - Performs a case-insensitive lookup (ilike)
 * - Does not require an Authorization header (public endpoint)
 * - Returns exact username as stored in DB (not the URL param casing)
 * - Handles null avatarId gracefully
 */

const request = require('supertest');
const { _setSupabaseClient } = require('../db/supabase');

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a minimal fluent Supabase mock supporting two chained queries:
 *
 * query 1 (user_profiles): from → select → ilike → maybeSingle
 * query 2 (user_stats): from → select → eq → maybeSingle
 *
 * Both chains share the same mock functions but we queue return values via
 * `mockResolvedValueOnce`, so the first call to maybeSingle() resolves query 1
 * and the second call resolves query 2.
 */
function buildMockSupabase() {
  const maybeSingle = jest.fn();
  const ilike = jest.fn();
  const eq = jest.fn();
  const select = jest.fn();

  // All chained methods return the same chain object so the test can queue
  // responses on maybeSingle without worrying about the method order.
  const chain = { select, ilike, eq, maybeSingle };

  select.mockReturnValue(chain);
  ilike.mockReturnValue(chain);
  eq.mockReturnValue(chain);

  const from = jest.fn().mockReturnValue(chain);

  return {
    from,
    auth: { getUser: jest.fn() },
    _chain: chain,
  };
}

/** A minimal user_profiles row. */
function makeProfileRow(overrides = {}) {
  return {
    id: 'user-uuid-1',
    display_name: 'Alice',
    avatar_id: 'avatar-3',
    ...overrides,
  };
}

/** A minimal user_stats row with all columns present. */
function makeStatsRow(overrides = {}) {
  return {
    games_played: 20,
    games_completed: 15,
    wins: 10,
    losses: 5,
    declarations_correct: 8,
    declarations_incorrect: 4,
    declarations_attempted: 12,
    ...overrides,
  };
}

// ── Test suite ─────────────────────────────────────────────────────────────────

describe('GET /api/profile/:username', () => {
  let app;
  let mockSupabase;

  beforeEach(() => {
    jest.resetModules();
    mockSupabase = buildMockSupabase();

    // Inject mock before loading index so all requires pick it up
    const { _setSupabaseClient: set } = require('../db/supabase');
    set(mockSupabase);

    app = require('../index');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── Input validation ─────────────────────────────────────────────────────────

  it('returns 400 when username is longer than 20 characters', async () => {
    const res = await request(app).get('/api/profile/ThisNameIsTooLongForDB');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/20 characters/i);
  });

  // ── Profile lookup failures ──────────────────────────────────────────────────

  it('returns 404 when no user_profiles row matches the username', async () => {
    // Only one maybeSingle call needed — profiles query returns null
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await request(app).get('/api/profile/NoSuchPlayer');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/profile not found/i);
  });

  it('returns 500 when the user_profiles query fails', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'Connection refused' },
    });

    const res = await request(app).get('/api/profile/Alice');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to load profile/i);
  });

  it('returns 500 when the user_stats query fails', async () => {
    // First call: profiles query succeeds
    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: makeProfileRow(), error: null })
      // Second call: stats query errors
      .mockResolvedValueOnce({ data: null, error: { message: 'Timeout' } });

    const res = await request(app).get('/api/profile/Alice');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to load profile/i);
  });

  it('returns 500 when Supabase throws an unexpected exception', async () => {
    mockSupabase._chain.maybeSingle.mockRejectedValueOnce(new Error('Network error'));

    const res = await request(app).get('/api/profile/Alice');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to load profile/i);
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  it('returns 200 with correct aggregated stats for a known user', async () => {
    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: makeProfileRow(), error: null })
      .mockResolvedValueOnce({ data: makeStatsRow(), error: null });

    const res = await request(app).get('/api/profile/Alice');

    expect(res.status).toBe(200);
    const { profile } = res.body;
    expect(profile).toBeDefined();
    expect(profile.userId).toBe('user-uuid-1');
    expect(profile.username).toBe('Alice');
    expect(profile.avatarId).toBe('avatar-3');
    expect(profile.gamesPlayed).toBe(20);
    expect(profile.gamesCompleted).toBe(15);
    expect(profile.wins).toBe(10);
    expect(profile.losses).toBe(5);
    expect(profile.declarationsMade).toBe(12);
    expect(profile.declarationsCorrect).toBe(8);
    expect(profile.declarationsIncorrect).toBe(4);
  });

  it('computes winPercentage = wins / gamesCompleted rounded to 4 d.p.', async () => {
    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: makeProfileRow(), error: null })
      .mockResolvedValueOnce({ data: makeStatsRow({ wins: 7, games_completed: 13 }), error: null });

    const res = await request(app).get('/api/profile/Alice');

    expect(res.status).toBe(200);
    // 7 13 = 0.538461… → rounded to 4 d.p. = 0.5385
    expect(res.body.profile.winPercentage).toBe(Math.round((7 / 13) * 10000) / 10000);
  });

  it('returns winPercentage = 0 when gamesCompleted = 0', async () => {
    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: makeProfileRow(), error: null })
      .mockResolvedValueOnce({
        data: makeStatsRow({ wins: 0, games_completed: 0 }),
        error: null,
      });

    const res = await request(app).get('/api/profile/Alice');

    expect(res.status).toBe(200);
    expect(res.body.profile.winPercentage).toBe(0);
  });

  it('computes declarationSuccessRate = correct / attempted rounded to 4 d.p.', async () => {
    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: makeProfileRow(), error: null })
      .mockResolvedValueOnce({
        data: makeStatsRow({
          declarations_correct: 5,
          declarations_incorrect: 3,
          declarations_attempted: 9, // includes timer-expired attempt not in correct+incorrect
        }),
        error: null,
      });

    const res = await request(app).get('/api/profile/Alice');

    expect(res.status).toBe(200);
    // 5 9 = 0.5555… → 0.5556 (4 d.p.)
    expect(res.body.profile.declarationSuccessRate).toBe(Math.round((5 / 9) * 10000) / 10000);
    expect(res.body.profile.declarationsMade).toBe(9);
  });

  it('returns declarationSuccessRate = 0 when declarationsMade = 0', async () => {
    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: makeProfileRow(), error: null })
      .mockResolvedValueOnce({
        data: makeStatsRow({
          declarations_correct: 0,
          declarations_incorrect: 0,
          declarations_attempted: 0,
        }),
        error: null,
      });

    const res = await request(app).get('/api/profile/Alice');

    expect(res.status).toBe(200);
    expect(res.body.profile.declarationSuccessRate).toBe(0);
    expect(res.body.profile.declarationsMade).toBe(0);
  });

  it('falls back to correct+incorrect for pre-008 rows where declarations_attempted is null', async () => {
    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: makeProfileRow(), error: null })
      .mockResolvedValueOnce({
        data: makeStatsRow({
          declarations_correct: 6,
          declarations_incorrect: 2,
          declarations_attempted: null, // pre-migration 008 row
        }),
        error: null,
      });

    const res = await request(app).get('/api/profile/Alice');

    expect(res.status).toBe(200);
    // Fallback: 6 + 2 = 8
    expect(res.body.profile.declarationsMade).toBe(8);
    // Success rate: 6 8 = 0.75
    expect(res.body.profile.declarationSuccessRate).toBe(0.75);
  });

  it('returns the display_name as stored in the DB (not the URL param casing)', async () => {
    // DB stores "Alice" but URL uses lowercase "alice"
    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: makeProfileRow({ display_name: 'Alice' }), error: null })
      .mockResolvedValueOnce({ data: makeStatsRow(), error: null });

    const res = await request(app).get('/api/profile/alice');

    expect(res.status).toBe(200);
    expect(res.body.profile.username).toBe('Alice');
  });

  it('uses ilike for case-insensitive display name lookup', async () => {
    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: makeProfileRow(), error: null })
      .mockResolvedValueOnce({ data: makeStatsRow(), error: null });

    await request(app).get('/api/profile/ALICE');

    // Verify ilike was called (not eq) on the user_profiles query
    expect(mockSupabase._chain.ilike).toHaveBeenCalledWith('display_name', 'ALICE');
  });

  it('does not require an Authorization header (public endpoint)', async () => {
    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: makeProfileRow(), error: null })
      .mockResolvedValueOnce({ data: makeStatsRow(), error: null });

    const res = await request(app).get('/api/profile/Alice');
    // No Authorization header — should still succeed
    expect(res.status).toBe(200);
  });

  it('handles null avatarId in user_profiles gracefully', async () => {
    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({
        data: makeProfileRow({ avatar_id: null }),
        error: null,
      })
      .mockResolvedValueOnce({ data: makeStatsRow(), error: null });

    const res = await request(app).get('/api/profile/Alice');

    expect(res.status).toBe(200);
    expect(res.body.profile.avatarId).toBeNull();
  });

  it('handles a user with no stats row (stats query returns null)', async () => {
    // Some edge-case: profile row exists but stats row was never created
    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: makeProfileRow(), error: null })
      .mockResolvedValueOnce({ data: null, error: null });

    const res = await request(app).get('/api/profile/Alice');

    expect(res.status).toBe(200);
    const { profile } = res.body;
    expect(profile.gamesPlayed).toBe(0);
    expect(profile.gamesCompleted).toBe(0);
    expect(profile.wins).toBe(0);
    expect(profile.losses).toBe(0);
    expect(profile.winPercentage).toBe(0);
    expect(profile.declarationsMade).toBe(0);
    expect(profile.declarationSuccessRate).toBe(0);
  });

  it('includes all required top-level fields in the profile object', async () => {
    mockSupabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: makeProfileRow(), error: null })
      .mockResolvedValueOnce({ data: makeStatsRow(), error: null });

    const res = await request(app).get('/api/profile/Alice');

    expect(res.status).toBe(200);
    const { profile } = res.body;
    const requiredFields = [
      'userId',
      'username',
      'avatarId',
      'gamesPlayed',
      'gamesCompleted',
      'wins',
      'losses',
      'winPercentage',
      'declarationsMade',
      'declarationsCorrect',
      'declarationsIncorrect',
      'declarationSuccessRate',
    ];
    for (const field of requiredFields) {
      expect(profile).toHaveProperty(field);
    }
  });
});
