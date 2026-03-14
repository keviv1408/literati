'use strict';

/**
 * Unit tests for matchmaking/botFiller.js — balanced bot team assignment.
 *
 * Sub-AC 6.2: Balanced bot team assignment algorithm.
 *
 * Coverage:
 *   A. Empty room          — correct count, equal team split
 *   B. Partial humans      — bots respect human distribution; final teams balanced
 *   C. Full T1 humans      — all bots assigned to T2
 *   D. Full T2 humans      — all bots assigned to T1
 *   E. Mixed distributions — parameterised balance guarantee over all valid inputs
 *   F. Full room           — zero bots when all seats are occupied
 *   G. Seat properties     — seatIndex, playerId format, isBot, displayName
 *   H. Name uniqueness     — no two bots share a display name
 *   I. 8-player rooms      — correct behaviour for the larger variant
 *   J. Edge: non-standard seat layout — balance still achieved when human seat
 *      indices don't match the even=T1 / odd=T2 convention (robustness)
 */

const { fillWithBots, _keyToDisplayName } = require('../matchmaking/botFiller');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a Map<seatIndex, LobbySeat> from a flat descriptor array.
 *
 * @param {Array<{seatIndex: number, teamId: 1|2, playerId?: string}>} seats
 * @returns {Map<number, Object>}
 */
function buildOccupiedMap(seats) {
  const map = new Map();
  for (const seat of seats) {
    map.set(seat.seatIndex, {
      seatIndex:   seat.seatIndex,
      playerId:    seat.playerId ?? `human_${seat.seatIndex}`,
      displayName: `Player ${seat.seatIndex}`,
      avatarId:    null,
      teamId:      seat.teamId,
      isBot:       false,
      isGuest:     false,
    });
  }
  return map;
}

/**
 * Count T1 and T2 bots in the result array.
 *
 * @param {Array<Object>} bots
 * @returns {{ t1: number, t2: number }}
 */
function countTeams(bots) {
  return {
    t1: bots.filter((b) => b.teamId === 1).length,
    t2: bots.filter((b) => b.teamId === 2).length,
  };
}

// ---------------------------------------------------------------------------
// A. Empty room
// ---------------------------------------------------------------------------

describe('A. Empty room', () => {
  it('returns 6 bots for an empty 6-player room', () => {
    const bots = fillWithBots(6, new Map());
    expect(bots).toHaveLength(6);
  });

  it('returns 8 bots for an empty 8-player room', () => {
    const bots = fillWithBots(8, new Map());
    expect(bots).toHaveLength(8);
  });

  it('distributes exactly 3 bots per team for a 6-player empty room', () => {
    const bots = fillWithBots(6, new Map());
    const { t1, t2 } = countTeams(bots);
    expect(t1).toBe(3);
    expect(t2).toBe(3);
  });

  it('distributes exactly 4 bots per team for an 8-player empty room', () => {
    const bots = fillWithBots(8, new Map());
    const { t1, t2 } = countTeams(bots);
    expect(t1).toBe(4);
    expect(t2).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// B. Partial human distribution — bots make up the difference
// ---------------------------------------------------------------------------

describe('B. Partial human distribution', () => {
  it('adds 2 T1 bots + 3 T2 bots when only 1 T1 human is present', () => {
    const occupied = buildOccupiedMap([{ seatIndex: 0, teamId: 1 }]);
    const bots = fillWithBots(6, occupied);
    const { t1, t2 } = countTeams(bots);
    expect(t1).toBe(2); // needs 3 - 1 = 2
    expect(t2).toBe(3); // needs 3 - 0 = 3
    expect(bots).toHaveLength(5);
  });

  it('adds 3 T1 bots + 2 T2 bots when only 1 T2 human is present', () => {
    const occupied = buildOccupiedMap([{ seatIndex: 1, teamId: 2 }]);
    const bots = fillWithBots(6, occupied);
    const { t1, t2 } = countTeams(bots);
    expect(t1).toBe(3);
    expect(t2).toBe(2);
    expect(bots).toHaveLength(5);
  });

  it('adds 1 T1 bot + 2 T2 bots when 2 T1 humans and 1 T2 human are seated', () => {
    // T1 humans at seats 0, 2 (even); T2 human at seat 1 (odd)
    const occupied = buildOccupiedMap([
      { seatIndex: 0, teamId: 1 },
      { seatIndex: 2, teamId: 1 },
      { seatIndex: 1, teamId: 2 },
    ]);
    const bots = fillWithBots(6, occupied);
    const { t1, t2 } = countTeams(bots);
    expect(t1).toBe(1);
    expect(t2).toBe(2);
    expect(bots).toHaveLength(3);
  });

  it('adds 2 T1 bots + 1 T2 bot when 1 T1 human and 2 T2 humans are seated', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 0, teamId: 1 },
      { seatIndex: 1, teamId: 2 },
      { seatIndex: 3, teamId: 2 },
    ]);
    const bots = fillWithBots(6, occupied);
    const { t1, t2 } = countTeams(bots);
    expect(t1).toBe(2);
    expect(t2).toBe(1);
    expect(bots).toHaveLength(3);
  });

  it('final totals equal target when 2 T1 humans and 2 T2 humans are seated', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 0, teamId: 1 },
      { seatIndex: 2, teamId: 1 },
      { seatIndex: 1, teamId: 2 },
      { seatIndex: 3, teamId: 2 },
    ]);
    const bots = fillWithBots(6, occupied);
    const { t1, t2 } = countTeams(bots);
    expect(t1).toBe(1); // 3 - 2 = 1
    expect(t2).toBe(1);
    expect(bots).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// C. All T1 seats filled by humans — all bots must go to T2
// ---------------------------------------------------------------------------

describe('C. T1 fully occupied by humans', () => {
  it('assigns all 3 bots to T2 when T1 has 3 humans (6-player)', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 0, teamId: 1 },
      { seatIndex: 2, teamId: 1 },
      { seatIndex: 4, teamId: 1 },
    ]);
    const bots = fillWithBots(6, occupied);
    const { t1, t2 } = countTeams(bots);
    expect(t1).toBe(0);
    expect(t2).toBe(3);
    expect(bots).toHaveLength(3);
  });

  it('all cross-assigned bots still have valid teamId 2', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 0, teamId: 1 },
      { seatIndex: 2, teamId: 1 },
      { seatIndex: 4, teamId: 1 },
    ]);
    const bots = fillWithBots(6, occupied);
    for (const bot of bots) {
      expect([1, 2]).toContain(bot.teamId);
    }
  });
});

// ---------------------------------------------------------------------------
// D. All T2 seats filled by humans — all bots must go to T1
// ---------------------------------------------------------------------------

describe('D. T2 fully occupied by humans', () => {
  it('assigns all 3 bots to T1 when T2 has 3 humans (6-player)', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 1, teamId: 2 },
      { seatIndex: 3, teamId: 2 },
      { seatIndex: 5, teamId: 2 },
    ]);
    const bots = fillWithBots(6, occupied);
    const { t1, t2 } = countTeams(bots);
    expect(t1).toBe(3);
    expect(t2).toBe(0);
    expect(bots).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// E. Parameterised balance guarantee — all valid human distributions
// ---------------------------------------------------------------------------

describe('E. Balance guarantee — parameterised', () => {
  /**
   * For any valid human distribution (at most playerCount/2 per team),
   * final T1 count + bots on T1 must equal final T2 count + bots on T2 = target.
   *
   * Seat assignment: T1 humans at even indices, T2 humans at odd indices
   * (mirrors buildOccupiedSeats — the normal call path).
   */
  const scenarios6 = [
    [0, 0], [1, 0], [0, 1], [1, 1],
    [2, 0], [0, 2], [2, 1], [1, 2],
    [3, 0], [0, 3], [2, 2], [3, 1], [1, 3],
    [3, 2], [2, 3], [3, 3],
  ];

  test.each(scenarios6)(
    '6-player: humanT1=%i humanT2=%i → each team reaches 3',
    (humanT1, humanT2) => {
      const occupied = new Map();
      for (let i = 0; i < humanT1; i++) {
        const si = i * 2;
        occupied.set(si, { seatIndex: si, teamId: 1, playerId: `h1_${i}`, displayName: `H1${i}`, avatarId: null, isBot: false, isGuest: false });
      }
      for (let i = 0; i < humanT2; i++) {
        const si = i * 2 + 1;
        occupied.set(si, { seatIndex: si, teamId: 2, playerId: `h2_${i}`, displayName: `H2${i}`, avatarId: null, isBot: false, isGuest: false });
      }

      const bots = fillWithBots(6, occupied);
      let totalT1 = humanT1;
      let totalT2 = humanT2;
      for (const bot of bots) {
        if (bot.teamId === 1) totalT1++;
        else totalT2++;
      }
      expect(totalT1).toBe(3);
      expect(totalT2).toBe(3);
    },
  );

  const scenarios8 = [
    [0, 0], [2, 0], [0, 2], [2, 2],
    [4, 0], [0, 4], [3, 1], [1, 3],
    [4, 2], [2, 4], [4, 4],
  ];

  test.each(scenarios8)(
    '8-player: humanT1=%i humanT2=%i → each team reaches 4',
    (humanT1, humanT2) => {
      const occupied = new Map();
      for (let i = 0; i < humanT1; i++) {
        const si = i * 2;
        occupied.set(si, { seatIndex: si, teamId: 1, playerId: `h1_${i}`, displayName: `H1${i}`, avatarId: null, isBot: false, isGuest: false });
      }
      for (let i = 0; i < humanT2; i++) {
        const si = i * 2 + 1;
        occupied.set(si, { seatIndex: si, teamId: 2, playerId: `h2_${i}`, displayName: `H2${i}`, avatarId: null, isBot: false, isGuest: false });
      }

      const bots = fillWithBots(8, occupied);
      let totalT1 = humanT1;
      let totalT2 = humanT2;
      for (const bot of bots) {
        if (bot.teamId === 1) totalT1++;
        else totalT2++;
      }
      expect(totalT1).toBe(4);
      expect(totalT2).toBe(4);
    },
  );
});

// ---------------------------------------------------------------------------
// F. Full room — no bots added
// ---------------------------------------------------------------------------

describe('F. Full room', () => {
  it('returns an empty array when all 6 seats are occupied', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 0, teamId: 1 },
      { seatIndex: 1, teamId: 2 },
      { seatIndex: 2, teamId: 1 },
      { seatIndex: 3, teamId: 2 },
      { seatIndex: 4, teamId: 1 },
      { seatIndex: 5, teamId: 2 },
    ]);
    const bots = fillWithBots(6, occupied);
    expect(bots).toHaveLength(0);
  });

  it('returns an empty array when all 8 seats are occupied', () => {
    const occupied = buildOccupiedMap(
      Array.from({ length: 8 }, (_, i) => ({
        seatIndex: i,
        teamId: /** @type {1|2} */ (i % 2 === 0 ? 1 : 2),
      })),
    );
    const bots = fillWithBots(8, occupied);
    expect(bots).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// G. Seat properties
// ---------------------------------------------------------------------------

describe('G. Seat properties', () => {
  it('all bot seatIndices are within 0..(playerCount-1)', () => {
    const bots = fillWithBots(6, new Map());
    for (const bot of bots) {
      expect(bot.seatIndex).toBeGreaterThanOrEqual(0);
      expect(bot.seatIndex).toBeLessThan(6);
    }
  });

  it('bot seatIndices cover all empty slots exactly', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 0, teamId: 1 },
      { seatIndex: 3, teamId: 2 },
    ]);
    const bots = fillWithBots(6, occupied);
    const botIndices = new Set(bots.map((b) => b.seatIndex));
    // Expect seats 1, 2, 4, 5
    expect(botIndices).toEqual(new Set([1, 2, 4, 5]));
  });

  it('all bot playerIds start with "bot_"', () => {
    const bots = fillWithBots(6, new Map());
    for (const bot of bots) {
      expect(bot.playerId).toMatch(/^bot_/);
    }
  });

  it('all bots have isBot: true', () => {
    const bots = fillWithBots(6, new Map());
    for (const bot of bots) {
      expect(bot.isBot).toBe(true);
    }
  });

  it('all bots have isGuest: false', () => {
    const bots = fillWithBots(6, new Map());
    for (const bot of bots) {
      expect(bot.isGuest).toBe(false);
    }
  });

  it('all bots have avatarId: null', () => {
    const bots = fillWithBots(6, new Map());
    for (const bot of bots) {
      expect(bot.avatarId).toBeNull();
    }
  });

  it('all bots have a non-empty string displayName', () => {
    const bots = fillWithBots(6, new Map());
    for (const bot of bots) {
      expect(typeof bot.displayName).toBe('string');
      expect(bot.displayName.length).toBeGreaterThan(0);
    }
  });

  it('all bot teamIds are 1 or 2', () => {
    const bots = fillWithBots(8, new Map());
    for (const bot of bots) {
      expect([1, 2]).toContain(bot.teamId);
    }
  });
});

// ---------------------------------------------------------------------------
// H. Name uniqueness
// ---------------------------------------------------------------------------

describe('H. Name uniqueness', () => {
  it('all 6 bots have distinct displayNames in a 6-player empty room', () => {
    const bots = fillWithBots(6, new Map());
    const names = bots.map((b) => b.displayName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all 8 bots have distinct displayNames in an 8-player empty room', () => {
    const bots = fillWithBots(8, new Map());
    const names = bots.map((b) => b.displayName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not reuse bot names already present in occupiedSeats', () => {
    // Pre-place a bot with a known name at seat 0
    const existingBotName = 'Admiring Turing';
    const occupied = new Map();
    occupied.set(0, {
      seatIndex:   0,
      playerId:    'bot_existing',
      displayName: existingBotName,
      avatarId:    null,
      teamId:      1,
      isBot:       true,
      isGuest:     false,
    });

    const bots = fillWithBots(6, occupied);
    const names = bots.map((b) => b.displayName);
    expect(names).not.toContain(existingBotName);
  });
});

// ---------------------------------------------------------------------------
// I. 8-player room — specific scenarios
// ---------------------------------------------------------------------------

describe('I. 8-player room', () => {
  it('places 4 T1 bots + 4 T2 bots in an empty 8-player room', () => {
    const bots = fillWithBots(8, new Map());
    const { t1, t2 } = countTeams(bots);
    expect(t1).toBe(4);
    expect(t2).toBe(4);
  });

  it('balances correctly when 2 T1 humans and 2 T2 humans are in an 8-player room', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 0, teamId: 1 },
      { seatIndex: 2, teamId: 1 },
      { seatIndex: 1, teamId: 2 },
      { seatIndex: 3, teamId: 2 },
    ]);
    const bots = fillWithBots(8, occupied);
    const { t1, t2 } = countTeams(bots);
    expect(t1).toBe(2); // 4 - 2 = 2
    expect(t2).toBe(2);
    expect(bots).toHaveLength(4);
  });

  it('assigns all 4 bots to T2 when T1 has 4 humans (8-player)', () => {
    const occupied = buildOccupiedMap([
      { seatIndex: 0, teamId: 1 },
      { seatIndex: 2, teamId: 1 },
      { seatIndex: 4, teamId: 1 },
      { seatIndex: 6, teamId: 1 },
    ]);
    const bots = fillWithBots(8, occupied);
    const { t1, t2 } = countTeams(bots);
    expect(t1).toBe(0);
    expect(t2).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// J. Robustness — non-standard seat layout
// ---------------------------------------------------------------------------

describe('J. Balance with non-standard seat layouts (robustness)', () => {
  /**
   * When humans occupy seats that break the even=T1 / odd=T2 convention
   * (e.g. T1 players at odd seats), the algorithm must still produce
   * balanced teams in the final game — this tests the explicit deficit
   * calculation rather than the implicit parity assumption.
   */

  it('balances when 2 T1 humans are at odd seats 1 and 3', () => {
    // Non-standard: T1 humans placed at odd seats
    const occupied = buildOccupiedMap([
      { seatIndex: 1, teamId: 1 },
      { seatIndex: 3, teamId: 1 },
    ]);
    const bots = fillWithBots(6, occupied);
    // Total must be 3 per team
    let totalT1 = 2; // 2 humans on T1
    let totalT2 = 0;
    for (const bot of bots) {
      if (bot.teamId === 1) totalT1++;
      else totalT2++;
    }
    expect(totalT1).toBe(3);
    expect(totalT2).toBe(3);
  });

  it('balances when 3 T2 humans are at even seats 0, 2, 4', () => {
    // Non-standard: T2 humans placed at even seats
    const occupied = buildOccupiedMap([
      { seatIndex: 0, teamId: 2 },
      { seatIndex: 2, teamId: 2 },
      { seatIndex: 4, teamId: 2 },
    ]);
    const bots = fillWithBots(6, occupied);
    let totalT1 = 0;
    let totalT2 = 3;
    for (const bot of bots) {
      if (bot.teamId === 1) totalT1++;
      else totalT2++;
    }
    expect(totalT1).toBe(3);
    expect(totalT2).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// _keyToDisplayName (exported helper)
// ---------------------------------------------------------------------------

describe('_keyToDisplayName', () => {
  it('capitalises the first letter of each word', () => {
    expect(_keyToDisplayName('quirky_turing')).toBe('Quirky Turing');
  });

  it('handles a single-segment key without crashing', () => {
    expect(_keyToDisplayName('brave')).toBe('Brave');
  });

  it('lowercases the rest of each word', () => {
    expect(_keyToDisplayName('ADMIRING_LOVELACE')).toBe('Admiring Lovelace');
  });
});
