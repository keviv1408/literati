'use strict';

/**
 * Integration tests for matchmaking routes:
 *   POST   /api/matchmaking/join   — join the matchmaking queue
 *   DELETE /api/matchmaking/leave  — leave the matchmaking queue
 *   GET    /api/matchmaking/status — caller's queue status
 *   GET    /api/matchmaking/queues — public queue overview
 *
 * Auth is mocked via Supabase client injection.
 * The matchmaking queue is cleared between tests.
 */

const request = require('supertest');

// ---------------------------------------------------------------------------
// Module loading helpers
// ---------------------------------------------------------------------------

/**
 * Load a fresh app instance with the given Supabase mock injected.
 * Must be called BEFORE requiring any module that transitively requires
 * ../db/supabase, so we resetModules first.
 */
function loadApp(mockSupabase) {
  jest.resetModules();

  if (mockSupabase) {
    const { _setSupabaseClient } = require('../db/supabase');
    _setSupabaseClient(mockSupabase);
  }

  // Clear the matchmaking queue between test runs
  const { _clearQueue, stopQueueCleanupTimer } = require('../matchmaking/matchmakingQueue');
  _clearQueue();
  stopQueueCleanupTimer();

  // Clear guest session store too
  const { _clearStore, stopCleanupTimer } = require('../sessions/guestSessionStore');
  _clearStore();
  stopCleanupTimer();

  return require('../index');
}

function buildMockSupabase(userId = 'user-abc', email = 'test@example.com') {
  const chainMock = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    single: jest.fn().mockResolvedValue({ data: null, error: null }),
    insert: jest.fn().mockReturnThis(),
  };

  return {
    auth: {
      getUser: jest.fn().mockResolvedValue({
        data: {
          user: {
            id: userId,
            email,
            user_metadata: { display_name: 'TestUser', avatar_id: 'avatar-1' },
          },
        },
        error: null,
      }),
    },
    from: jest.fn().mockReturnValue(chainMock),
    _chain: chainMock,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let app;
let mockSupabase;

beforeEach(() => {
  mockSupabase = buildMockSupabase();
  app = loadApp(mockSupabase);
});

afterEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// POST /api/matchmaking/join
// ---------------------------------------------------------------------------

describe('POST /api/matchmaking/join', () => {

  it('returns 401 when no auth token provided', async () => {
    const res = await request(app)
      .post('/api/matchmaking/join')
      .send({ cardVariant: 'remove_7s', playerCount: 6 });

    expect(res.status).toBe(401);
  });

  it('returns 201 and entry when joining a new queue', async () => {
    const res = await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_7s', playerCount: 6 });

    expect(res.status).toBe(201);
    expect(res.body.queued).toBe(true);
    expect(res.body.refreshed).toBe(false);
    expect(res.body.entry).toBeDefined();
    expect(res.body.entry.cardVariant).toBe('remove_7s');
    expect(res.body.entry.playerCount).toBe(6);
    expect(res.body.position).toBe(1);
    expect(res.body.queueSize).toBe(1);
  });

  it('returns 200 with refreshed=true when re-joining same queue', async () => {
    // First join
    await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_7s', playerCount: 6 });

    // Second join (same filters)
    const res = await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_7s', playerCount: 6 });

    expect(res.status).toBe(200);
    expect(res.body.refreshed).toBe(true);
    expect(res.body.queued).toBe(true);
  });

  it('accepts playerCount 7', async () => {
    const res = await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_2s', playerCount: 7 });

    expect(res.status).toBe(201);
    expect(res.body.entry.playerCount).toBe(7);
  });

  it('accepts playerCount 8', async () => {
    const res = await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_8s', playerCount: 8 });

    expect(res.status).toBe(201);
    expect(res.body.entry.playerCount).toBe(8);
  });

  it('accepts all three cardVariant values', async () => {
    const variants = ['remove_2s', 'remove_7s', 'remove_8s'];

    for (const variant of variants) {
      // Use a different user per variant to avoid queue switching
      const mock = buildMockSupabase(`user-${variant}`, `${variant}@example.com`);
      const testApp = loadApp(mock);

      const res = await request(testApp)
        .post('/api/matchmaking/join')
        .set('Authorization', 'Bearer valid-token')
        .send({ cardVariant: variant, playerCount: 6 });

      expect(res.status).toBe(201);
      expect(res.body.entry.cardVariant).toBe(variant);
    }
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  it('returns 400 when cardVariant is missing', async () => {
    const res = await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ playerCount: 6 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.stringMatching(/cardVariant/)])
    );
  });

  it('returns 400 when playerCount is missing', async () => {
    const res = await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_7s' });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.stringMatching(/playerCount/)])
    );
  });

  it('returns 400 when cardVariant is invalid', async () => {
    const res = await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_jokers', playerCount: 6 });

    expect(res.status).toBe(400);
  });

  it('returns 400 when playerCount is invalid (e.g. 4)', async () => {
    const res = await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_7s', playerCount: 4 });

    expect(res.status).toBe(400);
  });

  it('returns 400 when playerCount is invalid (e.g. 10)', async () => {
    const res = await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_7s', playerCount: 10 });

    expect(res.status).toBe(400);
  });

  it('returns 400 for both missing fields simultaneously', async () => {
    const res = await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.details).toHaveLength(2);
  });

  it('includes entry.playerId in the response', async () => {
    const res = await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_7s', playerCount: 6 });

    expect(res.status).toBe(201);
    expect(res.body.entry.playerId).toBe('user-abc');
  });

  it('entry contains joinedAt and expiresAt timestamps', async () => {
    const before = Date.now();
    const res = await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_7s', playerCount: 6 });
    const after = Date.now();

    expect(res.status).toBe(201);
    expect(res.body.entry.joinedAt).toBeGreaterThanOrEqual(before);
    expect(res.body.entry.joinedAt).toBeLessThanOrEqual(after);
    expect(res.body.entry.expiresAt).toBeGreaterThan(after);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/matchmaking/leave
// ---------------------------------------------------------------------------

describe('DELETE /api/matchmaking/leave', () => {

  it('returns 401 when no auth token provided', async () => {
    const res = await request(app)
      .delete('/api/matchmaking/leave');

    expect(res.status).toBe(401);
  });

  it('returns 200 with left=true when player is in queue', async () => {
    // Join first
    await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_7s', playerCount: 6 });

    const res = await request(app)
      .delete('/api/matchmaking/leave')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.left).toBe(true);
  });

  it('returns 200 with left=false when player is not in any queue', async () => {
    const res = await request(app)
      .delete('/api/matchmaking/leave')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.left).toBe(false);
    expect(res.body.message).toMatch(/not currently in any queue/i);
  });

  it('removes player from queue — subsequent status returns inQueue=false', async () => {
    await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_7s', playerCount: 6 });

    await request(app)
      .delete('/api/matchmaking/leave')
      .set('Authorization', 'Bearer valid-token');

    const statusRes = await request(app)
      .get('/api/matchmaking/status')
      .set('Authorization', 'Bearer valid-token');

    expect(statusRes.body.inQueue).toBe(false);
  });

  it('accepts optional cardVariant + playerCount to leave a specific queue', async () => {
    await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_7s', playerCount: 6 });

    const res = await request(app)
      .delete('/api/matchmaking/leave')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_7s', playerCount: 6 });

    expect(res.status).toBe(200);
    expect(res.body.left).toBe(true);
  });

  it('returns 400 when partial filter is invalid', async () => {
    const res = await request(app)
      .delete('/api/matchmaking/leave')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'bad_variant', playerCount: 6 });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/matchmaking/status
// ---------------------------------------------------------------------------

describe('GET /api/matchmaking/status', () => {

  it('returns 401 when no auth token provided', async () => {
    const res = await request(app)
      .get('/api/matchmaking/status');

    expect(res.status).toBe(401);
  });

  it('returns inQueue=false when not in any queue', async () => {
    const res = await request(app)
      .get('/api/matchmaking/status')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.inQueue).toBe(false);
  });

  it('returns full status when in queue', async () => {
    await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_7s', playerCount: 6 });

    const res = await request(app)
      .get('/api/matchmaking/status')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.inQueue).toBe(true);
    expect(res.body.entry).toBeDefined();
    expect(res.body.entry.cardVariant).toBe('remove_7s');
    expect(res.body.entry.playerCount).toBe(6);
    expect(res.body.position).toBe(1);
    expect(res.body.queueSize).toBe(1);
    expect(res.body.queueKey).toBe('remove_7s:6');
  });
});

// ---------------------------------------------------------------------------
// GET /api/matchmaking/queues
// ---------------------------------------------------------------------------

describe('GET /api/matchmaking/queues', () => {

  it('returns 200 with empty queues when no players are waiting', async () => {
    const res = await request(app)
      .get('/api/matchmaking/queues');

    expect(res.status).toBe(200);
    expect(res.body.queues).toEqual({});
    expect(res.body.totalWaiting).toBe(0);
  });

  it('does not require auth', async () => {
    const res = await request(app)
      .get('/api/matchmaking/queues');
    // No Authorization header — should still succeed
    expect(res.status).toBe(200);
  });

  it('shows queue counts after a player joins', async () => {
    await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_7s', playerCount: 6 });

    const res = await request(app)
      .get('/api/matchmaking/queues');

    expect(res.status).toBe(200);
    expect(res.body.totalWaiting).toBe(1);
    expect(res.body.queues['remove_7s:6']).toBeDefined();
    expect(res.body.queues['remove_7s:6'].count).toBe(1);
    expect(res.body.queues['remove_7s:6'].cardVariant).toBe('remove_7s');
    expect(res.body.queues['remove_7s:6'].playerCount).toBe(6);
  });

  it('does not expose player identity (playerId, displayName) in public queues response', async () => {
    await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_7s', playerCount: 6 });

    const res = await request(app)
      .get('/api/matchmaking/queues');

    const queueData = res.body.queues['remove_7s:6'];
    expect(queueData).toBeDefined();
    expect(queueData.players).toBeUndefined();
    expect(queueData.playerId).toBeUndefined();
    expect(queueData.displayName).toBeUndefined();
  });

  it('decrements count after a player leaves', async () => {
    await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_7s', playerCount: 6 });

    await request(app)
      .delete('/api/matchmaking/leave')
      .set('Authorization', 'Bearer valid-token');

    const res = await request(app)
      .get('/api/matchmaking/queues');

    expect(res.body.totalWaiting).toBe(0);
    expect(res.body.queues['remove_7s:6']).toBeUndefined();
  });

  it('shows multiple active queues simultaneously', async () => {
    // User A in one queue
    const mockA = buildMockSupabase('user-a');
    const appA = loadApp(mockA);
    await request(appA)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer token-a')
      .send({ cardVariant: 'remove_7s', playerCount: 6 });

    // User B in a different queue (same app instance, different user)
    const mockB = buildMockSupabase('user-b');
    // Re-use appA but inject a new mock for the second auth call
    // (easier to just load a fresh app for user B and they share same queue store
    //  since jest.resetModules happens per loadApp call)
    // Instead, we join directly via the queue module
    const { joinQueue } = require('../matchmaking/matchmakingQueue');
    joinQueue(
      { id: 'user-b', isGuest: false, displayName: 'UserB', avatarId: 'avatar-2' },
      'remove_2s',
      8
    );

    const res = await request(appA)
      .get('/api/matchmaking/queues');

    expect(res.body.totalWaiting).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// End-to-end flow: join → status → leave → status
// ---------------------------------------------------------------------------

describe('end-to-end join → status → leave → status', () => {

  it('full lifecycle works correctly', async () => {
    // 1. Not in queue initially
    let res = await request(app)
      .get('/api/matchmaking/status')
      .set('Authorization', 'Bearer valid-token');
    expect(res.body.inQueue).toBe(false);

    // 2. Join
    res = await request(app)
      .post('/api/matchmaking/join')
      .set('Authorization', 'Bearer valid-token')
      .send({ cardVariant: 'remove_8s', playerCount: 7 });
    expect(res.status).toBe(201);
    expect(res.body.entry.cardVariant).toBe('remove_8s');
    expect(res.body.entry.playerCount).toBe(7);

    // 3. Status shows in queue
    res = await request(app)
      .get('/api/matchmaking/status')
      .set('Authorization', 'Bearer valid-token');
    expect(res.body.inQueue).toBe(true);
    expect(res.body.queueKey).toBe('remove_8s:7');

    // 4. Leave
    res = await request(app)
      .delete('/api/matchmaking/leave')
      .set('Authorization', 'Bearer valid-token');
    expect(res.body.left).toBe(true);

    // 5. Status shows not in queue again
    res = await request(app)
      .get('/api/matchmaking/status')
      .set('Authorization', 'Bearer valid-token');
    expect(res.body.inQueue).toBe(false);
  });
});
