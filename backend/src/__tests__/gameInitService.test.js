'use strict';

/**
 * Unit tests for game/gameInitService.js —
 *
 * Verifies that the game initialization service correctly:
 * 1. Detects empty (unfilled) seat slots at game start.
 * 2. Triggers bot auto-fill for every empty slot.
 * 3. Merges and sorts the final seat array.
 * 4. Delegates game state creation to the provided createGame function.
 *
 * Test sections:
 * A. detectEmptySeats() — pure seat-gap detection
 * B. buildBotSeats() — bot generation for empty slots
 * C. buildGameSeats() — detection + fill + merge pipeline
 * D. initializeGame() — full initialization entry point
 *
 * All external dependencies (createGame) are injected as mocks.
 * No network calls, no Supabase, no WebSocket ports opened.
 */

const {
  detectEmptySeats,
  buildBotSeats,
  buildGameSeats,
  initializeGame,
} = require('../game/gameInitService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal human-occupied seat Map for the given player configuration.
 *
 * @param {Array<{seatIndex: number, playerId: string, teamId: 1|2}>} seats
 * @returns {Map<number, Object>}
 */
function buildOccupiedMap(seats) {
  const m = new Map();
  for (const s of seats) {
    m.set(s.seatIndex, {
      seatIndex:   s.seatIndex,
      playerId:    s.playerId,
      displayName: s.displayName || `Player-${s.seatIndex}`,
      avatarId:    null,
      teamId:      s.teamId,
      isBot:       false,
      isGuest:     false,
    });
  }
  return m;
}

// ---------------------------------------------------------------------------
// A. detectEmptySeats()
// ---------------------------------------------------------------------------

describe('detectEmptySeats()', () => {
  it('returns all indices [0..5] when no seats are occupied (6-player)', () => {
    const empty = detectEmptySeats(6, new Map());
    expect(empty).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('returns all indices [0..7] when no seats are occupied (8-player)', () => {
    const empty = detectEmptySeats(8, new Map());
    expect(empty).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('returns empty array when all 6 seats are occupied', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'p0', teamId: 1 },
      { seatIndex: 1, playerId: 'p1', teamId: 2 },
      { seatIndex: 2, playerId: 'p2', teamId: 1 },
      { seatIndex: 3, playerId: 'p3', teamId: 2 },
      { seatIndex: 4, playerId: 'p4', teamId: 1 },
      { seatIndex: 5, playerId: 'p5', teamId: 2 },
    ]);
    const empty = detectEmptySeats(6, occupied);
    expect(empty).toEqual([]);
  });

  it('returns empty array when all 8 seats are occupied', () => {
    const occupied = buildOccupiedMap(
      Array.from({ length: 8 }, (_, i) => ({
        seatIndex: i,
        playerId:  `p${i}`,
        teamId:    /** @type {1|2} */ (i % 2 === 0 ? 1 : 2),
      }))
    );
    const empty = detectEmptySeats(8, occupied);
    expect(empty).toEqual([]);
  });

  it('detects the single empty seat in a 6-player room with 5 occupied', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'p0', teamId: 1 },
      { seatIndex: 1, playerId: 'p1', teamId: 2 },
      { seatIndex: 2, playerId: 'p2', teamId: 1 },
      { seatIndex: 3, playerId: 'p3', teamId: 2 },
      { seatIndex: 5, playerId: 'p5', teamId: 2 },
    ]);
    const empty = detectEmptySeats(6, occupied);
    expect(empty).toEqual([4]); // seat 4 is the gap
  });

  it('detects multiple gaps correctly', () => {
    // Only seats 0 and 3 occupied → gaps at 1, 2, 4, 5
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'h', teamId: 1 },
      { seatIndex: 3, playerId: 'p', teamId: 2 },
    ]);
    const empty = detectEmptySeats(6, occupied);
    expect(empty).toEqual([1, 2, 4, 5]);
  });

  it('result is always sorted ascending', () => {
    // Gaps at 1, 3, 5 (only even seats occupied)
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'p0', teamId: 1 },
      { seatIndex: 2, playerId: 'p2', teamId: 1 },
      { seatIndex: 4, playerId: 'p4', teamId: 1 },
    ]);
    const empty = detectEmptySeats(6, occupied);
    for (let i = 1; i < empty.length; i++) {
      expect(empty[i]).toBeGreaterThan(empty[i - 1]);
    }
  });

  it('works for a single-seat gap at the beginning (seat 0 empty)', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 1, playerId: 'p1', teamId: 2 },
      { seatIndex: 2, playerId: 'p2', teamId: 1 },
      { seatIndex: 3, playerId: 'p3', teamId: 2 },
      { seatIndex: 4, playerId: 'p4', teamId: 1 },
      { seatIndex: 5, playerId: 'p5', teamId: 2 },
    ]);
    const empty = detectEmptySeats(6, occupied);
    expect(empty).toEqual([0]);
  });

  it('works for a single-seat gap at the end (seat 5 empty)', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'p0', teamId: 1 },
      { seatIndex: 1, playerId: 'p1', teamId: 2 },
      { seatIndex: 2, playerId: 'p2', teamId: 1 },
      { seatIndex: 3, playerId: 'p3', teamId: 2 },
      { seatIndex: 4, playerId: 'p4', teamId: 1 },
    ]);
    const empty = detectEmptySeats(6, occupied);
    expect(empty).toEqual([5]);
  });

  it('returns one slot in 8-player room with 7 occupied', () => {
    const occupied = buildOccupiedMap(
      [0, 1, 2, 3, 4, 5, 7].map((i) => ({
        seatIndex: i,
        playerId:  `p${i}`,
        teamId:    /** @type {1|2} */ (i % 2 === 0 ? 1 : 2),
      }))
    );
    const empty = detectEmptySeats(8, occupied);
    expect(empty).toEqual([6]);
  });
});

// ---------------------------------------------------------------------------
// B. buildBotSeats()
// ---------------------------------------------------------------------------

describe('buildBotSeats()', () => {
  it('returns 6 bots for a completely empty 6-player room', () => {
    const bots = buildBotSeats(6, new Map());
    expect(bots).toHaveLength(6);
  });

  it('returns 8 bots for a completely empty 8-player room', () => {
    const bots = buildBotSeats(8, new Map());
    expect(bots).toHaveLength(8);
  });

  it('returns 0 bots when all seats are occupied', () => {
    const occupied = buildOccupiedMap(
      Array.from({ length: 6 }, (_, i) => ({
        seatIndex: i,
        playerId:  `p${i}`,
        teamId:    /** @type {1|2} */ (i % 2 === 0 ? 1 : 2),
      }))
    );
    const bots = buildBotSeats(6, occupied);
    expect(bots).toHaveLength(0);
  });

  it('returns exactly as many bots as there are empty seats', () => {
    // 2 humans occupy seats 0, 1 → 4 empty seats in 6-player room
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'h', teamId: 1 },
      { seatIndex: 1, playerId: 'p', teamId: 2 },
    ]);
    const bots = buildBotSeats(6, occupied);
    expect(bots).toHaveLength(4);
  });

  it('all returned bot entries have isBot: true', () => {
    const bots = buildBotSeats(6, new Map());
    expect(bots.every((b) => b.isBot === true)).toBe(true);
  });

  it('all bot playerIds start with "bot_"', () => {
    const bots = buildBotSeats(6, new Map());
    for (const bot of bots) {
      expect(bot.playerId).toMatch(/^bot_/);
    }
  });

  it('bot seat indices cover the correct empty slots', () => {
    // Only seat 0 occupied → bots should cover 1, 2, 3, 4, 5
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'host', teamId: 1 },
    ]);
    const bots = buildBotSeats(6, occupied);
    const botIndices = bots.map((b) => b.seatIndex).sort((a, b) => a - b);
    expect(botIndices).toEqual([1, 2, 3, 4, 5]);
  });

  it('bots have non-empty displayNames', () => {
    const bots = buildBotSeats(6, new Map());
    for (const bot of bots) {
      expect(typeof bot.displayName).toBe('string');
      expect(bot.displayName.length).toBeGreaterThan(0);
    }
  });

  it('bot display names use the configured memorable-name format', () => {
    const bots = buildBotSeats(6, new Map());
    for (const bot of bots) {
      expect(bot.displayName).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  it('odd-indexed bot seats are on team 2', () => {
    const bots = buildBotSeats(6, new Map());
    for (const bot of bots) {
      const expectedTeam = bot.seatIndex % 2 === 0 ? 1 : 2;
      expect(bot.teamId).toBe(expectedTeam);
    }
  });

  it('bot display names are unique within a single fill call', () => {
    const bots = buildBotSeats(8, new Map());
    const names = bots.map((b) => b.displayName);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// C. buildGameSeats()
// ---------------------------------------------------------------------------

describe('buildGameSeats()', () => {
  it('returns allSeats with length equal to playerCount', () => {
    const { allSeats } = buildGameSeats(6, new Map());
    expect(allSeats).toHaveLength(6);
  });

  it('allSeats is sorted by seatIndex ascending', () => {
    const { allSeats } = buildGameSeats(6, new Map());
    for (let i = 1; i < allSeats.length; i++) {
      expect(allSeats[i].seatIndex).toBeGreaterThan(allSeats[i - 1].seatIndex);
    }
  });

  it('allSeats covers all indices 0..(playerCount-1)', () => {
    const { allSeats } = buildGameSeats(6, new Map());
    const indices = new Set(allSeats.map((s) => s.seatIndex));
    for (let i = 0; i < 6; i++) {
      expect(indices.has(i)).toBe(true);
    }
  });

  it('allSeats covers all indices 0..7 for 8-player game', () => {
    const { allSeats } = buildGameSeats(8, new Map());
    const indices = new Set(allSeats.map((s) => s.seatIndex));
    for (let i = 0; i < 8; i++) {
      expect(indices.has(i)).toBe(true);
    }
  });

  it('human seats are preserved unchanged in allSeats', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'host-id', teamId: 1, displayName: 'Host' },
      { seatIndex: 1, playerId: 'p2-id',   teamId: 2, displayName: 'P2'   },
    ]);
    const { allSeats } = buildGameSeats(6, occupied);

    const seat0 = allSeats.find((s) => s.seatIndex === 0);
    const seat1 = allSeats.find((s) => s.seatIndex === 1);

    expect(seat0.playerId).toBe('host-id');
    expect(seat0.isBot).toBe(false);
    expect(seat1.playerId).toBe('p2-id');
    expect(seat1.isBot).toBe(false);
  });

  it('bot seats occupy exactly the empty indices', () => {
    // Humans at 0 and 1 → bots at 2, 3, 4, 5
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'h', teamId: 1 },
      { seatIndex: 1, playerId: 'p', teamId: 2 },
    ]);
    const { allSeats } = buildGameSeats(6, occupied);

    for (const seat of allSeats) {
      if (seat.seatIndex <= 1) {
        expect(seat.isBot).toBe(false);
      } else {
        expect(seat.isBot).toBe(true);
      }
    }
  });

  it('botSeats contains only the bot entries', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'h', teamId: 1 },
    ]);
    const { botSeats } = buildGameSeats(6, occupied);
    expect(botSeats.every((s) => s.isBot === true)).toBe(true);
    expect(botSeats).toHaveLength(5);
  });

  it('emptySlots matches the indices not in occupiedSeats', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'h', teamId: 1 },
      { seatIndex: 1, playerId: 'p', teamId: 2 },
    ]);
    const { emptySlots } = buildGameSeats(6, occupied);
    expect(emptySlots).toEqual([2, 3, 4, 5]);
  });

  it('emptySlots is empty when all seats are occupied', () => {
    const occupied = buildOccupiedMap(
      Array.from({ length: 6 }, (_, i) => ({
        seatIndex: i,
        playerId:  `p${i}`,
        teamId:    /** @type {1|2} */ (i % 2 === 0 ? 1 : 2),
      }))
    );
    const { emptySlots, botSeats, allSeats } = buildGameSeats(6, occupied);
    expect(emptySlots).toEqual([]);
    expect(botSeats).toHaveLength(0);
    expect(allSeats.every((s) => !s.isBot)).toBe(true);
  });

  it('works for a solo host in a 6-player room (5 bots needed)', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'host', teamId: 1 },
    ]);
    const { allSeats, botSeats, emptySlots } = buildGameSeats(6, occupied);
    expect(allSeats).toHaveLength(6);
    expect(botSeats).toHaveLength(5);
    expect(emptySlots).toEqual([1, 2, 3, 4, 5]);
  });

  it('works for a solo host in an 8-player room (7 bots needed)', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'host', teamId: 1 },
    ]);
    const { allSeats, botSeats, emptySlots } = buildGameSeats(8, occupied);
    expect(allSeats).toHaveLength(8);
    expect(botSeats).toHaveLength(7);
    expect(emptySlots).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('team parity is consistent: T1 at even indices, T2 at odd indices', () => {
    const { allSeats } = buildGameSeats(6, new Map());
    for (const seat of allSeats) {
      const expectedTeam = seat.seatIndex % 2 === 0 ? 1 : 2;
      expect(seat.teamId).toBe(expectedTeam);
    }
  });

  it('bot playerIds in botSeats match bot entries in allSeats', () => {
    const { allSeats, botSeats } = buildGameSeats(6, new Map());
    const botIdsInAll = new Set(allSeats.filter((s) => s.isBot).map((s) => s.playerId));
    for (const bot of botSeats) {
      expect(botIdsInAll.has(bot.playerId)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// D. initializeGame()
// ---------------------------------------------------------------------------

describe('initializeGame()', () => {
  const BASE_OPTIONS = {
    roomCode:    'INIT01',
    roomId:      'room-uuid-init01',
    variant:     'remove_7s',
    playerCount: 6,
  };

  function makeCreateGame(overrides = {}) {
    return jest.fn().mockReturnValue({
      roomCode:            'INIT01',
      status:              'active',
      currentTurnPlayerId: 'host-id',
      players:             [],
      ...overrides,
    });
  }

  it('calls createGame exactly once', () => {
    const createGame = makeCreateGame();
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'host-id', teamId: 1 },
    ]);
    initializeGame({ ...BASE_OPTIONS, occupiedSeats: occupied, createGame });
    expect(createGame).toHaveBeenCalledTimes(1);
  });

  it('passes roomCode, roomId, variant, and playerCount to createGame', () => {
    const createGame = makeCreateGame();
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'host-id', teamId: 1 },
    ]);
    initializeGame({ ...BASE_OPTIONS, occupiedSeats: occupied, createGame });

    const args = createGame.mock.calls[0][0];
    expect(args.roomCode).toBe('INIT01');
    expect(args.roomId).toBe('room-uuid-init01');
    expect(args.variant).toBe('remove_7s');
    expect(args.playerCount).toBe(6);
  });

  it('passes the full seat array (human + bots) to createGame', () => {
    const createGame = makeCreateGame();
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'host-id', teamId: 1 },
    ]);
    initializeGame({ ...BASE_OPTIONS, occupiedSeats: occupied, createGame });

    const { seats } = createGame.mock.calls[0][0];
    expect(seats).toHaveLength(6); // 1 human + 5 bots
  });

  it('returns the gameState from createGame', () => {
    const fakeGs    = { status: 'active', roomCode: 'INIT01', players: [] };
    const createGame = jest.fn().mockReturnValue(fakeGs);
    const occupied   = buildOccupiedMap([
      { seatIndex: 0, playerId: 'host-id', teamId: 1 },
    ]);
    const result = initializeGame({ ...BASE_OPTIONS, occupiedSeats: occupied, createGame });
    expect(result.gameState).toBe(fakeGs);
  });

  it('returns allSeats, botSeats, and emptySlots in the result', () => {
    const createGame = makeCreateGame();
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'host-id', teamId: 1 },
    ]);
    const { allSeats, botSeats, emptySlots } = initializeGame({
      ...BASE_OPTIONS, occupiedSeats: occupied, createGame,
    });
    expect(Array.isArray(allSeats)).toBe(true);
    expect(Array.isArray(botSeats)).toBe(true);
    expect(Array.isArray(emptySlots)).toBe(true);
  });

  it('emptySlots indicates the 5 unfilled seat indices for a solo-host room', () => {
    const createGame = makeCreateGame();
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'host-id', teamId: 1 },
    ]);
    const { emptySlots } = initializeGame({
      ...BASE_OPTIONS, occupiedSeats: occupied, createGame,
    });
    expect(emptySlots).toEqual([1, 2, 3, 4, 5]);
  });

  it('emptySlots is empty when the room was already full', () => {
    const createGame = makeCreateGame();
    const occupied = buildOccupiedMap(
      Array.from({ length: 6 }, (_, i) => ({
        seatIndex: i,
        playerId:  `p${i}`,
        teamId:    /** @type {1|2} */ (i % 2 === 0 ? 1 : 2),
      }))
    );
    const { emptySlots, botSeats } = initializeGame({
      ...BASE_OPTIONS, occupiedSeats: occupied, createGame,
    });
    expect(emptySlots).toEqual([]);
    expect(botSeats).toHaveLength(0);
  });

  it('seats passed to createGame are sorted by seatIndex', () => {
    const createGame = makeCreateGame();
    const occupied = buildOccupiedMap([
      { seatIndex: 2, playerId: 'h', teamId: 1 },
      { seatIndex: 3, playerId: 'p', teamId: 2 },
    ]);
    initializeGame({ ...BASE_OPTIONS, occupiedSeats: occupied, createGame });

    const { seats } = createGame.mock.calls[0][0];
    for (let i = 1; i < seats.length; i++) {
      expect(seats[i].seatIndex).toBeGreaterThan(seats[i - 1].seatIndex);
    }
  });

  it('re-throws errors from createGame', () => {
    const createGame = jest.fn().mockImplementation(() => {
      throw new Error('deck shuffle failed');
    });
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'host-id', teamId: 1 },
    ]);
    expect(() =>
      initializeGame({ ...BASE_OPTIONS, occupiedSeats: occupied, createGame })
    ).toThrow('deck shuffle failed');
  });

  it('works correctly for an 8-player game', () => {
    const createGame = makeCreateGame();
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'h', teamId: 1 },
      { seatIndex: 1, playerId: 'p', teamId: 2 },
    ]);
    const { allSeats, botSeats, emptySlots } = initializeGame({
      ...BASE_OPTIONS,
      playerCount:  8,
      occupiedSeats: occupied,
      createGame,
    });
    expect(allSeats).toHaveLength(8);
    expect(botSeats).toHaveLength(6);
    expect(emptySlots).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('all bot entries in allSeats have isBot: true', () => {
    const createGame = makeCreateGame();
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'host-id', teamId: 1 },
    ]);
    const { allSeats } = initializeGame({
      ...BASE_OPTIONS, occupiedSeats: occupied, createGame,
    });
    const botSeats = allSeats.filter((s) => s.isBot);
    expect(botSeats).toHaveLength(5);
    for (const bot of botSeats) {
      expect(bot.playerId).toMatch(/^bot_/);
    }
  });

  it('human seat at index 0 is preserved in allSeats', () => {
    const createGame = makeCreateGame();
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'host-id', teamId: 1, displayName: 'Host' },
    ]);
    const { allSeats } = initializeGame({
      ...BASE_OPTIONS, occupiedSeats: occupied, createGame,
    });
    const hostSeat = allSeats.find((s) => s.seatIndex === 0);
    expect(hostSeat.playerId).toBe('host-id');
    expect(hostSeat.isBot).toBe(false);
  });

  it('supports remove_2s variant', () => {
    const createGame = makeCreateGame();
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'h', teamId: 1 },
    ]);
    initializeGame({
      ...BASE_OPTIONS,
      variant:      'remove_2s',
      occupiedSeats: occupied,
      createGame,
    });
    expect(createGame.mock.calls[0][0].variant).toBe('remove_2s');
  });

  it('supports remove_8s variant', () => {
    const createGame = makeCreateGame();
    const occupied = buildOccupiedMap([
      { seatIndex: 0, playerId: 'h', teamId: 1 },
    ]);
    initializeGame({
      ...BASE_OPTIONS,
      variant:      'remove_8s',
      occupiedSeats: occupied,
      createGame,
    });
    expect(createGame.mock.calls[0][0].variant).toBe('remove_8s');
  });
});
