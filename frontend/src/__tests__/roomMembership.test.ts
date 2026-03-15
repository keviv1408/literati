/**
 * Unit tests for the room membership localStorage utility.
 *
 * Covers:
 *   • saveRoomMembership — stores a valid record and returns it
 *   • loadRoomMembership — returns valid record; returns null when missing,
 *                          expired, or malformed
 *   • clearRoomMembership — removes only the targeted key
 *   • clearAllRoomMemberships — removes all literati_room_* keys
 *   • MEMBERSHIP_TTL_MS — exported constant sanity check
 *   • Case-insensitive room code handling (always upper-cases)
 *   • Idempotent saves (overwriting with same data is safe)
 *   • Expiry: expired record is evicted on read and null is returned
 *   • Storage key format: `literati_room_<CODE>`
 *   • Keys for other prefixes are NOT touched by clearAllRoomMemberships
 *   • RoomRole type: 'host', 'player', 'spectator' all accepted
 */

import {
  saveRoomMembership,
  loadRoomMembership,
  clearRoomMembership,
  clearAllRoomMemberships,
  MEMBERSHIP_TTL_MS,
  type RoomMembership,
  type RoomRole,
} from '@/lib/roomMembership';

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  window.localStorage.clear();
  jest.useRealTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe('MEMBERSHIP_TTL_MS', () => {
  it('equals 12 hours in milliseconds', () => {
    expect(MEMBERSHIP_TTL_MS).toBe(12 * 60 * 60 * 1000);
  });
});

// ── saveRoomMembership ────────────────────────────────────────────────────────

describe('saveRoomMembership', () => {
  it('returns the membership object it just saved', () => {
    const result = saveRoomMembership('abc123', 'tok_abc', 'pid_1');
    expect(result.roomCode).toBe('ABC123');
    expect(result.bearerToken).toBe('tok_abc');
    expect(result.playerId).toBe('pid_1');
    expect(result.role).toBe('player');
    expect(typeof result.expiresAt).toBe('number');
  });

  it('upper-cases the room code', () => {
    saveRoomMembership('abc123', 'token', 'pid');
    const raw = window.localStorage.getItem('literati_room_ABC123');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as RoomMembership;
    expect(parsed.roomCode).toBe('ABC123');
  });

  it('stores a correct expiresAt approximately MEMBERSHIP_TTL_MS in the future', () => {
    const before = Date.now();
    const result = saveRoomMembership('ROOM01', 'tok', 'pid');
    const after = Date.now();
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + MEMBERSHIP_TTL_MS);
    expect(result.expiresAt).toBeLessThanOrEqual(after + MEMBERSHIP_TTL_MS);
  });

  it('defaults role to "player" when not specified', () => {
    const result = saveRoomMembership('ROOM01', 'tok', 'pid');
    expect(result.role).toBe('player');
  });

  it('accepts "host" role', () => {
    const result = saveRoomMembership('ROOM01', 'tok', 'pid', 'host');
    expect(result.role).toBe('host');
  });

  it('accepts "spectator" role', () => {
    const result = saveRoomMembership('ROOM01', 'tok', 'pid', 'spectator');
    expect(result.role).toBe('spectator');
  });

  it('stores data under the key literati_room_<CODE>', () => {
    saveRoomMembership('XYZ999', 'token', 'pid');
    const stored = window.localStorage.getItem('literati_room_XYZ999');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as RoomMembership;
    expect(parsed.bearerToken).toBe('token');
  });

  it('is idempotent — calling twice for the same room overwrites cleanly', () => {
    saveRoomMembership('ROOM01', 'tok1', 'pid1');
    saveRoomMembership('ROOM01', 'tok2', 'pid2', 'host');
    const stored = loadRoomMembership('ROOM01');
    expect(stored).not.toBeNull();
    expect(stored!.bearerToken).toBe('tok2');
    expect(stored!.playerId).toBe('pid2');
    expect(stored!.role).toBe('host');
  });

  it('stores different rooms under separate keys', () => {
    saveRoomMembership('ROOM01', 'tokA', 'pidA');
    saveRoomMembership('ROOM02', 'tokB', 'pidB');
    expect(window.localStorage.getItem('literati_room_ROOM01')).not.toBeNull();
    expect(window.localStorage.getItem('literati_room_ROOM02')).not.toBeNull();
  });
});

// ── loadRoomMembership ────────────────────────────────────────────────────────

describe('loadRoomMembership', () => {
  it('returns the saved membership for a valid record', () => {
    saveRoomMembership('ABC123', 'tok', 'pid', 'player');
    const loaded = loadRoomMembership('ABC123');
    expect(loaded).not.toBeNull();
    expect(loaded!.roomCode).toBe('ABC123');
    expect(loaded!.bearerToken).toBe('tok');
    expect(loaded!.playerId).toBe('pid');
    expect(loaded!.role).toBe('player');
  });

  it('returns null when no record exists', () => {
    expect(loadRoomMembership('NOTHERE')).toBeNull();
  });

  it('returns null when localStorage contains invalid JSON', () => {
    window.localStorage.setItem('literati_room_BADJSON', 'not-json');
    expect(loadRoomMembership('BADJSON')).toBeNull();
  });

  it('returns null when stored object is missing required fields', () => {
    window.localStorage.setItem(
      'literati_room_PARTIAL',
      JSON.stringify({ roomCode: 'PARTIAL', bearerToken: 'tok' })
    );
    expect(loadRoomMembership('PARTIAL')).toBeNull();
  });

  it('returns null when stored object is not an object at all', () => {
    window.localStorage.setItem('literati_room_ARRAY', JSON.stringify([1, 2, 3]));
    expect(loadRoomMembership('ARRAY')).toBeNull();
  });

  it('is case-insensitive — lower-case lookup matches upper-cased stored code', () => {
    saveRoomMembership('ABC123', 'tok', 'pid');
    const loaded = loadRoomMembership('abc123');
    expect(loaded).not.toBeNull();
    expect(loaded!.roomCode).toBe('ABC123');
  });

  it('returns null and evicts the record when it is expired', () => {
    jest.useFakeTimers();
    // Save now.
    jest.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    saveRoomMembership('EXPIRE', 'tok', 'pid');

    // Advance time past the TTL.
    jest.advanceTimersByTime(MEMBERSHIP_TTL_MS + 1);

    const loaded = loadRoomMembership('EXPIRE');
    expect(loaded).toBeNull();

    // The key should also have been removed from storage.
    expect(window.localStorage.getItem('literati_room_EXPIRE')).toBeNull();
  });

  it('returns the record when it is NOT yet expired', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    saveRoomMembership('FRESH', 'tok', 'pid');

    // Advance time to just before expiry.
    jest.advanceTimersByTime(MEMBERSHIP_TTL_MS - 1000);

    const loaded = loadRoomMembership('FRESH');
    expect(loaded).not.toBeNull();
    expect(loaded!.bearerToken).toBe('tok');
  });
});

// ── clearRoomMembership ───────────────────────────────────────────────────────

describe('clearRoomMembership', () => {
  it('removes the specified room record from localStorage', () => {
    saveRoomMembership('ROOM01', 'tok', 'pid');
    clearRoomMembership('ROOM01');
    expect(loadRoomMembership('ROOM01')).toBeNull();
    expect(window.localStorage.getItem('literati_room_ROOM01')).toBeNull();
  });

  it('is case-insensitive', () => {
    saveRoomMembership('ROOM01', 'tok', 'pid');
    clearRoomMembership('room01');
    expect(window.localStorage.getItem('literati_room_ROOM01')).toBeNull();
  });

  it('is safe to call when the record does not exist (no-op)', () => {
    expect(() => clearRoomMembership('NOTHERE')).not.toThrow();
  });

  it('leaves other room records intact', () => {
    saveRoomMembership('ROOM01', 'tokA', 'pidA');
    saveRoomMembership('ROOM02', 'tokB', 'pidB');
    clearRoomMembership('ROOM01');
    expect(loadRoomMembership('ROOM01')).toBeNull();
    expect(loadRoomMembership('ROOM02')).not.toBeNull();
  });

  it('leaves non-room localStorage keys untouched', () => {
    window.localStorage.setItem('some_other_key', 'value');
    saveRoomMembership('ROOM01', 'tok', 'pid');
    clearRoomMembership('ROOM01');
    expect(window.localStorage.getItem('some_other_key')).toBe('value');
  });
});

// ── clearAllRoomMemberships ───────────────────────────────────────────────────

describe('clearAllRoomMemberships', () => {
  it('removes all literati_room_* keys', () => {
    saveRoomMembership('ROOM01', 'tokA', 'pidA');
    saveRoomMembership('ROOM02', 'tokB', 'pidB');
    saveRoomMembership('ROOM03', 'tokC', 'pidC');
    clearAllRoomMemberships();
    expect(loadRoomMembership('ROOM01')).toBeNull();
    expect(loadRoomMembership('ROOM02')).toBeNull();
    expect(loadRoomMembership('ROOM03')).toBeNull();
  });

  it('leaves non-room keys untouched', () => {
    window.localStorage.setItem('literati_guest_session', '{"type":"guest"}');
    window.localStorage.setItem('some_app_key', 'value');
    saveRoomMembership('ROOM01', 'tok', 'pid');
    clearAllRoomMemberships();
    expect(window.localStorage.getItem('literati_guest_session')).toBe('{"type":"guest"}');
    expect(window.localStorage.getItem('some_app_key')).toBe('value');
  });

  it('is safe to call when no room keys are stored', () => {
    expect(() => clearAllRoomMemberships()).not.toThrow();
  });

  it('is safe to call multiple times', () => {
    saveRoomMembership('ROOM01', 'tok', 'pid');
    clearAllRoomMemberships();
    expect(() => clearAllRoomMemberships()).not.toThrow();
  });
});

// ── RoomRole type ─────────────────────────────────────────────────────────────

describe('RoomRole values', () => {
  const roles: RoomRole[] = ['host', 'player', 'spectator'];

  roles.forEach((role) => {
    it(`saves and restores role "${role}" correctly`, () => {
      saveRoomMembership('ROLE01', 'tok', 'pid', role);
      const loaded = loadRoomMembership('ROLE01');
      expect(loaded).not.toBeNull();
      expect(loaded!.role).toBe(role);
    });
  });
});

// ── Storage key format ────────────────────────────────────────────────────────

describe('Storage key format', () => {
  it('uses the literati_room_ prefix', () => {
    saveRoomMembership('FOOBAR', 'tok', 'pid');
    const stored = window.localStorage.getItem('literati_room_FOOBAR');
    expect(stored).not.toBeNull();
  });

  it('does NOT store under a key without the prefix', () => {
    saveRoomMembership('FOOBAR', 'tok', 'pid');
    expect(window.localStorage.getItem('FOOBAR')).toBeNull();
    expect(window.localStorage.getItem('literati_FOOBAR')).toBeNull();
  });
});

// ── Persistence round-trip ────────────────────────────────────────────────────

describe('Persistence round-trip', () => {
  it('data written by saveRoomMembership is immediately readable by loadRoomMembership', () => {
    saveRoomMembership('ROUND1', 'round_token', 'round_pid', 'host');
    const loaded = loadRoomMembership('ROUND1');
    expect(loaded).not.toBeNull();
    expect(loaded!.bearerToken).toBe('round_token');
    expect(loaded!.playerId).toBe('round_pid');
    expect(loaded!.role).toBe('host');
  });

  it('clearRoomMembership makes the record unreadable by loadRoomMembership', () => {
    saveRoomMembership('ROUND2', 'tok', 'pid');
    clearRoomMembership('ROUND2');
    expect(loadRoomMembership('ROUND2')).toBeNull();
  });
});
