'use strict';

/**
 * Unit tests for the roomBlocklist module.
 *
 * All tests use the exported _resetForTests() to ensure complete isolation
 * between cases — no shared state bleeds across.
 */

const {
  blockPlayer,
  isBlocked,
  getBlockedPlayers,
  clearRoom,
  getBlockedRoomCount,
  getPlayerIdentifier,
  _resetForTests,
  _getRawBlocklist,
} = require('../rooms/roomBlocklist');

// Reset the in-memory store before every test
beforeEach(() => {
  _resetForTests();
});

// ---------------------------------------------------------------------------
// blockPlayer
// ---------------------------------------------------------------------------

describe('blockPlayer()', () => {
  it('adds a player ID to the blocklist for a room', () => {
    blockPlayer('ABCDEF', 'player-uuid-1');
    expect(isBlocked('ABCDEF', 'player-uuid-1')).toBe(true);
  });

  it('is case-insensitive for the room code (stores uppercase)', () => {
    blockPlayer('abcdef', 'player-1');
    // Both lowercase and uppercase lookups should match
    expect(isBlocked('abcdef', 'player-1')).toBe(true);
    expect(isBlocked('ABCDEF', 'player-1')).toBe(true);
  });

  it('supports multiple players blocked in the same room', () => {
    blockPlayer('ROOM01', 'player-a');
    blockPlayer('ROOM01', 'player-b');
    blockPlayer('ROOM01', 'player-c');

    expect(isBlocked('ROOM01', 'player-a')).toBe(true);
    expect(isBlocked('ROOM01', 'player-b')).toBe(true);
    expect(isBlocked('ROOM01', 'player-c')).toBe(true);
  });

  it('supports blocking in multiple independent rooms', () => {
    blockPlayer('ROOM01', 'player-x');
    blockPlayer('ROOM02', 'player-y');

    expect(isBlocked('ROOM01', 'player-x')).toBe(true);
    expect(isBlocked('ROOM02', 'player-y')).toBe(true);
    // Cross-room: player-x is NOT blocked in ROOM02
    expect(isBlocked('ROOM02', 'player-x')).toBe(false);
    expect(isBlocked('ROOM01', 'player-y')).toBe(false);
  });

  it('is idempotent — blocking the same player twice does not throw or duplicate', () => {
    blockPlayer('ABCDEF', 'player-dup');
    blockPlayer('ABCDEF', 'player-dup');

    const blocked = getBlockedPlayers('ABCDEF');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toBe('player-dup');
  });

  it('throws when roomCode is not a string', () => {
    expect(() => blockPlayer(null, 'player-1')).toThrow('roomCode must be a non-empty string');
    expect(() => blockPlayer(undefined, 'player-1')).toThrow('roomCode must be a non-empty string');
    expect(() => blockPlayer(123, 'player-1')).toThrow('roomCode must be a non-empty string');
  });

  it('throws when roomCode is empty string', () => {
    expect(() => blockPlayer('', 'player-1')).toThrow('roomCode must be a non-empty string');
    expect(() => blockPlayer('   ', 'player-1')).toThrow('roomCode must be a non-empty string');
  });

  it('throws when playerId is not a string', () => {
    expect(() => blockPlayer('ABCDEF', null)).toThrow('playerId must be a non-empty string');
    expect(() => blockPlayer('ABCDEF', undefined)).toThrow('playerId must be a non-empty string');
    expect(() => blockPlayer('ABCDEF', 42)).toThrow('playerId must be a non-empty string');
  });

  it('throws when playerId is empty string', () => {
    expect(() => blockPlayer('ABCDEF', '')).toThrow('playerId must be a non-empty string');
    expect(() => blockPlayer('ABCDEF', '   ')).toThrow('playerId must be a non-empty string');
  });
});

// ---------------------------------------------------------------------------
// isBlocked
// ---------------------------------------------------------------------------

describe('isBlocked()', () => {
  it('returns false for a player who has not been blocked', () => {
    expect(isBlocked('ABCDEF', 'never-blocked')).toBe(false);
  });

  it('returns false for an unknown room', () => {
    expect(isBlocked('ZZZZZZ', 'player-1')).toBe(false);
  });

  it('returns true for a player who was blocked', () => {
    blockPlayer('ROOM99', 'targeted-player');
    expect(isBlocked('ROOM99', 'targeted-player')).toBe(true);
  });

  it('returns false for null/undefined arguments without throwing', () => {
    expect(isBlocked(null, 'player')).toBe(false);
    expect(isBlocked('ABCDEF', null)).toBe(false);
    expect(isBlocked(undefined, undefined)).toBe(false);
  });

  it('returns false for empty string arguments without throwing', () => {
    expect(isBlocked('', 'player')).toBe(false);
    expect(isBlocked('ABCDEF', '')).toBe(false);
  });

  it('is case-insensitive for room code', () => {
    blockPlayer('MIXEDCASE', 'player-7');
    expect(isBlocked('mixedcase', 'player-7')).toBe(true);
    expect(isBlocked('MixedCase', 'player-7')).toBe(true);
    expect(isBlocked('MIXEDCASE', 'player-7')).toBe(true);
  });

  it('player IDs are case-sensitive', () => {
    blockPlayer('ABCDEF', 'Player-UUID');
    // Exact match
    expect(isBlocked('ABCDEF', 'Player-UUID')).toBe(true);
    // Different case should NOT match
    expect(isBlocked('ABCDEF', 'player-uuid')).toBe(false);
    expect(isBlocked('ABCDEF', 'PLAYER-UUID')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getBlockedPlayers
// ---------------------------------------------------------------------------

describe('getBlockedPlayers()', () => {
  it('returns an empty array for a room with no blocked players', () => {
    expect(getBlockedPlayers('NOBLOCKS')).toEqual([]);
  });

  it('returns empty array for unknown room', () => {
    expect(getBlockedPlayers('UNKNOWN')).toEqual([]);
  });

  it('returns all blocked player IDs for a room', () => {
    blockPlayer('LISTTEST', 'pid-1');
    blockPlayer('LISTTEST', 'pid-2');
    blockPlayer('LISTTEST', 'pid-3');

    const result = getBlockedPlayers('LISTTEST');
    expect(result).toHaveLength(3);
    expect(result).toContain('pid-1');
    expect(result).toContain('pid-2');
    expect(result).toContain('pid-3');
  });

  it('returns a copy — mutating the result does not affect the store', () => {
    blockPlayer('MUTTEST', 'pid-original');
    const result = getBlockedPlayers('MUTTEST');
    result.push('injected');

    // The store should be unaffected
    expect(getBlockedPlayers('MUTTEST')).toHaveLength(1);
    expect(getBlockedPlayers('MUTTEST')).not.toContain('injected');
  });

  it('returns empty array for null/non-string roomCode without throwing', () => {
    expect(getBlockedPlayers(null)).toEqual([]);
    expect(getBlockedPlayers(undefined)).toEqual([]);
    expect(getBlockedPlayers(42)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// clearRoom
// ---------------------------------------------------------------------------

describe('clearRoom()', () => {
  it('removes all blocked players for a room', () => {
    blockPlayer('CLEARME', 'pid-a');
    blockPlayer('CLEARME', 'pid-b');

    clearRoom('CLEARME');

    expect(isBlocked('CLEARME', 'pid-a')).toBe(false);
    expect(isBlocked('CLEARME', 'pid-b')).toBe(false);
    expect(getBlockedPlayers('CLEARME')).toEqual([]);
  });

  it('does not affect other rooms', () => {
    blockPlayer('KEEP', 'pid-1');
    blockPlayer('REMOVE', 'pid-2');

    clearRoom('REMOVE');

    expect(isBlocked('KEEP', 'pid-1')).toBe(true);
    expect(isBlocked('REMOVE', 'pid-2')).toBe(false);
  });

  it('is a no-op for an unknown room (does not throw)', () => {
    expect(() => clearRoom('NONEXIST')).not.toThrow();
  });

  it('is case-insensitive for room code', () => {
    blockPlayer('CLEARCASE', 'pid-x');
    clearRoom('clearcase');
    expect(isBlocked('CLEARCASE', 'pid-x')).toBe(false);
  });

  it('does not throw for null/non-string argument', () => {
    expect(() => clearRoom(null)).not.toThrow();
    expect(() => clearRoom(undefined)).not.toThrow();
    expect(() => clearRoom('')).not.toThrow();
  });

  it('frees the Map entry (reduces getBlockedRoomCount)', () => {
    blockPlayer('ROOM1', 'p1');
    blockPlayer('ROOM2', 'p2');
    expect(getBlockedRoomCount()).toBe(2);

    clearRoom('ROOM1');
    expect(getBlockedRoomCount()).toBe(1);

    clearRoom('ROOM2');
    expect(getBlockedRoomCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getBlockedRoomCount
// ---------------------------------------------------------------------------

describe('getBlockedRoomCount()', () => {
  it('returns 0 when no rooms have blocked players', () => {
    expect(getBlockedRoomCount()).toBe(0);
  });

  it('increments as rooms gain blocked players', () => {
    blockPlayer('R1', 'p1');
    expect(getBlockedRoomCount()).toBe(1);

    blockPlayer('R2', 'p2');
    expect(getBlockedRoomCount()).toBe(2);

    // Blocking another player in an existing room does not increment
    blockPlayer('R1', 'p3');
    expect(getBlockedRoomCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getPlayerIdentifier
// ---------------------------------------------------------------------------

describe('getPlayerIdentifier()', () => {
  it('returns user.id for a registered user', () => {
    const registeredUser = { id: 'reg-uuid-123', isGuest: false };
    expect(getPlayerIdentifier(registeredUser)).toBe('reg-uuid-123');
  });

  it('returns user.sessionId for a guest user', () => {
    const guestUser = { sessionId: 'guest-session-uuid', isGuest: true };
    expect(getPlayerIdentifier(guestUser)).toBe('guest-session-uuid');
  });

  it('returns null for null user', () => {
    expect(getPlayerIdentifier(null)).toBeNull();
  });

  it('returns null for undefined user', () => {
    expect(getPlayerIdentifier(undefined)).toBeNull();
  });

  it('returns null when registered user has no id', () => {
    expect(getPlayerIdentifier({ isGuest: false })).toBeNull();
  });

  it('returns null when guest user has no sessionId', () => {
    expect(getPlayerIdentifier({ isGuest: true })).toBeNull();
  });

  it('prefers sessionId over id for guests (never looks at .id for guests)', () => {
    const guestWithBothFields = {
      id: 'should-not-use',
      sessionId: 'correct-guest-id',
      isGuest: true,
    };
    expect(getPlayerIdentifier(guestWithBothFields)).toBe('correct-guest-id');
  });
});

// ---------------------------------------------------------------------------
// _resetForTests / _getRawBlocklist
// ---------------------------------------------------------------------------

describe('test helpers', () => {
  it('_resetForTests() clears all entries', () => {
    blockPlayer('R1', 'p1');
    blockPlayer('R2', 'p2');
    expect(getBlockedRoomCount()).toBe(2);

    _resetForTests();
    expect(getBlockedRoomCount()).toBe(0);
  });

  it('_getRawBlocklist() returns the internal Map reference', () => {
    blockPlayer('RAWTEST', 'pid');
    const map = _getRawBlocklist();
    expect(map).toBeInstanceOf(Map);
    expect(map.get('RAWTEST')).toBeInstanceOf(Set);
    expect(map.get('RAWTEST').has('pid')).toBe(true);
  });
});
