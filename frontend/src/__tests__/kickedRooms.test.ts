/**
 * Unit tests for the kicked-rooms localStorage utility.
 *
 * Covers:
 *   • getKickedRooms / isKickedFromRoom / addKickedRoom / removeKickedRoom / clearKickedRooms
 *   • Case-insensitive handling (always uppercases codes)
 *   • Idempotent adds
 *   • Graceful handling of corrupt localStorage data
 *   • SSR-safe (window === undefined) paths are exercised indirectly since
 *     jsdom always provides window — the guard is present for completeness.
 */

import {
  addKickedRoom,
  clearKickedRooms,
  getKickedRooms,
  isKickedFromRoom,
  removeKickedRoom,
} from '@/lib/kickedRooms';

// ── Setup: clear localStorage before every test ──────────────────────────────

beforeEach(() => {
  window.localStorage.clear();
});

// ── getKickedRooms ────────────────────────────────────────────────────────────

describe('getKickedRooms', () => {
  it('returns an empty array when nothing is stored', () => {
    expect(getKickedRooms()).toEqual([]);
  });

  it('returns the stored array of codes after additions', () => {
    addKickedRoom('ABC123');
    addKickedRoom('XYZ999');
    const rooms = getKickedRooms();
    expect(rooms).toContain('ABC123');
    expect(rooms).toContain('XYZ999');
    expect(rooms).toHaveLength(2);
  });

  it('returns an empty array when localStorage contains invalid JSON', () => {
    window.localStorage.setItem('literati_kicked_rooms', 'not-json');
    expect(getKickedRooms()).toEqual([]);
  });

  it('returns an empty array when stored value is not an array', () => {
    window.localStorage.setItem(
      'literati_kicked_rooms',
      JSON.stringify({ foo: 'bar' })
    );
    expect(getKickedRooms()).toEqual([]);
  });
});

// ── isKickedFromRoom ──────────────────────────────────────────────────────────

describe('isKickedFromRoom', () => {
  it('returns false when the code is not in the list', () => {
    expect(isKickedFromRoom('ABC123')).toBe(false);
  });

  it('returns true after the code has been added', () => {
    addKickedRoom('ABC123');
    expect(isKickedFromRoom('ABC123')).toBe(true);
  });

  it('is case-insensitive — lower-case query matches upper-case stored code', () => {
    addKickedRoom('ABC123');
    expect(isKickedFromRoom('abc123')).toBe(true);
  });

  it('is case-insensitive — lower-case add is found by upper-case query', () => {
    addKickedRoom('abc123');
    expect(isKickedFromRoom('ABC123')).toBe(true);
  });

  it('does not confuse similar-looking codes', () => {
    addKickedRoom('ABC123');
    expect(isKickedFromRoom('ABC124')).toBe(false);
  });
});

// ── addKickedRoom ─────────────────────────────────────────────────────────────

describe('addKickedRoom', () => {
  it('persists the upper-cased room code to localStorage', () => {
    addKickedRoom('abc123');
    expect(isKickedFromRoom('ABC123')).toBe(true);
  });

  it('is idempotent — adding the same code twice stores it only once', () => {
    addKickedRoom('ABC123');
    addKickedRoom('ABC123');
    expect(getKickedRooms()).toHaveLength(1);
  });

  it('idempotency is case-insensitive', () => {
    addKickedRoom('abc123');
    addKickedRoom('ABC123');
    expect(getKickedRooms()).toHaveLength(1);
  });

  it('can accumulate multiple distinct codes', () => {
    addKickedRoom('AAA000');
    addKickedRoom('BBB111');
    addKickedRoom('CCC222');
    expect(getKickedRooms()).toHaveLength(3);
  });
});

// ── removeKickedRoom ──────────────────────────────────────────────────────────

describe('removeKickedRoom', () => {
  it('removes the specified code from the list', () => {
    addKickedRoom('ABC123');
    removeKickedRoom('ABC123');
    expect(isKickedFromRoom('ABC123')).toBe(false);
  });

  it('is case-insensitive when removing', () => {
    addKickedRoom('ABC123');
    removeKickedRoom('abc123');
    expect(isKickedFromRoom('ABC123')).toBe(false);
  });

  it('leaves other codes intact', () => {
    addKickedRoom('AAA000');
    addKickedRoom('BBB111');
    removeKickedRoom('AAA000');
    expect(isKickedFromRoom('BBB111')).toBe(true);
    expect(getKickedRooms()).toHaveLength(1);
  });

  it('is safe to call when the code is not present (no-op)', () => {
    expect(() => removeKickedRoom('NOTEXIST')).not.toThrow();
    expect(getKickedRooms()).toHaveLength(0);
  });
});

// ── clearKickedRooms ──────────────────────────────────────────────────────────

describe('clearKickedRooms', () => {
  it('removes all kicked room codes', () => {
    addKickedRoom('AAA000');
    addKickedRoom('BBB111');
    clearKickedRooms();
    expect(getKickedRooms()).toEqual([]);
  });

  it('is safe to call when the list is already empty', () => {
    expect(() => clearKickedRooms()).not.toThrow();
  });

  it('leaves other localStorage keys untouched', () => {
    window.localStorage.setItem('some_other_key', 'value');
    addKickedRoom('ABC123');
    clearKickedRooms();
    expect(window.localStorage.getItem('some_other_key')).toBe('value');
  });
});

// ── Persistence ───────────────────────────────────────────────────────────────

describe('localStorage persistence', () => {
  it('data written by addKickedRoom can be read back by getKickedRooms', () => {
    addKickedRoom('PER123');
    // Simulate a "fresh" call that reads from storage
    const rooms = getKickedRooms();
    expect(rooms).toContain('PER123');
  });

  it('stores data under the key literati_kicked_rooms', () => {
    addKickedRoom('ABC123');
    const raw = window.localStorage.getItem('literati_kicked_rooms');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toContain('ABC123');
  });
});
