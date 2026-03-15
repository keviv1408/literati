'use strict';

/**
 * Unit tests for matchmakingStore.js
 *
 * Coverage:
 *   - makeFilterKey / parseFilterKey
 *   - joinQueue: add player, re-queue in same group, switch filter groups
 *   - leaveQueue: remove player, not-in-queue case
 *   - getQueuePlayers / getQueueSize / getPlayerFilterKey
 *   - dequeueGroup: happy path, not-enough-players, FIFO ordering
 *   - getAllQueueStats
 *   - Test helpers: _clearAll, _getQueues, _getPlayerQueue
 */

const {
  makeFilterKey,
  parseFilterKey,
  joinQueue,
  leaveQueue,
  getQueuePlayers,
  getQueueSize,
  getPlayerFilterKey,
  dequeueGroup,
  getAllQueueStats,
  _clearAll,
  _getQueues,
  _getPlayerQueue,
} = require('../matchmaking/matchmakingStore');

// Helpers ─────────────────────────────────────────────────────────────────────

function makeWs(open = true) {
  return {
    readyState: open ? 1 /* OPEN */ : 3 /* CLOSED */,
    send: jest.fn(),
    close: jest.fn(),
  };
}

function makePlayer(overrides = {}) {
  return {
    playerId: 'player-1',
    displayName: 'Alice',
    avatarId: 'avatar-1',
    isGuest: true,
    connectionId: 'conn-1',
    ws: makeWs(),
    ...overrides,
  };
}

// Setup / teardown ─────────────────────────────────────────────────────────────

beforeEach(() => {
  _clearAll();
});

afterEach(() => {
  _clearAll();
});

// =============================================================================
// makeFilterKey / parseFilterKey
// =============================================================================

describe('makeFilterKey', () => {
  it('formats as "{playerCount}:{cardRemovalVariant}"', () => {
    expect(makeFilterKey(6, 'remove_7s')).toBe('6:remove_7s');
    expect(makeFilterKey(8, 'remove_2s')).toBe('8:remove_2s');
    expect(makeFilterKey(6, 'remove_8s')).toBe('6:remove_8s');
  });
});

describe('parseFilterKey', () => {
  it('parses back to playerCount and cardRemovalVariant', () => {
    expect(parseFilterKey('6:remove_7s')).toEqual({ playerCount: 6, cardRemovalVariant: 'remove_7s' });
    expect(parseFilterKey('8:remove_2s')).toEqual({ playerCount: 8, cardRemovalVariant: 'remove_2s' });
  });
});

// =============================================================================
// joinQueue
// =============================================================================

describe('joinQueue', () => {
  it('adds a player and returns position and queueSize', () => {
    const player = makePlayer();
    const fk = makeFilterKey(6, 'remove_7s');

    const result = joinQueue(fk, player);

    expect(result).toEqual({ position: 1, queueSize: 1 });
    expect(getQueueSize(fk)).toBe(1);
    expect(getPlayerFilterKey(player.playerId)).toBe(fk);
  });

  it('stores the filterKey and joinedAt on the player entry', () => {
    const fk = makeFilterKey(6, 'remove_7s');
    const before = Date.now();
    joinQueue(fk, makePlayer());
    const after = Date.now();

    const players = getQueuePlayers(fk);
    expect(players).toHaveLength(1);
    expect(players[0].filterKey).toBe(fk);
    expect(players[0].joinedAt).toBeGreaterThanOrEqual(before);
    expect(players[0].joinedAt).toBeLessThanOrEqual(after);
  });

  it('preserves existing joinedAt when re-queueing', () => {
    const fk = makeFilterKey(6, 'remove_7s');
    const oldJoinedAt = Date.now() - 5000;
    const player = makePlayer({ joinedAt: oldJoinedAt });

    joinQueue(fk, player);

    const players = getQueuePlayers(fk);
    expect(players[0].joinedAt).toBe(oldJoinedAt);
  });

  it('adds multiple players and reports correct queue size', () => {
    const fk = makeFilterKey(6, 'remove_7s');
    const p1 = makePlayer({ playerId: 'p1', connectionId: 'c1' });
    const p2 = makePlayer({ playerId: 'p2', connectionId: 'c2' });
    const p3 = makePlayer({ playerId: 'p3', connectionId: 'c3' });

    joinQueue(fk, p1);
    joinQueue(fk, p2);
    const r3 = joinQueue(fk, p3);

    expect(r3.queueSize).toBe(3);
    expect(getQueueSize(fk)).toBe(3);
  });

  it('removes player from previous filter group when switching queues', () => {
    const fk1 = makeFilterKey(6, 'remove_7s');
    const fk2 = makeFilterKey(8, 'remove_2s');
    const player = makePlayer();

    joinQueue(fk1, player);
    expect(getQueueSize(fk1)).toBe(1);

    joinQueue(fk2, player);
    expect(getQueueSize(fk1)).toBe(0);
    expect(getQueueSize(fk2)).toBe(1);
    expect(getPlayerFilterKey(player.playerId)).toBe(fk2);
  });

  it('cleans up empty queues after player moves to a different group', () => {
    const fk1 = makeFilterKey(6, 'remove_7s');
    const fk2 = makeFilterKey(8, 'remove_2s');
    const player = makePlayer();

    joinQueue(fk1, player);
    joinQueue(fk2, player);

    expect(_getQueues().has(fk1)).toBe(false);
  });
});

// =============================================================================
// leaveQueue
// =============================================================================

describe('leaveQueue', () => {
  it('removes an existing player and returns removed:true with filterKey', () => {
    const fk = makeFilterKey(6, 'remove_7s');
    const player = makePlayer();
    joinQueue(fk, player);

    const result = leaveQueue(player.playerId);

    expect(result).toEqual({ removed: true, filterKey: fk });
    expect(getQueueSize(fk)).toBe(0);
    expect(getPlayerFilterKey(player.playerId)).toBeNull();
  });

  it('returns removed:false when player is not in any queue', () => {
    const result = leaveQueue('nonexistent-player');
    expect(result).toEqual({ removed: false, filterKey: null });
  });

  it('cleans up empty queue after last player leaves', () => {
    const fk = makeFilterKey(6, 'remove_7s');
    joinQueue(fk, makePlayer());
    leaveQueue('player-1');

    expect(_getQueues().has(fk)).toBe(false);
  });

  it('leaves other players in the queue when one departs', () => {
    const fk = makeFilterKey(6, 'remove_7s');
    joinQueue(fk, makePlayer({ playerId: 'p1', connectionId: 'c1' }));
    joinQueue(fk, makePlayer({ playerId: 'p2', connectionId: 'c2' }));

    leaveQueue('p1');

    expect(getQueueSize(fk)).toBe(1);
    expect(getQueuePlayers(fk)[0].playerId).toBe('p2');
  });
});

// =============================================================================
// getQueuePlayers
// =============================================================================

describe('getQueuePlayers', () => {
  it('returns empty array for nonexistent filter key', () => {
    expect(getQueuePlayers('99:remove_7s')).toEqual([]);
  });

  it('returns all players in the queue', () => {
    const fk = makeFilterKey(6, 'remove_7s');
    const p1 = makePlayer({ playerId: 'p1', connectionId: 'c1', displayName: 'Alice' });
    const p2 = makePlayer({ playerId: 'p2', connectionId: 'c2', displayName: 'Bob' });
    joinQueue(fk, p1);
    joinQueue(fk, p2);

    const players = getQueuePlayers(fk);
    expect(players).toHaveLength(2);
    const ids = players.map((p) => p.playerId);
    expect(ids).toContain('p1');
    expect(ids).toContain('p2');
  });
});

// =============================================================================
// getQueueSize
// =============================================================================

describe('getQueueSize', () => {
  it('returns 0 for nonexistent queue', () => {
    expect(getQueueSize('nonexistent')).toBe(0);
  });

  it('returns correct size after joins and leaves', () => {
    const fk = makeFilterKey(8, 'remove_2s');
    joinQueue(fk, makePlayer({ playerId: 'p1', connectionId: 'c1' }));
    joinQueue(fk, makePlayer({ playerId: 'p2', connectionId: 'c2' }));
    expect(getQueueSize(fk)).toBe(2);
    leaveQueue('p1');
    expect(getQueueSize(fk)).toBe(1);
  });
});

// =============================================================================
// getPlayerFilterKey
// =============================================================================

describe('getPlayerFilterKey', () => {
  it('returns null when player is not in any queue', () => {
    expect(getPlayerFilterKey('nobody')).toBeNull();
  });

  it('returns the correct filterKey for a queued player', () => {
    const fk = makeFilterKey(6, 'remove_8s');
    joinQueue(fk, makePlayer());
    expect(getPlayerFilterKey('player-1')).toBe(fk);
  });
});

// =============================================================================
// dequeueGroup
// =============================================================================

describe('dequeueGroup', () => {
  it('returns null when queue has fewer players than requested', () => {
    const fk = makeFilterKey(6, 'remove_7s');
    joinQueue(fk, makePlayer({ playerId: 'p1', connectionId: 'c1' }));
    joinQueue(fk, makePlayer({ playerId: 'p2', connectionId: 'c2' }));

    expect(dequeueGroup(fk, 6)).toBeNull();
  });

  it('returns null for nonexistent filter key', () => {
    expect(dequeueGroup('nonexistent', 2)).toBeNull();
  });

  it('removes and returns exactly count players when queue is sufficient', () => {
    const fk = makeFilterKey(6, 'remove_7s');
    for (let i = 1; i <= 6; i++) {
      joinQueue(fk, makePlayer({ playerId: `p${i}`, connectionId: `c${i}` }));
    }

    const group = dequeueGroup(fk, 6);
    expect(group).toHaveLength(6);
    expect(getQueueSize(fk)).toBe(0);
  });

  it('leaves remaining players in the queue after partial dequeue', () => {
    const fk = makeFilterKey(6, 'remove_7s');
    for (let i = 1; i <= 8; i++) {
      joinQueue(fk, makePlayer({ playerId: `p${i}`, connectionId: `c${i}` }));
    }

    const group = dequeueGroup(fk, 6);
    expect(group).toHaveLength(6);
    expect(getQueueSize(fk)).toBe(2);
  });

  it('orders dequeued players by joinedAt (FIFO)', () => {
    const fk = makeFilterKey(6, 'remove_7s');
    const now = Date.now();

    // Add players with explicit joinedAt to test ordering
    joinQueue(fk, makePlayer({ playerId: 'p-late',  connectionId: 'c3', joinedAt: now + 100 }));
    joinQueue(fk, makePlayer({ playerId: 'p-early', connectionId: 'c1', joinedAt: now - 100 }));
    joinQueue(fk, makePlayer({ playerId: 'p-mid',   connectionId: 'c2', joinedAt: now }));

    const group = dequeueGroup(fk, 2);
    // Should return the two earliest joiners
    const ids = group.map((p) => p.playerId);
    expect(ids[0]).toBe('p-early');
    expect(ids[1]).toBe('p-mid');
  });

  it('removes dequeued players from the player→filterKey index', () => {
    const fk = makeFilterKey(6, 'remove_7s');
    for (let i = 1; i <= 6; i++) {
      joinQueue(fk, makePlayer({ playerId: `p${i}`, connectionId: `c${i}` }));
    }

    dequeueGroup(fk, 6);

    for (let i = 1; i <= 6; i++) {
      expect(getPlayerFilterKey(`p${i}`)).toBeNull();
    }
  });

  it('cleans up the queue map entry when all players are dequeued', () => {
    const fk = makeFilterKey(6, 'remove_7s');
    for (let i = 1; i <= 6; i++) {
      joinQueue(fk, makePlayer({ playerId: `p${i}`, connectionId: `c${i}` }));
    }

    dequeueGroup(fk, 6);

    expect(_getQueues().has(fk)).toBe(false);
  });
});

// =============================================================================
// getAllQueueStats
// =============================================================================

describe('getAllQueueStats', () => {
  it('returns empty array when no players are queued', () => {
    expect(getAllQueueStats()).toEqual([]);
  });

  it('returns one entry per non-empty queue', () => {
    const fk1 = makeFilterKey(6, 'remove_7s');
    const fk2 = makeFilterKey(8, 'remove_2s');

    joinQueue(fk1, makePlayer({ playerId: 'p1', connectionId: 'c1' }));
    joinQueue(fk1, makePlayer({ playerId: 'p2', connectionId: 'c2' }));
    joinQueue(fk2, makePlayer({ playerId: 'p3', connectionId: 'c3' }));

    const stats = getAllQueueStats();
    expect(stats).toHaveLength(2);

    const s1 = stats.find((s) => s.filterKey === fk1);
    const s2 = stats.find((s) => s.filterKey === fk2);
    expect(s1).toBeDefined();
    expect(s1.queueSize).toBe(2);
    expect(s2).toBeDefined();
    expect(s2.queueSize).toBe(1);
  });
});
