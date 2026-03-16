'use strict';

/**
 * AC 31: Last survivor on a team plays normally with no special restrictions.
 *
 * When all teammates have been eliminated (empty hands), the single remaining
 * player on a team — the "last survivor" — must be able to:
 *   1. Ask opponents for cards (validateAsk returns valid)
 *   2. Declare half-suits they hold cards in (validateDeclaration returns valid)
 *   3. Receive the turn correctly (via _resolveValidTurn)
 *   4. Have no implicit restrictions added to any game-engine function
 *
 * Additionally, when the last player on a team to be ELIMINATED has no
 * eligible teammates remaining, no choose_turn_recipient_prompt should
 * be sent (there is nobody to receive the turn).
 */

const {
  validateAsk,
  validateDeclaration,
  applyAsk,
  applyDeclaration,
  _resolveValidTurn,
  _detectNewlyEliminated,
} = require('../game/gameEngine');

const {
  createGameState,
  getCardCount,
  getPlayerTeam,
} = require('../game/gameState');

const {
  _processNewlyEliminatedPlayers,
  handleChooseTurnRecipient,
} = require('../game/gameSocketServer');

const { _clearAll, setGame, registerConnection } = require('../game/gameStore');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a 6-player game state.
 *
 * Team 1: p1 (seat 0), p2 (seat 2), p3 (seat 4)
 * Team 2: p4 (seat 1), p5 (seat 3), p6 (seat 5)
 *
 * Variant: remove_7s
 * low_s  = [1_s, 2_s, 3_s, 4_s, 5_s, 6_s]
 * high_s = [8_s, 9_s, 10_s, 11_s, 12_s, 13_s]
 * low_h  = [1_h, 2_h, 3_h, 4_h, 5_h, 6_h]
 */
function buildGs(handOverrides = {}) {
  const seats = [
    { seatIndex: 0, playerId: 'p1', displayName: 'Alice', avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 1, playerId: 'p4', displayName: 'Dave',  avatarId: null, teamId: 2, isBot: false, isGuest: false },
    { seatIndex: 2, playerId: 'p2', displayName: 'Bob',   avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 3, playerId: 'p5', displayName: 'Eve',   avatarId: null, teamId: 2, isBot: false, isGuest: false },
    { seatIndex: 4, playerId: 'p3', displayName: 'Carol', avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 5, playerId: 'p6', displayName: 'Frank', avatarId: null, teamId: 2, isBot: false, isGuest: false },
  ];
  const gs = createGameState({
    roomCode:    'SURV01',
    roomId:      'room-uuid-1',
    variant:     'remove_7s',
    playerCount: 6,
    seats,
  });

  // Apply hand overrides for predictable test state.
  for (const [playerId, cards] of Object.entries(handOverrides)) {
    const hand = gs.hands.get(playerId);
    hand.clear();
    if (Array.isArray(cards)) {
      cards.forEach((c) => hand.add(c));
    }
  }

  return gs;
}

/** Set up last-survivor scenario: p2 and p3 eliminated, p1 is the only remaining team1 player. */
function buildLastSurvivorGs() {
  const gs = buildGs({
    // p1 (last survivor on team1) holds low_s cards
    p1: ['1_s', '2_s', '3_s'],
    // p2 and p3 are eliminated (no cards)
    p2: [],
    p3: [],
    // Opponents still have cards
    p4: ['4_s', '5_s', '6_s'],
    p5: ['1_h', '2_h', '3_h'],
    p6: ['4_h', '5_h', '6_h'],
  });

  // Mark p2 and p3 as eliminated
  gs.eliminatedPlayerIds.add('p2');
  gs.eliminatedPlayerIds.add('p3');

  // It is p1's turn
  gs.currentTurnPlayerId = 'p1';

  return gs;
}

// ---------------------------------------------------------------------------
// 1. validateAsk — last survivor can ask opponents normally
// ---------------------------------------------------------------------------

describe('validateAsk — last survivor on team1', () => {
  test('last survivor can ask opponent for a card in a half-suit they hold', () => {
    const gs = buildLastSurvivorGs();
    // p1 holds 1_s, 2_s, 3_s; p4 holds 4_s, 5_s, 6_s (same low_s half-suit)
    const result = validateAsk(gs, 'p1', 'p4', '4_s');
    expect(result.valid).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  test('last survivor cannot ask eliminated teammate (wrong team check still fires)', () => {
    const gs = buildLastSurvivorGs();
    // p2 is on the same team as p1 → SAME_TEAM error
    const result = validateAsk(gs, 'p1', 'p2', '4_s');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('SAME_TEAM');
  });

  test('last survivor can ask target even if target has no cards in the half-suit', () => {
    const gs = buildLastSurvivorGs();
    // p5 holds 1_h–3_h (low_h), but p1 holds 1_s–3_s (low_s). Ask is valid because asker holds a card in the half-suit.
    const result = validateAsk(gs, 'p1', 'p5', '4_s');
    expect(result.valid).toBe(true);
  });

  test('last survivor cannot ask a player with 0 total cards', () => {
    const gs = buildLastSurvivorGs();
    // p2 has 0 cards
    const result = validateAsk(gs, 'p1', 'p2', '1_h');
    // SAME_TEAM fires first (p2 is a teammate), but if we use an opponent
    // with 0 cards, TARGET_EMPTY should fire.

    // Clear p4's hand and ask them
    gs.hands.get('p4').clear();
    const result2 = validateAsk(gs, 'p1', 'p4', '4_s');
    expect(result2.valid).toBe(false);
    expect(result2.errorCode).toBe('TARGET_EMPTY');
  });

  test('last survivor cannot ask for a card they already hold', () => {
    const gs = buildLastSurvivorGs();
    // p1 already holds 1_s
    const result = validateAsk(gs, 'p1', 'p4', '1_s');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('ALREADY_HELD');
  });

  test('last survivor cannot ask for a card in a declared half-suit', () => {
    const gs = buildLastSurvivorGs();
    // Mark low_s as declared
    gs.declaredSuits.set('low_s', { teamId: 1, declaredBy: 'p1' });
    const result = validateAsk(gs, 'p1', 'p4', '4_s');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('SUIT_DECLARED');
  });
});

// ---------------------------------------------------------------------------
// 2. validateDeclaration — last survivor can declare
// ---------------------------------------------------------------------------

describe('validateDeclaration — last survivor on team1', () => {
  test('last survivor can declare a half-suit when they hold ≥1 card from it', () => {
    const gs = buildLastSurvivorGs();
    // p1 holds 1_s, 2_s, 3_s.  Build an assignment: assign all low_s cards to p1.
    // (p1 is the only team1 player; they must receive ALL 6 cards in the assignment)
    const assignment = {
      '1_s': 'p1',
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p1',
      '5_s': 'p1',
      '6_s': 'p1',
    };
    const result = validateDeclaration(gs, 'p1', 'low_s', assignment);
    expect(result.valid).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  test('last survivor is blocked if it is not their turn', () => {
    const gs = buildLastSurvivorGs();
    gs.currentTurnPlayerId = 'p4'; // opponent's turn
    const assignment = Object.fromEntries(
      ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'].map((c) => [c, 'p1'])
    );
    const result = validateDeclaration(gs, 'p1', 'low_s', assignment);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('NOT_YOUR_TURN');
  });

  test('last survivor cannot declare a half-suit they hold no cards from', () => {
    const gs = buildLastSurvivorGs();
    // p1 holds only low_s cards; trying to declare high_s fails
    const assignment = Object.fromEntries(
      ['8_s', '9_s', '10_s', '11_s', '12_s', '13_s'].map((c) => [c, 'p1'])
    );
    const result = validateDeclaration(gs, 'p1', 'high_s', assignment);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('DECLARANT_HAS_NO_CARDS');
  });

  test('last survivor cannot assign cards to opponents', () => {
    const gs = buildLastSurvivorGs();
    // Assign one low_s card to p4 (an opponent)
    const assignment = {
      '1_s': 'p1',
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p4', // wrong team
      '5_s': 'p1',
      '6_s': 'p1',
    };
    const result = validateDeclaration(gs, 'p1', 'low_s', assignment);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('CROSS_TEAM_ASSIGN');
  });
});

// ---------------------------------------------------------------------------
// 3. applyAsk — last survivor's turn stays or passes correctly
// ---------------------------------------------------------------------------

describe('applyAsk — last survivor turn handling', () => {
  test('successful ask keeps the turn with the last survivor', () => {
    const gs = buildLastSurvivorGs();
    // p1 asks p4 for 4_s (which p4 holds)
    const result = applyAsk(gs, 'p1', 'p4', '4_s');
    expect(result.success).toBe(true);
    expect(result.newTurnPlayerId).toBe('p1');
    expect(gs.currentTurnPlayerId).toBe('p1');
  });

  test('failed ask passes turn to the target opponent, not blocked by last-survivor status', () => {
    const gs = buildLastSurvivorGs();
    // p1 asks p4 for a card p4 does NOT hold (e.g. 1_h)
    // But first give p1 a low_h card so the ask is structurally valid.
    gs.hands.get('p1').add('1_h');
    // Give p4 a low_h card so the deny is meaningful (p4 doesn't hold 3_h).
    gs.hands.get('p4').add('2_h');
    const result = applyAsk(gs, 'p1', 'p4', '3_h'); // p4 doesn't hold 3_h
    expect(result.success).toBe(false);
    // Turn passes to p4 (the target), not to an eliminated teammate
    expect(result.newTurnPlayerId).toBe('p4');
  });
});

// ---------------------------------------------------------------------------
// 4. _resolveValidTurn — returns last survivor when candidates are exhausted
// ---------------------------------------------------------------------------

describe('_resolveValidTurn — last survivor scenarios', () => {
  test('returns last survivor immediately when they have cards', () => {
    const gs = buildLastSurvivorGs();
    // p1 is the last survivor; resolving from p1 should return p1 unchanged
    const next = _resolveValidTurn(gs, 'p1');
    expect(next).toBe('p1');
  });

  test('resolves to last survivor when turn is for an eliminated teammate', () => {
    const gs = buildLastSurvivorGs();
    // Resolve from p2 (eliminated, no cards): should find p1 (last survivor)
    gs.turnRecipients = new Map();
    const next = _resolveValidTurn(gs, 'p2');
    expect(next).toBe('p1');
  });

  test('resolves to last survivor when turn is for the other eliminated teammate', () => {
    const gs = buildLastSurvivorGs();
    // Resolve from p3 (eliminated, no cards): should also find p1
    gs.turnRecipients = new Map();
    const next = _resolveValidTurn(gs, 'p3');
    expect(next).toBe('p1');
  });

  test('uses stored turnRecipient when resolving for an eliminated player', () => {
    const gs = buildLastSurvivorGs();
    // p2 has designated p1 as turn recipient
    gs.turnRecipients = new Map([['p2', 'p1']]);
    const next = _resolveValidTurn(gs, 'p2');
    expect(next).toBe('p1');
  });

  test('falls back to any player with cards when all team1 members are empty', () => {
    const gs = buildLastSurvivorGs();
    // Eliminate p1 too (all team1 members now have no cards)
    gs.hands.get('p1').clear();
    gs.eliminatedPlayerIds.add('p1');
    // Resolving from p1 should return any team2 player with cards (e.g. p4, p5, or p6)
    const next = _resolveValidTurn(gs, 'p1');
    expect(['p4', 'p5', 'p6']).toContain(next);
  });
});

// ---------------------------------------------------------------------------
// 5. _processNewlyEliminatedPlayers — last survivor is listed as recipient
// ---------------------------------------------------------------------------

describe('_processNewlyEliminatedPlayers — last survivor is the sole recipient', () => {
  beforeEach(() => {
    _clearAll();
  });

  function buildWithConnections(botTeammates = false) {
    const gs = buildGs({
      p1: ['1_s', '2_s', '3_s'], // last survivor
      p2: [],                     // just eliminated
      p3: [],                     // already eliminated
      p4: ['4_s', '5_s', '6_s'],
      p5: ['1_h', '2_h', '3_h'],
      p6: ['4_h', '5_h', '6_h'],
    });
    gs.eliminatedPlayerIds.add('p3'); // p3 already eliminated before this call
    gs.currentTurnPlayerId = 'p1';

    if (botTeammates) {
      const p2 = gs.players.find((p) => p.playerId === 'p2');
      p2.isBot = true;
    }

    const broadcasts = [];
    const targeted = {};

    gs.players.forEach((p) => {
      const ws = {
        readyState: 1,
        send: (data) => {
          const parsed = JSON.parse(data);
          broadcasts.push({ to: p.playerId, msg: parsed });
          if (!targeted[p.playerId]) targeted[p.playerId] = [];
          targeted[p.playerId].push(parsed);
        },
      };
      registerConnection('SURV01', p.playerId, ws);
    });

    setGame('SURV01', gs);
    gs.turnRecipients = new Map();

    return { gs, broadcasts, targeted };
  }

  test('player_eliminated broadcast is sent to all players', () => {
    const { gs, broadcasts } = buildWithConnections();
    // Eliminate p2 now
    gs.eliminatedPlayerIds.add('p2');

    _processNewlyEliminatedPlayers(gs, ['p2']);

    const elimEvents = broadcasts.filter((b) => b.msg.type === 'player_eliminated');
    expect(elimEvents.length).toBe(6); // all 6 players receive it
    expect(elimEvents[0].msg.playerId).toBe('p2');
  });

  test('choose_turn_recipient_prompt lists only the last survivor as eligible', () => {
    const { gs, targeted } = buildWithConnections();
    gs.eliminatedPlayerIds.add('p2');

    _processNewlyEliminatedPlayers(gs, ['p2']);

    const p2Msgs = targeted['p2'] || [];
    const prompt = p2Msgs.find((m) => m.type === 'choose_turn_recipient_prompt');
    expect(prompt).toBeDefined();
    // Only p1 (the last survivor) should appear
    const recipientIds = prompt.eligibleTeammates.map((t) => t.playerId);
    expect(recipientIds).toEqual(['p1']);
    expect(recipientIds).not.toContain('p3'); // already eliminated
    expect(recipientIds).not.toContain('p4'); // wrong team
  });

  test('bot eliminated with only one eligible teammate: auto-picks the last survivor', () => {
    const { gs } = buildWithConnections(true); // p2 is a bot
    gs.eliminatedPlayerIds.add('p2');

    _processNewlyEliminatedPlayers(gs, ['p2']);

    expect(gs.turnRecipients.has('p2')).toBe(true);
    expect(gs.turnRecipients.get('p2')).toBe('p1'); // last survivor
  });

  test('no choose_turn_recipient_prompt sent when no eligible teammates remain', () => {
    // All team1 members are eliminated simultaneously (edge case)
    const { gs, targeted } = buildWithConnections();
    // Eliminate p1 as well (now the whole team is gone)
    gs.hands.get('p1').clear();
    gs.eliminatedPlayerIds.add('p1');
    gs.eliminatedPlayerIds.add('p2');

    // Call with p2 being newly eliminated; p1 is also out
    _processNewlyEliminatedPlayers(gs, ['p2']);

    const p2Msgs = targeted['p2'] || [];
    const prompt = p2Msgs.find((m) => m.type === 'choose_turn_recipient_prompt');
    // With no eligible teammates, no prompt should be sent
    expect(prompt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. applyDeclaration — last survivor scores correctly
// ---------------------------------------------------------------------------

describe('applyDeclaration — last survivor full flow', () => {
  test('last survivor declares correctly: team1 scores, cards removed, turn stays', () => {
    const gs = buildLastSurvivorGs();
    // Give p1 all 6 low_s cards so they can declare
    gs.hands.get('p1').clear();
    ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'].forEach((c) => gs.hands.get('p1').add(c));

    // p4 needs other cards so the game isn't over from the start
    gs.hands.get('p4').clear();
    gs.hands.get('p4').add('1_h');

    const assignment = Object.fromEntries(
      ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'].map((c) => [c, 'p1'])
    );

    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);

    expect(result.correct).toBe(true);
    expect(result.winningTeam).toBe(1);
    expect(gs.scores.team1).toBe(1);
    expect(gs.scores.team2).toBe(0);
    // All low_s cards removed
    expect(gs.hands.get('p1').size).toBe(0); // p1 held only low_s
    expect(gs.declaredSuits.has('low_s')).toBe(true);
  });

  test('last survivor declares incorrectly: opponent scores, cards removed, turn passes', () => {
    const gs = buildLastSurvivorGs();
    // p1 holds 1_s, 2_s, 3_s; p4 holds 4_s, 5_s, 6_s
    // p1 incorrectly assigns 4_s to themselves (actually held by p4)
    const wrongAssignment = {
      '1_s': 'p1',
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p1', // wrong: p4 holds this
      '5_s': 'p1', // wrong: p4 holds this
      '6_s': 'p1', // wrong: p4 holds this
    };

    const result = applyDeclaration(gs, 'p1', 'low_s', wrongAssignment);

    expect(result.correct).toBe(false);
    expect(result.winningTeam).toBe(2);
    expect(gs.scores.team2).toBe(1);
    // Turn passes to team2 opponent
    expect(['p4', 'p5', 'p6']).toContain(gs.currentTurnPlayerId);
  });
});

// ---------------------------------------------------------------------------
// 7. Integration — full ask + declare cycle with last survivor
// ---------------------------------------------------------------------------

describe('Integration — last survivor full cycle', () => {
  test('last survivor acquires card via ask, then successfully declares', () => {
    // Setup: p1 has 1_s,2_s,3_s; p4 has 4_s,5_s,6_s
    // Step 1: p1 asks p4 for 4_s → success
    // Step 2: p1 asks p4 for 5_s → success
    // Step 3: p1 asks p4 for 6_s → success
    // Step 4: p1 declares low_s correctly

    const gs = buildLastSurvivorGs();
    // Ensure p4 only has low_s cards for simplicity
    gs.hands.get('p4').clear();
    gs.hands.get('p4').add('4_s');
    gs.hands.get('p4').add('5_s');
    gs.hands.get('p4').add('6_s');

    // Add other cards to p5 and p6 so game doesn't end prematurely
    gs.hands.get('p5').clear();
    gs.hands.get('p5').add('1_h');
    gs.hands.get('p6').clear();
    gs.hands.get('p6').add('2_h');

    // Step 1
    let askResult = applyAsk(gs, 'p1', 'p4', '4_s');
    expect(askResult.success).toBe(true);
    expect(gs.currentTurnPlayerId).toBe('p1');

    // Step 2
    askResult = applyAsk(gs, 'p1', 'p4', '5_s');
    expect(askResult.success).toBe(true);
    expect(gs.currentTurnPlayerId).toBe('p1');

    // Step 3
    askResult = applyAsk(gs, 'p1', 'p4', '6_s');
    expect(askResult.success).toBe(true);
    // p4 now has 0 cards and is the turn candidate if ask fails, but it succeeded
    expect(gs.currentTurnPlayerId).toBe('p1');

    // Now p1 has all 6 low_s cards
    expect([...gs.hands.get('p1')].sort()).toEqual(['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'].sort());

    // Step 4: declare
    const assignment = Object.fromEntries(
      ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'].map((c) => [c, 'p1'])
    );
    const declResult = applyDeclaration(gs, 'p1', 'low_s', assignment);
    expect(declResult.correct).toBe(true);
    expect(declResult.winningTeam).toBe(1);
    expect(gs.scores.team1).toBe(1);
  });
});
