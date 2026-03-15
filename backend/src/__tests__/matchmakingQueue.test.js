'use strict';

/**
 * Unit tests for the matchmaking queue data structure.
 *
 * All tests are synchronous (no DB, no network).
 */

const {
  joinQueue,
  leaveQueue,
  getQueueEntry,
  getQueuePosition,
  getQueueSnapshot,
  getQueueForFilter,
  cleanupExpiredEntries,
  getPlayerIdentifier,
  VALID_CARD_VARIANTS,
  VALID_PLAYER_COUNTS,
  ENTRY_TTL_MS,
  _clearQueue,
  _getRawQueues,
  _getRawPlayerIndex,
} = require('../matchmaking/matchmakingQueue');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRegisteredUser(id = 'user-001', displayName = 'Alice') {
  return {
    id,
    displayName,
    avatarId: 'avatar-3',
    isGuest: false,
    email: `${id}@example.com`,
  };
}

function makeGuestUser(sessionId = 'guest-session-001', displayName = 'GuestBob') {
  return {
    sessionId,
    displayName,
    avatarId: 'avatar-7',
    isGuest: true,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _clearQueue();
});

afterAll(() => {
  _clearQueue();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('Constants', () => {
  it('VALID_CARD_VARIANTS contains the three removal variants', () => {
    expect(VALID_CARD_VARIANTS).toEqual(
      expect.arrayContaining(['remove_2s', 'remove_7s', 'remove_8s'])
    );
    expect(VALID_CARD_VARIANTS).toHaveLength(3);
  });

  it('VALID_PLAYER_COUNTS contains 6, 7, 8', () => {
    expect(VALID_PLAYER_COUNTS).toEqual(expect.arrayContaining([6, 7, 8]));
    expect(VALID_PLAYER_COUNTS).toHaveLength(3);
  });

  it('ENTRY_TTL_MS is a positive number', () => {
    expect(ENTRY_TTL_MS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getPlayerIdentifier
// ---------------------------------------------------------------------------

describe('getPlayerIdentifier', () => {
  it('returns id for registered user', () => {
    const user = makeRegisteredUser('reg-id-99');
    expect(getPlayerIdentifier(user)).toBe('reg-id-99');
  });

  it('returns sessionId for guest', () => {
    const user = makeGuestUser('guest-sess-42');
    expect(getPlayerIdentifier(user)).toBe('guest-sess-42');
  });
});

// ---------------------------------------------------------------------------
// joinQueue — happy path
// ---------------------------------------------------------------------------

describe('joinQueue — happy path', () => {
  it('adds a registered user to the queue and returns an entry', () => {
    const user = makeRegisteredUser();
    const { entry, alreadyQueued } = joinQueue(user, 'remove_7s', 6);

    expect(alreadyQueued).toBe(false);
    expect(entry.playerId).toBe('user-001');
    expect(entry.isGuest).toBe(false);
    expect(entry.displayName).toBe('Alice');
    expect(entry.cardVariant).toBe('remove_7s');
    expect(entry.playerCount).toBe(6);
    expect(entry.joinedAt).toBeLessThanOrEqual(Date.now());
    expect(entry.expiresAt).toBeGreaterThan(Date.now());
  });

  it('adds a guest user to the queue', () => {
    const user = makeGuestUser();
    const { entry, alreadyQueued } = joinQueue(user, 'remove_2s', 8);

    expect(alreadyQueued).toBe(false);
    expect(entry.playerId).toBe('guest-session-001');
    expect(entry.isGuest).toBe(true);
    expect(entry.cardVariant).toBe('remove_2s');
    expect(entry.playerCount).toBe(8);
  });

  it('accepts playerCount as a string (coerces to number)', () => {
    const user = makeRegisteredUser();
    const { entry } = joinQueue(user, 'remove_8s', '7');
    expect(entry.playerCount).toBe(7);
  });

  it('returns position 1 for the first player in a queue', () => {
    const user = makeRegisteredUser();
    joinQueue(user, 'remove_7s', 6);
    const pos = getQueuePosition(user);
    expect(pos.position).toBe(1);
    expect(pos.queueSize).toBe(1);
  });

  it('multiple different players join the same queue in FIFO order', () => {
    const alice = makeRegisteredUser('u-alice', 'Alice');
    const bob = makeRegisteredUser('u-bob', 'Bob');
    const carol = makeRegisteredUser('u-carol', 'Carol');

    joinQueue(alice, 'remove_7s', 6);
    joinQueue(bob, 'remove_7s', 6);
    joinQueue(carol, 'remove_7s', 6);

    const alicePos = getQueuePosition(alice);
    const bobPos = getQueuePosition(bob);
    const carolPos = getQueuePosition(carol);

    expect(alicePos.position).toBe(1);
    expect(bobPos.position).toBe(2);
    expect(carolPos.position).toBe(3);
    expect(alicePos.queueSize).toBe(3);
  });

  it('players with different filters are in separate queues', () => {
    const u1 = makeRegisteredUser('u1', 'P1');
    const u2 = makeRegisteredUser('u2', 'P2');

    joinQueue(u1, 'remove_7s', 6);
    joinQueue(u2, 'remove_2s', 8);

    const q1 = getQueueForFilter('remove_7s', 6);
    const q2 = getQueueForFilter('remove_2s', 8);

    expect(q1).toHaveLength(1);
    expect(q2).toHaveLength(1);
    expect(q1[0].playerId).toBe('u1');
    expect(q2[0].playerId).toBe('u2');
  });
});

// ---------------------------------------------------------------------------
// joinQueue — re-join same queue (TTL refresh)
// ---------------------------------------------------------------------------

describe('joinQueue — re-join same queue refreshes TTL', () => {
  it('returns alreadyQueued=true and refreshes expiresAt', () => {
    const user = makeRegisteredUser();
    joinQueue(user, 'remove_7s', 6);

    // Manually backdate the stored entry to simulate approaching expiry
    const rawQueues = _getRawQueues();
    const entries = rawQueues.get('remove_7s:6');
    const nearExpiryTime = Date.now() + 1000; // near expiry
    entries[0].expiresAt = nearExpiryTime;

    const { entry: second, alreadyQueued } = joinQueue(user, 'remove_7s', 6);

    expect(alreadyQueued).toBe(true);
    // TTL reset: expiresAt should now be far in the future (not near expiry)
    expect(second.expiresAt).toBeGreaterThan(nearExpiryTime);
  });

  it('only one entry exists in the queue after repeated join calls', () => {
    const user = makeRegisteredUser();
    joinQueue(user, 'remove_7s', 6);
    joinQueue(user, 'remove_7s', 6);
    joinQueue(user, 'remove_7s', 6);

    const q = getQueueForFilter('remove_7s', 6);
    expect(q).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// joinQueue — switching queues
// ---------------------------------------------------------------------------

describe('joinQueue — switching queues removes from previous', () => {
  it('removes player from old queue when joining a different filter', () => {
    const user = makeRegisteredUser();

    joinQueue(user, 'remove_7s', 6);
    expect(getQueueForFilter('remove_7s', 6)).toHaveLength(1);

    // Switch to different filter
    joinQueue(user, 'remove_2s', 8);

    expect(getQueueForFilter('remove_7s', 6)).toHaveLength(0);
    expect(getQueueForFilter('remove_2s', 8)).toHaveLength(1);

    const entry = getQueueEntry(user);
    expect(entry.cardVariant).toBe('remove_2s');
    expect(entry.playerCount).toBe(8);
  });

  it('player index points to the new queue after switch', () => {
    const user = makeRegisteredUser();
    joinQueue(user, 'remove_7s', 6);
    joinQueue(user, 'remove_8s', 7);

    const index = _getRawPlayerIndex();
    expect(index.get('user-001')).toBe('remove_8s:7');
  });
});

// ---------------------------------------------------------------------------
// joinQueue — validation errors
// ---------------------------------------------------------------------------

describe('joinQueue — validation', () => {
  it('throws on invalid cardVariant', () => {
    const user = makeRegisteredUser();
    expect(() => joinQueue(user, 'remove_jokers', 6)).toThrow(/Invalid cardVariant/);
  });

  it('throws on invalid playerCount', () => {
    const user = makeRegisteredUser();
    expect(() => joinQueue(user, 'remove_7s', 5)).toThrow(/Invalid playerCount/);
  });

  it('throws on non-numeric playerCount that cannot be coerced', () => {
    const user = makeRegisteredUser();
    expect(() => joinQueue(user, 'remove_7s', 'six')).toThrow(/Invalid playerCount/);
  });
});

// ---------------------------------------------------------------------------
// leaveQueue
// ---------------------------------------------------------------------------

describe('leaveQueue', () => {
  it('removes player from the queue and returns true', () => {
    const user = makeRegisteredUser();
    joinQueue(user, 'remove_7s', 6);

    const removed = leaveQueue(user);

    expect(removed).toBe(true);
    expect(getQueueEntry(user)).toBeNull();
    expect(getQueueForFilter('remove_7s', 6)).toHaveLength(0);
  });

  it('returns false when player is not in any queue', () => {
    const user = makeRegisteredUser();
    expect(leaveQueue(user)).toBe(false);
  });

  it('removes player by specific filter when both cardVariant and playerCount provided', () => {
    const user = makeRegisteredUser();
    joinQueue(user, 'remove_7s', 6);

    const removed = leaveQueue(user, 'remove_7s', 6);

    expect(removed).toBe(true);
    expect(getQueueForFilter('remove_7s', 6)).toHaveLength(0);
  });

  it('returns false when specific filter does not match active queue', () => {
    const user = makeRegisteredUser();
    joinQueue(user, 'remove_7s', 6); // in remove_7s:6

    // Try to leave remove_2s:8 — player is not in that queue
    const removed = leaveQueue(user, 'remove_2s', 8);

    expect(removed).toBe(false);
    // Original queue entry should still exist
    expect(getQueueEntry(user)).not.toBeNull();
  });

  it('leaving one player does not affect others in the same queue', () => {
    const alice = makeRegisteredUser('alice', 'Alice');
    const bob = makeRegisteredUser('bob', 'Bob');

    joinQueue(alice, 'remove_7s', 6);
    joinQueue(bob, 'remove_7s', 6);

    leaveQueue(alice);

    const q = getQueueForFilter('remove_7s', 6);
    expect(q).toHaveLength(1);
    expect(q[0].playerId).toBe('bob');
  });

  it('cleans up the queue map when last player leaves', () => {
    const user = makeRegisteredUser();
    joinQueue(user, 'remove_7s', 6);
    leaveQueue(user);

    const rawQueues = _getRawQueues();
    expect(rawQueues.has('remove_7s:6')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getQueueEntry
// ---------------------------------------------------------------------------

describe('getQueueEntry', () => {
  it('returns the entry when player is in the queue', () => {
    const user = makeRegisteredUser();
    joinQueue(user, 'remove_7s', 6);

    const entry = getQueueEntry(user);
    expect(entry).not.toBeNull();
    expect(entry.playerId).toBe('user-001');
  });

  it('returns null when player is not in any queue', () => {
    const user = makeRegisteredUser();
    expect(getQueueEntry(user)).toBeNull();
  });

  it('returns null for an expired entry (lazy cleanup)', () => {
    const user = makeRegisteredUser();
    joinQueue(user, 'remove_7s', 6);

    // Manually expire the entry
    const rawQueues = _getRawQueues();
    const entries = rawQueues.get('remove_7s:6');
    entries[0].expiresAt = Date.now() - 1;

    expect(getQueueEntry(user)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getQueueForFilter
// ---------------------------------------------------------------------------

describe('getQueueForFilter', () => {
  it('returns empty array for an empty queue', () => {
    expect(getQueueForFilter('remove_7s', 6)).toEqual([]);
  });

  it('returns all players in that filter combination', () => {
    const u1 = makeRegisteredUser('u1', 'P1');
    const u2 = makeRegisteredUser('u2', 'P2');

    joinQueue(u1, 'remove_7s', 6);
    joinQueue(u2, 'remove_7s', 6);

    const q = getQueueForFilter('remove_7s', 6);
    expect(q).toHaveLength(2);
  });

  it('returns copies (mutation does not affect internal store)', () => {
    const user = makeRegisteredUser();
    joinQueue(user, 'remove_7s', 6);

    const q = getQueueForFilter('remove_7s', 6);
    q[0].displayName = 'hacked';

    const q2 = getQueueForFilter('remove_7s', 6);
    expect(q2[0].displayName).toBe('Alice');
  });
});

// ---------------------------------------------------------------------------
// getQueueSnapshot
// ---------------------------------------------------------------------------

describe('getQueueSnapshot', () => {
  it('returns empty snapshot when no players are queued', () => {
    const snap = getQueueSnapshot();
    expect(snap.queues).toEqual({});
    expect(snap.totalWaiting).toBe(0);
  });

  it('reflects all active queues', () => {
    const u1 = makeRegisteredUser('u1', 'P1');
    const u2 = makeRegisteredUser('u2', 'P2');
    const u3 = makeRegisteredUser('u3', 'P3');

    joinQueue(u1, 'remove_7s', 6);
    joinQueue(u2, 'remove_7s', 6);
    joinQueue(u3, 'remove_2s', 8);

    const snap = getQueueSnapshot();

    expect(snap.totalWaiting).toBe(3);
    expect(snap.queues['remove_7s:6'].count).toBe(2);
    expect(snap.queues['remove_2s:8'].count).toBe(1);
    expect(snap.queues['remove_7s:6'].cardVariant).toBe('remove_7s');
    expect(snap.queues['remove_7s:6'].playerCount).toBe(6);
  });

  it('does not include empty queues in snapshot', () => {
    const user = makeRegisteredUser();
    joinQueue(user, 'remove_7s', 6);
    leaveQueue(user);

    const snap = getQueueSnapshot();
    expect(Object.keys(snap.queues)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getQueuePosition
// ---------------------------------------------------------------------------

describe('getQueuePosition', () => {
  it('returns null when player is not queued', () => {
    const user = makeRegisteredUser();
    expect(getQueuePosition(user)).toBeNull();
  });

  it('returns correct position and queue size', () => {
    const u1 = makeRegisteredUser('u1', 'P1');
    const u2 = makeRegisteredUser('u2', 'P2');
    const u3 = makeRegisteredUser('u3', 'P3');

    joinQueue(u1, 'remove_7s', 6);
    joinQueue(u2, 'remove_7s', 6);
    joinQueue(u3, 'remove_7s', 6);

    expect(getQueuePosition(u1)).toEqual({
      position: 1,
      queueSize: 3,
      queueKey: 'remove_7s:6',
    });
    expect(getQueuePosition(u3)).toEqual({
      position: 3,
      queueSize: 3,
      queueKey: 'remove_7s:6',
    });
  });

  it('position shifts after a player ahead in line leaves', () => {
    const u1 = makeRegisteredUser('u1', 'P1');
    const u2 = makeRegisteredUser('u2', 'P2');

    joinQueue(u1, 'remove_7s', 6);
    joinQueue(u2, 'remove_7s', 6);

    leaveQueue(u1);

    const pos = getQueuePosition(u2);
    expect(pos.position).toBe(1);
    expect(pos.queueSize).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cleanupExpiredEntries
// ---------------------------------------------------------------------------

describe('cleanupExpiredEntries', () => {
  it('removes entries that have passed their expiresAt', () => {
    const u1 = makeRegisteredUser('u1', 'P1');
    const u2 = makeRegisteredUser('u2', 'P2');

    joinQueue(u1, 'remove_7s', 6);
    joinQueue(u2, 'remove_7s', 6);

    // Expire u1
    const rawQueues = _getRawQueues();
    rawQueues.get('remove_7s:6')[0].expiresAt = Date.now() - 1;

    cleanupExpiredEntries();

    const q = getQueueForFilter('remove_7s', 6);
    expect(q).toHaveLength(1);
    expect(q[0].playerId).toBe('u2');
  });

  it('removes the queue key when all entries expire', () => {
    const user = makeRegisteredUser();
    joinQueue(user, 'remove_7s', 6);

    const rawQueues = _getRawQueues();
    rawQueues.get('remove_7s:6')[0].expiresAt = Date.now() - 1;

    cleanupExpiredEntries();

    expect(rawQueues.has('remove_7s:6')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Multi-variant edge cases
// ---------------------------------------------------------------------------

describe('multi-variant edge cases', () => {
  it('supports all 9 filter combinations (3 variants × 3 counts)', () => {
    let userIdx = 0;
    for (const variant of VALID_CARD_VARIANTS) {
      for (const count of VALID_PLAYER_COUNTS) {
        const user = makeRegisteredUser(`u-${userIdx++}`, `Player${userIdx}`);
        joinQueue(user, variant, count);
      }
    }

    const snap = getQueueSnapshot();
    expect(snap.totalWaiting).toBe(9);
    expect(Object.keys(snap.queues)).toHaveLength(9);
  });

  it('guests and registered users can coexist in the same queue', () => {
    const reg = makeRegisteredUser('reg-1', 'RegPlayer');
    const guest = makeGuestUser('guest-sess-1', 'GuestPlayer');

    joinQueue(reg, 'remove_7s', 6);
    joinQueue(guest, 'remove_7s', 6);

    const q = getQueueForFilter('remove_7s', 6);
    expect(q).toHaveLength(2);

    const ids = q.map((e) => e.playerId);
    expect(ids).toContain('reg-1');
    expect(ids).toContain('guest-sess-1');
  });

  it('_clearQueue wipes all queues and the player index', () => {
    const u1 = makeRegisteredUser('u1', 'P1');
    joinQueue(u1, 'remove_7s', 6);

    _clearQueue();

    expect(_getRawQueues().size).toBe(0);
    expect(_getRawPlayerIndex().size).toBe(0);
  });
});
