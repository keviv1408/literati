'use strict';

/**
 * Tests for getEligibleNextTurnPlayers
 *
 * Verifies that after a declaration, the server correctly computes and
 * exposes the list of non-eliminated players with cards remaining.
 *
 * Coverage:
 * getEligibleNextTurnPlayers:
 * 1. All players have cards → all 6 players are eligible
 * 2. One player's hand is emptied → they are excluded from the list
 * 3. Player in eliminatedPlayerIds with cards still returns excluded
 * (the eliminatedPlayerIds flag is authoritative)
 * 4. Player with cards NOT in eliminatedPlayerIds is included
 * 5. Game completed (all 8 suits) → still returns remaining card holders
 * 6. Empty players array → returns empty list
 * 7. No eliminatedPlayerIds set on gs → treated as no one eliminated
 * 8. Declarant still has cards after declaration → included in eligible list
 * 9. Declarant has NO cards after declaration → excluded from eligible list
 * 10. Order is by seatIndex (ascending)
 *
 * Integration — applyDeclaration + getEligibleNextTurnPlayers:
 * 11. Correct declaration: eligible list excludes players emptied by card removal
 * 12. Incorrect declaration: same exclusion applies
 * 13. After declaration that empties multiple players, eligible list shrinks
 * 14. Declarant is included in eligible list if they still hold cards
 * 15. Declarant is excluded from eligible list if their hand is emptied
 */

const { getEligibleNextTurnPlayers, applyDeclaration } = require('../game/gameEngine');
const { getCardCount } = require('../game/gameState');

// ---------------------------------------------------------------------------
// Helper: build a minimal 6-player game state
// ---------------------------------------------------------------------------

/**
 * Build a test game with remove_7s variant.
 *
 * Card layout (remove_7s):
 * low_s: 1_s 2_s 3_s 4_s 5_s 6_s
 * high_s: 8_s 9_s 10_s 11_s 12_s 13_s
 * low_h: 1_h 2_h 3_h 4_h 5_h 6_h
 * high_h: 8_h 9_h 10_h 11_h 12_h 13_h
 * low_d: 1_d 2_d 3_d 4_d 5_d 6_d
 * high_d: 8_d 9_d 10_d 11_d 12_d 13_d
 * low_c: 1_c 2_c 3_c 4_c 5_c 6_c
 * high_c: 8_c 9_c 10_c 11_c 12_c 13_c
 *
 * Team 1: p1(seat 0), p2(seat 2), p3(seat 4)
 * Team 2: p4(seat 1), p5(seat 3), p6(seat 5)
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

  return {
    roomCode:            'TEST_28A',
    roomId:              'room-28a',
    variant:             'remove_7s',
    playerCount:         6,
    status:              'active',
    currentTurnPlayerId: 'p1',
    players,
    hands: new Map([
      ['p1', new Set(['1_s', '2_s', '3_s'])],    // team1, low_s cards
      ['p2', new Set(['4_s', '5_s', '6_s'])],    // team1, low_s cards
      ['p3', new Set(['8_s', '9_s', '10_s'])],   // team1, high_s cards
      ['p4', new Set(['11_s', '12_s', '13_s'])], // team2, high_s cards
      ['p5', new Set(['1_h', '2_h', '3_h'])],    // team2
      ['p6', new Set(['4_h', '5_h', '6_h'])],    // team2
    ]),
    declaredSuits:       new Map(),
    scores:              { team1: 0, team2: 0 },
    lastMove:            null,
    winner:              null,
    tiebreakerWinner:    null,
    botKnowledge:        new Map(),
    moveHistory:         [],
    eliminatedPlayerIds: new Set(),
    turnRecipients:      new Map(),
  };
}

// ---------------------------------------------------------------------------
// getEligibleNextTurnPlayers — unit tests
// ---------------------------------------------------------------------------

describe('getEligibleNextTurnPlayers', () => {
  let gs;

  beforeEach(() => {
    gs = buildTestGame();
  });

  it('test 1: all players have cards → all 6 are eligible, ordered by seatIndex', () => {
    const result = getEligibleNextTurnPlayers(gs);
    // Players ordered by seatIndex: p1(0), p4(1), p2(2), p5(3), p3(4), p6(5)
    expect(result).toEqual(['p1', 'p4', 'p2', 'p5', 'p3', 'p6']);
  });

  it('test 2: one player has an empty hand → excluded from the list', () => {
    gs.hands.set('p3', new Set()); // p3 hand emptied
    const result = getEligibleNextTurnPlayers(gs);
    // p3 excluded (cardCount === 0); order: p1(0), p4(1), p2(2), p5(3), p6(5)
    expect(result).not.toContain('p3');
    expect(result).toHaveLength(5);
    expect(result).toEqual(['p1', 'p4', 'p2', 'p5', 'p6']);
  });

  it('test 3: player in eliminatedPlayerIds even with cards → excluded', () => {
    // Unusual edge: eliminated flag set even if hand is non-empty (defensive test)
    gs.eliminatedPlayerIds.add('p2');
    const result = getEligibleNextTurnPlayers(gs);
    expect(result).not.toContain('p2');
    expect(result).toHaveLength(5);
  });

  it('test 4: player with cards NOT in eliminatedPlayerIds → included', () => {
    // Only p3 is eliminated
    gs.eliminatedPlayerIds.add('p3');
    gs.hands.set('p3', new Set()); // also empty hand
    const result = getEligibleNextTurnPlayers(gs);
    expect(result).not.toContain('p3');
    // p1 is NOT eliminated, has cards → included
    expect(result).toContain('p1');
  });

  it('test 5: game status completed → still returns players with cards', () => {
    gs.status = 'completed';
    const result = getEligibleNextTurnPlayers(gs);
    // Even after game ends, the function returns whoever still holds cards
    expect(result).toHaveLength(6);
  });

  it('test 6: empty players array → returns empty list', () => {
    gs.players = [];
    const result = getEligibleNextTurnPlayers(gs);
    expect(result).toEqual([]);
  });

  it('test 7: gs has no eliminatedPlayerIds set → treats everyone as not eliminated', () => {
    delete gs.eliminatedPlayerIds; // simulate missing field
    const result = getEligibleNextTurnPlayers(gs);
    expect(result).toHaveLength(6); // all 6 included since none eliminated
  });

  it('test 8: null/undefined gs → returns empty list', () => {
    expect(getEligibleNextTurnPlayers(null)).toEqual([]);
    expect(getEligibleNextTurnPlayers(undefined)).toEqual([]);
  });

  it('test 9: order is by seatIndex ascending (seats: p1=0, p4=1, p2=2, p5=3, p3=4, p6=5)', () => {
    const result = getEligibleNextTurnPlayers(gs);
    // Verify exact order matches ascending seatIndex
    expect(result[0]).toBe('p1'); // seat 0
    expect(result[1]).toBe('p4'); // seat 1
    expect(result[2]).toBe('p2'); // seat 2
    expect(result[3]).toBe('p5'); // seat 3
    expect(result[4]).toBe('p3'); // seat 4
    expect(result[5]).toBe('p6'); // seat 5
  });

  it('test 10: only one player has cards → returns only that player', () => {
    // Empty all hands except p5
    for (const pid of ['p1', 'p2', 'p3', 'p4', 'p6']) {
      gs.hands.set(pid, new Set());
    }
    const result = getEligibleNextTurnPlayers(gs);
    expect(result).toEqual(['p5']);
  });
});

// ---------------------------------------------------------------------------
// Integration: applyDeclaration + getEligibleNextTurnPlayers
// ---------------------------------------------------------------------------

describe('getEligibleNextTurnPlayers after applyDeclaration', () => {
  /**
   * Set up a game where p1 (team1) can declare low_s.
   * low_s cards: 1_s 2_s 3_s 4_s 5_s 6_s
   *
   * p1 holds 1_s, 2_s, 3_s (3 of the 6 low_s cards)
   * p2 holds 4_s, 5_s, 6_s (remaining 3 low_s cards)
   * Other players hold non-low_s cards so they won't be affected by removal.
   */
  function buildDeclarationGame() {
    const players = [
      { playerId: 'p1', displayName: 'P1', avatarId: null, teamId: 1, seatIndex: 0, isBot: false, isGuest: false },
      { playerId: 'p2', displayName: 'P2', avatarId: null, teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
      { playerId: 'p3', displayName: 'P3', avatarId: null, teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
      { playerId: 'p4', displayName: 'P4', avatarId: null, teamId: 2, seatIndex: 1, isBot: false, isGuest: false },
      { playerId: 'p5', displayName: 'P5', avatarId: null, teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
      { playerId: 'p6', displayName: 'P6', avatarId: null, teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
    ];

    return {
      roomCode:            'TEST_DECL',
      roomId:              'room-decl',
      variant:             'remove_7s',
      playerCount:         6,
      status:              'active',
      currentTurnPlayerId: 'p1',
      players,
      hands: new Map([
        // p1 holds only low_s cards → will be emptied by a low_s declaration
        ['p1', new Set(['1_s', '2_s', '3_s'])],
        // p2 holds only low_s cards → will also be emptied
        ['p2', new Set(['4_s', '5_s', '6_s'])],
        // p3, p4, p5, p6 hold non-low_s cards (unaffected by low_s declaration)
        ['p3', new Set(['8_h', '9_h', '10_h'])],
        ['p4', new Set(['1_h', '2_h', '3_h'])],
        ['p5', new Set(['4_h', '5_h', '6_h'])],
        ['p6', new Set(['11_h', '12_h', '13_h'])],
      ]),
      declaredSuits:       new Map(),
      scores:              { team1: 0, team2: 0 },
      lastMove:            null,
      winner:              null,
      tiebreakerWinner:    null,
      botKnowledge:        new Map(),
      moveHistory:         [],
      eliminatedPlayerIds: new Set(),
      turnRecipients:      new Map(),
    };
  }

  it('test 11: correct declaration — players emptied by card removal are excluded', () => {
    const gs = buildDeclarationGame();
    // p1 correctly assigns all low_s cards to team1
    const assignment = {
      '1_s': 'p1', '2_s': 'p1', '3_s': 'p1',
      '4_s': 'p2', '5_s': 'p2', '6_s': 'p2',
    };
    applyDeclaration(gs, 'p1', 'low_s', assignment);

    // After declaration: p1 and p2 both have empty hands
    expect(getCardCount(gs, 'p1')).toBe(0);
    expect(getCardCount(gs, 'p2')).toBe(0);

    const eligible = getEligibleNextTurnPlayers(gs);
    // p1 and p2 must be excluded (hands empty)
    expect(eligible).not.toContain('p1');
    expect(eligible).not.toContain('p2');
    // p3, p4, p5, p6 still have cards → included
    expect(eligible).toContain('p3');
    expect(eligible).toContain('p4');
    expect(eligible).toContain('p5');
    expect(eligible).toContain('p6');
    expect(eligible).toHaveLength(4);
  });

  it('test 12: incorrect declaration — opposing team gets point; same exclusion applies', () => {
    const gs = buildDeclarationGame();
    // p1 declares low_s INCORRECTLY (swaps p1/p2 assignments)
    const assignment = {
      '1_s': 'p2', '2_s': 'p2', '3_s': 'p2', // wrong: p1 actually holds these
      '4_s': 'p1', '5_s': 'p1', '6_s': 'p1', // wrong: p2 actually holds these
    };
    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);
    expect(result.correct).toBe(false);

    // Cards are still removed even on incorrect declaration
    expect(getCardCount(gs, 'p1')).toBe(0);
    expect(getCardCount(gs, 'p2')).toBe(0);

    const eligible = getEligibleNextTurnPlayers(gs);
    expect(eligible).not.toContain('p1');
    expect(eligible).not.toContain('p2');
    expect(eligible).toHaveLength(4);
  });

  it('test 13: declarant still has cards after declaration → included in eligible list', () => {
    // Give p1 extra cards outside low_s so they won't be emptied
    const gs = buildDeclarationGame();
    gs.hands.get('p1').add('8_h'); // p1 now has low_s + one high_h card

    const assignment = {
      '1_s': 'p1', '2_s': 'p1', '3_s': 'p1',
      '4_s': 'p2', '5_s': 'p2', '6_s': 'p2',
    };
    applyDeclaration(gs, 'p1', 'low_s', assignment);

    // p1 still holds 8_h after the low_s cards are removed
    expect(getCardCount(gs, 'p1')).toBe(1);

    const eligible = getEligibleNextTurnPlayers(gs);
    // p1 should be included since they still have a card
    expect(eligible).toContain('p1');
    // p2 hand emptied → excluded
    expect(eligible).not.toContain('p2');
  });

  it('test 14: declarant has NO cards after declaration → excluded from eligible list', () => {
    const gs = buildDeclarationGame();
    // p1 only had low_s cards; after removal, hand is empty
    const assignment = {
      '1_s': 'p1', '2_s': 'p1', '3_s': 'p1',
      '4_s': 'p2', '5_s': 'p2', '6_s': 'p2',
    };
    applyDeclaration(gs, 'p1', 'low_s', assignment);

    expect(getCardCount(gs, 'p1')).toBe(0);

    const eligible = getEligibleNextTurnPlayers(gs);
    // declarant p1 excluded (hand empty, added to eliminatedPlayerIds by applyDeclaration)
    expect(eligible).not.toContain('p1');
  });

  it('test 15: after declaration emptying multiple players, list length reduces correctly', () => {
    // p1: 3 low_s, p2: 3 low_s, p3: 3 high_h, p4: 3 low_h, p5: 3 high_h, p6: 3 high_h
    const gs = buildDeclarationGame();
    // Everyone except p3/p5/p6 will be affected
    // p3, p5, p6 keep their cards
    const assignment = {
      '1_s': 'p1', '2_s': 'p1', '3_s': 'p1',
      '4_s': 'p2', '5_s': 'p2', '6_s': 'p2',
    };
    applyDeclaration(gs, 'p1', 'low_s', assignment);

    const eligible = getEligibleNextTurnPlayers(gs);
    // p1 and p2 emptied; p3, p4, p5, p6 remain
    expect(eligible).toHaveLength(4);

    // Verify eliminated set was updated
    expect(gs.eliminatedPlayerIds.has('p1')).toBe(true);
    expect(gs.eliminatedPlayerIds.has('p2')).toBe(true);
    expect(gs.eliminatedPlayerIds.has('p3')).toBe(false);
  });
});
