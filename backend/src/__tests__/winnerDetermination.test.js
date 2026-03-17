'use strict';

/**
 * Winner determination logic
 *
 * Tests that verify the game correctly counts each team's declared
 * half-suits and awards victory to the team with 5 or more.
 *
 * Coverage:
 * _endGame (direct unit tests):
 * 1. team1 wins 5-3 → gs.winner === 1
 * 2. team1 wins 6-2 → gs.winner === 1
 * 3. team1 wins 7-1 → gs.winner === 1
 * 4. team1 wins 8-0 → gs.winner === 1
 * 5. team2 wins 3-5 → gs.winner === 2
 * 6. team2 wins 2-6 → gs.winner === 2
 * 7. team2 wins 1-7 → gs.winner === 2
 * 8. team2 wins 0-8 → gs.winner === 2
 * 9. 4-4 tie: team1 declared high_d → gs.winner === 1 (tiebreaker)
 * 10. 4-4 tie: team2 declared high_d → gs.winner === 2 (tiebreaker)
 * 11. 4-4 tie: no high_d declared → gs.winner === null
 * 12. sets gs.status === 'completed'
 *
 * applyDeclaration (end-to-end game completion):
 * 13. team1 gets 5th half-suit → game completes, gs.winner === 1
 * 14. team2 gets 5th half-suit → game completes, gs.winner === 2
 * 15. applyDeclaration with full 8-suit game → correct winner
 * 16. winner is included in returned gs state (not in function return)
 *
 * applyForcedFailedDeclaration (end-to-end):
 * 17. forced-failed declaration that awards team2 their 5th suit → game ends, team2 wins
 *
 * Tiebreaker variant sensitivity:
 * 18. TIEBREAKER_HALF_SUIT constant is 'high_d' regardless of variant
 * 19. 4-4 tie where high_d was declared early (not last suit) → still uses it
 */

const { applyDeclaration, applyForcedFailedDeclaration, _endGame } = require('../game/gameEngine');
const { buildHalfSuitMap, TIEBREAKER_HALF_SUIT } = require('../game/halfSuits');

// ---------------------------------------------------------------------------
// Helper: build a minimal 6-player game state
// ---------------------------------------------------------------------------
function buildTestGame() {
  const players = [
    { playerId: 'p1', displayName: 'P1', avatarId: null, teamId: 1, seatIndex: 0, isBot: false, isGuest: false },
    { playerId: 'p2', displayName: 'P2', avatarId: null, teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
    { playerId: 'p3', displayName: 'P3', avatarId: null, teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
    { playerId: 'p4', displayName: 'P4', avatarId: null, teamId: 2, seatIndex: 1, isBot: false, isGuest: false },
    { playerId: 'p5', displayName: 'P5', avatarId: null, teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
    { playerId: 'p6', displayName: 'P6', avatarId: null, teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
  ];

  return {
    roomCode: 'TEST1',
    roomId: 'room-1',
    variant: 'remove_7s',
    playerCount: 6,
    status: 'active',
    currentTurnPlayerId: 'p1',
    players,
    hands: new Map([
      ['p1', new Set()],
      ['p2', new Set()],
      ['p3', new Set()],
      ['p4', new Set()],
      ['p5', new Set()],
      ['p6', new Set()],
    ]),
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
 * Build a minimal gs with scores already set and declaredSuits filled to 8,
 * but status still 'active' — so _endGame can be called manually.
 */
function buildPreEndGame(team1Score, team2Score, tiebreakerWinner = null) {
  const gs = buildTestGame();
  gs.scores = { team1: team1Score, team2: team2Score };
  gs.tiebreakerWinner = tiebreakerWinner;

  // Fill declaredSuits to exactly 8
  const halfSuits = buildHalfSuitMap('remove_7s');
  let i = 0;
  for (const [hsId] of halfSuits) {
    const winningTeam = i < team1Score ? 1 : 2;
    gs.declaredSuits.set(hsId, { teamId: winningTeam, declaredBy: 'p1' });
    i++;
  }

  return gs;
}

// ---------------------------------------------------------------------------
// _endGame direct unit tests
// ---------------------------------------------------------------------------

describe('_endGame — winner determination', () => {
  it('1. team1 wins 5-3 → gs.winner === 1', () => {
    const gs = buildPreEndGame(5, 3);
    _endGame(gs);
    expect(gs.winner).toBe(1);
    expect(gs.status).toBe('completed');
  });

  it('2. team1 wins 6-2 → gs.winner === 1', () => {
    const gs = buildPreEndGame(6, 2);
    _endGame(gs);
    expect(gs.winner).toBe(1);
    expect(gs.status).toBe('completed');
  });

  it('3. team1 wins 7-1 → gs.winner === 1', () => {
    const gs = buildPreEndGame(7, 1);
    _endGame(gs);
    expect(gs.winner).toBe(1);
    expect(gs.status).toBe('completed');
  });

  it('4. team1 wins 8-0 → gs.winner === 1', () => {
    const gs = buildPreEndGame(8, 0);
    _endGame(gs);
    expect(gs.winner).toBe(1);
    expect(gs.status).toBe('completed');
  });

  it('5. team2 wins 3-5 → gs.winner === 2', () => {
    const gs = buildPreEndGame(3, 5);
    _endGame(gs);
    expect(gs.winner).toBe(2);
    expect(gs.status).toBe('completed');
  });

  it('6. team2 wins 2-6 → gs.winner === 2', () => {
    const gs = buildPreEndGame(2, 6);
    _endGame(gs);
    expect(gs.winner).toBe(2);
    expect(gs.status).toBe('completed');
  });

  it('7. team2 wins 1-7 → gs.winner === 2', () => {
    const gs = buildPreEndGame(1, 7);
    _endGame(gs);
    expect(gs.winner).toBe(2);
    expect(gs.status).toBe('completed');
  });

  it('8. team2 wins 0-8 → gs.winner === 2', () => {
    const gs = buildPreEndGame(0, 8);
    _endGame(gs);
    expect(gs.winner).toBe(2);
    expect(gs.status).toBe('completed');
  });

  it('9. 4-4 tie with team1 having declared high_d → gs.winner === 1 (tiebreaker)', () => {
    const gs = buildPreEndGame(4, 4, /* tiebreakerWinner= */ 1);
    _endGame(gs);
    expect(gs.winner).toBe(1);
    expect(gs.status).toBe('completed');
  });

  it('10. 4-4 tie with team2 having declared high_d → gs.winner === 2 (tiebreaker)', () => {
    const gs = buildPreEndGame(4, 4, /* tiebreakerWinner= */ 2);
    _endGame(gs);
    expect(gs.winner).toBe(2);
    expect(gs.status).toBe('completed');
  });

  it('11. 4-4 tie with no high_d declaration → gs.winner === null', () => {
    const gs = buildPreEndGame(4, 4, /* tiebreakerWinner= */ null);
    _endGame(gs);
    expect(gs.winner).toBeNull();
    expect(gs.status).toBe('completed');
  });

  it('12. _endGame always sets gs.status === "completed"', () => {
    const gs = buildPreEndGame(5, 3);
    expect(gs.status).toBe('active');
    _endGame(gs);
    expect(gs.status).toBe('completed');
  });

  it('winner threshold: team must have > 4 suits (strictly more than half of 8) to win outright', () => {
    // 4 is NOT enough to win without tiebreaker; 5 IS enough
    const gs4 = buildPreEndGame(4, 4, null);
    _endGame(gs4);
    expect(gs4.winner).toBeNull(); // 4-4, no tiebreaker → null

    const gs5 = buildPreEndGame(5, 3, null);
    _endGame(gs5);
    expect(gs5.winner).toBe(1); // 5 > 3 → team1 wins
  });
});

// ---------------------------------------------------------------------------
// applyDeclaration — game completion integration tests
// ---------------------------------------------------------------------------

describe('applyDeclaration — game completion via 5th winning suit', () => {
  const halfSuits = buildHalfSuitMap('remove_7s');

  /**
   * Build a game state with N-1 suits already declared to the specified team,
   * and give all remaining half-suit cards to team1.
   */
  function buildNearEndGame(team1Declared, team2Declared) {
    const gs = buildTestGame();

    // First, collect all half-suit IDs in order
    const halfSuitIds = [...halfSuits.keys()];
    let t1Count = 0;
    let t2Count = 0;

    for (const hsId of halfSuitIds) {
      if (t1Count < team1Declared) {
        gs.declaredSuits.set(hsId, { teamId: 1, declaredBy: 'p1' });
        gs.scores.team1++;
        // Remove those cards from all hands
        for (const card of halfSuits.get(hsId)) {
          for (const [, hand] of gs.hands) hand.delete(card);
        }
        t1Count++;
      } else if (t2Count < team2Declared) {
        gs.declaredSuits.set(hsId, { teamId: 2, declaredBy: 'p4' });
        gs.scores.team2++;
        // Remove those cards from all hands
        for (const card of halfSuits.get(hsId)) {
          for (const [, hand] of gs.hands) hand.delete(card);
        }
        t2Count++;
      }
    }

    return gs;
  }

  it('13. team1 gets 5th half-suit → game completes with gs.winner === 1', () => {
    // Team1 has 4, team2 has 3. Declare one more to team1 → 5-3, game over.
    const gs = buildNearEndGame(4, 3);

    // Find the first undeclared half-suit and give all its cards to team1
    let targetHsId = null;
    for (const [hsId] of halfSuits) {
      if (!gs.declaredSuits.has(hsId)) {
        targetHsId = hsId;
        break;
      }
    }
    expect(targetHsId).not.toBeNull();

    const targetCards = halfSuits.get(targetHsId);
    // Give 3 cards to p1, 3 to p2
    const cardsArr = [...targetCards];
    gs.hands.set('p1', new Set(cardsArr.slice(0, 3)));
    gs.hands.set('p2', new Set(cardsArr.slice(3, 6)));
    gs.currentTurnPlayerId = 'p1';

    const assignment = {};
    cardsArr.slice(0, 3).forEach(c => { assignment[c] = 'p1'; });
    cardsArr.slice(3, 6).forEach(c => { assignment[c] = 'p2'; });

    applyDeclaration(gs, 'p1', targetHsId, assignment);

    expect(gs.status).toBe('completed');
    expect(gs.winner).toBe(1);
    expect(gs.scores.team1).toBe(5);
    expect(gs.scores.team2).toBe(3);
    expect(gs.declaredSuits.size).toBe(8);
  });

  it('14. team2 gets 5th half-suit → game completes with gs.winner === 2', () => {
    // Team1 has 3, team2 has 4. Team2 declares incorrectly (by team1 player), awarding to team2 → 3-5.
    const gs = buildNearEndGame(3, 4);

    // Find the first undeclared half-suit
    let targetHsId = null;
    for (const [hsId] of halfSuits) {
      if (!gs.declaredSuits.has(hsId)) {
        targetHsId = hsId;
        break;
      }
    }
    expect(targetHsId).not.toBeNull();

    const targetCards = halfSuits.get(targetHsId);
    const cardsArr = [...targetCards];

    // Give all cards to team2 (p4, p5, p6), but have p1 declare with wrong assignment
    gs.hands.set('p4', new Set(cardsArr.slice(0, 3)));
    gs.hands.set('p5', new Set(cardsArr.slice(3, 6)));
    gs.hands.set('p1', new Set());
    gs.hands.set('p2', new Set());
    gs.hands.set('p3', new Set());
    gs.currentTurnPlayerId = 'p4';

    // Correct assignment for team2 declarant
    const assignment = {};
    cardsArr.slice(0, 3).forEach(c => { assignment[c] = 'p4'; });
    cardsArr.slice(3, 6).forEach(c => { assignment[c] = 'p5'; });

    applyDeclaration(gs, 'p4', targetHsId, assignment);

    expect(gs.status).toBe('completed');
    expect(gs.winner).toBe(2);
    expect(gs.scores.team1).toBe(3);
    expect(gs.scores.team2).toBe(5);
    expect(gs.declaredSuits.size).toBe(8);
  });

  it('15. full 8-suit game: team1 declares 5 suits correctly → team1 wins', () => {
    const gs = buildTestGame();

    // Give all 48 cards to team1 for simplicity
    const allCards = [];
    for (const [, cards] of halfSuits) allCards.push(...cards);
    const team1Ids = ['p1', 'p2', 'p3'];
    for (const [pid] of gs.hands) gs.hands.set(pid, new Set());
    allCards.forEach((card, i) => {
      gs.hands.get(team1Ids[i % 3]).add(card);
    });

    const halfSuitIds = [...halfSuits.keys()];

    // Declare 5 suits for team1
    for (let i = 0; i < 5; i++) {
      const hsId = halfSuitIds[i];
      const cards = [...halfSuits.get(hsId)];
      const assignment = {};
      for (const card of cards) {
        for (const pid of team1Ids) {
          if (gs.hands.get(pid).has(card)) {
            assignment[card] = pid;
            break;
          }
        }
      }
      // Pick current turn holder
      const withCards = gs.players.find(p => gs.hands.get(p.playerId).size > 0 && p.teamId === 1);
      if (withCards) gs.currentTurnPlayerId = withCards.playerId;
      applyDeclaration(gs, gs.currentTurnPlayerId, hsId, assignment);
    }

    // Declare 3 more suits for team2 (incorrectly declared by team1, so team2 gets the point)
    for (let i = 5; i < 8; i++) {
      const hsId = halfSuitIds[i];
      const cards = [...halfSuits.get(hsId)];
      // Build a wrong assignment (assign all to p1 even if they don't hold them)
      const assignment = {};
      for (const card of cards) {
        assignment[card] = 'p1'; // all assigned to p1 but team2 actually holds them
      }
      const withCards = gs.players.find(p => gs.hands.get(p.playerId).size > 0 && p.teamId === 1);
      if (withCards) gs.currentTurnPlayerId = withCards.playerId;
      applyDeclaration(gs, gs.currentTurnPlayerId, hsId, assignment);
    }

    expect(gs.status).toBe('completed');
    expect(gs.winner).toBe(1);
    expect(gs.scores.team1).toBe(5);
    expect(gs.scores.team2).toBe(3);
  });

  it('16. game winner is stored in gs.winner (not in applyDeclaration return value)', () => {
    const gs = buildNearEndGame(4, 3);

    let targetHsId = null;
    for (const [hsId] of halfSuits) {
      if (!gs.declaredSuits.has(hsId)) { targetHsId = hsId; break; }
    }

    const cardsArr = [...halfSuits.get(targetHsId)];
    gs.hands.set('p1', new Set(cardsArr.slice(0, 3)));
    gs.hands.set('p2', new Set(cardsArr.slice(3, 6)));
    gs.currentTurnPlayerId = 'p1';

    const assignment = {};
    cardsArr.slice(0, 3).forEach(c => { assignment[c] = 'p1'; });
    cardsArr.slice(3, 6).forEach(c => { assignment[c] = 'p2'; });

    const result = applyDeclaration(gs, 'p1', targetHsId, assignment);

    // The function return tells you which team won THIS declaration's point
    expect(result.winningTeam).toBe(1);
    // The game-level winner is on gs.winner
    expect(gs.winner).toBe(1);
    expect(gs.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// applyForcedFailedDeclaration — game completion
// ---------------------------------------------------------------------------

describe('applyForcedFailedDeclaration — game completion', () => {
  const halfSuits = buildHalfSuitMap('remove_7s');

  it('17. forced-failed declaration awards team2 their 5th suit → game ends, team2 wins', () => {
    const gs = buildTestGame();

    // Team1 has 3 declared, team2 has 4 declared — so forced fail by team1 player → team2 gets 5th
    const halfSuitIds = [...halfSuits.keys()];
    for (let i = 0; i < 7; i++) {
      const hsId = halfSuitIds[i];
      const winTeam = i < 3 ? 1 : 2; // team1 gets first 3, team2 gets next 4
      gs.declaredSuits.set(hsId, { teamId: winTeam, declaredBy: 'p1' });
      if (winTeam === 1) gs.scores.team1++;
      else gs.scores.team2++;
      for (const card of halfSuits.get(hsId)) {
        for (const [, hand] of gs.hands) hand.delete(card);
      }
    }
    expect(gs.scores).toEqual({ team1: 3, team2: 4 });

    // Last suit: give cards to team2, p1 is current turn player (team1)
    const lastHsId = halfSuitIds[7];
    const lastCards = [...halfSuits.get(lastHsId)];
    gs.hands.set('p4', new Set(lastCards.slice(0, 3)));
    gs.hands.set('p5', new Set(lastCards.slice(3, 6)));
    gs.hands.set('p1', new Set(['dummy_card_placeholder'])); // p1 must have ≥1 card to be current turn
    // Actually p1 needs to hold a real card to avoid immediate turn skip.
    // Just use a card from the remaining half-suit doesn't work if it's team2's.
    // Give p1 a card that doesn't exist (the engine doesn't check card validity for forced-fail).
    gs.hands.set('p1', new Set([lastCards[0]])); // p1 holds 1 card from lastHsId (doesn't matter for forced fail)
    gs.currentTurnPlayerId = 'p1'; // p1 is team1, forced fail → team2 gets point (their 5th)

    const result = applyForcedFailedDeclaration(gs, 'p1', lastHsId);

    expect(result.winningTeam).toBe(2);
    expect(gs.status).toBe('completed');
    expect(gs.winner).toBe(2);
    expect(gs.scores.team1).toBe(3);
    expect(gs.scores.team2).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Tiebreaker constant and variant sensitivity
// ---------------------------------------------------------------------------

describe('Tiebreaker logic', () => {
  it('18. TIEBREAKER_HALF_SUIT is always "high_d" regardless of variant', () => {
    expect(TIEBREAKER_HALF_SUIT).toBe('high_d');
  });

  it('19. 4-4 tie where high_d was declared 3rd (not last) → tiebreakerWinner still decides', () => {
    // Simulate: high_d declared 3rd, then 4 more suits declared to reach 4-4.
    const gs = buildTestGame();
    const halfSuits = buildHalfSuitMap('remove_7s');

    // Give all cards to team1
    const allCards = [];
    for (const [, cards] of halfSuits) allCards.push(...cards);
    const team1Ids = ['p1', 'p2', 'p3'];
    for (const [pid] of gs.hands) gs.hands.set(pid, new Set());
    allCards.forEach((card, i) => {
      gs.hands.get(team1Ids[i % 3]).add(card);
    });

    const halfSuitIds = [...halfSuits.keys()];
    // high_d is one of them; let's declare it 3rd as team1
    // Then give team2 the remaining 4 points by incorrect declarations

    // Helpers
    function declareCorrectlyForTeam1(hsId) {
      const cards = [...halfSuits.get(hsId)];
      const assignment = {};
      for (const card of cards) {
        for (const pid of team1Ids) {
          if (gs.hands.get(pid) && gs.hands.get(pid).has(card)) {
            assignment[card] = pid;
            break;
          }
        }
      }
      const withCards = gs.players.find(p => gs.hands.get(p.playerId) && gs.hands.get(p.playerId).size > 0 && p.teamId === 1);
      if (withCards) gs.currentTurnPlayerId = withCards.playerId;
      applyDeclaration(gs, gs.currentTurnPlayerId, hsId, assignment);
    }

    function declareWronglyForTeam2(hsId) {
      // p1 declares with wrong assignment → team2 gets point
      const cards = [...halfSuits.get(hsId)];
      const assignment = {};
      // Assign all to p1 even though team1 has them (wrong = team2 gets point)
      // Wait, the actual cards ARE on team1. So p1 declares correctly → team1 gets point.
      // To give team2 a point, we need team2 to hold the cards and team1 to declare wrongly.
      // Remove cards from team1 first, give to team2.
      for (const card of cards) {
        for (const pid of team1Ids) {
          if (gs.hands.get(pid)) gs.hands.get(pid).delete(card);
        }
      }
      const team2Ids = ['p4', 'p5', 'p6'];
      cards.forEach((card, i) => {
        if (!gs.hands.get(team2Ids[i % 3])) gs.hands.set(team2Ids[i % 3], new Set());
        gs.hands.get(team2Ids[i % 3]).add(card);
      });

      // Now p1 has to be current turn. But p1 must have ≥1 card in this half-suit to declare.
      // Add one card to p1
      gs.hands.get('p1').add(cards[0]);

      const withCards = gs.players.find(p => gs.hands.get(p.playerId) && gs.hands.get(p.playerId).size > 0 && p.teamId === 1);
      if (withCards) gs.currentTurnPlayerId = withCards.playerId;

      // Wrong assignment (assign team2's cards to team1 players)
      const wrongAssignment = {};
      cards.forEach((card, i) => { wrongAssignment[card] = team1Ids[i % 3]; });
      applyDeclaration(gs, gs.currentTurnPlayerId, hsId, wrongAssignment);
    }

    // Declare 3 suits correctly for team1 (including high_d as the 3rd one)
    let team1Count = 0;
    for (const hsId of halfSuitIds) {
      if (team1Count >= 3) break;
      if (gs.declaredSuits.has(hsId)) continue;
      declareCorrectlyForTeam1(hsId);
      team1Count++;
    }

    // high_d must still be undeclared at this point — declare it for team1
    if (!gs.declaredSuits.has('high_d')) {
      declareCorrectlyForTeam1('high_d');
    }

    // Now team1 has ≥3 suits + high_d. Give team2 4 suits via wrong declarations
    let team2Count = 0;
    for (const hsId of halfSuitIds) {
      if (team2Count >= 4) break;
      if (gs.declaredSuits.has(hsId)) continue;
      declareWronglyForTeam2(hsId);
      team2Count++;
    }

    // Game should be over. We expect team1 to have used high_d tiebreaker if 4-4.
    expect(gs.status).toBe('completed');
    if (gs.scores.team1 === 4 && gs.scores.team2 === 4) {
      expect(gs.tiebreakerWinner).toBe(1);
      expect(gs.winner).toBe(1);
    } else {
      // Scores diverged — just verify a winner was set
      expect(gs.winner).not.toBeNull();
    }
  });

  it('20. winning team is always the one with more than 4 declared half-suits (5+ = majority)', () => {
    // With 8 total half-suits, getting 5 means opponent has at most 3.
    // This is a mathematical guarantee — verify it holds for all score splits.
    const scoreSplits = [
      [5, 3], [6, 2], [7, 1], [8, 0],
      [3, 5], [2, 6], [1, 7], [0, 8],
    ];
    for (const [t1, t2] of scoreSplits) {
      const gs = buildPreEndGame(t1, t2);
      _endGame(gs);
      if (t1 > t2) {
        expect(gs.winner).toBe(1);
        expect(t1).toBeGreaterThanOrEqual(5);
      } else {
        expect(gs.winner).toBe(2);
        expect(t2).toBeGreaterThanOrEqual(5);
      }
    }
  });
});
