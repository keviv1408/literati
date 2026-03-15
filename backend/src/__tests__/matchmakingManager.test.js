'use strict';

/**
 * Unit tests for matchmakingManager.js
 *
 * Coverage:
 *   handleJoinQueue:
 *     1. Valid join → player added, queue-joined sent, queue-update broadcast
 *     2. Invalid playerCount → error sent
 *     3. Invalid cardRemovalVariant → error sent
 *     4. Player switches filter groups
 *     5. Match assembles when queue reaches playerCount
 *
 *   handleLeaveQueue:
 *     6. Successful leave → queue-left sent, queue-update broadcast
 *     7. Leave when not in queue → error sent
 *
 *   cleanupQueuedPlayer:
 *     8. Removes player and broadcasts queue-update on disconnect
 *     9. No-op when player not in queue
 *
 *   tryAssembleMatch:
 *    10. Does nothing when queue is below threshold
 *    11. Creates a room and sends match-found when queue fills
 *    12. Re-queues players if room creation fails
 */

// Mock utils/roomCode with explicit jest factory so the functions are jest.fn()s
jest.mock('../utils/roomCode', () => ({
  generateUniqueRoomCode: jest.fn(),
  generateInviteCode:     jest.fn(),
  generateSpectatorToken: jest.fn(),
}));

// Do NOT auto-mock supabase — use _setSupabaseClient to inject a mock instead
const { _setSupabaseClient } = require('../db/supabase');

const {
  handleJoinQueue,
  handleLeaveQueue,
  cleanupQueuedPlayer,
  tryAssembleMatch,
} = require('../matchmaking/matchmakingManager');

const {
  makeFilterKey,
  getQueueSize,
  getPlayerFilterKey,
  _clearAll,
} = require('../matchmaking/matchmakingStore');

const {
  generateUniqueRoomCode,
  generateInviteCode,
  generateSpectatorToken,
} = require('../utils/roomCode');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWs(open = true) {
  return {
    readyState: open ? 1 /* OPEN */ : 3 /* CLOSED */,
    send: jest.fn(),
    close: jest.fn(),
  };
}

/** Find the first message of a given type among all sent messages. */
function findMsg(ws, type) {
  for (const [raw] of ws.send.mock.calls) {
    const m = JSON.parse(raw);
    if (m.type === type) return m;
  }
  return null;
}

function allSent(ws) {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
}

function makeUser(overrides = {}) {
  return {
    playerId:    'player-1',
    displayName: 'Alice',
    avatarId:    'avatar-1',
    isGuest:     true,
    ...overrides,
  };
}

function buildMockSupabase(room = null) {
  const mockChain = {
    insert: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(
      room
        ? { data: room, error: null }
        : { data: null, error: { message: 'DB insert failed' } }
    ),
  };
  return {
    from: jest.fn().mockReturnValue(mockChain),
    _chain: mockChain,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _clearAll();
  jest.clearAllMocks();
  // Default mocks for room code helpers
  generateUniqueRoomCode.mockResolvedValue('ABC123');
  generateInviteCode.mockReturnValue('ABCDEF1234567890');
  generateSpectatorToken.mockReturnValue('A1B2C3D4E5F60000A1B2C3D4E5F60000');
});

afterEach(() => {
  _clearAll();
});

// =============================================================================
// handleJoinQueue
// =============================================================================

describe('handleJoinQueue', () => {
  it('adds player to queue and sends queue-joined confirmation', async () => {
    const ws = makeWs();
    const user = makeUser();

    await handleJoinQueue(ws, 'conn-1', user, {
      type: 'join-queue',
      playerCount: 6,
      cardRemovalVariant: 'remove_7s',
    });

    const fk = makeFilterKey(6, 'remove_7s');
    expect(getQueueSize(fk)).toBe(1);

    const msg = findMsg(ws, 'queue-joined');
    expect(msg).not.toBeNull();
    expect(msg.filterKey).toBe(fk);
    expect(msg.playerCount).toBe(6);
    expect(msg.cardRemovalVariant).toBe('remove_7s');
    expect(msg.position).toBe(1);
    expect(msg.queueSize).toBe(1);
  });

  it('sends error for invalid playerCount', async () => {
    const ws = makeWs();
    await handleJoinQueue(ws, 'conn-1', makeUser(), {
      type: 'join-queue',
      playerCount: 5,
      cardRemovalVariant: 'remove_7s',
    });

    const msg = findMsg(ws, 'error');
    expect(msg).not.toBeNull();
    expect(msg.code).toBe('INVALID_PLAYER_COUNT');
  });

  it('sends error for invalid cardRemovalVariant', async () => {
    const ws = makeWs();
    await handleJoinQueue(ws, 'conn-1', makeUser(), {
      type: 'join-queue',
      playerCount: 6,
      cardRemovalVariant: 'remove_jokers',
    });

    const msg = findMsg(ws, 'error');
    expect(msg).not.toBeNull();
    expect(msg.code).toBe('INVALID_VARIANT');
  });

  it('sends error for missing cardRemovalVariant', async () => {
    const ws = makeWs();
    await handleJoinQueue(ws, 'conn-1', makeUser(), {
      type: 'join-queue',
      playerCount: 6,
    });

    const msg = findMsg(ws, 'error');
    expect(msg).not.toBeNull();
    expect(msg.code).toBe('INVALID_VARIANT');
  });

  it('broadcasts queue-update after a player joins', async () => {
    // Add first player
    const ws1 = makeWs();
    await handleJoinQueue(ws1, 'c1', makeUser({ playerId: 'p1' }), {
      type: 'join-queue',
      playerCount: 6,
      cardRemovalVariant: 'remove_7s',
    });

    // Add second player
    const ws2 = makeWs();
    await handleJoinQueue(ws2, 'c2', makeUser({ playerId: 'p2' }), {
      type: 'join-queue',
      playerCount: 6,
      cardRemovalVariant: 'remove_7s',
    });

    // ws1 should receive a queue-update with queueSize=2
    const messages = allSent(ws1);
    const updateMsg = messages.find((m) => m.type === 'queue-update' && m.queueSize === 2);
    expect(updateMsg).toBeDefined();
    expect(updateMsg.filterKey).toBe(makeFilterKey(6, 'remove_7s'));
  });

  it('moves player to new filter group when they join-queue again', async () => {
    const ws = makeWs();
    const user = makeUser();

    await handleJoinQueue(ws, 'conn-1', user, {
      type: 'join-queue', playerCount: 6, cardRemovalVariant: 'remove_7s',
    });
    await handleJoinQueue(ws, 'conn-1', user, {
      type: 'join-queue', playerCount: 8, cardRemovalVariant: 'remove_2s',
    });

    expect(getQueueSize(makeFilterKey(6, 'remove_7s'))).toBe(0);
    expect(getQueueSize(makeFilterKey(8, 'remove_2s'))).toBe(1);
    expect(getPlayerFilterKey(user.playerId)).toBe(makeFilterKey(8, 'remove_2s'));
  });

  it('assembles a match and sends match-found when queue fills', async () => {
    const fakeRoom = {
      id:                  'room-id',
      code:                'ABC123',
      player_count:        6,
      card_removal_variant: 'remove_7s',
      status:              'waiting',
    };
    _setSupabaseClient(buildMockSupabase(fakeRoom));

    const sockets = [];
    for (let i = 1; i <= 6; i++) {
      const ws = makeWs();
      sockets.push(ws);
      await handleJoinQueue(ws, `conn-${i}`, makeUser({ playerId: `p${i}` }), {
        type: 'join-queue',
        playerCount: 6,
        cardRemovalVariant: 'remove_7s',
      });
    }

    // All 6 sockets should have received match-found
    for (const ws of sockets) {
      const matchMsg = findMsg(ws, 'match-found');
      expect(matchMsg).not.toBeNull();
      expect(matchMsg.roomCode).toBe('ABC123');
      expect(matchMsg.playerCount).toBe(6);
      expect(matchMsg.cardRemovalVariant).toBe('remove_7s');
    }

    // Queue should be empty after successful match
    expect(getQueueSize(makeFilterKey(6, 'remove_7s'))).toBe(0);
  });
});

// =============================================================================
// handleLeaveQueue
// =============================================================================

describe('handleLeaveQueue', () => {
  it('removes player from queue and sends queue-left confirmation', async () => {
    const ws = makeWs();
    const user = makeUser();
    const fk = makeFilterKey(6, 'remove_7s');

    await handleJoinQueue(ws, 'conn-1', user, {
      type: 'join-queue', playerCount: 6, cardRemovalVariant: 'remove_7s',
    });
    ws.send.mockClear(); // Clear join messages

    handleLeaveQueue(ws, 'conn-1', user);

    expect(getQueueSize(fk)).toBe(0);
    const msg = findMsg(ws, 'queue-left');
    expect(msg).not.toBeNull();
    expect(msg.filterKey).toBe(fk);
  });

  it('broadcasts queue-update to remaining players after a leave', async () => {
    const ws1 = makeWs();
    const ws2 = makeWs();
    const user1 = makeUser({ playerId: 'p1' });
    const user2 = makeUser({ playerId: 'p2' });

    await handleJoinQueue(ws1, 'c1', user1, {
      type: 'join-queue', playerCount: 6, cardRemovalVariant: 'remove_7s',
    });
    await handleJoinQueue(ws2, 'c2', user2, {
      type: 'join-queue', playerCount: 6, cardRemovalVariant: 'remove_7s',
    });
    ws1.send.mockClear();
    ws2.send.mockClear();

    handleLeaveQueue(ws1, 'c1', user1);

    // ws2 should receive a queue-update with queueSize=1
    const msgs = allSent(ws2);
    expect(msgs.some((m) => m.type === 'queue-update' && m.queueSize === 1)).toBe(true);
  });

  it('sends NOT_IN_QUEUE error when player is not in any queue', () => {
    const ws = makeWs();
    handleLeaveQueue(ws, 'conn-1', makeUser());

    const msg = findMsg(ws, 'error');
    expect(msg).not.toBeNull();
    expect(msg.code).toBe('NOT_IN_QUEUE');
  });
});

// =============================================================================
// cleanupQueuedPlayer
// =============================================================================

describe('cleanupQueuedPlayer', () => {
  it('removes player on disconnect and broadcasts queue-update', async () => {
    const ws1 = makeWs();
    const ws2 = makeWs();
    const fk = makeFilterKey(6, 'remove_7s');

    await handleJoinQueue(ws1, 'c1', makeUser({ playerId: 'p1' }), {
      type: 'join-queue', playerCount: 6, cardRemovalVariant: 'remove_7s',
    });
    await handleJoinQueue(ws2, 'c2', makeUser({ playerId: 'p2' }), {
      type: 'join-queue', playerCount: 6, cardRemovalVariant: 'remove_7s',
    });
    ws1.send.mockClear();
    ws2.send.mockClear();

    cleanupQueuedPlayer('p1');

    expect(getQueueSize(fk)).toBe(1);
    expect(getPlayerFilterKey('p1')).toBeNull();

    // ws2 should receive queue-update with queueSize=1
    const msgs = allSent(ws2);
    expect(msgs.some((m) => m.type === 'queue-update' && m.queueSize === 1)).toBe(true);
  });

  it('is a no-op when player is not in any queue', () => {
    expect(() => cleanupQueuedPlayer('nonexistent')).not.toThrow();
  });
});

// =============================================================================
// tryAssembleMatch
// =============================================================================

describe('tryAssembleMatch', () => {
  it('does nothing when queue is below the required count', async () => {
    const fk = makeFilterKey(6, 'remove_7s');
    const ws = makeWs();
    await handleJoinQueue(ws, 'c1', makeUser({ playerId: 'p1' }), {
      type: 'join-queue', playerCount: 6, cardRemovalVariant: 'remove_7s',
    });

    ws.send.mockClear();
    await tryAssembleMatch(fk, 6, 'remove_7s');

    // Queue should still have the player
    expect(getQueueSize(fk)).toBe(1);
    // No match-found sent
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('creates a room and sends match-found when queue is exactly the required count', async () => {
    const fakeRoom = {
      id:                  'room-id',
      code:                'XYZ789',
      player_count:        6,
      card_removal_variant: 'remove_7s',
      status:              'waiting',
    };
    generateUniqueRoomCode.mockResolvedValue('XYZ789');
    _setSupabaseClient(buildMockSupabase(fakeRoom));

    const fk = makeFilterKey(6, 'remove_7s');
    const sockets = [];

    for (let i = 1; i <= 6; i++) {
      const ws = makeWs();
      sockets.push(ws);
      await handleJoinQueue(ws, `c${i}`, makeUser({ playerId: `p${i}` }), {
        type: 'join-queue', playerCount: 6, cardRemovalVariant: 'remove_7s',
      });
    }

    // Verify match-found was sent to all players
    for (const ws of sockets) {
      const matchMsg = findMsg(ws, 'match-found');
      expect(matchMsg).not.toBeNull();
      expect(matchMsg.roomCode).toBe('XYZ789');
    }

    expect(getQueueSize(fk)).toBe(0);
  });

  it('sets is_matchmaking: true in the Supabase room insert', async () => {
    const fakeRoom = {
      id:                  'room-id',
      code:                'MMK001',
      player_count:        6,
      card_removal_variant: 'remove_7s',
      status:              'waiting',
      is_matchmaking:      true,
    };
    generateUniqueRoomCode.mockResolvedValue('MMK001');
    const mockSb = buildMockSupabase(fakeRoom);
    _setSupabaseClient(mockSb);

    const fk = makeFilterKey(6, 'remove_7s');

    for (let i = 1; i <= 6; i++) {
      const ws = makeWs();
      await handleJoinQueue(ws, `c${i}`, makeUser({ playerId: `p${i}` }), {
        type: 'join-queue', playerCount: 6, cardRemovalVariant: 'remove_7s',
      });
    }

    // The insert call should have received is_matchmaking: true
    const insertArg = mockSb._chain.insert.mock.calls[0][0];
    expect(insertArg).toMatchObject({ is_matchmaking: true });
  });

  it('includes isMatchmaking: true in all match-found messages', async () => {
    const fakeRoom = {
      id:                  'room-id',
      code:                'MMK002',
      player_count:        6,
      card_removal_variant: 'remove_7s',
      status:              'waiting',
      is_matchmaking:      true,
    };
    generateUniqueRoomCode.mockResolvedValue('MMK002');
    _setSupabaseClient(buildMockSupabase(fakeRoom));

    const sockets = [];
    for (let i = 1; i <= 6; i++) {
      const ws = makeWs();
      sockets.push(ws);
      await handleJoinQueue(ws, `c${i}`, makeUser({ playerId: `p${i}` }), {
        type: 'join-queue', playerCount: 6, cardRemovalVariant: 'remove_7s',
      });
    }

    // Every matched player's 'match-found' message must carry isMatchmaking: true
    for (const ws of sockets) {
      const matchMsg = findMsg(ws, 'match-found');
      expect(matchMsg).not.toBeNull();
      expect(matchMsg.isMatchmaking).toBe(true);
    }
  });

  it('re-queues players if room creation fails', async () => {
    _setSupabaseClient(buildMockSupabase(null)); // DB returns error

    const fk = makeFilterKey(6, 'remove_7s');
    const sockets = [];

    for (let i = 1; i <= 6; i++) {
      const ws = makeWs();
      sockets.push(ws);
      await handleJoinQueue(ws, `c${i}`, makeUser({ playerId: `p${i}` }), {
        type: 'join-queue', playerCount: 6, cardRemovalVariant: 'remove_7s',
      });
    }

    // Players should be back in the queue after failed room creation
    expect(getQueueSize(fk)).toBe(6);

    // No match-found should have been sent
    for (const ws of sockets) {
      expect(findMsg(ws, 'match-found')).toBeNull();
    }
  });
});
