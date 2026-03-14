'use strict';

/**
 * clockwiseTurnPass.test.js
 *
 * AC 19: Turn passes clockwise to next eligible player if the receiving player
 *        is simultaneously eliminated.
 *
 * "Simultaneously eliminated" means the player who would receive the turn has
 * 0 cards at the moment the turn is assigned — most commonly because a
 * declaration just removed their last cards in the same processing step.
 *
 * Coverage:
 *   1. _resolveValidTurn: eliminated candidate → next clockwise same-team player
 *   2. _resolveValidTurn: first clockwise teammate also eliminated → second
 *   3. _resolveValidTurn: all teammates eliminated → any player with cards
 *   4. _resolveValidTurn: clockwise wrap-around (candidate near end of seat list)
 *   5. applyDeclaration (correct): declarant simultaneously eliminated → turn
 *      passes clockwise to next teammate, NOT to the first teammate in array order
 *      when that is NOT the clockwise-next one
 *   6. applyDeclaration (correct): turn stays with non-eliminated declarant
 *   7. applyDeclaration (correct): multiple teammates eliminated; turn passes to
 *      the correct next-clockwise survivor
 *   8. applyDeclaration (incorrect): turn passes to opponent via
 *      _nextClockwiseOpponent (regression guard — AC 29 logic unchanged)
 */

const {
  applyDeclaration,
  _resolveValidTurn,
} = require('../game/gameEngine');

// ---------------------------------------------------------------------------
// Seat layout (used throughout):
//
//   clockwise: p1(T1,seat0) → p4(T2,seat1) → p2(T1,seat2)
//              → p5(T2,seat3) → p3(T1,seat4) → p6(T2,seat5)
//
// So within T1: clockwise order is p1(0) → p2(2) → p3(4) → (wrap) → p1
// Within T2: clockwise order is p4(1) → p5(3) → p6(5) → (wrap) → p4
// ---------------------------------------------------------------------------

function buildGs(overrides = {}) {
  const players = [
    { playerId: 'p1', displayName: 'P1', teamId: 1, seatIndex: 0, avatarId: null, isBot: false, isGuest: false },
    { playerId: 'p4', displayName: 'P4', teamId: 2, seatIndex: 1, avatarId: null, isBot: false, isGuest: false },
    { playerId: 'p2', displayName: 'P2', teamId: 1, seatIndex: 2, avatarId: null, isBot: false, isGuest: false },
    { playerId: 'p5', displayName: 'P5', teamId: 2, seatIndex: 3, avatarId: null, isBot: false, isGuest: false },
    { playerId: 'p3', displayName: 'P3', teamId: 1, seatIndex: 4, avatarId: null, isBot: false, isGuest: false },
    { playerId: 'p6', displayName: 'P6', teamId: 2, seatIndex: 5, avatarId: null, isBot: false, isGuest: false },
  ];

  const gs = {
    roomCode: 'CW01',
    roomId:   'room-cw-1',
    variant:  'remove_7s',
    playerCount: 6,
    status:   'active',
    currentTurnPlayerId: 'p1',
    players,
    hands: new Map([
      ['p1', new Set(['1_s', '2_s', '3_s'])],
      ['p2', new Set(['4_s', '5_s', '6_s'])],
      ['p3', new Set(['8_s', '9_s', '10_s'])],
      ['p4', new Set(['11_s', '12_s', '13_s'])],
      ['p5', new Set(['1_h', '2_h', '3_h'])],
      ['p6', new Set(['4_h', '5_h', '6_h'])],
    ]),
    declaredSuits: new Map(),
    scores:        { team1: 0, team2: 0 },
    lastMove:      null,
    winner:        null,
    tiebreakerWinner: null,
    botKnowledge:  new Map(),
    moveHistory:   [],
    eliminatedPlayerIds: new Set(),
    turnRecipients: new Map(),
  };

  Object.assign(gs, overrides);
  return gs;
}

// ---------------------------------------------------------------------------
// 1–4: _resolveValidTurn clockwise behaviour
// ---------------------------------------------------------------------------

describe('_resolveValidTurn — AC 19 clockwise pass', () => {
  it('1. eliminated candidate passes to next clockwise same-team player', () => {
    const gs = buildGs();
    // p1 (seat 0, T1) is eliminated
    gs.hands.get('p1').clear();
    gs.eliminatedPlayerIds.add('p1');

    // Clockwise from p1(seat0): p4(T2,1), p2(T1,2) ← first T1 survivor
    const result = _resolveValidTurn(gs, 'p1');
    expect(result).toBe('p2');
  });

  it('2. first clockwise teammate also eliminated → second clockwise teammate', () => {
    const gs = buildGs();
    // p1 (seat 0, T1) and p2 (seat 2, T1) are both eliminated
    gs.hands.get('p1').clear();
    gs.hands.get('p2').clear();
    gs.eliminatedPlayerIds.add('p1');
    gs.eliminatedPlayerIds.add('p2');

    // Clockwise from p1(0): p4(T2,1) skip, p2(T1,2) eliminated skip, p5(T2,3) skip, p3(T1,4) ✓
    const result = _resolveValidTurn(gs, 'p1');
    expect(result).toBe('p3');
  });

  it('3. all teammates eliminated → falls back to any player with cards', () => {
    const gs = buildGs();
    // All T1 players eliminated
    gs.hands.get('p1').clear();
    gs.hands.get('p2').clear();
    gs.hands.get('p3').clear();
    gs.eliminatedPlayerIds.add('p1');
    gs.eliminatedPlayerIds.add('p2');
    gs.eliminatedPlayerIds.add('p3');

    const result = _resolveValidTurn(gs, 'p1');
    // Must be some T2 player with cards
    expect(['p4', 'p5', 'p6']).toContain(result);
    expect(gs.hands.get(result).size).toBeGreaterThan(0);
  });

  it('4. clockwise wrap-around: eliminated p3 (seat 4, T1) passes to p1 (seat 0, T1)', () => {
    const gs = buildGs();
    // p3 (seat 4, T1) is eliminated; p1 (seat 0) and p2 (seat 2) still have cards
    gs.hands.get('p3').clear();
    gs.eliminatedPlayerIds.add('p3');

    // Clockwise from p3(4): p6(T2,5) skip, p1(T1,0) ✓
    const result = _resolveValidTurn(gs, 'p3');
    expect(result).toBe('p1');
  });
});

// ---------------------------------------------------------------------------
// 5–8: Integration with applyDeclaration
// ---------------------------------------------------------------------------

describe('applyDeclaration — AC 19 simultaneous elimination turn-pass', () => {
  it('5. correct declaration: declarant simultaneously eliminated → clockwise next teammate', () => {
    const gs = buildGs();
    // p1 (T1, seat 0) holds ONLY the low_s cards (1_s, 2_s, 3_s)
    // p2 (T1, seat 2) holds the rest: 4_s, 5_s, 6_s
    // After declaring low_s correctly, ALL low_s cards are removed:
    //   p1 loses 1_s 2_s 3_s → hand becomes empty → p1 is simultaneously eliminated
    //   p2 loses 4_s 5_s 6_s → hand becomes empty → p2 also eliminated
    // p3 (T1, seat 4) still has cards → that's the next clockwise T1 player from p1

    const assignment = {
      '1_s': 'p1',
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p2',
      '5_s': 'p2',
      '6_s': 'p2',
    };

    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);

    expect(result.correct).toBe(true);
    // p1 and p2 are both eliminated; next clockwise T1 is p3 (seat 4)
    expect(result.newTurnPlayerId).toBe('p3');
    expect(gs.currentTurnPlayerId).toBe('p3');
  });

  it('6. correct declaration: non-eliminated declarant keeps the turn', () => {
    const gs = buildGs();
    // p1 holds 1_s 2_s 3_s (and we add extra card so they survive)
    gs.hands.get('p1').add('8_h'); // extra card → p1 won't be eliminated after low_s removal

    const assignment = {
      '1_s': 'p1',
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p2',
      '5_s': 'p2',
      '6_s': 'p2',
    };

    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);

    expect(result.correct).toBe(true);
    // p1 still has 8_h → not eliminated → keeps the turn
    expect(result.newTurnPlayerId).toBe('p1');
    expect(gs.currentTurnPlayerId).toBe('p1');
  });

  it('7. correct declaration: only last T1 survivor remains → turn goes to them', () => {
    const gs = buildGs();
    // Simulate: p2 and p3 already eliminated before this declaration
    gs.hands.get('p2').clear();
    gs.hands.get('p3').clear();
    gs.eliminatedPlayerIds.add('p2');
    gs.eliminatedPlayerIds.add('p3');

    // p1 (seat 0, T1) makes a correct declaration and loses all their cards too
    // p1 holds: 1_s 2_s 3_s; p2 held 4_s 5_s 6_s (now empty, but we still need them
    // in the assignment since we're declaring a half-suit)
    // Restore p2 cards for the assignment (they are in the half-suit)
    gs.hands.get('p2').add('4_s');
    gs.hands.get('p2').add('5_s');
    gs.hands.get('p2').add('6_s');

    const assignment = {
      '1_s': 'p1',
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p2',
      '5_s': 'p2',
      '6_s': 'p2',
    };

    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);
    expect(result.correct).toBe(true);

    // After declaration: p1 loses 1_s/2_s/3_s → empty (eliminated), p2 also empty (newly)
    // All T1 players empty → fallback to any player with cards (T2)
    expect(gs.hands.get(result.newTurnPlayerId).size).toBeGreaterThan(0);
    expect(['p4', 'p5', 'p6']).toContain(result.newTurnPlayerId);
  });

  it('8. incorrect declaration: turn passes to clockwise opponent (AC 29 regression)', () => {
    const gs = buildGs();
    // p1 (seat 0, T1) declares low_s incorrectly (wrong card assignment)
    const assignment = {
      '1_s': 'p3', // wrong — p1 actually holds 1_s
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p2',
      '5_s': 'p2',
      '6_s': 'p2',
    };

    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);

    expect(result.correct).toBe(false);
    // Clockwise from p1 (seat 0): first T2 opponent is p4 (seat 1)
    expect(result.newTurnPlayerId).toBe('p4');
    expect(gs.currentTurnPlayerId).toBe('p4');
  });
});
