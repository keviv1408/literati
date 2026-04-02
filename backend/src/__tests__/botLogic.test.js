'use strict';

/**
 * Unit tests for botLogic.js
 *
 * Coverage:
 *   decideBotMove:
 *     1. Returns { action: 'ask' } or { action: 'declare' } (never undefined)
 *     2. When public information uniquely identifies all 6 cards of a half-suit,
 *        action is 'declare'
 *     3. When bot knows an opponent has a specific card it needs, action is 'ask'
 *     4. When bot knows nothing, still returns a valid action (ask or declare)
 *     5. All returned targetId values are opponents (not teammates)
 *     6. Returned cardId for 'ask' is in same half-suit as something bot holds
 *   updateKnowledgeAfterAsk:
 *     7. Failed ask records that target does NOT have the card
 *     8. Successful ask records that asker HAS the card
 *   updateKnowledgeAfterDeclaration:
 *     9. After correct declaration, all players known to not have those cards
 *   team signaling intent memory:
 *     10. Teammate asks create a suit-intent signal
 *     11. Declaring a suit clears any stale signal for that suit
 *     12. Bots prefer teammate-signaled suits when fallback asks are otherwise similar
 */

const {
  decideBotMove,
  updateKnowledgeAfterAsk,
  updateKnowledgeAfterDeclaration,
  updateTeamIntentAfterAsk,
  updateTeamIntentAfterDeclaration,
} = require('../game/botLogic');
const { buildCardToHalfSuitMap } = require('../game/halfSuits');
const { getPlayerTeam } = require('../game/gameState');

// ---------------------------------------------------------------------------
// Helper: build test game state with known card distributions
// ---------------------------------------------------------------------------

/**
 * Team 1 (bot's team): bot (p1), p2, p3
 * Team 2 (opponents):  p4, p5, p6
 *
 * Card layout (remove_7s):
 *   low_s (6 cards): 1_s,2_s,3_s,4_s,5_s,6_s
 *   high_s (6 cards): 8_s,9_s,10_s,11_s,12_s,13_s
 *   low_h (6 cards): 1_h,2_h,3_h,4_h,5_h,6_h
 *   high_h (6 cards): 8_h,9_h,10_h,11_h,12_h,13_h
 *   low_d, high_d, low_c, high_c similarly
 */
function buildBotTestGame(handOverrides) {
  const players = [
    { playerId: 'p1', displayName: 'Bot',  avatarId: null, teamId: 1, seatIndex: 0, isBot: true,  isGuest: false },
    { playerId: 'p2', displayName: 'P2',   avatarId: null, teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
    { playerId: 'p3', displayName: 'P3',   avatarId: null, teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
    { playerId: 'p4', displayName: 'P4',   avatarId: null, teamId: 2, seatIndex: 1, isBot: false, isGuest: false },
    { playerId: 'p5', displayName: 'P5',   avatarId: null, teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
    { playerId: 'p6', displayName: 'P6',   avatarId: null, teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
  ];

  const defaultHands = new Map([
    ['p1', new Set(['1_s', '2_s', '3_s'])],          // team1 bot: holds low_s partial
    ['p2', new Set(['4_s', '5_s', '6_s'])],          // team1: holds rest of low_s
    ['p3', new Set(['8_s', '9_s', '10_s'])],         // team1: holds high_s partial
    ['p4', new Set(['11_s', '12_s', '13_s'])],       // team2: holds rest of high_s
    ['p5', new Set(['1_h', '2_h', '3_h'])],          // team2: holds low_h partial
    ['p6', new Set(['4_h', '5_h', '6_h'])],          // team2: holds rest of low_h
  ]);

  const hands = handOverrides || defaultHands;

  return {
    roomCode: 'BOT1',
    roomId: 'room-bot-1',
    variant: 'remove_7s',
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
    teamIntentMemory: new Map(),
    moveHistory: [],
  };
}

// ---------------------------------------------------------------------------
// decideBotMove — basic validity
// ---------------------------------------------------------------------------

describe('decideBotMove — basic validity', () => {
  it('returns an object with action "ask" or "declare" (never undefined)', () => {
    const gs = buildBotTestGame();
    const move = decideBotMove(gs, 'p1');
    expect(move).toBeDefined();
    expect(['ask', 'declare', 'pass']).toContain(move.action);
  });

  it('never returns undefined', () => {
    const gs = buildBotTestGame();
    const move = decideBotMove(gs, 'p1');
    expect(move).not.toBeUndefined();
  });

  it('action is a string', () => {
    const gs = buildBotTestGame();
    const move = decideBotMove(gs, 'p1');
    expect(typeof move.action).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// decideBotMove — declare when public information is sufficient
// ---------------------------------------------------------------------------

describe('decideBotMove — declares when public information uniquely identifies a half-suit', () => {
  it('returns { action: "declare" } when team holds all 6 low_s cards', () => {
    // Give all low_s cards to team-1 players
    const hands = new Map([
      ['p1', new Set(['1_s', '2_s', '3_s'])],
      ['p2', new Set(['4_s', '5_s', '6_s'])],
      ['p3', new Set(['8_s'])],             // keep p3 with a card
      ['p4', new Set(['11_s', '12_s'])],
      ['p5', new Set(['1_h', '2_h'])],
      ['p6', new Set(['3_h', '4_h'])],
    ]);
    const gs = buildBotTestGame(hands);
    const move = decideBotMove(gs, 'p1');
    expect(move.action).toBe('declare');
  });

  it('declare action includes halfSuitId', () => {
    const hands = new Map([
      ['p1', new Set(['1_s', '2_s', '3_s'])],
      ['p2', new Set(['4_s', '5_s', '6_s'])],
      ['p3', new Set(['8_s'])],
      ['p4', new Set(['11_s', '12_s'])],
      ['p5', new Set(['1_h', '2_h'])],
      ['p6', new Set(['3_h', '4_h'])],
    ]);
    const gs = buildBotTestGame(hands);
    const move = decideBotMove(gs, 'p1');
    expect(move.action).toBe('declare');
    expect(move.halfSuitId).toBe('low_s');
  });

  it('declare action includes assignment object covering all 6 cards', () => {
    const hands = new Map([
      ['p1', new Set(['1_s', '2_s', '3_s'])],
      ['p2', new Set(['4_s', '5_s', '6_s'])],
      ['p3', new Set(['8_s'])],
      ['p4', new Set(['11_s', '12_s'])],
      ['p5', new Set(['1_h', '2_h'])],
      ['p6', new Set(['3_h', '4_h'])],
    ]);
    const gs = buildBotTestGame(hands);
    const move = decideBotMove(gs, 'p1');
    expect(move.action).toBe('declare');
    expect(Object.keys(move.assignment)).toHaveLength(6);
  });

  it('does not declare when team holds all 6 cards but teammate ownership is still ambiguous', () => {
    const hands = new Map([
      ['p1', new Set(['1_s', '8_h'])],
      ['p2', new Set(['2_s', '3_s'])],
      ['p3', new Set(['4_s', '5_s', '6_s'])],
      ['p4', new Set(['9_h'])],
      ['p5', new Set(['10_h'])],
      ['p6', new Set(['11_h'])],
    ]);
    const gs = buildBotTestGame(hands);

    // Give the bot a clearly better public ask so the test stays deterministic.
    gs.botKnowledge.set('p4', new Map([['9_h', true]]));

    const move = decideBotMove(gs, 'p1');
    expect(move).toEqual({ action: 'ask', targetId: 'p4', cardId: '9_h' });
  });
});

// ---------------------------------------------------------------------------
// decideBotMove — ask when knowledge is available
// ---------------------------------------------------------------------------

describe('decideBotMove — asks for a known card', () => {
  it('returns { action: "ask" } when opponent is known to have a card the bot needs', () => {
    const gs = buildBotTestGame();
    // Bot (p1) holds 1_s,2_s,3_s (low_s). Mark p4 as known to have 4_s (low_s).
    // p4 is on team 2 (opponent). Give p4 a low_s card.
    gs.hands.get('p4').add('4_s'); // p4 now holds 4_s
    // Remove 4_s from p2 to avoid confusion
    gs.hands.get('p2').delete('4_s');
    // Set knowledge: p4 has 4_s
    gs.botKnowledge.set('p4', new Map([['4_s', true]]));

    const move = decideBotMove(gs, 'p1');
    expect(move.action).toBe('ask');
    expect(move.targetId).toBe('p4');
    expect(move.cardId).toBe('4_s');
  });

  it('avoids re-asking an opponent for a card they are known not to have when another opponent remains possible', () => {
    const hands = new Map([
      ['p1', new Set(['1_s', '2_s', '3_s', '5_s', '6_s'])],
      ['p2', new Set(['8_s'])],
      ['p3', new Set(['8_h'])],
      ['p4', new Set(['9_h'])],
      ['p5', new Set(['10_h'])],
      ['p6', new Set()],
    ]);
    const gs = buildBotTestGame(hands);

    updateKnowledgeAfterAsk(gs, 'p1', 'p4', '4_s', false);

    const move = decideBotMove(gs, 'p1');
    expect(move).toEqual({ action: 'ask', targetId: 'p5', cardId: '4_s' });
  });

  it('can ask the same opponent for that card again once knowledge says they gained it', () => {
    const hands = new Map([
      ['p1', new Set(['1_s', '2_s', '3_s', '5_s', '6_s'])],
      ['p2', new Set(['8_s'])],
      ['p3', new Set(['8_h'])],
      ['p4', new Set(['4_s', '9_h'])],
      ['p5', new Set(['10_h'])],
      ['p6', new Set()],
    ]);
    const gs = buildBotTestGame(hands);

    updateKnowledgeAfterAsk(gs, 'p1', 'p4', '4_s', false);
    updateKnowledgeAfterAsk(gs, 'p4', 'p5', '4_s', true);

    const move = decideBotMove(gs, 'p1');
    expect(move).toEqual({ action: 'ask', targetId: 'p4', cardId: '4_s' });
  });

  it('when asking, targetId is an opponent (not a teammate)', () => {
    const gs = buildBotTestGame();
    const move = decideBotMove(gs, 'p1');
    if (move.action === 'ask') {
      const targetTeam = getPlayerTeam(gs, move.targetId);
      const botTeam = getPlayerTeam(gs, 'p1');
      expect(targetTeam).not.toBe(botTeam);
    }
  });

  it('when asking, cardId is in same half-suit as a card the bot holds', () => {
    const gs = buildBotTestGame();
    const move = decideBotMove(gs, 'p1');
    if (move.action === 'ask') {
      const cardToHalfSuit = buildCardToHalfSuitMap('remove_7s');
      const askedHalfSuit = cardToHalfSuit.get(move.cardId);
      // Check that the bot has at least one card in that same half-suit
      const botHand = gs.hands.get('p1');
      let botHasInSameSuit = false;
      for (const c of botHand) {
        if (cardToHalfSuit.get(c) === askedHalfSuit) {
          botHasInSameSuit = true;
          break;
        }
      }
      expect(botHasInSameSuit).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// decideBotMove — fallback when no knowledge
// ---------------------------------------------------------------------------

describe('decideBotMove — fallback when bot knows nothing', () => {
  it('still returns a valid action when knowledge is empty', () => {
    const gs = buildBotTestGame();
    // Ensure empty knowledge
    gs.botKnowledge.clear();
    const move = decideBotMove(gs, 'p1');
    expect(['ask', 'declare', 'pass']).toContain(move.action);
  });

  it('ask action has a valid targetId (not self, not teammate)', () => {
    const gs = buildBotTestGame();
    gs.botKnowledge.clear();
    const move = decideBotMove(gs, 'p1');
    if (move.action === 'ask') {
      expect(move.targetId).not.toBe('p1');
      const targetTeam = getPlayerTeam(gs, move.targetId);
      expect(targetTeam).toBe(2); // team 2 = opponents
    }
  });
});

// ---------------------------------------------------------------------------
// updateKnowledgeAfterAsk
// ---------------------------------------------------------------------------

describe('updateKnowledgeAfterAsk', () => {
  let gs;

  beforeEach(() => {
    gs = buildBotTestGame();
  });

  it('failed ask: records that target does NOT have the card (false)', () => {
    updateKnowledgeAfterAsk(gs, 'p1', 'p4', '4_s', false);
    const knowledge = gs.botKnowledge.get('p4');
    expect(knowledge).toBeDefined();
    expect(knowledge.get('4_s')).toBe(false);
  });

  it('successful ask: records that asker HAS the card (true)', () => {
    updateKnowledgeAfterAsk(gs, 'p1', 'p4', '11_s', true);
    const askerKnowledge = gs.botKnowledge.get('p1');
    expect(askerKnowledge).toBeDefined();
    expect(askerKnowledge.get('11_s')).toBe(true);
  });

  it('successful ask: records that target NO LONGER has the card (false)', () => {
    updateKnowledgeAfterAsk(gs, 'p1', 'p4', '11_s', true);
    const targetKnowledge = gs.botKnowledge.get('p4');
    expect(targetKnowledge).toBeDefined();
    expect(targetKnowledge.get('11_s')).toBe(false);
  });

  it('failed ask does NOT mark asker as having the card', () => {
    updateKnowledgeAfterAsk(gs, 'p1', 'p4', '4_s', false);
    const askerKnowledge = gs.botKnowledge.get('p1');
    // Either undefined or explicitly not true
    if (askerKnowledge && askerKnowledge.has('4_s')) {
      expect(askerKnowledge.get('4_s')).not.toBe(true);
    } else {
      expect(true).toBe(true); // no knowledge entry is fine
    }
  });

  it('multiple asks accumulate in botKnowledge', () => {
    updateKnowledgeAfterAsk(gs, 'p1', 'p4', '4_s', false);
    updateKnowledgeAfterAsk(gs, 'p1', 'p5', '1_h', false);
    expect(gs.botKnowledge.get('p4').get('4_s')).toBe(false);
    expect(gs.botKnowledge.get('p5').get('1_h')).toBe(false);
  });

  it('successful ask overrides earlier failed knowledge for the new holder', () => {
    updateKnowledgeAfterAsk(gs, 'p1', 'p4', '4_s', false);
    updateKnowledgeAfterAsk(gs, 'p4', 'p5', '4_s', true);

    expect(gs.botKnowledge.get('p4').get('4_s')).toBe(true);
    expect(gs.botKnowledge.get('p5').get('4_s')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateKnowledgeAfterDeclaration
// ---------------------------------------------------------------------------

describe('updateKnowledgeAfterDeclaration', () => {
  let gs;

  beforeEach(() => {
    gs = buildBotTestGame();
  });

  it('correct declaration: all players marked as NOT having those cards', () => {
    const assignment = {
      '1_s': 'p1', '2_s': 'p1', '3_s': 'p1',
      '4_s': 'p2', '5_s': 'p2', '6_s': 'p2',
    };
    updateKnowledgeAfterDeclaration(gs, 'low_s', assignment, true);

    // For each card in the assignment, all players should be marked false
    const lowSCards = ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'];
    for (const player of gs.players) {
      const knowledge = gs.botKnowledge.get(player.playerId);
      if (knowledge) {
        for (const card of lowSCards) {
          if (knowledge.has(card)) {
            expect(knowledge.get(card)).toBe(false);
          }
        }
      }
    }
  });

  it('incorrect declaration: knowledge not updated (cards location remains uncertain)', () => {
    const assignment = {
      '1_s': 'p1', '2_s': 'p1', '3_s': 'p1',
      '4_s': 'p2', '5_s': 'p2', '6_s': 'p2',
    };
    updateKnowledgeAfterDeclaration(gs, 'low_s', assignment, false);
    // After incorrect declaration, the function doesn't update knowledge (by design)
    // botKnowledge should remain empty or at least not have these entries as true
    // The actual cards are still removed from play, but inference doesn't record positions
    // Just verify it doesn't throw and doesn't set any to true
    for (const player of gs.players) {
      const knowledge = gs.botKnowledge.get(player.playerId);
      if (knowledge) {
        for (const [, val] of knowledge) {
          expect(val).not.toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Team signaling intent memory
// ---------------------------------------------------------------------------

describe('team signaling intent memory', () => {
  let gs;

  beforeEach(() => {
    gs = buildBotTestGame();
  });

  it('records teammate suit intent after an ask', () => {
    updateTeamIntentAfterAsk(gs, 'p2', '11_s', false);

    const teamSignals = gs.teamIntentMemory.get(1);
    expect(teamSignals).toBeDefined();
    expect(teamSignals.get('high_s')).toMatchObject({
      sourcePlayerId: 'p2',
      lastOutcome: 'failure',
    });
    expect(teamSignals.get('high_s').strength).toBeGreaterThan(0);
  });

  it('clears a half-suit intent signal after that half-suit is declared', () => {
    updateTeamIntentAfterAsk(gs, 'p2', '11_s', true);
    updateTeamIntentAfterDeclaration(gs, 'high_s');

    expect(gs.teamIntentMemory.get(1)?.has('high_s')).toBe(false);
  });

  it('prefers a teammate-signaled suit when fallback asks are otherwise similar', () => {
    const hands = new Map([
      ['p1', new Set(['1_s', '2_s', '3_s', '4_s', '5_s', '8_h', '9_h', '10_h', '11_h', '12_h'])],
      ['p2', new Set(['1_c'])],
      ['p3', new Set(['1_d'])],
      ['p4', new Set(['6_s'])],
      ['p5', new Set(['13_h'])],
      ['p6', new Set(['2_c'])],
    ]);
    const gsWithSignal = buildBotTestGame(hands);

    updateTeamIntentAfterAsk(gsWithSignal, 'p2', '13_h', false);

    const move = decideBotMove(gsWithSignal, 'p1');
    expect(move.action).toBe('ask');
    expect(move.cardId).toBe('13_h');
  });
});
