'use strict';

/**
 * Remove all 6 half-suit cards from all players' hands after
 * a declaration resolves, regardless of success or failure.
 *
 * Rules:
 * - When a declaration resolves (correct, incorrect, or forced-failed via
 * timer expiry), ALL 6 cards belonging to the declared half-suit MUST be
 * removed from every player's hand immediately.
 * - The removal is unconditional — it does not matter which player held any
 * of the cards or whether the declaration was correct.
 * - Non-declared cards remain untouched in their holders' hands.
 * - The half-suit is recorded in gs.declaredSuits with the winning teamId.
 *
 * Coverage:
 *
 * applyDeclaration (correct declaration):
 * 1. All 6 declared cards removed from the declarant's own hand
 * 2. All 6 declared cards removed from a teammate's hand
 * 3. Declared cards spread across 3 team-1 players — all removed
 * 4. Non-declared cards in all hands are NOT affected
 * 5. declaredSuits is updated after the removal
 * 6. Removal works for remove_2s variant
 * 7. Removal works for remove_8s variant
 *
 * applyDeclaration (incorrect declaration):
 * 8. All 6 declared cards still removed even when declaration is wrong
 * 9. Cards held by opponents are removed even on wrong declaration
 * 10. Wrong declaration removes cards AND awards point to opposing team
 *
 * applyForcedFailedDeclaration (timer expiry):
 * 11. All 6 declared cards removed on forced failure
 * 12. Cards held by players who didn't initiate declare are also removed
 * 13. Other hands untouched after forced failure
 *
 * 8-player game:
 * 14. All 8 players' hands are cleaned of declared cards (4v4 game)
 *
 * Game state coherence after removal:
 * 15. After removal, no player holds any card from the declared half-suit
 * 16. Asking for a card from a declared half-suit is blocked (SUIT_DECLARED)
 * 17. Multiple sequential declarations each remove their respective 6 cards
 * 18. After declaring all 8 half-suits the game is over and all hands empty
 */

const { applyDeclaration, applyForcedFailedDeclaration, validateAsk } = require('../game/gameEngine');
const { buildHalfSuitMap, allHalfSuitIds } = require('../game/halfSuits');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal 6-player game state for declaration tests.
 * Variant defaults to remove_7s.
 *
 * Team 1: p1 (seat 0), p2 (seat 2), p3 (seat 4)
 * Team 2: p4 (seat 1), p5 (seat 3), p6 (seat 5)
 *
 * @param {Object} opts
 * @param {string} [opts.variant='remove_7s']
 * @param {Object.<string, Set<string>>} [opts.handOverrides={}]
 * @param {string} [opts.currentTurnPlayerId='p1']
 * @returns {Object} GameState
 */
function buildGame6({
  variant = 'remove_7s',
  handOverrides = {},
  currentTurnPlayerId = 'p1',
} = {}) {
  const players = [
    { playerId: 'p1', displayName: 'Alice',  teamId: 1, seatIndex: 0, isBot: false, isGuest: false },
    { playerId: 'p2', displayName: 'Bob',    teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
    { playerId: 'p3', displayName: 'Carol',  teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
    { playerId: 'p4', displayName: 'Dave',   teamId: 2, seatIndex: 1, isBot: false, isGuest: false },
    { playerId: 'p5', displayName: 'Eve',    teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
    { playerId: 'p6', displayName: 'Frank',  teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
  ];

  const halfSuits = buildHalfSuitMap(variant);
  // Default: p1 holds first 3 low_s; p2 holds last 3 low_s; others hold something else
  const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');
  const [h0, h1, h2, h3, h4, h5] = halfSuits.get('high_s');

  const defaults = {
    p1: new Set([c0, c1, c2]),       // 3 low_s cards
    p2: new Set([c3, c4, c5]),       // 3 low_s cards
    p3: new Set([h0, h1, h2]),       // non-declared half-suit cards
    p4: new Set([h3, h4, h5]),       // non-declared half-suit cards
    p5: new Set(),
    p6: new Set(),
  };

  const hands = new Map();
  for (const pid of players.map((p) => p.playerId)) {
    hands.set(pid, handOverrides[pid] !== undefined ? handOverrides[pid] : defaults[pid]);
  }

  return {
    roomCode: 'HS27A',
    roomId: 'room-hs27a',
    variant,
    playerCount: 6,
    status: 'active',
    currentTurnPlayerId,
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
 * Build an 8-player game state (4v4).
 *
 * Team 1: p1, p2, p3, p4
 * Team 2: p5, p6, p7, p8
 *
 * low_s cards are spread one-per-player across all 8 players for maximum
 * coverage of the "all hands cleaned" requirement.
 *
 * @param {string} [variant='remove_7s']
 * @returns {Object} GameState
 */
function buildGame8(variant = 'remove_7s') {
  const players = [
    { playerId: 'p1', displayName: 'P1', teamId: 1, seatIndex: 0, isBot: false, isGuest: false },
    { playerId: 'p2', displayName: 'P2', teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
    { playerId: 'p3', displayName: 'P3', teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
    { playerId: 'p4', displayName: 'P4', teamId: 1, seatIndex: 6, isBot: false, isGuest: false },
    { playerId: 'p5', displayName: 'P5', teamId: 2, seatIndex: 1, isBot: false, isGuest: false },
    { playerId: 'p6', displayName: 'P6', teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
    { playerId: 'p7', displayName: 'P7', teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
    { playerId: 'p8', displayName: 'P8', teamId: 2, seatIndex: 7, isBot: false, isGuest: false },
  ];

  const halfSuits = buildHalfSuitMap(variant);
  // Spread low_s cards: one card per player for the first 6, p7 and p8 get nothing from it
  const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');
  const [h0, h1] = halfSuits.get('high_s');

  const hands = new Map([
    ['p1', new Set([c0])],          // 1 low_s card
    ['p2', new Set([c1])],          // 1 low_s card
    ['p3', new Set([c2])],          // 1 low_s card
    ['p4', new Set([c3])],          // 1 low_s card
    ['p5', new Set([c4])],          // 1 low_s card (opponent)
    ['p6', new Set([c5])],          // 1 low_s card (opponent)
    ['p7', new Set([h0])],          // non-declared card
    ['p8', new Set([h1])],          // non-declared card
  ]);

  return {
    roomCode: 'HS27B',
    roomId: 'room-hs27b',
    variant,
    playerCount: 8,
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

/** Assert every card from halfSuitCards is absent from every hand in gs. */
function assertAllCardsRemoved(gs, halfSuitCards) {
  for (const [pid, hand] of gs.hands) {
    for (const card of halfSuitCards) {
      expect(hand.has(card)).toBe(false);
    }
  }
}

/** Build a correct card → holder assignment from actual hands. */
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
// 1–7: applyDeclaration — correct declaration removes all 6 cards
// ---------------------------------------------------------------------------

describe('correct declaration: all 6 cards removed', () => {
  it('1. removes all 6 declared cards from the declarant\'s own hand', () => {
    const gs = buildGame6({
      handOverrides: {
        p1: new Set(buildHalfSuitMap('remove_7s').get('low_s')), // p1 holds all 6
        p2: new Set(),
        p3: new Set(),
      },
    });
    const halfSuitCards = buildHalfSuitMap('remove_7s').get('low_s');
    const assignment = Object.fromEntries(halfSuitCards.map((c) => [c, 'p1']));

    applyDeclaration(gs, 'p1', 'low_s', assignment);

    // p1 should have no low_s cards left
    const p1Hand = gs.hands.get('p1');
    for (const card of halfSuitCards) {
      expect(p1Hand.has(card)).toBe(false);
    }
  });

  it('2. removes all 6 declared cards from a teammate\'s hand (default split: p1+p2)', () => {
    const gs = buildGame6(); // p1 has c0-c2, p2 has c3-c5
    const halfSuitCards = buildHalfSuitMap('remove_7s').get('low_s');
    const assignment = buildCorrectAssignment(gs, 'low_s');

    applyDeclaration(gs, 'p1', 'low_s', assignment);

    assertAllCardsRemoved(gs, halfSuitCards);
  });

  it('3. removes all 6 cards when spread across all 3 team-1 players (2 cards each)', () => {
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');
    const gs = buildGame6({
      handOverrides: {
        p1: new Set([c0, c1]),
        p2: new Set([c2, c3]),
        p3: new Set([c4, c5]),
        p4: new Set(),
        p5: new Set(),
        p6: new Set(),
      },
    });
    const assignment = { [c0]: 'p1', [c1]: 'p1', [c2]: 'p2', [c3]: 'p2', [c4]: 'p3', [c5]: 'p3' };

    applyDeclaration(gs, 'p1', 'low_s', assignment);

    assertAllCardsRemoved(gs, [c0, c1, c2, c3, c4, c5]);
  });

  it('4. non-declared cards in all hands are NOT removed', () => {
    const gs = buildGame6(); // p3 holds high_s: h0,h1,h2; p4 holds h3,h4,h5
    const highSCards = buildHalfSuitMap('remove_7s').get('high_s');
    const assignment = buildCorrectAssignment(gs, 'low_s');

    applyDeclaration(gs, 'p1', 'low_s', assignment);

    // high_s cards must still be in their holders' hands
    const p3Hand = gs.hands.get('p3');
    const p4Hand = gs.hands.get('p4');
    for (let i = 0; i < 3; i++) {
      expect(p3Hand.has(highSCards[i])).toBe(true);
      expect(p4Hand.has(highSCards[i + 3])).toBe(true);
    }
  });

  it('5. gs.declaredSuits is updated with the declaring team after removal', () => {
    const gs = buildGame6();
    const assignment = buildCorrectAssignment(gs, 'low_s');

    applyDeclaration(gs, 'p1', 'low_s', assignment);

    expect(gs.declaredSuits.has('low_s')).toBe(true);
    expect(gs.declaredSuits.get('low_s').teamId).toBe(1);
  });

  it('6. all 6 cards removed for remove_2s variant', () => {
    const gs = buildGame6({ variant: 'remove_2s' });
    const halfSuitCards = buildHalfSuitMap('remove_2s').get('low_s');
    const assignment = buildCorrectAssignment(gs, 'low_s');

    applyDeclaration(gs, 'p1', 'low_s', assignment);

    assertAllCardsRemoved(gs, halfSuitCards);
  });

  it('7. all 6 cards removed for remove_8s variant', () => {
    const gs = buildGame6({ variant: 'remove_8s' });
    const halfSuitCards = buildHalfSuitMap('remove_8s').get('low_s');
    const assignment = buildCorrectAssignment(gs, 'low_s');

    applyDeclaration(gs, 'p1', 'low_s', assignment);

    assertAllCardsRemoved(gs, halfSuitCards);
  });
});

// ---------------------------------------------------------------------------
// 8–10: applyDeclaration — incorrect declaration still removes all 6 cards
// ---------------------------------------------------------------------------

describe('incorrect declaration: all 6 cards STILL removed', () => {
  it('8. all 6 cards still removed even when the assignment is completely wrong', () => {
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');
    const gs = buildGame6({
      handOverrides: {
        p1: new Set([c0, c1, c2]),
        p2: new Set([c3, c4, c5]),
        p3: new Set(),
        p4: new Set(),
        p5: new Set(),
        p6: new Set(),
      },
    });
    // Swap p1's and p2's cards in the assignment → incorrect
    const wrongAssignment = {
      [c0]: 'p2', [c1]: 'p2', [c2]: 'p2',
      [c3]: 'p1', [c4]: 'p1', [c5]: 'p1',
    };

    const result = applyDeclaration(gs, 'p1', 'low_s', wrongAssignment);

    expect(result.correct).toBe(false);
    assertAllCardsRemoved(gs, [c0, c1, c2, c3, c4, c5]);
  });

  it('9. cards held by opponents are also removed on an incorrect declaration', () => {
    // Hypothetical: all 6 low_s cards are held by team-2 players; team 1 declares
    // (server would reject validateDeclaration due to DECLARANT_HAS_NO_CARDS,
    // but applyDeclaration itself is side-effect-safe — we test it directly)
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');
    const gs = buildGame6({
      handOverrides: {
        p1: new Set([c0]),           // keep 1 so validation passes
        p2: new Set(),
        p3: new Set(),
        p4: new Set([c1, c2]),
        p5: new Set([c3, c4]),
        p6: new Set([c5]),
      },
    });
    // Wrong assignment: put everything on p1 (only c0 is actually theirs)
    const wrongAssignment = {
      [c0]: 'p1', [c1]: 'p1', [c2]: 'p1',
      [c3]: 'p1', [c4]: 'p1', [c5]: 'p1',
    };

    const result = applyDeclaration(gs, 'p1', 'low_s', wrongAssignment);

    expect(result.correct).toBe(false);
    // All 6 cards must be gone from every hand (including opponents)
    assertAllCardsRemoved(gs, [c0, c1, c2, c3, c4, c5]);
  });

  it('10. wrong declaration removes cards AND awards the point to the opposing team', () => {
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');
    const gs = buildGame6();
    const wrongAssignment = {
      [c0]: 'p2', [c1]: 'p2', [c2]: 'p2',
      [c3]: 'p1', [c4]: 'p1', [c5]: 'p1',
    };

    applyDeclaration(gs, 'p1', 'low_s', wrongAssignment);

    // Scores: team2 wins the point
    expect(gs.scores.team2).toBe(1);
    expect(gs.scores.team1).toBe(0);
    // Cards removed
    assertAllCardsRemoved(gs, [c0, c1, c2, c3, c4, c5]);
  });
});

// ---------------------------------------------------------------------------
// 11–13: applyForcedFailedDeclaration (timer expiry) — removes all 6 cards
// ---------------------------------------------------------------------------

describe('forced-failed declaration (timer expiry): all 6 cards removed', () => {
  it('11. all 6 declared cards removed on forced failure', () => {
    const gs = buildGame6();
    const halfSuitCards = buildHalfSuitMap('remove_7s').get('low_s');

    applyForcedFailedDeclaration(gs, 'p1', 'low_s');

    assertAllCardsRemoved(gs, halfSuitCards);
  });

  it('12. cards held by players who did NOT initiate the declare are also removed', () => {
    // p2 holds c3,c4,c5 in the default fixture — they must be removed too
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');
    const gs = buildGame6();

    // Confirm p2 has cards before the call
    expect(gs.hands.get('p2').has(c3)).toBe(true);

    applyForcedFailedDeclaration(gs, 'p1', 'low_s');

    // p2's cards must be removed
    const p2Hand = gs.hands.get('p2');
    for (const card of [c3, c4, c5]) {
      expect(p2Hand.has(card)).toBe(false);
    }
  });

  it('13. other (non-declared) cards are not touched after forced failure', () => {
    const halfSuits = buildHalfSuitMap('remove_7s');
    const highSCards = halfSuits.get('high_s');
    const gs = buildGame6();

    // p3 holds high_s cards h0,h1,h2 in the default fixture
    const p3HandBefore = new Set(gs.hands.get('p3'));

    applyForcedFailedDeclaration(gs, 'p1', 'low_s');

    // p3's non-declared cards should be untouched
    const p3HandAfter = gs.hands.get('p3');
    for (const card of p3HandBefore) {
      expect(p3HandAfter.has(card)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 14: 8-player game — all 8 hands cleaned of declared cards
// ---------------------------------------------------------------------------

describe('8-player game: all 8 hands cleaned', () => {
  it('14. all 8 players\' hands have zero cards from the declared half-suit', () => {
    // In buildGame8, p1-p6 each hold 1 low_s card, p7-p8 hold none.
    // After declaring (with a wrong-but-valid-form assignment), all 6 must be gone.
    const gs = buildGame8();
    const halfSuitCards = buildHalfSuitMap('remove_7s').get('low_s');

    // Team 1 (p1-p4) holds c0,c1,c2,c3; team 2 (p5,p6) holds c4,c5.
    // Build a correct assignment for all team-1 held cards + pretend team-2 cards
    // are held by team-1 members (wrong, but applyDeclaration accepts any assignment
    // targeting team members — correctness is evaluated per actual holder).
    // For simplicity, use a correct assignment built from actual hands.
    const assignment = buildCorrectAssignment(gs, 'low_s');
    // Note: c4 (p5) and c5 (p6) are on team 2, so cross-team assignment would be
    // rejected by validateDeclaration. Instead, test applyForcedFailedDeclaration
    // which has no assignment requirement, covering all 8 hands cleanly.

    applyForcedFailedDeclaration(gs, 'p1', 'low_s');

    // Verify all 8 players' hands contain zero low_s cards
    for (const [pid, hand] of gs.hands) {
      for (const card of halfSuitCards) {
        expect(hand.has(card)).toBe(
          false,
          `Expected ${pid} to not hold ${card} after forced declaration`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 15–18: Game state coherence after removal
// ---------------------------------------------------------------------------

describe('game state coherence after half-suit removal', () => {
  it('15. after declaration no player holds any card from the declared half-suit', () => {
    const gs = buildGame6();
    const halfSuitCards = buildHalfSuitMap('remove_7s').get('low_s');
    const assignment = buildCorrectAssignment(gs, 'low_s');

    applyDeclaration(gs, 'p1', 'low_s', assignment);

    for (const [, hand] of gs.hands) {
      for (const card of halfSuitCards) {
        expect(hand.has(card)).toBe(false);
      }
    }
  });

  it('16. asking for a card from the declared half-suit is blocked with SUIT_DECLARED', () => {
    // Setup: p4 holds a low_s card AND a non-declared card so their hand is not empty.
    // After declaring low_s, the low_s card is removed from p4 but they still have
    // the non-declared card. The server should reject an ask for the removed card
    // with SUIT_DECLARED (card lookup returns the half-suit as declared).
    const halfSuits = buildHalfSuitMap('remove_7s');
    const [c0, c1, c2, c3, c4, c5] = halfSuits.get('low_s');
    const [h0, h1, h2, h3, h4, h5] = halfSuits.get('high_s');

    const gs = buildGame6({
      handOverrides: {
        p1: new Set([c0, c1, c2, h0]),   // 3 low_s + 1 high_s (stays after declare)
        p2: new Set([c3]),
        p3: new Set(),
        p4: new Set([c4, c5, h3]),        // 2 low_s + 1 high_s (h3 stays after declare)
        p5: new Set(),
        p6: new Set(),
      },
    });

    // Declare low_s correctly (all 6 low_s cards removed from all hands)
    const assignment = buildCorrectAssignment(gs, 'low_s');
    applyDeclaration(gs, 'p1', 'low_s', assignment);

    // After declaration: p4 still holds h3 (not empty), p1 still holds h0.
    expect(gs.hands.get('p4').has(h3)).toBe(true);   // sanity: p4 non-empty
    expect(gs.hands.get('p4').has(c4)).toBe(false);   // sanity: c4 removed

    // p1 is team-1, p4 is team-2 (opponent). p1 holds h0 so can ask for high_s cards.
    // p1 tries to ask for c4 (a low_s card that is now in a declared suit).
    gs.currentTurnPlayerId = 'p1';
    const askResult = validateAsk(gs, 'p1', 'p4', c4);
    expect(askResult.valid).toBe(false);
    expect(askResult.errorCode).toBe('SUIT_DECLARED');
  });

  it('17. two sequential declarations each remove their own 6 cards independently', () => {
    const halfSuits = buildHalfSuitMap('remove_7s');
    const lowSCards  = halfSuits.get('low_s');
    const highSCards = halfSuits.get('high_s');
    const [c0, c1, c2, c3, c4, c5] = lowSCards;
    const [h0, h1, h2, h3, h4, h5] = highSCards;

    const gs = buildGame6({
      handOverrides: {
        p1: new Set([c0, c1, c2, h0, h1, h2]),  // 3 low_s + 3 high_s
        p2: new Set([c3, c4, c5, h3, h4, h5]),  // 3 low_s + 3 high_s
        p3: new Set(),
        p4: new Set(),
        p5: new Set(),
        p6: new Set(),
      },
    });

    // First declaration: low_s (correct)
    const lowAssignment = buildCorrectAssignment(gs, 'low_s');
    applyDeclaration(gs, 'p1', 'low_s', lowAssignment);

    // low_s cards gone; high_s cards still present
    assertAllCardsRemoved(gs, lowSCards);
    expect(gs.hands.get('p1').has(h0)).toBe(true);
    expect(gs.hands.get('p2').has(h3)).toBe(true);

    // Second declaration: high_s (correct)
    const highAssignment = buildCorrectAssignment(gs, 'high_s');
    applyDeclaration(gs, 'p1', 'high_s', highAssignment);

    // high_s cards also gone now
    assertAllCardsRemoved(gs, highSCards);
  });

  it('18. after declaring all 8 half-suits the game is over and all hands are empty', () => {
    const halfSuits = buildHalfSuitMap('remove_7s');
    const halfSuitIds = [...halfSuits.keys()]; // 8 ids

    // Build a game where all 48 cards are neatly distributed across p1 and p2
    const allCards = [];
    for (const [, cards] of halfSuits) allCards.push(...cards);

    const half = allCards.length / 2; // 24 each
    const handP1 = new Set(allCards.slice(0, half));
    const handP2 = new Set(allCards.slice(half));

    const gs = buildGame6({
      handOverrides: {
        p1: handP1,
        p2: handP2,
        p3: new Set(),
        p4: new Set(),
        p5: new Set(),
        p6: new Set(),
      },
    });

    // Declare all 8 half-suits in order, each time using a correct assignment
    for (const hsId of halfSuitIds) {
      if (gs.status === 'completed') break;

      // Whose turn is it? Must hold ≥1 card in the half-suit.
      const hsCards = halfSuits.get(hsId);
      const declarerId = gs.currentTurnPlayerId;

      // Build assignment from actual holders (team 1: p1, p2)
      const assignment = {};
      for (const card of hsCards) {
        for (const [pid, hand] of gs.hands) {
          if (hand.has(card)) { assignment[card] = pid; break; }
        }
      }

      // p1 or p2 may not always hold a card — find someone on team1 who does
      const declarerHand = gs.hands.get(declarerId);
      const holdsCard = hsCards.some((c) => declarerHand && declarerHand.has(c));
      if (!holdsCard) {
        // Find a team-1 player who holds at least one
        const team1Players = gs.players.filter((p) => p.teamId === 1).map((p) => p.playerId);
        const alt = team1Players.find((pid) => hsCards.some((c) => gs.hands.get(pid).has(c)));
        if (alt) gs.currentTurnPlayerId = alt;
      }

      applyDeclaration(gs, gs.currentTurnPlayerId, hsId, assignment);
    }

    expect(gs.status).toBe('completed');

    // All hands must be empty
    for (const [, hand] of gs.hands) {
      expect(hand.size).toBe(0);
    }
  });
});
