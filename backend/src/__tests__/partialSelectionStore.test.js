'use strict';

/**
 * Unit tests for partialSelectionStore.js
 *
 * Covers the full public API:
 *   setPartialSelection, getPartialSelection, clearPartialSelection,
 *   clearRoomPartialSelections, _clearAll, _partialSelections (raw store)
 */

const {
  setPartialSelection,
  getPartialSelection,
  clearPartialSelection,
  clearRoomPartialSelections,
  _clearAll,
  _partialSelections,
} = require('../game/partialSelectionStore');

beforeEach(() => {
  _clearAll();
});

// ---------------------------------------------------------------------------
// setPartialSelection / getPartialSelection
// ---------------------------------------------------------------------------

describe('setPartialSelection + getPartialSelection', () => {
  test('stores and retrieves an ask-step-2 partial (half-suit only)', () => {
    const partial = { flow: 'ask', halfSuitId: 'low_s' };
    setPartialSelection('ROOM1', 'player-A', partial);
    expect(getPartialSelection('ROOM1', 'player-A')).toEqual(partial);
  });

  test('stores and retrieves an ask-step-3 partial (half-suit + card)', () => {
    const partial = { flow: 'ask', halfSuitId: 'high_h', cardId: 'Ah' };
    setPartialSelection('ROOM1', 'player-B', partial);
    expect(getPartialSelection('ROOM1', 'player-B')).toEqual(partial);
  });

  test('stores and retrieves a declare partial (half-suit + assignment)', () => {
    const assignment = { '2s': 'player-A', '3s': 'player-B', '4s': 'player-C' };
    const partial = { flow: 'declare', halfSuitId: 'low_s', assignment };
    setPartialSelection('ROOM2', 'player-C', partial);
    expect(getPartialSelection('ROOM2', 'player-C')).toEqual(partial);
  });

  test('returns null when no partial is stored', () => {
    expect(getPartialSelection('ROOM1', 'nobody')).toBeNull();
  });

  test('overwrites an existing partial with a newer one', () => {
    setPartialSelection('ROOM1', 'player-A', { flow: 'ask', halfSuitId: 'low_s' });
    const updated = { flow: 'ask', halfSuitId: 'low_s', cardId: '3s' };
    setPartialSelection('ROOM1', 'player-A', updated);
    expect(getPartialSelection('ROOM1', 'player-A')).toEqual(updated);
  });

  test('room codes are case-insensitive (normalised to upper)', () => {
    const partial = { flow: 'ask', halfSuitId: 'low_c' };
    setPartialSelection('abc', 'player-X', partial);
    // Retrieve with mixed case — should still match
    expect(getPartialSelection('ABC', 'player-X')).toEqual(partial);
    expect(getPartialSelection('Abc', 'player-X')).toEqual(partial);
  });

  test('different rooms are isolated — same player, different rooms', () => {
    setPartialSelection('ROOM1', 'player-A', { flow: 'ask', halfSuitId: 'low_s' });
    setPartialSelection('ROOM2', 'player-A', { flow: 'declare', halfSuitId: 'high_d' });
    expect(getPartialSelection('ROOM1', 'player-A')).toMatchObject({ halfSuitId: 'low_s' });
    expect(getPartialSelection('ROOM2', 'player-A')).toMatchObject({ halfSuitId: 'high_d' });
  });

  test('different players in same room are isolated', () => {
    setPartialSelection('ROOM1', 'player-A', { flow: 'ask', halfSuitId: 'low_s' });
    setPartialSelection('ROOM1', 'player-B', { flow: 'ask', halfSuitId: 'high_h' });
    expect(getPartialSelection('ROOM1', 'player-A')).toMatchObject({ halfSuitId: 'low_s' });
    expect(getPartialSelection('ROOM1', 'player-B')).toMatchObject({ halfSuitId: 'high_h' });
  });
});

// ---------------------------------------------------------------------------
// clearPartialSelection
// ---------------------------------------------------------------------------

describe('clearPartialSelection', () => {
  test('removes the stored partial for a player', () => {
    setPartialSelection('ROOM1', 'player-A', { flow: 'ask', halfSuitId: 'low_s' });
    clearPartialSelection('ROOM1', 'player-A');
    expect(getPartialSelection('ROOM1', 'player-A')).toBeNull();
  });

  test('is a no-op when no partial exists for that player', () => {
    // Should not throw
    expect(() => clearPartialSelection('ROOM1', 'ghost')).not.toThrow();
    expect(getPartialSelection('ROOM1', 'ghost')).toBeNull();
  });

  test('does not remove other players in the same room', () => {
    setPartialSelection('ROOM1', 'player-A', { flow: 'ask', halfSuitId: 'low_s' });
    setPartialSelection('ROOM1', 'player-B', { flow: 'ask', halfSuitId: 'high_h' });
    clearPartialSelection('ROOM1', 'player-A');
    expect(getPartialSelection('ROOM1', 'player-A')).toBeNull();
    expect(getPartialSelection('ROOM1', 'player-B')).not.toBeNull();
  });

  test('does not remove the same player in a different room', () => {
    setPartialSelection('ROOM1', 'player-A', { flow: 'ask', halfSuitId: 'low_s' });
    setPartialSelection('ROOM2', 'player-A', { flow: 'declare', halfSuitId: 'high_d' });
    clearPartialSelection('ROOM1', 'player-A');
    expect(getPartialSelection('ROOM1', 'player-A')).toBeNull();
    expect(getPartialSelection('ROOM2', 'player-A')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// clearRoomPartialSelections
// ---------------------------------------------------------------------------

describe('clearRoomPartialSelections', () => {
  beforeEach(() => {
    // Populate two rooms with multiple players
    setPartialSelection('ROOM1', 'p1', { flow: 'ask', halfSuitId: 'low_s' });
    setPartialSelection('ROOM1', 'p2', { flow: 'declare', halfSuitId: 'high_h' });
    setPartialSelection('ROOM1', 'p3', { flow: 'ask', halfSuitId: 'low_c' });
    setPartialSelection('ROOM2', 'p1', { flow: 'ask', halfSuitId: 'high_d' });
    setPartialSelection('ROOM2', 'p4', { flow: 'declare', halfSuitId: 'low_d' });
  });

  test('removes all entries for the target room', () => {
    clearRoomPartialSelections('ROOM1');
    expect(getPartialSelection('ROOM1', 'p1')).toBeNull();
    expect(getPartialSelection('ROOM1', 'p2')).toBeNull();
    expect(getPartialSelection('ROOM1', 'p3')).toBeNull();
  });

  test('does not affect other rooms', () => {
    clearRoomPartialSelections('ROOM1');
    expect(getPartialSelection('ROOM2', 'p1')).not.toBeNull();
    expect(getPartialSelection('ROOM2', 'p4')).not.toBeNull();
  });

  test('is a no-op when the room has no entries', () => {
    expect(() => clearRoomPartialSelections('EMPTY_ROOM')).not.toThrow();
  });

  test('room code is normalised to uppercase for prefix matching', () => {
    // Insert with lower case; clear with upper
    setPartialSelection('testroom', 'px', { flow: 'ask', halfSuitId: 'low_s' });
    clearRoomPartialSelections('TESTROOM');
    expect(getPartialSelection('TESTROOM', 'px')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// _clearAll (test helper)
// ---------------------------------------------------------------------------

describe('_clearAll', () => {
  test('removes every entry across all rooms', () => {
    setPartialSelection('R1', 'p1', { flow: 'ask', halfSuitId: 'low_s' });
    setPartialSelection('R2', 'p2', { flow: 'declare', halfSuitId: 'high_h' });
    _clearAll();
    expect(getPartialSelection('R1', 'p1')).toBeNull();
    expect(getPartialSelection('R2', 'p2')).toBeNull();
  });

  test('leaves the store empty (size 0)', () => {
    setPartialSelection('R1', 'p1', { flow: 'ask', halfSuitId: 'low_s' });
    _clearAll();
    expect(_partialSelections.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// _partialSelections (raw store reference)
// ---------------------------------------------------------------------------

describe('_partialSelections (raw Map reference)', () => {
  test('is the same Map instance that back the public API', () => {
    setPartialSelection('ROOM1', 'p1', { flow: 'ask', halfSuitId: 'low_s' });
    // The raw store should contain exactly 1 entry
    expect(_partialSelections.size).toBe(1);
    const key = 'ROOM1:p1';
    expect(_partialSelections.has(key)).toBe(true);
    expect(_partialSelections.get(key)).toEqual({ flow: 'ask', halfSuitId: 'low_s' });
  });

  test('reflects clearPartialSelection immediately', () => {
    setPartialSelection('ROOM1', 'p1', { flow: 'ask', halfSuitId: 'low_s' });
    clearPartialSelection('ROOM1', 'p1');
    expect(_partialSelections.size).toBe(0);
  });

  test('reflects clearRoomPartialSelections immediately', () => {
    setPartialSelection('ROOM1', 'p1', { flow: 'ask', halfSuitId: 'low_s' });
    setPartialSelection('ROOM1', 'p2', { flow: 'declare', halfSuitId: 'high_h' });
    setPartialSelection('ROOM2', 'p3', { flow: 'ask', halfSuitId: 'low_c' });
    clearRoomPartialSelections('ROOM1');
    expect(_partialSelections.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Overwrite-on-progress scenario (simulates wizard progression)
// ---------------------------------------------------------------------------

describe('wizard progression scenario', () => {
  test('ask flow: step 2 → step 3 overwrites correctly', () => {
    // Player enters step 2 (picked half-suit)
    setPartialSelection('GAME', 'human-1', { flow: 'ask', halfSuitId: 'low_s' });
    expect(getPartialSelection('GAME', 'human-1')).toEqual({ flow: 'ask', halfSuitId: 'low_s' });

    // Player picks a card (step 3)
    setPartialSelection('GAME', 'human-1', { flow: 'ask', halfSuitId: 'low_s', cardId: '3s' });
    expect(getPartialSelection('GAME', 'human-1')).toEqual({ flow: 'ask', halfSuitId: 'low_s', cardId: '3s' });
  });

  test('declare flow: partial assignment updated on each card assignment', () => {
    const assign1 = { '2s': 'p1' };
    setPartialSelection('GAME', 'human-1', { flow: 'declare', halfSuitId: 'low_s', assignment: assign1 });

    const assign2 = { '2s': 'p1', '3s': 'p2' };
    setPartialSelection('GAME', 'human-1', { flow: 'declare', halfSuitId: 'low_s', assignment: assign2 });

    expect(getPartialSelection('GAME', 'human-1')).toMatchObject({ assignment: assign2 });
  });

  test('cleared after successful move submission', () => {
    setPartialSelection('GAME', 'human-1', { flow: 'ask', halfSuitId: 'low_s', cardId: '3s' });
    // Simulate successful ask
    clearPartialSelection('GAME', 'human-1');
    expect(getPartialSelection('GAME', 'human-1')).toBeNull();
  });
});
