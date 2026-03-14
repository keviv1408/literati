'use strict';

/**
 * Sub-AC 25a — Server-side declaration correctness validation
 *
 * Tests that applyDeclaration() correctly:
 *   1. Awards the half-suit point to the declaring team when every card is
 *      assigned to the player who actually holds it.
 *   2. Awards the half-suit point to the OPPOSING team when any card is
 *      assigned to the wrong player — including a wrong player on the same team.
 *   3. Records the correct/incorrect status in moveHistory.
 *   4. Works correctly for all three variants (remove_2s, remove_7s, remove_8s).
 *   5. Handles the tiebreaker (high_d) for each variant.
 */

const { applyDeclaration } = require('../game/gameEngine');
const { buildHalfSuitMap } = require('../game/halfSuits');

// ---------------------------------------------------------------------------
// Helper: build a minimal 6-player game state for declaration tests
// ---------------------------------------------------------------------------

function buildGame(variant = 'remove_7s', extraHandOverrides = {}) {
  const players = [
    { playerId: 'p1', displayName: 'Alice',   avatarId: null, teamId: 1, seatIndex: 0, isBot: false, isGuest: false },
    { playerId: 'p2', displayName: 'Bob',     avatarId: null, teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
    { playerId: 'p3', displayName: 'Carol',   avatarId: null, teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
    { playerId: 'p4', displayName: 'Dave',    avatarId: null, teamId: 2, seatIndex: 1, isBot: false, isGuest: false },
    { playerId: 'p5', displayName: 'Eve',     avatarId: null, teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
    { playerId: 'p6', displayName: 'Frank',   avatarId: null, teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
  ];

  // Build low_s cards for the chosen variant so tests can use them
  const halfSuits = buildHalfSuitMap(variant);
  const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');

  const defaultHands = {
    p1: new Set([c0, c1, c2]),     // team1 — holds first 3 low_s cards
    p2: new Set([c3, c4, c5]),     // team1 — holds last  3 low_s cards
    p3: new Set(),
    p4: new Set(),
    p5: new Set(),
    p6: new Set(),
  };

  const hands = new Map();
  for (const pid of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
    hands.set(pid, extraHandOverrides[pid] !== undefined ? extraHandOverrides[pid] : defaultHands[pid]);
  }

  return {
    roomCode: 'DECL1',
    roomId: 'room-decl',
    variant,
    playerCount: 6,
    status: 'active',
    currentTurnPlayerId: 'p1',
    players,
    hands,
    declaredSuits: new Map(),
    scores: { team1: 0, team2: 0 },
    lastMove: null,
    winner: null,
    tiebreakerWinner: null,
    botKnowledge: new Map(),
    moveHistory: [],
  };
}

/**
 * Build a perfect assignment for a half-suit given the current hands.
 * Iterates over each card and assigns it to whoever holds it.
 */
function buildCorrectAssignment(gs, halfSuitId) {
  const cards = buildHalfSuitMap(gs.variant).get(halfSuitId);
  const assignment = {};
  for (const card of cards) {
    for (const [pid, hand] of gs.hands) {
      if (hand.has(card)) { assignment[card] = pid; break; }
    }
  }
  return assignment;
}

// ---------------------------------------------------------------------------
// 1. Correct declaration → declaring team scores
// ---------------------------------------------------------------------------

describe('applyDeclaration — correct declaration (team 1 declares)', () => {
  it('awards exactly 1 point to team 1 when all 6 cards assigned correctly', () => {
    const gs = buildGame();
    const assignment = buildCorrectAssignment(gs, 'low_s');
    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);

    expect(result.correct).toBe(true);
    expect(result.winningTeam).toBe(1);
    expect(gs.scores.team1).toBe(1);
    expect(gs.scores.team2).toBe(0);
  });

  it('awards exactly 1 point to team 2 when team 2 declares correctly', () => {
    const gs = buildGame();
    // Move all low_s cards to team2 players
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');
    gs.hands.set('p1', new Set());
    gs.hands.set('p2', new Set());
    gs.hands.set('p4', new Set([c0, c1, c2]));
    gs.hands.set('p5', new Set([c3, c4, c5]));
    gs.currentTurnPlayerId = 'p4';

    const assignment = buildCorrectAssignment(gs, 'low_s');
    const result = applyDeclaration(gs, 'p4', 'low_s', assignment);

    expect(result.correct).toBe(true);
    expect(result.winningTeam).toBe(2);
    expect(gs.scores.team2).toBe(1);
    expect(gs.scores.team1).toBe(0);
  });

  it('marks result.correct === true and move history correct:true', () => {
    const gs = buildGame();
    const assignment = buildCorrectAssignment(gs, 'low_s');
    applyDeclaration(gs, 'p1', 'low_s', assignment);

    const entry = gs.moveHistory[gs.moveHistory.length - 1];
    expect(entry.correct).toBe(true);
  });

  it('removes all 6 half-suit cards from all hands after correct declaration', () => {
    const gs = buildGame();
    const halfSuits = buildHalfSuitMap('remove_7s');
    const lowSCards = halfSuits.get('low_s');
    const assignment = buildCorrectAssignment(gs, 'low_s');
    applyDeclaration(gs, 'p1', 'low_s', assignment);

    for (const [, hand] of gs.hands) {
      for (const card of lowSCards) {
        expect(hand.has(card)).toBe(false);
      }
    }
  });

  it('marks declaredSuits with the declaring team on correct declaration', () => {
    const gs = buildGame();
    const assignment = buildCorrectAssignment(gs, 'low_s');
    applyDeclaration(gs, 'p1', 'low_s', assignment);

    expect(gs.declaredSuits.has('low_s')).toBe(true);
    expect(gs.declaredSuits.get('low_s').teamId).toBe(1);
    expect(gs.declaredSuits.get('low_s').declaredBy).toBe('p1');
  });
});

// ---------------------------------------------------------------------------
// 2. Wrong player within same team → opposing team scores
// ---------------------------------------------------------------------------

describe('applyDeclaration — wrong player within own team → opposing team scores', () => {
  it('awards point to team 2 when team 1 swaps two teammates within their own team', () => {
    const gs = buildGame();
    // p1 holds c0,c1,c2 and p2 holds c3,c4,c5 — swap their assignments
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');

    // Swap: assign p1's cards to p2 and p2's cards to p1
    const swappedAssignment = {
      [c0]: 'p2', [c1]: 'p2', [c2]: 'p2',   // wrong: p1 holds these
      [c3]: 'p1', [c4]: 'p1', [c5]: 'p1',   // wrong: p2 holds these
    };

    const result = applyDeclaration(gs, 'p1', 'low_s', swappedAssignment);

    expect(result.correct).toBe(false);
    expect(result.winningTeam).toBe(2);
    expect(gs.scores.team2).toBe(1);
    expect(gs.scores.team1).toBe(0);
  });

  it('awards point to team 2 when only ONE card is mis-assigned within team 1', () => {
    const gs = buildGame();
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');

    // Assign 5 cards correctly but give p1's c0 to p2
    const oneWrong = {
      [c0]: 'p2',  // wrong: p1 holds c0
      [c1]: 'p1',
      [c2]: 'p1',
      [c3]: 'p2',
      [c4]: 'p2',
      [c5]: 'p2',
    };

    const result = applyDeclaration(gs, 'p1', 'low_s', oneWrong);

    expect(result.correct).toBe(false);
    expect(result.winningTeam).toBe(2);
    expect(gs.scores.team2).toBe(1);
    expect(gs.scores.team1).toBe(0);
  });

  it('marks result.correct === false and move history correct:false', () => {
    const gs = buildGame();
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');
    const swappedAssignment = {
      [c0]: 'p2', [c1]: 'p2', [c2]: 'p2',
      [c3]: 'p1', [c4]: 'p1', [c5]: 'p1',
    };

    const result = applyDeclaration(gs, 'p1', 'low_s', swappedAssignment);

    expect(result.correct).toBe(false);
    const entry = gs.moveHistory[gs.moveHistory.length - 1];
    expect(entry.correct).toBe(false);
    expect(entry.winningTeam).toBe(2);
  });

  it('even a fully wrong assignment (all 6 to wrong teammates) awards only 1 point', () => {
    const gs = buildGame();
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');
    // Assign all to p3 (who holds none)
    const allWrong = {
      [c0]: 'p3', [c1]: 'p3', [c2]: 'p3',
      [c3]: 'p3', [c4]: 'p3', [c5]: 'p3',
    };

    const result = applyDeclaration(gs, 'p1', 'low_s', allWrong);

    expect(result.correct).toBe(false);
    expect(gs.scores.team2).toBe(1);
    expect(gs.scores.team1).toBe(0);
    // Only 1 point awarded total, not 6
    expect(gs.scores.team1 + gs.scores.team2).toBe(1);
  });

  it('still removes all 6 half-suit cards even on incorrect declaration', () => {
    const gs = buildGame();
    const halfSuits = buildHalfSuitMap('remove_7s');
    const lowSCards = halfSuits.get('low_s');
    const [c0, c1, c2, c3, c4, c5] = lowSCards;
    const swappedAssignment = {
      [c0]: 'p2', [c1]: 'p2', [c2]: 'p2',
      [c3]: 'p1', [c4]: 'p1', [c5]: 'p1',
    };
    applyDeclaration(gs, 'p1', 'low_s', swappedAssignment);

    for (const [, hand] of gs.hands) {
      for (const card of lowSCards) {
        expect(hand.has(card)).toBe(false);
      }
    }
  });

  it('marks declaredSuits with the opposing (winning) team on incorrect declaration', () => {
    const gs = buildGame();
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');
    const swappedAssignment = {
      [c0]: 'p2', [c1]: 'p2', [c2]: 'p2',
      [c3]: 'p1', [c4]: 'p1', [c5]: 'p1',
    };
    applyDeclaration(gs, 'p1', 'low_s', swappedAssignment);

    expect(gs.declaredSuits.has('low_s')).toBe(true);
    expect(gs.declaredSuits.get('low_s').teamId).toBe(2);  // opposing team wins
  });

  it('lastMove string says "incorrect" and names the winning team on wrong-within-team', () => {
    const gs = buildGame();
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');
    const swappedAssignment = {
      [c0]: 'p2', [c1]: 'p2', [c2]: 'p2',
      [c3]: 'p1', [c4]: 'p1', [c5]: 'p1',
    };
    const result = applyDeclaration(gs, 'p1', 'low_s', swappedAssignment);

    expect(result.lastMove).toMatch(/incorrect/i);
    expect(result.lastMove).toMatch(/team 2/i);
  });
});

// ---------------------------------------------------------------------------
// 3. All 3 variants — low_s half-suit cards differ by variant
// ---------------------------------------------------------------------------

describe('applyDeclaration — variant correctness (low_s half-suit cards per variant)', () => {
  const variants = ['remove_2s', 'remove_7s', 'remove_8s'];

  for (const variant of variants) {
    it(`[${variant}] correct declaration awards point to declaring team`, () => {
      const gs = buildGame(variant);
      const assignment = buildCorrectAssignment(gs, 'low_s');
      const result = applyDeclaration(gs, 'p1', 'low_s', assignment);

      expect(result.correct).toBe(true);
      expect(result.winningTeam).toBe(1);
      expect(gs.scores.team1).toBe(1);
    });

    it(`[${variant}] wrong-player-within-own-team awards point to opposing team`, () => {
      const gs = buildGame(variant);
      const halfSuits = buildHalfSuitMap(variant);
      const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');

      const swapped = {
        [c0]: 'p2', [c1]: 'p2', [c2]: 'p2',
        [c3]: 'p1', [c4]: 'p1', [c5]: 'p1',
      };
      const result = applyDeclaration(gs, 'p1', 'low_s', swapped);

      expect(result.correct).toBe(false);
      expect(result.winningTeam).toBe(2);
      expect(gs.scores.team2).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Tiebreaker half-suit (high_d) for each variant
// ---------------------------------------------------------------------------

describe('applyDeclaration — tiebreaker (high_d) per variant', () => {
  const variants = ['remove_2s', 'remove_7s', 'remove_8s'];

  for (const variant of variants) {
    it(`[${variant}] declaring high_d correctly sets tiebreakerWinner`, () => {
      const halfSuits = buildHalfSuitMap(variant);
      const highDCards = halfSuits.get('high_d');
      const [c0, c1, c2, c3, c4, c5] = highDCards;

      // Build game with team1 holding all high_d cards
      const gs = buildGame(variant, {
        p1: new Set([c0, c1, c2]),
        p2: new Set([c3, c4, c5]),
        p3: new Set(),
        p4: new Set(),
        p5: new Set(),
        p6: new Set(),
      });
      gs.scores = { team1: 4, team2: 4 };  // force a tie

      // Mark 7 other half-suits as declared to get close to game end
      let count = 0;
      for (const [hsId] of halfSuits) {
        if (hsId === 'high_d') continue;
        gs.declaredSuits.set(hsId, { teamId: 1, declaredBy: 'p1' });
        count++;
        if (count === 7) break;
      }

      const assignment = {
        [c0]: 'p1', [c1]: 'p1', [c2]: 'p1',
        [c3]: 'p2', [c4]: 'p2', [c5]: 'p2',
      };
      applyDeclaration(gs, 'p1', 'high_d', assignment);

      expect(gs.tiebreakerWinner).toBe(1);
      expect(gs.status).toBe('completed');
      expect(gs.winner).toBe(1);
    });

    it(`[${variant}] incorrectly declaring high_d awards tiebreaker to opposing team`, () => {
      const halfSuits = buildHalfSuitMap(variant);
      const highDCards = halfSuits.get('high_d');
      const [c0, c1, c2, c3, c4, c5] = highDCards;

      const gs = buildGame(variant, {
        p1: new Set([c0, c1, c2]),
        p2: new Set([c3, c4, c5]),
        p3: new Set(),
        p4: new Set(),
        p5: new Set(),
        p6: new Set(),
      });
      gs.scores = { team1: 4, team2: 4 };

      let count = 0;
      for (const [hsId] of halfSuits) {
        if (hsId === 'high_d') continue;
        gs.declaredSuits.set(hsId, { teamId: 1, declaredBy: 'p1' });
        count++;
        if (count === 7) break;
      }

      // Wrong assignment: swap p1 and p2's cards within team1
      const wrongAssignment = {
        [c0]: 'p2', [c1]: 'p2', [c2]: 'p2',
        [c3]: 'p1', [c4]: 'p1', [c5]: 'p1',
      };
      applyDeclaration(gs, 'p1', 'high_d', wrongAssignment);

      // Wrong declaration → opposing team 2 gets the tiebreaker point
      expect(gs.tiebreakerWinner).toBe(2);
      expect(gs.winner).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Move history correctness fields
// ---------------------------------------------------------------------------

describe('applyDeclaration — moveHistory entry structure', () => {
  it('moveHistory entry includes correct:true, winningTeam, declarerId, halfSuitId, assignment', () => {
    const gs = buildGame();
    const assignment = buildCorrectAssignment(gs, 'low_s');
    applyDeclaration(gs, 'p1', 'low_s', assignment);

    const entry = gs.moveHistory[gs.moveHistory.length - 1];
    expect(entry.type).toBe('declaration');
    expect(entry.declarerId).toBe('p1');
    expect(entry.halfSuitId).toBe('low_s');
    expect(entry.correct).toBe(true);
    expect(entry.winningTeam).toBe(1);
    expect(entry.assignment).toEqual(assignment);
    expect(typeof entry.ts).toBe('number');
  });

  it('moveHistory entry includes correct:false and winningTeam=opposing on wrong-player', () => {
    const gs = buildGame();
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');
    const swapped = {
      [c0]: 'p2', [c1]: 'p2', [c2]: 'p2',
      [c3]: 'p1', [c4]: 'p1', [c5]: 'p1',
    };
    applyDeclaration(gs, 'p1', 'low_s', swapped);

    const entry = gs.moveHistory[gs.moveHistory.length - 1];
    expect(entry.correct).toBe(false);
    expect(entry.winningTeam).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. lastMove string format
// ---------------------------------------------------------------------------

describe('applyDeclaration — lastMove string', () => {
  it('lastMove says "correct" and "Team 1 scores" on correct declaration by team 1', () => {
    const gs = buildGame();
    const assignment = buildCorrectAssignment(gs, 'low_s');
    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);

    expect(result.lastMove).toMatch(/correct/i);
    expect(result.lastMove).toMatch(/team 1/i);
  });

  it('lastMove says "incorrect" and "Team 2 scores" when team 1 mis-assigns within own team', () => {
    const gs = buildGame();
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');
    const swapped = {
      [c0]: 'p2', [c1]: 'p2', [c2]: 'p2',
      [c3]: 'p1', [c4]: 'p1', [c5]: 'p1',
    };
    const result = applyDeclaration(gs, 'p1', 'low_s', swapped);

    expect(result.lastMove).toMatch(/incorrect/i);
    expect(result.lastMove).toMatch(/team 2/i);
  });

  it('lastMove includes the half-suit name (Low Spades for low_s)', () => {
    const gs = buildGame();
    const assignment = buildCorrectAssignment(gs, 'low_s');
    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);

    expect(result.lastMove).toMatch(/low spades/i);
  });
});

// ---------------------------------------------------------------------------
// 7. Score accumulation across multiple declarations
// ---------------------------------------------------------------------------

describe('applyDeclaration — score accumulation', () => {
  it('correctly accumulates scores after multiple declarations by different teams', () => {
    const gs = buildGame();
    // First declaration: team1 correct → team1 = 1
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');
    const correctAssign = buildCorrectAssignment(gs, 'low_s');
    applyDeclaration(gs, 'p1', 'low_s', correctAssign);
    expect(gs.scores.team1).toBe(1);

    // Setup high_s for next declaration: give team2 all high_s cards
    const [h0, h1, h2, h3, h4, h5] = halfSuits.get('high_s');
    gs.hands.set('p4', new Set([h0, h1, h2]));
    gs.hands.set('p5', new Set([h3, h4, h5]));
    gs.currentTurnPlayerId = 'p4';

    // Second declaration: team2 correct → team2 = 1
    const correctHighS = buildCorrectAssignment(gs, 'high_s');
    applyDeclaration(gs, 'p4', 'high_s', correctHighS);
    expect(gs.scores.team2).toBe(1);

    // Final: 1-1 tie — both sides have scored
    expect(gs.scores.team1 + gs.scores.team2).toBe(2);
  });

  it('scores do not go negative when opposing team wins the point', () => {
    const gs = buildGame();
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');
    const wrongAssign = {
      [c0]: 'p2', [c1]: 'p2', [c2]: 'p2',
      [c3]: 'p1', [c4]: 'p1', [c5]: 'p1',
    };
    applyDeclaration(gs, 'p1', 'low_s', wrongAssign);

    expect(gs.scores.team1).toBe(0);
    expect(gs.scores.team2).toBe(1);
    expect(gs.scores.team1).toBeGreaterThanOrEqual(0);
  });
});
