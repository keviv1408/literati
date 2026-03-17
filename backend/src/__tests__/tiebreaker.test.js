'use strict';

/**
 * 4-4 tie-breaking rule
 *
 * The team that declared the high-diamonds half-suit ("high_d") wins any
 * 4-4 tie, regardless of which variant is active (remove_2s, remove_7s,
 * remove_8s). "high_d" always refers to the six highest remaining diamond
 * ranks after the variant's removal is applied.
 *
 * Coverage:
 * 1. TIEBREAKER_HALF_SUIT constant equals "high_d" for all three variants.
 * 2. 4-4 tie: team 1 declared high_d → team 1 wins.
 * 3. 4-4 tie: team 2 declared high_d → team 2 wins.
 * 4. high_d declared early (not last suit) — tiebreakerWinner is set
 * immediately and used when the game later ends 4-4.
 * 5. Incorrect high_d declaration awards tiebreaker to opposing team.
 * 6. Forced-failed (timer-expired) high_d declaration awards tiebreaker
 * to opposing team.
 * 7. Each variant has a distinct high_d card set that correctly contains
 * the "tiebreaker" half-suit cards.
 * 8. Non-tie outcome (5-3, 6-2, …) ignores tiebreakerWinner for winner.
 * 9. tiebreakerWinner survives game-state serialisation round-trip.
 */

const {
  applyDeclaration,
  applyForcedFailedDeclaration,
} = require('../game/gameEngine');
const {
  buildHalfSuitMap,
  TIEBREAKER_HALF_SUIT,
} = require('../game/halfSuits');
const {
  serializePublicState,
  restoreGameState,
} = require('../game/gameState');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal 6-player game state with the given variant. */
function buildGame(variant = 'remove_7s', handOverrides = {}) {
  const players = [
    { playerId: 'p1', displayName: 'Alice', avatarId: null, teamId: 1, seatIndex: 0, isBot: false, isGuest: false },
    { playerId: 'p2', displayName: 'Bob',   avatarId: null, teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
    { playerId: 'p3', displayName: 'Carol', avatarId: null, teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
    { playerId: 'p4', displayName: 'Dave',  avatarId: null, teamId: 2, seatIndex: 1, isBot: false, isGuest: false },
    { playerId: 'p5', displayName: 'Eve',   avatarId: null, teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
    { playerId: 'p6', displayName: 'Frank', avatarId: null, teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
  ];

  const halfSuits = buildHalfSuitMap(variant);
  const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');

  const defaultHands = {
    p1: new Set([c0, c1, c2]),
    p2: new Set([c3, c4, c5]),
    p3: new Set(),
    p4: new Set(),
    p5: new Set(),
    p6: new Set(),
  };

  const hands = new Map();
  for (const pid of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
    hands.set(pid, handOverrides[pid] !== undefined ? handOverrides[pid] : defaultHands[pid]);
  }

  return {
    roomCode: 'TIE01',
    roomId:   'room-tie',
    variant,
    playerCount: 6,
    status: 'active',
    currentTurnPlayerId: 'p1',
    players,
    hands,
    declaredSuits:      new Map(),
    scores:             { team1: 0, team2: 0 },
    lastMove:           null,
    winner:             null,
    tiebreakerWinner:   null,
    botKnowledge:       new Map(),
    moveHistory:        [],
    eliminatedPlayerIds: new Set(),
  };
}

/**
 * Mark all 8 half-suits as declared EXCEPT the ones in `skip`.
 * Adjusts hands so those cards are removed.
 */
function declareAllExcept(gs, skipIds = []) {
  const halfSuits = buildHalfSuitMap(gs.variant);
  for (const [hsId, cards] of halfSuits) {
    if (skipIds.includes(hsId)) continue;
    gs.declaredSuits.set(hsId, { teamId: 1, declaredBy: 'p1' });
    for (const card of cards) {
      for (const [, hand] of gs.hands) hand.delete(card);
    }
  }
}

/**
 * Give all high_d cards to team 1 players (p1 and p2) and return them.
 */
function giveHighDToTeam1(gs) {
  const halfSuits = buildHalfSuitMap(gs.variant);
  const highDCards = halfSuits.get('high_d');
  const [c0, c1, c2, c3, c4, c5] = highDCards;
  // Clear any existing holdings
  for (const [, hand] of gs.hands) {
    for (const card of highDCards) hand.delete(card);
  }
  gs.hands.set('p1', new Set([c0, c1, c2]));
  gs.hands.set('p2', new Set([c3, c4, c5]));
  return { highDCards, c0, c1, c2, c3, c4, c5 };
}

/**
 * Give all high_d cards to team 2 players (p4 and p5) and return them.
 */
function giveHighDToTeam2(gs) {
  const halfSuits = buildHalfSuitMap(gs.variant);
  const highDCards = halfSuits.get('high_d');
  const [c0, c1, c2, c3, c4, c5] = highDCards;
  for (const [, hand] of gs.hands) {
    for (const card of highDCards) hand.delete(card);
  }
  gs.hands.set('p4', new Set([c0, c1, c2]));
  gs.hands.set('p5', new Set([c3, c4, c5]));
  return { highDCards, c0, c1, c2, c3, c4, c5 };
}

// ---------------------------------------------------------------------------
// 1. TIEBREAKER_HALF_SUIT constant
// ---------------------------------------------------------------------------

describe('TIEBREAKER_HALF_SUIT constant', () => {
  it('is "high_d" (the ID is variant-independent)', () => {
    expect(TIEBREAKER_HALF_SUIT).toBe('high_d');
  });

  it('high_d half-suit exists in remove_2s', () => {
    expect(buildHalfSuitMap('remove_2s').has('high_d')).toBe(true);
  });

  it('high_d half-suit exists in remove_7s', () => {
    expect(buildHalfSuitMap('remove_7s').has('high_d')).toBe(true);
  });

  it('high_d half-suit exists in remove_8s', () => {
    expect(buildHalfSuitMap('remove_8s').has('high_d')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. 4-4 tie: team 1 declared high_d → team 1 wins
// ---------------------------------------------------------------------------

describe('4-4 tie: team that declared high_d wins', () => {
  for (const variant of ['remove_2s', 'remove_7s', 'remove_8s']) {
    it(`[${variant}] team 1 declares high_d correctly → winner = 1`, () => {
      const gs = buildGame(variant);
      declareAllExcept(gs, ['high_d']);
      gs.scores = { team1: 4, team2: 4 };
      const { c0, c1, c2, c3, c4, c5 } = giveHighDToTeam1(gs);
      gs.currentTurnPlayerId = 'p1';

      applyDeclaration(gs, 'p1', 'high_d', {
        [c0]: 'p1', [c1]: 'p1', [c2]: 'p1',
        [c3]: 'p2', [c4]: 'p2', [c5]: 'p2',
      });

      expect(gs.status).toBe('completed');
      expect(gs.winner).toBe(1);
      expect(gs.tiebreakerWinner).toBe(1);
    });

    it(`[${variant}] team 2 declares high_d correctly → winner = 2`, () => {
      const gs = buildGame(variant);
      declareAllExcept(gs, ['high_d']);
      gs.scores = { team1: 4, team2: 4 };
      const { c0, c1, c2, c3, c4, c5 } = giveHighDToTeam2(gs);
      gs.currentTurnPlayerId = 'p4';

      applyDeclaration(gs, 'p4', 'high_d', {
        [c0]: 'p4', [c1]: 'p4', [c2]: 'p4',
        [c3]: 'p5', [c4]: 'p5', [c5]: 'p5',
      });

      expect(gs.status).toBe('completed');
      expect(gs.winner).toBe(2);
      expect(gs.tiebreakerWinner).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. high_d declared early (not as last suit)
// ---------------------------------------------------------------------------

describe('high_d declared early — tiebreakerWinner set mid-game', () => {
  it('tiebreakerWinner is set when high_d is declared early and game not yet over', () => {
    const gs = buildGame('remove_7s');
    // Only 1 other suit has been declared; 6 remain after high_d
    gs.declaredSuits.set('low_s', { teamId: 1, declaredBy: 'p1' });
    // Give high_d to team 1
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('high_d');
    for (const [, hand] of gs.hands) {
      for (const card of halfSuits.get('high_d')) hand.delete(card);
      for (const card of halfSuits.get('low_s'))  hand.delete(card);
    }
    gs.hands.set('p1', new Set([c0, c1, c2]));
    gs.hands.set('p2', new Set([c3, c4, c5]));
    gs.scores = { team1: 1, team2: 0 };

    applyDeclaration(gs, 'p1', 'high_d', {
      [c0]: 'p1', [c1]: 'p1', [c2]: 'p1',
      [c3]: 'p2', [c4]: 'p2', [c5]: 'p2',
    });

    // Game is NOT over yet (only 2 of 8 suits declared)
    expect(gs.status).toBe('active');
    expect(gs.tiebreakerWinner).toBe(1); // ← set immediately
    expect(gs.winner).toBeNull();         // ← not determined yet
  });

  it('tiebreakerWinner set early persists to final winner when score ends 4-4', () => {
    // Scenario:
    // 1. Game starts; team 1 correctly declares high_d early (score 1-0).
    // 2. Game continues; 6 more suits are declared (alternating, 3 each) → score 4-3.
    // 3. Team 2 declares the 8th suit correctly → score 4-4.
    // 4. Because tiebreakerWinner was set to 1 when high_d was declared, team 1 wins.

    const gs = buildGame('remove_7s');
    const halfSuits = buildHalfSuitMap('remove_7s');

    // ── Step 1: declare high_d for team 1 ──────────────────────────────
    const highDCards = halfSuits.get('high_d');
    const [hd0, hd1, hd2, hd3, hd4, hd5] = highDCards;
    for (const [, hand] of gs.hands) {
      for (const c of highDCards) hand.delete(c);
    }
    gs.hands.set('p1', new Set([hd0, hd1, hd2]));
    gs.hands.set('p2', new Set([hd3, hd4, hd5]));
    gs.currentTurnPlayerId = 'p1';

    applyDeclaration(gs, 'p1', 'high_d', {
      [hd0]: 'p1', [hd1]: 'p1', [hd2]: 'p1',
      [hd3]: 'p2', [hd4]: 'p2', [hd5]: 'p2',
    });
    // After step 1: score = 1-0, tiebreakerWinner = 1, game still active
    expect(gs.tiebreakerWinner).toBe(1);
    expect(gs.status).toBe('active');
    expect(gs.scores).toEqual({ team1: 1, team2: 0 });

    // ── Step 2: force 6 more suits declared (3 by each team) ───────────
    // Scores after: team1 = 1+3 = 4, team2 = 0+3 = 3
    const allIds = [...halfSuits.keys()].filter(id => id !== 'high_d');
    // Alternate: 3 to team1, 3 to team2, leaving the last 1 for team2
    for (let i = 0; i < 6; i++) {
      const hsId = allIds[i];
      const teamId = i < 3 ? 1 : 2;
      gs.declaredSuits.set(hsId, { teamId, declaredBy: teamId === 1 ? 'p1' : 'p4' });
      for (const card of halfSuits.get(hsId)) {
        for (const [, hand] of gs.hands) hand.delete(card);
      }
    }
    gs.scores = { team1: 4, team2: 3 }; // 1 + 3 = 4 for team1; 3 for team2
    // declaredSuits now has 7 entries (high_d + 6 others)
    expect(gs.declaredSuits.size).toBe(7);

    // ── Step 3: team 2 declares the 8th suit (last one) correctly ──────
    const lastHsId = allIds[6]; // 7th id in allIds (index 6), suits are: high_d + 7 others
    const lastCards = halfSuits.get(lastHsId);
    const [lc0, lc1, lc2, lc3, lc4, lc5] = lastCards;
    for (const [, hand] of gs.hands) {
      for (const c of lastCards) hand.delete(c);
    }
    gs.hands.set('p4', new Set([lc0, lc1, lc2]));
    gs.hands.set('p5', new Set([lc3, lc4, lc5]));
    gs.currentTurnPlayerId = 'p4';

    applyDeclaration(gs, 'p4', lastHsId, {
      [lc0]: 'p4', [lc1]: 'p4', [lc2]: 'p4',
      [lc3]: 'p5', [lc4]: 'p5', [lc5]: 'p5',
    });

    // After step 3: score = 4-4 → tiebreaker applies
    expect(gs.status).toBe('completed');
    expect(gs.scores).toEqual({ team1: 4, team2: 4 });
    expect(gs.tiebreakerWinner).toBe(1); // set when high_d was declared in step 1
    expect(gs.winner).toBe(1);           // team1 wins via tiebreaker
  });
});

// ---------------------------------------------------------------------------
// 4. Incorrect high_d declaration awards tiebreaker to opposing team
// ---------------------------------------------------------------------------

describe('incorrect high_d declaration — tiebreaker goes to opponent', () => {
  for (const variant of ['remove_2s', 'remove_7s', 'remove_8s']) {
    it(`[${variant}] wrong assignment → tiebreakerWinner = opposing team`, () => {
      const gs = buildGame(variant);
      declareAllExcept(gs, ['high_d']);
      gs.scores = { team1: 4, team2: 4 };
      const { c0, c1, c2, c3, c4, c5 } = giveHighDToTeam1(gs);
      gs.currentTurnPlayerId = 'p1';

      // p1 (team1) declares but with a wrong assignment (swap cards between teammates)
      applyDeclaration(gs, 'p1', 'high_d', {
        [c0]: 'p2', [c1]: 'p2', [c2]: 'p2', // actually held by p1
        [c3]: 'p1', [c4]: 'p1', [c5]: 'p1', // actually held by p2
      });

      // Wrong declaration → team2 gets the point AND the tiebreaker
      expect(gs.tiebreakerWinner).toBe(2);
      expect(gs.winner).toBe(2);
      expect(gs.status).toBe('completed');
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Forced-failed (timer-expired) high_d declaration
// ---------------------------------------------------------------------------

describe('forced-failed high_d declaration — tiebreaker goes to opponent', () => {
  for (const variant of ['remove_2s', 'remove_7s', 'remove_8s']) {
    it(`[${variant}] timer expiry during high_d → tiebreakerWinner = opposing team`, () => {
      const gs = buildGame(variant);
      declareAllExcept(gs, ['high_d']);
      gs.scores = { team1: 4, team2: 4 };
      giveHighDToTeam1(gs); // team1 holds high_d
      gs.currentTurnPlayerId = 'p1';

      // p1 (team1) runs out of time
      applyForcedFailedDeclaration(gs, 'p1', 'high_d');

      expect(gs.tiebreakerWinner).toBe(2); // team2 awarded the tiebreaker
      expect(gs.winner).toBe(2);
      expect(gs.status).toBe('completed');
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Per-variant high_d card definitions
// ---------------------------------------------------------------------------

describe('high_d card set per variant', () => {
  it('remove_7s: high_d = [8_d, 9_d, 10_d, 11_d, 12_d, 13_d]', () => {
    const map = buildHalfSuitMap('remove_7s');
    expect(map.get('high_d')).toEqual(['8_d', '9_d', '10_d', '11_d', '12_d', '13_d']);
  });

  it('remove_2s: high_d = [8_d, 9_d, 10_d, 11_d, 12_d, 13_d]', () => {
    const map = buildHalfSuitMap('remove_2s');
    expect(map.get('high_d')).toEqual(['8_d', '9_d', '10_d', '11_d', '12_d', '13_d']);
  });

  it('remove_8s: high_d = [7_d, 9_d, 10_d, 11_d, 12_d, 13_d] (7 replaces 8)', () => {
    const map = buildHalfSuitMap('remove_8s');
    expect(map.get('high_d')).toEqual(['7_d', '9_d', '10_d', '11_d', '12_d', '13_d']);
  });

  it('high_d always has exactly 6 cards in every variant', () => {
    for (const variant of ['remove_2s', 'remove_7s', 'remove_8s']) {
      expect(buildHalfSuitMap(variant).get('high_d')).toHaveLength(6);
    }
  });

  it('high_d always contains 13_d (ace of diamonds equivalent) in all variants', () => {
    for (const variant of ['remove_2s', 'remove_7s', 'remove_8s']) {
      expect(buildHalfSuitMap(variant).get('high_d')).toContain('13_d');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Non-tie outcomes do NOT use tiebreaker for winner
// ---------------------------------------------------------------------------

describe('non-tie outcome: winner determined by score alone', () => {
  it('5-3 score: team1 wins without consulting tiebreakerWinner', () => {
    const gs = buildGame('remove_7s');
    declareAllExcept(gs, ['high_d']);
    gs.scores = { team1: 5, team2: 3 };
    // Give high_d to team2 (they should NOT win since score favors team1)
    const { c0, c1, c2, c3, c4, c5 } = giveHighDToTeam2(gs);
    gs.currentTurnPlayerId = 'p4';

    applyDeclaration(gs, 'p4', 'high_d', {
      [c0]: 'p4', [c1]: 'p4', [c2]: 'p4',
      [c3]: 'p5', [c4]: 'p5', [c5]: 'p5',
    });

    // team2 scores: 5-4 → team1 still wins by score
    expect(gs.scores).toEqual({ team1: 5, team2: 4 });
    expect(gs.winner).toBe(1); // team1 wins 5-4 on score
    expect(gs.tiebreakerWinner).toBe(2); // set, but not used for winner
    expect(gs.status).toBe('completed');
  });

  it('3-5 score: team2 wins regardless of who declared high_d', () => {
    const gs = buildGame('remove_7s');
    declareAllExcept(gs, ['high_d']);
    gs.scores = { team1: 3, team2: 4 };
    // Team1 declares high_d (correctly) for final point → 4-4... wait, that IS a tie.
    // Use 2-5 so after team1 correctly declares: 3-5 → team2 wins
    gs.scores = { team1: 2, team2: 5 };
    const { c0, c1, c2, c3, c4, c5 } = giveHighDToTeam1(gs);
    gs.currentTurnPlayerId = 'p1';

    applyDeclaration(gs, 'p1', 'high_d', {
      [c0]: 'p1', [c1]: 'p1', [c2]: 'p1',
      [c3]: 'p2', [c4]: 'p2', [c5]: 'p2',
    });

    // team1 scores: 3-5 → team2 still wins by score
    expect(gs.scores).toEqual({ team1: 3, team2: 5 });
    expect(gs.winner).toBe(2); // team2 wins 5-3 on score
    expect(gs.tiebreakerWinner).toBe(1); // set, but not consulted
    expect(gs.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 8. tiebreakerWinner survives serialisation round-trip
// ---------------------------------------------------------------------------

describe('tiebreakerWinner in serialisation', () => {
  it('serializePublicState includes tiebreakerWinner = 2', () => {
    const gs = buildGame('remove_7s');
    gs.tiebreakerWinner = 2;
    const pub = serializePublicState(gs);
    expect(pub.tiebreakerWinner).toBe(2);
  });

  it('serializePublicState includes tiebreakerWinner = 1', () => {
    const gs = buildGame('remove_7s');
    gs.tiebreakerWinner = 1;
    const pub = serializePublicState(gs);
    expect(pub.tiebreakerWinner).toBe(1);
  });

  it('serializePublicState includes tiebreakerWinner = null when not yet set', () => {
    const gs = buildGame('remove_7s');
    const pub = serializePublicState(gs);
    expect(pub.tiebreakerWinner).toBeNull();
  });

  it('restoreGameState preserves tiebreakerWinner = 1 from snapshot', () => {
    // Build a minimal persistence snapshot (as stored in Supabase)
    const gs = buildGame('remove_7s');
    const snapshot = {
      roomCode:    gs.roomCode,
      roomId:      gs.roomId,
      variant:     gs.variant,
      playerCount: gs.playerCount,
      status:      'completed',
      currentTurnPlayerId: 'p1',
      players:     gs.players,
      hands:       Object.fromEntries([...gs.hands].map(([pid, hand]) => [pid, [...hand]])),
      declaredSuits: [],
      scores:      { team1: 4, team2: 4 },
      lastMove:    'Alice declared High Diamonds — correct! Team 1 scores',
      winner:      1,
      tiebreakerWinner: 1,
      moveHistory: [],
      eliminatedPlayerIds: [],
      turnRecipients: {},
    };

    const restored = restoreGameState(snapshot);
    expect(restored.tiebreakerWinner).toBe(1);
    expect(restored.winner).toBe(1);
  });

  it('restoreGameState preserves tiebreakerWinner = null from snapshot', () => {
    const gs = buildGame('remove_7s');
    const snapshot = {
      roomCode:    gs.roomCode,
      roomId:      gs.roomId,
      variant:     gs.variant,
      playerCount: gs.playerCount,
      status:      'active',
      currentTurnPlayerId: 'p1',
      players:     gs.players,
      hands:       Object.fromEntries([...gs.hands].map(([pid, hand]) => [pid, [...hand]])),
      declaredSuits: [],
      scores:      { team1: 0, team2: 0 },
      lastMove:    null,
      winner:      null,
      tiebreakerWinner: null,
      moveHistory: [],
      eliminatedPlayerIds: [],
      turnRecipients: {},
    };

    const restored = restoreGameState(snapshot);
    expect(restored.tiebreakerWinner).toBeNull();
  });
});
