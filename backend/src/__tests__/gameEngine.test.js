'use strict';

/**
 * Unit tests for gameEngine.js
 *
 * Coverage:
 *   validateAsk:
 *     1. Valid ask → { valid: true }
 *     2. p1 asks teammate (p2) → NOT_YOUR_TURN / SAME_TEAM
 *     3. p1 asks for card not in same half-suit it holds → NO_HALF_SUIT_CARD
 *     4. p1 asks when it's p2's turn → NOT_YOUR_TURN
 *     5. p1 asks for card already in p1's hand → ALREADY_HELD
 *     6. Target player has 0 cards → TARGET_EMPTY
 *     7. p1 asks for a card that doesn't exist → INVALID_CARD
 *   applyAsk:
 *     8. Successful ask transfers card, turn stays with asker
 *     9. Failed ask keeps card with target, turn passes to target
 *    10. Returns { success, newTurnPlayerId, lastMove }
 *   validateDeclaration:
 *    11. Valid declaration → { valid: true }
 *    12. Wrong turn → NOT_YOUR_TURN
 *    13. Only 5 cards assigned → INCOMPLETE_ASSIGNMENT
 *    14. Opponent in assignment → CROSS_TEAM_ASSIGN
 *    15. Half-suit already declared → ALREADY_DECLARED
 *    15a. Declarer holds no cards from that half-suit → DECLARANT_HAS_NO_CARDS
 *   applyDeclaration:
 *    16. Correct declaration: team gets point, cards removed
 *    17. Incorrect declaration: opponent gets point
 *    18. declaredSuits updated
 *    19. After 8 declarations gs.status === 'completed'
 *    20. Tiebreaker: 4-4 tie → winner is team that declared high_d
 *    21. moveHistory updated after declaration
 */

const { validateAsk, applyAsk, getDeclarantLockedCards, validateDeclaration, applyDeclaration, applyForcedFailedDeclaration, _nextClockwiseOpponent } = require('../game/gameEngine');
const { buildHalfSuitMap } = require('../game/halfSuits');
const { serializePlayers, getHalfSuitCardCount } = require('../game/gameState');

// ---------------------------------------------------------------------------
// Helper: build a minimal 6-player game state with known hands
// ---------------------------------------------------------------------------

/**
 * Card layout for remove_7s (for reference):
 *   low_s:  1_s 2_s 3_s 4_s 5_s 6_s
 *   high_s: 8_s 9_s 10_s 11_s 12_s 13_s
 *   low_h:  1_h 2_h 3_h 4_h 5_h 6_h
 *   high_h: 8_h 9_h 10_h 11_h 12_h 13_h
 *   low_d:  1_d 2_d 3_d 4_d 5_d 6_d
 *   high_d: 8_d 9_d 10_d 11_d 12_d 13_d
 *   low_c:  1_c 2_c 3_c 4_c 5_c 6_c
 *   high_c: 8_c 9_c 10_c 11_c 12_c 13_c
 *
 * Team 1: p1, p2, p3
 * Team 2: p4, p5, p6
 */
function buildTestGame() {
  const players = [
    { playerId: 'p1', displayName: 'P1', avatarId: null, teamId: 1, seatIndex: 0, isBot: false, isGuest: false },
    { playerId: 'p2', displayName: 'P2', avatarId: null, teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
    { playerId: 'p3', displayName: 'P3', avatarId: null, teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
    { playerId: 'p4', displayName: 'P4', avatarId: null, teamId: 2, seatIndex: 1, isBot: false, isGuest: false },
    { playerId: 'p5', displayName: 'P5', avatarId: null, teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
    { playerId: 'p6', displayName: 'P6', avatarId: null, teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
  ];

  const gs = {
    roomCode: 'TEST1',
    roomId: 'room-1',
    variant: 'remove_7s',
    playerCount: 6,
    status: 'active',
    currentTurnPlayerId: 'p1',
    players,
    hands: new Map([
      ['p1', new Set(['1_s', '2_s', '3_s'])],   // team1, holds low_s cards
      ['p2', new Set(['4_s', '5_s', '6_s'])],   // team1, holds rest of low_s
      ['p3', new Set(['8_s', '9_s', '10_s'])],  // team1, holds some high_s
      ['p4', new Set(['11_s', '12_s', '13_s'])], // team2, holds rest of high_s
      ['p5', new Set(['1_h', '2_h', '3_h'])],   // team2
      ['p6', new Set(['4_h', '5_h', '6_h'])],   // team2
    ]),
    declaredSuits: new Map(),
    scores: { team1: 0, team2: 0 },
    lastMove: null,
    winner: null,
    tiebreakerWinner: null,
    botKnowledge: new Map(),
    moveHistory: [],
  };

  return gs;
}

// ---------------------------------------------------------------------------
// validateAsk
// ---------------------------------------------------------------------------

describe('validateAsk', () => {
  let gs;

  beforeEach(() => {
    gs = buildTestGame();
  });

  it('valid ask: p1 (holds high_s card) asks p4 for a high_s card → { valid: true }', () => {
    // p4 holds 11_s,12_s,13_s (high_s). Give p1 a high_s card so they can
    // ask for high_s cards (asker must hold ≥1 in the half-suit, and target
    // must also hold ≥1 in the half-suit).
    gs.hands.get('p1').add('8_s'); // p1 now holds a high_s card
    const result = validateAsk(gs, 'p1', 'p4', '11_s');
    // p4 has 11_s (high_s), p1 has 8_s (high_s) → valid
    expect(result).toEqual({ valid: true });
  });

  it('error: p1 asks teammate p2 for a card → SAME_TEAM', () => {
    const result = validateAsk(gs, 'p1', 'p2', '4_s');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('SAME_TEAM');
  });

  it('error: p1 asks for a card not in any half-suit it holds → NO_HALF_SUIT_CARD', () => {
    // p1 holds low_s cards. Ask for a high_h card (different half-suit with no p1 cards).
    const result = validateAsk(gs, 'p1', 'p4', '8_h');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('NO_HALF_SUIT_CARD');
  });

  it('error: p1 asks when it is p2\'s turn → NOT_YOUR_TURN', () => {
    gs.currentTurnPlayerId = 'p2';
    const result = validateAsk(gs, 'p1', 'p4', '4_s');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('NOT_YOUR_TURN');
  });

  it('error: p1 asks for a card already in p1\'s hand → ALREADY_HELD', () => {
    const result = validateAsk(gs, 'p1', 'p4', '1_s');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('ALREADY_HELD');
  });

  it('error: target player p4 has 0 total cards → TARGET_EMPTY', () => {
    gs.hands.set('p4', new Set());
    const result = validateAsk(gs, 'p1', 'p4', '4_s');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('TARGET_EMPTY');
  });

  it('error: target p4 has cards but none in the requested half-suit (low_s) → TARGET_EMPTY_HALF_SUIT', () => {
    // p1 holds low_s cards. p4 holds only high_s cards (11_s,12_s,13_s).
    // p4 has 0 low_s cards, so asking p4 for a low_s card is illegal.
    const result = validateAsk(gs, 'p1', 'p4', '4_s');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('TARGET_EMPTY_HALF_SUIT');
  });

  it('error: p1 asks for 7_s which is not in the deck (remove_7s) → INVALID_CARD', () => {
    const result = validateAsk(gs, 'p1', 'p4', '7_s');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('INVALID_CARD');
  });

  it('error: game not active → GAME_NOT_ACTIVE', () => {
    gs.status = 'completed';
    const result = validateAsk(gs, 'p1', 'p4', '4_s');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('GAME_NOT_ACTIVE');
  });
});

// ---------------------------------------------------------------------------
// applyAsk
// ---------------------------------------------------------------------------

describe('applyAsk', () => {
  let gs;

  beforeEach(() => {
    gs = buildTestGame();
  });

  it('successful ask: card transfers from target to asker, turn stays with asker', () => {
    // p4 holds 11_s. p1 holds low_s cards (different suit group). Give p1 a high_s card
    // so they can legally ask for high_s cards, then ask p4 for 11_s.
    gs.hands.get('p1').add('8_s'); // p1 now has high_s representation
    const result = applyAsk(gs, 'p1', 'p4', '11_s');

    expect(result.success).toBe(true);
    expect(gs.hands.get('p1').has('11_s')).toBe(true);
    expect(gs.hands.get('p4').has('11_s')).toBe(false);
    expect(result.newTurnPlayerId).toBe('p1');
  });

  it('failed ask: card stays with target, turn passes to target', () => {
    // p1 asks p4 for 4_s, but p4 does NOT hold 4_s (p2 does)
    const result = applyAsk(gs, 'p1', 'p4', '4_s');

    expect(result.success).toBe(false);
    expect(gs.hands.get('p2').has('4_s')).toBe(true); // still with p2
    expect(result.newTurnPlayerId).toBe('p4');
    // AC 18: gs.currentTurnPlayerId must also be updated to the specific player asked
    expect(gs.currentTurnPlayerId).toBe('p4');
  });

  it('AC 18: failed ask — turn passes to the SPECIFIC player asked, not a teammate', () => {
    // p1 (team-1) asks p5 (team-2) for 4_s. p5 does NOT hold 4_s (p4 does).
    // Turn must pass to p5 specifically, NOT to p4 (p5's teammate) even though p4 holds cards.
    const result = applyAsk(gs, 'p1', 'p5', '4_s');

    expect(result.success).toBe(false);
    expect(result.newTurnPlayerId).toBe('p5');
    expect(gs.currentTurnPlayerId).toBe('p5');
    // Confirm the turn did NOT accidentally jump to a different team-2 player
    expect(result.newTurnPlayerId).not.toBe('p4');
    expect(result.newTurnPlayerId).not.toBe('p6');
  });

  it('result includes { success, newTurnPlayerId, lastMove }', () => {
    const result = applyAsk(gs, 'p1', 'p4', '4_s');
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('newTurnPlayerId');
    expect(result).toHaveProperty('lastMove');
  });

  it('successful ask adds an entry to moveHistory with type "ask"', () => {
    gs.hands.get('p1').add('8_s');
    applyAsk(gs, 'p1', 'p4', '11_s');
    const last = gs.moveHistory[gs.moveHistory.length - 1];
    expect(last.type).toBe('ask');
    expect(last.success).toBe(true);
    expect(last.cardId).toBe('11_s');
  });

  it('failed ask adds an entry to moveHistory with success: false', () => {
    applyAsk(gs, 'p1', 'p4', '4_s');
    const last = gs.moveHistory[gs.moveHistory.length - 1];
    expect(last.type).toBe('ask');
    expect(last.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateDeclaration
// ---------------------------------------------------------------------------

describe('validateDeclaration', () => {
  let gs;

  // Build assignment assigning all 6 low_s cards to team-1 players
  function makeLowSAssignment() {
    return {
      '1_s': 'p1',
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p2',
      '5_s': 'p2',
      '6_s': 'p2',
    };
  }

  beforeEach(() => {
    gs = buildTestGame();
  });

  it('valid declaration: p1 declares low_s assigning all 6 cards to team-1 players', () => {
    const result = validateDeclaration(gs, 'p1', 'low_s', makeLowSAssignment());
    expect(result).toEqual({ valid: true });
  });

  it('error: p2 declares when it is p1\'s turn → NOT_YOUR_TURN', () => {
    const result = validateDeclaration(gs, 'p2', 'low_s', makeLowSAssignment());
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('NOT_YOUR_TURN');
  });

  it('error: assignment has only 5 cards → INCOMPLETE_ASSIGNMENT', () => {
    const assignment = { ...makeLowSAssignment() };
    delete assignment['6_s'];
    const result = validateDeclaration(gs, 'p1', 'low_s', assignment);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('INCOMPLETE_ASSIGNMENT');
  });

  it('error: assignment has 6 cards but one is wrong card for the suit → MISSING_CARDS', () => {
    const assignment = {
      '1_s': 'p1',
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p2',
      '5_s': 'p2',
      '8_s': 'p2', // 8_s is high_s, not low_s
    };
    const result = validateDeclaration(gs, 'p1', 'low_s', assignment);
    expect(result.valid).toBe(false);
    // Either MISSING_CARDS or INCOMPLETE_ASSIGNMENT depending on implementation
    expect(['MISSING_CARDS', 'INCOMPLETE_ASSIGNMENT']).toContain(result.errorCode);
  });

  it('error: p1 assigns a card to p4 (opponent, team 2) → CROSS_TEAM_ASSIGN', () => {
    const assignment = {
      '1_s': 'p1',
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p2',
      '5_s': 'p2',
      '6_s': 'p4', // opponent!
    };
    const result = validateDeclaration(gs, 'p1', 'low_s', assignment);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('CROSS_TEAM_ASSIGN');
  });

  it('error: half-suit already declared → ALREADY_DECLARED', () => {
    gs.declaredSuits.set('low_s', { teamId: 1, declaredBy: 'p1' });
    const result = validateDeclaration(gs, 'p1', 'low_s', makeLowSAssignment());
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('ALREADY_DECLARED');
  });

  it('error: game not active → GAME_NOT_ACTIVE', () => {
    gs.status = 'completed';
    const result = validateDeclaration(gs, 'p1', 'low_s', makeLowSAssignment());
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('GAME_NOT_ACTIVE');
  });

  it('error: p1 declares high_h but holds no high_h cards → DECLARANT_HAS_NO_CARDS', () => {
    // p1 holds 1_s,2_s,3_s (low_s only). high_h cards: 8_h,9_h,10_h,11_h,12_h,13_h
    // p5 holds 1_h,2_h,3_h; p6 holds 4_h,5_h,6_h — but NO high_h cards anywhere in p1's hand
    const assignment = {
      '8_h': 'p1',
      '9_h': 'p1',
      '10_h': 'p1',
      '11_h': 'p2',
      '12_h': 'p2',
      '13_h': 'p2',
    };
    const result = validateDeclaration(gs, 'p1', 'high_h', assignment);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('DECLARANT_HAS_NO_CARDS');
  });

  it('valid declaration: p1 can declare low_s because they hold 1_s,2_s,3_s', () => {
    // Explicitly verify the ≥1 card check passes for a suit the player holds
    const result = validateDeclaration(gs, 'p1', 'low_s', makeLowSAssignment());
    expect(result).toEqual({ valid: true });
  });

  // -------------------------------------------------------------------------
  // Sub-AC 22a: Locked-card enforcement — declarant's own cards must be
  // assigned to themselves and cannot be re-attributed to a teammate.
  // -------------------------------------------------------------------------

  it('Sub-AC 22a: p1 tries to assign their own card (1_s) to teammate p2 → LOCKED_CARD_REASSIGNED', () => {
    // p1 holds 1_s,2_s,3_s. Assigning 1_s to p2 should be rejected.
    const assignment = {
      '1_s': 'p2', // p1 actually holds this — locked!
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p2',
      '5_s': 'p2',
      '6_s': 'p2',
    };
    const result = validateDeclaration(gs, 'p1', 'low_s', assignment);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('LOCKED_CARD_REASSIGNED');
    expect(result.lockedCard).toBe('1_s');
  });

  it('Sub-AC 22a: p1 tries to assign all their cards (1_s,2_s,3_s) to p3 → LOCKED_CARD_REASSIGNED', () => {
    // All of p1's own low_s cards assigned to a teammate — rejected on the first locked card found.
    const assignment = {
      '1_s': 'p3',
      '2_s': 'p3',
      '3_s': 'p3',
      '4_s': 'p2',
      '5_s': 'p2',
      '6_s': 'p2',
    };
    const result = validateDeclaration(gs, 'p1', 'low_s', assignment);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('LOCKED_CARD_REASSIGNED');
  });

  it('Sub-AC 22a: correct assignment where declarant holds no extra cards passes lock check', () => {
    // p2 has the turn. p2 holds 4_s,5_s,6_s. They declare low_s.
    // p1 holds 1_s,2_s,3_s — not the declarer, so no lock from p2's perspective on those.
    gs.currentTurnPlayerId = 'p2';
    const assignment = {
      '1_s': 'p1',
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p2',
      '5_s': 'p2',
      '6_s': 'p2',
    };
    const result = validateDeclaration(gs, 'p2', 'low_s', assignment);
    expect(result).toEqual({ valid: true });
  });

  it('Sub-AC 22a: p2 (declarant) tries to assign their own card (4_s) to p1 → LOCKED_CARD_REASSIGNED', () => {
    // p2 holds 4_s,5_s,6_s. Assigning 4_s to p1 is a locked-card violation.
    gs.currentTurnPlayerId = 'p2';
    const assignment = {
      '1_s': 'p1',
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p1', // p2 holds 4_s — locked!
      '5_s': 'p2',
      '6_s': 'p2',
    };
    const result = validateDeclaration(gs, 'p2', 'low_s', assignment);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('LOCKED_CARD_REASSIGNED');
    expect(result.lockedCard).toBe('4_s');
  });
});

// ---------------------------------------------------------------------------
// getDeclarantLockedCards
// ---------------------------------------------------------------------------

describe('getDeclarantLockedCards', () => {
  let gs;

  beforeEach(() => {
    gs = buildTestGame();
  });

  it('returns the set of cards from the half-suit that the declarant currently holds', () => {
    // p1 holds 1_s,2_s,3_s — all are low_s cards
    const locked = getDeclarantLockedCards(gs, 'p1', 'low_s');
    expect(locked).toBeInstanceOf(Set);
    expect(locked.size).toBe(3);
    expect(locked.has('1_s')).toBe(true);
    expect(locked.has('2_s')).toBe(true);
    expect(locked.has('3_s')).toBe(true);
    // Cards held by teammates are not in the locked set
    expect(locked.has('4_s')).toBe(false);
    expect(locked.has('5_s')).toBe(false);
    expect(locked.has('6_s')).toBe(false);
  });

  it('returns an empty set when the declarant holds no cards from the half-suit', () => {
    // p1 holds only low_s cards. Querying high_h should return empty.
    const locked = getDeclarantLockedCards(gs, 'p1', 'high_h');
    expect(locked.size).toBe(0);
  });

  it('returns an empty set for an invalid half-suit ID', () => {
    const locked = getDeclarantLockedCards(gs, 'p1', 'invalid_suit');
    expect(locked.size).toBe(0);
  });

  it('returns all 6 cards when declarant holds the full half-suit', () => {
    // Give p1 all 6 low_s cards
    gs.hands.set('p1', new Set(['1_s', '2_s', '3_s', '4_s', '5_s', '6_s']));
    gs.hands.set('p2', new Set()); // remove from p2
    const locked = getDeclarantLockedCards(gs, 'p1', 'low_s');
    expect(locked.size).toBe(6);
  });

  it('locked set updates dynamically when hand changes (card added)', () => {
    // p1 does not hold 4_s initially
    const lockedBefore = getDeclarantLockedCards(gs, 'p1', 'low_s');
    expect(lockedBefore.has('4_s')).toBe(false);

    // Simulate p1 gaining 4_s (e.g. successful ask)
    gs.hands.get('p1').add('4_s');
    gs.hands.get('p2').delete('4_s');

    const lockedAfter = getDeclarantLockedCards(gs, 'p1', 'low_s');
    expect(lockedAfter.has('4_s')).toBe(true);
    expect(lockedAfter.size).toBe(4); // 1_s,2_s,3_s,4_s
  });
});

// ---------------------------------------------------------------------------
// applyDeclaration
// ---------------------------------------------------------------------------

describe('applyDeclaration', () => {
  let gs;

  beforeEach(() => {
    gs = buildTestGame();
  });

  it('correct declaration: declaring team gets a point', () => {
    // p1 holds 1_s,2_s,3_s; p2 holds 4_s,5_s,6_s — correct low_s assignment
    const assignment = {
      '1_s': 'p1', '2_s': 'p1', '3_s': 'p1',
      '4_s': 'p2', '5_s': 'p2', '6_s': 'p2',
    };
    applyDeclaration(gs, 'p1', 'low_s', assignment);
    expect(gs.scores.team1).toBe(1);
    expect(gs.scores.team2).toBe(0);
  });

  it('correct declaration: all 6 low_s cards removed from all hands', () => {
    const assignment = {
      '1_s': 'p1', '2_s': 'p1', '3_s': 'p1',
      '4_s': 'p2', '5_s': 'p2', '6_s': 'p2',
    };
    applyDeclaration(gs, 'p1', 'low_s', assignment);

    const lowSCards = ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'];
    for (const [, hand] of gs.hands) {
      for (const card of lowSCards) {
        expect(hand.has(card)).toBe(false);
      }
    }
  });

  it('incorrect declaration: opponent team gets a point', () => {
    // p1 declares low_s but assigns 1_s to p3 (p1 actually holds it)
    const assignment = {
      '1_s': 'p3', // wrong: p1 holds it
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p2',
      '5_s': 'p2',
      '6_s': 'p2',
    };
    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);
    expect(result.correct).toBe(false);
    expect(result.winningTeam).toBe(2);
    expect(gs.scores.team2).toBe(1);
    expect(gs.scores.team1).toBe(0);
  });

  // ── AC 26a: wrong-assignment diffs and actual-holder map ─────────────────

  it('incorrect declaration: returns wrongAssignmentDiffs for each mis-assigned card', () => {
    // p1 holds 1_s; p2 holds 4_s,5_s,6_s — but p1 mistakenly claims 1_s → p3
    const assignment = {
      '1_s': 'p3', // wrong: p1 holds it
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p2',
      '5_s': 'p2',
      '6_s': 'p2',
    };
    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);
    expect(result.correct).toBe(false);
    expect(result.wrongAssignmentDiffs).toHaveLength(1);
    const diff = result.wrongAssignmentDiffs[0];
    expect(diff.card).toBe('1_s');
    expect(diff.claimedPlayerId).toBe('p3');
    expect(diff.actualPlayerId).toBe('p1');
  });

  it('incorrect declaration: returns actualHolders map for all 6 half-suit cards', () => {
    const assignment = {
      '1_s': 'p3', // wrong: p1 holds it
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p2',
      '5_s': 'p2',
      '6_s': 'p2',
    };
    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);
    // actualHolders must cover all 6 cards in the half-suit
    expect(Object.keys(result.actualHolders).sort()).toEqual(['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'].sort());
    // Spot-check a few entries
    expect(result.actualHolders['1_s']).toBe('p1'); // p1 actually holds 1_s
    expect(result.actualHolders['4_s']).toBe('p2'); // p2 actually holds 4_s
  });

  it('incorrect declaration with multiple wrong assignments returns all diffs', () => {
    // Swap 1_s ↔ 4_s between p1 and p2 so two cards are wrong
    const assignment = {
      '1_s': 'p2', // wrong: p1 holds it
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p1', // wrong: p2 holds it
      '5_s': 'p2',
      '6_s': 'p2',
    };
    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);
    expect(result.correct).toBe(false);
    expect(result.wrongAssignmentDiffs).toHaveLength(2);
    const cards = result.wrongAssignmentDiffs.map((d) => d.card).sort();
    expect(cards).toEqual(['1_s', '4_s'].sort());
  });

  it('correct declaration: wrongAssignmentDiffs is empty and actualHolders covers all 6 cards', () => {
    const assignment = {
      '1_s': 'p1', '2_s': 'p1', '3_s': 'p1',
      '4_s': 'p2', '5_s': 'p2', '6_s': 'p2',
    };
    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);
    expect(result.correct).toBe(true);
    expect(result.wrongAssignmentDiffs).toHaveLength(0);
    // actualHolders still populated even for correct declarations
    expect(Object.keys(result.actualHolders)).toHaveLength(6);
  });

  it('declaredSuits updated with the halfSuitId after declaration', () => {
    const assignment = {
      '1_s': 'p1', '2_s': 'p1', '3_s': 'p1',
      '4_s': 'p2', '5_s': 'p2', '6_s': 'p2',
    };
    applyDeclaration(gs, 'p1', 'low_s', assignment);
    expect(gs.declaredSuits.has('low_s')).toBe(true);
    expect(gs.declaredSuits.get('low_s').teamId).toBe(1);
  });

  it('moveHistory has a new entry after declaration', () => {
    const assignment = {
      '1_s': 'p1', '2_s': 'p1', '3_s': 'p1',
      '4_s': 'p2', '5_s': 'p2', '6_s': 'p2',
    };
    const before = gs.moveHistory.length;
    applyDeclaration(gs, 'p1', 'low_s', assignment);
    expect(gs.moveHistory.length).toBe(before + 1);
    expect(gs.moveHistory[gs.moveHistory.length - 1].type).toBe('declaration');
  });

  it('after 8 declarations gs.status === "completed"', () => {
    // Declare all 8 half-suits. Assign each to team-1 players (p1,p2,p3).
    // We need all cards to be in team-1 hands for correct declarations.
    const halfSuits = buildHalfSuitMap('remove_7s');
    const team1Players = ['p1', 'p2', 'p3'];

    // Redistribute all cards to team-1 (for simplicity)
    const allCards = [];
    for (const [, cards] of halfSuits) allCards.push(...cards);
    for (const [pid] of gs.hands) gs.hands.set(pid, new Set());
    for (let i = 0; i < allCards.length; i++) {
      gs.hands.get(team1Players[i % 3]).add(allCards[i]);
    }

    for (const [halfSuitId, cards] of halfSuits) {
      // Build assignment: each card assigned to whoever holds it on team1
      const assignment = {};
      for (const card of cards) {
        for (const pid of team1Players) {
          if (gs.hands.get(pid).has(card)) {
            assignment[card] = pid;
            break;
          }
        }
      }
      gs.currentTurnPlayerId = gs.currentTurnPlayerId; // keep turn valid
      // Find current turn holder; if they have no cards, use p1
      if (!gs.hands.get(gs.currentTurnPlayerId) || gs.hands.get(gs.currentTurnPlayerId).size === 0) {
        // pick anyone with cards
        const withCards = gs.players.find((p) => gs.hands.get(p.playerId).size > 0);
        if (withCards) gs.currentTurnPlayerId = withCards.playerId;
      }
      applyDeclaration(gs, gs.currentTurnPlayerId, halfSuitId, assignment);
    }

    expect(gs.status).toBe('completed');
  });

  it('tiebreaker: 4-4 tie → winner is team that declared high_d', () => {
    // Manually set scores to 4-4, declare 7 suits, then declare high_d for team 1
    gs.scores = { team1: 4, team2: 3 };

    // Mark 7 half-suits as already declared (skip high_d)
    const halfSuits = buildHalfSuitMap('remove_7s');
    let declared = 0;
    for (const [halfSuitId] of halfSuits) {
      if (halfSuitId === 'high_d') continue;
      gs.declaredSuits.set(halfSuitId, { teamId: 1, declaredBy: 'p1' });
      declared++;
      if (declared === 7) break;
    }

    // Remove all the already-declared cards from hands
    for (const [hsId, info] of gs.declaredSuits) {
      const cards = halfSuits.get(hsId);
      for (const card of cards) {
        for (const [, hand] of gs.hands) hand.delete(card);
      }
    }

    // Give team-1 all high_d cards
    const highDCards = halfSuits.get('high_d'); // ['8_d','9_d','10_d','11_d','12_d','13_d']
    for (const [, hand] of gs.hands) {
      for (const card of highDCards) hand.delete(card);
    }
    // Assign high_d cards to p1 and p2
    gs.hands.set('p1', new Set(['8_d', '9_d', '10_d']));
    gs.hands.set('p2', new Set(['11_d', '12_d', '13_d']));
    gs.hands.set('p3', new Set());
    gs.hands.set('p4', new Set());
    gs.hands.set('p5', new Set());
    gs.hands.set('p6', new Set());

    gs.currentTurnPlayerId = 'p1';
    gs.scores = { team1: 4, team2: 4 }; // force tie

    const assignment = {
      '8_d': 'p1', '9_d': 'p1', '10_d': 'p1',
      '11_d': 'p2', '12_d': 'p2', '13_d': 'p2',
    };
    applyDeclaration(gs, 'p1', 'high_d', assignment);

    expect(gs.status).toBe('completed');
    expect(gs.winner).toBe(1);
    expect(gs.tiebreakerWinner).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getHalfSuitCardCount + serializePlayers halfSuitCounts (Sub-AC 1 of AC 38)
// ---------------------------------------------------------------------------

describe('getHalfSuitCardCount', () => {
  let gs;

  beforeEach(() => {
    gs = buildTestGame();
  });

  it('returns the correct count for a player who holds cards in a half-suit', () => {
    // p1 holds 1_s, 2_s, 3_s — all low_s cards
    expect(getHalfSuitCardCount(gs, 'p1', 'low_s')).toBe(3);
  });

  it('returns 0 for a player who holds NO cards in a half-suit', () => {
    // p1 holds only low_s cards; they hold 0 high_s cards
    expect(getHalfSuitCardCount(gs, 'p1', 'high_s')).toBe(0);
  });

  it('returns 0 for a player with an empty hand', () => {
    gs.hands.set('p1', new Set());
    expect(getHalfSuitCardCount(gs, 'p1', 'low_s')).toBe(0);
  });

  it('returns 0 after cards in that half-suit are removed (post-declaration)', () => {
    // Simulate declaration: remove all low_s cards from p1
    gs.hands.set('p1', new Set(['1_h'])); // only holds a heart now
    expect(getHalfSuitCardCount(gs, 'p1', 'low_s')).toBe(0);
  });
});

describe('serializePlayers — halfSuitCounts', () => {
  let gs;

  beforeEach(() => {
    gs = buildTestGame();
  });

  it('each serialized player includes a halfSuitCounts object', () => {
    const players = serializePlayers(gs);
    for (const p of players) {
      expect(p).toHaveProperty('halfSuitCounts');
      expect(typeof p.halfSuitCounts).toBe('object');
    }
  });

  it('halfSuitCounts has entries for all 8 half-suits', () => {
    const players = serializePlayers(gs);
    const expected = ['low_s','high_s','low_h','high_h','low_d','high_d','low_c','high_c'];
    for (const p of players) {
      for (const hsId of expected) {
        expect(p.halfSuitCounts).toHaveProperty(hsId);
      }
    }
  });

  it('p1 halfSuitCounts.low_s === 3 (holds 1_s,2_s,3_s)', () => {
    const players = serializePlayers(gs);
    const p1 = players.find((p) => p.playerId === 'p1');
    expect(p1.halfSuitCounts.low_s).toBe(3);
  });

  it('p4 halfSuitCounts.high_s === 3 (holds 11_s,12_s,13_s) and low_s === 0', () => {
    const players = serializePlayers(gs);
    const p4 = players.find((p) => p.playerId === 'p4');
    expect(p4.halfSuitCounts.high_s).toBe(3);
    expect(p4.halfSuitCounts.low_s).toBe(0);
  });

  it('halfSuitCounts correctly becomes 0 after cards are removed from a hand', () => {
    // Remove all low_s cards from p1
    gs.hands.set('p1', new Set());
    const players = serializePlayers(gs);
    const p1 = players.find((p) => p.playerId === 'p1');
    expect(p1.halfSuitCounts.low_s).toBe(0);
    expect(p1.cardCount).toBe(0);
  });

  it('all halfSuitCounts values are non-negative integers', () => {
    const players = serializePlayers(gs);
    for (const p of players) {
      for (const [, count] of Object.entries(p.halfSuitCounts)) {
        expect(Number.isInteger(count)).toBe(true);
        expect(count).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC 29: After failed declaration, turn auto-passes clockwise to next eligible
//        opponent.
//
// Seat layout (clockwise by seatIndex):
//   p1 (team1, seat 0) → p4 (team2, seat 1) → p2 (team1, seat 2)
//   → p5 (team2, seat 3) → p3 (team1, seat 4) → p6 (team2, seat 5)
// ---------------------------------------------------------------------------

describe('_nextClockwiseOpponent (AC 29)', () => {
  let gs;

  beforeEach(() => {
    gs = buildTestGame();
  });

  it('returns the first clockwise opponent with cards from the declarer seat', () => {
    // p1 is at seat 0. p4 (team2) is at seat 1 and has cards.
    expect(_nextClockwiseOpponent(gs, 'p1', 2)).toBe('p4');
  });

  it('skips opponents with 0 cards and returns the next eligible one', () => {
    // Empty p4's hand; next team-2 seat clockwise from p1 is p5 (seat 3).
    gs.hands.set('p4', new Set());
    expect(_nextClockwiseOpponent(gs, 'p1', 2)).toBe('p5');
  });

  it('wraps around the seat order when no opponent is found before end', () => {
    // p6 is at seat 5 (team2). After p6, clockwise next opponent is p4 (seat 1).
    // Empty p4 and p5, only p6 should remain.
    gs.hands.set('p4', new Set());
    gs.hands.set('p5', new Set());
    expect(_nextClockwiseOpponent(gs, 'p1', 2)).toBe('p6');
  });

  it('from p3 (seat 4), next team-2 clockwise is p6 (seat 5)', () => {
    gs.currentTurnPlayerId = 'p3';
    expect(_nextClockwiseOpponent(gs, 'p3', 2)).toBe('p6');
  });

  it('from p3 (seat 4), wraps around to p4 (seat 1) when p6 has no cards', () => {
    gs.hands.set('p6', new Set());
    expect(_nextClockwiseOpponent(gs, 'p3', 2)).toBe('p4');
  });

  it('returns from _resolveValidTurn fallback if no opponent has any cards', () => {
    // All team-2 players empty; the game should still be running (not completed).
    // The fallback returns whoever _resolveValidTurn finds.
    gs.hands.set('p4', new Set());
    gs.hands.set('p5', new Set());
    gs.hands.set('p6', new Set());
    // With no opponents, falls back — result should be a player with cards on team1.
    const result = _nextClockwiseOpponent(gs, 'p1', 2);
    // Must be some player with cards (p1, p2, or p3).
    expect(['p1', 'p2', 'p3']).toContain(result);
  });

  it('returns fromPlayerId immediately when game is already completed', () => {
    gs.status = 'completed';
    expect(_nextClockwiseOpponent(gs, 'p1', 2)).toBe('p1');
  });
});

describe('applyDeclaration — turn pass after failure (AC 29)', () => {
  let gs;

  beforeEach(() => {
    gs = buildTestGame();
  });

  it('incorrect declaration: turn passes to next clockwise opponent (p4)', () => {
    // p1 (team1, seat0) declares low_s incorrectly.
    // Winning team = 2; next clockwise opponent from p1 is p4 (seat1).
    const assignment = {
      '1_s': 'p3', // wrong: p1 actually holds it
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p2',
      '5_s': 'p2',
      '6_s': 'p2',
    };
    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);
    expect(result.correct).toBe(false);
    expect(result.newTurnPlayerId).toBe('p4');
    expect(gs.currentTurnPlayerId).toBe('p4');
  });

  it('incorrect declaration: skips opponent with no cards, passes to next', () => {
    // Empty p4's hand; next team-2 clockwise from p1 should be p5 (seat3).
    gs.hands.set('p4', new Set());
    const assignment = {
      '1_s': 'p3', // wrong
      '2_s': 'p1', '3_s': 'p1',
      '4_s': 'p2', '5_s': 'p2', '6_s': 'p2',
    };
    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);
    expect(result.correct).toBe(false);
    expect(result.newTurnPlayerId).toBe('p5');
  });

  it('correct declaration: declaring team keeps the turn', () => {
    // p1 (team1) correctly declares low_s; p1 has cards after (high_h etc. not set,
    // but p1 still has 0 cards after low_s removal, so _resolveValidTurn picks p2 or p3).
    const assignment = {
      '1_s': 'p1', '2_s': 'p1', '3_s': 'p1',
      '4_s': 'p2', '5_s': 'p2', '6_s': 'p2',
    };
    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);
    expect(result.correct).toBe(true);
    // Turn should stay with team1 (p1 now has 0 cards, so resolves to a teammate).
    const turnPlayer = gs.players.find((p) => p.playerId === result.newTurnPlayerId);
    expect(turnPlayer.teamId).toBe(1);
  });
});

describe('applyForcedFailedDeclaration — turn pass (AC 29)', () => {
  let gs;

  beforeEach(() => {
    gs = buildTestGame();
  });

  it('forced-failed declaration: turn passes to next clockwise opponent', () => {
    // p1 (team1, seat0) times out on low_s. Winning team = 2.
    // Next clockwise from p1 with cards on team2 is p4 (seat1).
    const result = applyForcedFailedDeclaration(gs, 'p1', 'low_s');
    expect(result.winningTeam).toBe(2);
    expect(result.newTurnPlayerId).toBe('p4');
    expect(gs.currentTurnPlayerId).toBe('p4');
  });

  it('forced-failed declaration: skips empty opponents, passes to next eligible', () => {
    gs.hands.set('p4', new Set());
    const result = applyForcedFailedDeclaration(gs, 'p1', 'low_s');
    expect(result.winningTeam).toBe(2);
    expect(result.newTurnPlayerId).toBe('p5');
  });

  it('forced-failed declaration from team2 player: turn passes to team1 opponent', () => {
    // Set p4 as current turn player and have p4 do a forced-failed declaration.
    gs.currentTurnPlayerId = 'p4';
    // Next clockwise from p4 (seat1) with cards on team1: p2 (seat2).
    const result = applyForcedFailedDeclaration(gs, 'p4', 'high_s');
    expect(result.winningTeam).toBe(1);
    // p2 is at seat2 (next team1 clockwise from p4 seat1).
    expect(result.newTurnPlayerId).toBe('p2');
  });
});
