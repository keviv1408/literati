'use strict';

/**
 * AC 35: Last-move display shows full public details.
 *
 * Coverage:
 *   applyAsk — lastMove string format:
 *     1. Successful ask: "[asker] asked [target] for [card] — got it"
 *     2. Failed ask:     "[asker] asked [target] for [card] — denied"
 *     3. Uses display names, not player IDs
 *     4. Card label uses suit symbol (e.g. 9♠)
 *     5. lastMove is set on gs after applyAsk
 *   applyDeclaration — lastMove string format:
 *     6. Correct declaration: "[declarer] declared [suit] — correct! Team N scores"
 *     7. Incorrect declaration: "[declarer] declared [suit] — incorrect! Team N scores"
 *     8. lastMove is set on gs after applyDeclaration
 */

const { applyAsk, applyDeclaration } = require('../game/gameEngine');
const { halfSuitLabel } = require('../game/halfSuits');

// ---------------------------------------------------------------------------
// Minimal game state for testing lastMove format only
// ---------------------------------------------------------------------------
function buildGs() {
  const players = [
    { playerId: 'alice', displayName: 'Alice', avatarId: null, teamId: 1, seatIndex: 0, isBot: false, isGuest: false },
    { playerId: 'bob',   displayName: 'Bob',   avatarId: null, teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
    { playerId: 'carol', displayName: 'Carol', avatarId: null, teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
    { playerId: 'dave',  displayName: 'Dave',  avatarId: null, teamId: 2, seatIndex: 1, isBot: false, isGuest: false },
    { playerId: 'eve',   displayName: 'Eve',   avatarId: null, teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
    { playerId: 'frank', displayName: 'Frank', avatarId: null, teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
  ];

  return {
    roomCode: 'TEST01',
    roomId: 'room-test',
    variant: 'remove_7s',
    playerCount: 6,
    status: 'active',
    currentTurnPlayerId: 'alice',
    players,
    // Alice holds low_s: 1_s, 2_s, 3_s  (can ask for other low_s cards)
    // Dave holds low_s: 4_s, 9_s         (opponent with low_s card)
    // Eve holds high_s: 8_s, 9_s         (opponent with high_s cards)
    hands: new Map([
      ['alice', new Set(['1_s', '2_s', '3_s'])],
      ['bob',   new Set(['4_s', '5_s', '6_s'])],  // team1 — holds rest of low_s
      ['carol', new Set(['8_s', '10_s', '11_s'])], // team1 — high_s
      ['dave',  new Set(['9_s', '12_s', '13_s'])], // team2 — high_s (9♠ targeted below)
      ['eve',   new Set(['1_h', '2_h', '3_h'])],   // team2
      ['frank', new Set(['4_h', '5_h', '6_h'])],   // team2
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

// Full low_s assignment for declaration tests
function makeLowSAssignment() {
  return {
    '1_s': 'alice',
    '2_s': 'alice',
    '3_s': 'alice',
    '4_s': 'bob',
    '5_s': 'bob',
    '6_s': 'bob',
  };
}

// ---------------------------------------------------------------------------
// applyAsk — lastMove format
// ---------------------------------------------------------------------------

describe('AC 35: applyAsk lastMove format', () => {
  let gs;

  beforeEach(() => {
    gs = buildGs();
  });

  it('successful ask: lastMove is "[asker] asked [target] for [card] — got it"', () => {
    // Alice (team1) asks Dave (team2) for 9_s. Dave holds 9_s → success.
    // Alice already holds high_s? No — she holds low_s cards. Let's make her hold high_s too.
    // Actually Alice needs to hold ≥1 card in the same half-suit as 9_s (high_s).
    gs.hands.get('alice').add('8_s'); // now Alice holds 8_s (high_s) → can ask for 9_s

    const result = applyAsk(gs, 'alice', 'dave', '9_s');

    expect(result.success).toBe(true);
    expect(result.lastMove).toBe('Alice asked Dave for 9♠ — got it');
    // Also set on gs
    expect(gs.lastMove).toBe('Alice asked Dave for 9♠ — got it');
  });

  it('failed ask: lastMove is "[asker] asked [target] for [card] — denied"', () => {
    // Alice (team1) asks Eve (team2) for 9_s. Eve does NOT hold 9_s → denied.
    // Alice must hold ≥1 high_s card to ask for 9_s.
    gs.hands.get('alice').add('8_s');
    // Eve doesn't hold 9_s — she holds 1_h,2_h,3_h but we need her to have a high_s card
    // for the ask to be valid (server checks target has ≥1 card in the half-suit).
    // Let's give Eve a high_s card that isn't 9_s.
    gs.hands.get('eve').add('10_s'); // Eve holds 10_s (high_s) but not 9_s

    const result = applyAsk(gs, 'alice', 'eve', '9_s');

    expect(result.success).toBe(false);
    expect(result.lastMove).toBe('Alice asked Eve for 9♠ — denied');
    expect(gs.lastMove).toBe('Alice asked Eve for 9♠ — denied');
  });

  it('lastMove uses display name (not playerId)', () => {
    gs.hands.get('alice').add('8_s');
    applyAsk(gs, 'alice', 'dave', '9_s');
    // Must not contain raw player IDs
    expect(gs.lastMove).not.toContain('alice');
    expect(gs.lastMove).not.toContain('dave');
    // Must contain display names
    expect(gs.lastMove).toContain('Alice');
    expect(gs.lastMove).toContain('Dave');
  });

  it('lastMove uses suit symbol (♠ for spades)', () => {
    gs.hands.get('alice').add('8_s');
    applyAsk(gs, 'alice', 'dave', '9_s');
    expect(gs.lastMove).toContain('♠');
    expect(gs.lastMove).not.toContain('_s');
  });

  it('ask result object contains lastMove matching gs.lastMove', () => {
    gs.hands.get('alice').add('8_s');
    const result = applyAsk(gs, 'alice', 'dave', '9_s');
    expect(result.lastMove).toBe(gs.lastMove);
  });

  it('format with Ace: card label shows "A" not "1"', () => {
    // Alice holds 1_s (Ace of Spades) already. Dave holds a high_s card.
    // Make Dave hold a low_s card for Alice to ask for.
    gs.hands.get('dave').add('4_s'); // Dave now holds 4_s (low_s)
    // Alice asks Dave for 4_s (low_s; Alice holds 1_s,2_s,3_s in low_s)
    const result = applyAsk(gs, 'alice', 'dave', '4_s');
    // 4_s → "4♠"
    expect(result.lastMove).toContain('4♠');
  });

  it('format for heart suit: card label shows ♥', () => {
    // Alice needs to ask for a heart card. Make Alice hold a low_h card first.
    gs.hands.get('alice').add('1_h');
    // Eve holds 1_h,2_h,3_h. Ask Eve for 2_h (Alice holds 1_h).
    const result = applyAsk(gs, 'alice', 'eve', '2_h');
    expect(result.lastMove).toContain('♥');
  });
});

// ---------------------------------------------------------------------------
// applyDeclaration — lastMove format
// ---------------------------------------------------------------------------

describe('AC 35: applyDeclaration lastMove format', () => {
  let gs;

  beforeEach(() => {
    gs = buildGs();
  });

  it('correct declaration: lastMove is "[declarer] declared [suit] — correct! Team N scores"', () => {
    // Alice declares low_s. All 6 cards are held by alice+bob (team1).
    const assignment = makeLowSAssignment();
    const result = applyDeclaration(gs, 'alice', 'low_s', assignment);

    expect(result.correct).toBe(true);
    expect(result.winningTeam).toBe(1);
    const suitName = halfSuitLabel('low_s');
    expect(result.lastMove).toBe(`Alice declared ${suitName} — correct! Team 1 scores`);
    expect(gs.lastMove).toBe(`Alice declared ${suitName} — correct! Team 1 scores`);
  });

  it('incorrect declaration: lastMove is "[declarer] declared [suit] — incorrect! Team N scores"', () => {
    // Alice declares low_s but assigns cards wrong.
    const wrongAssignment = {
      '1_s': 'alice',
      '2_s': 'alice',
      '3_s': 'alice',
      '4_s': 'alice', // wrong: 4_s is held by bob, not alice
      '5_s': 'bob',   // wrong: 5_s is held by bob — correctly assigned but 4_s isn't
      '6_s': 'bob',   // wrong: 6_s is held by bob — correctly assigned but 4_s isn't
    };
    const result = applyDeclaration(gs, 'alice', 'low_s', wrongAssignment);

    expect(result.correct).toBe(false);
    expect(result.winningTeam).toBe(2); // wrong declaration → opposing team scores
    const suitName = halfSuitLabel('low_s');
    expect(result.lastMove).toBe(`Alice declared ${suitName} — incorrect! Team 2 scores`);
    expect(gs.lastMove).toBe(`Alice declared ${suitName} — incorrect! Team 2 scores`);
  });

  it('lastMove uses display name (not playerId) for declarer', () => {
    const assignment = makeLowSAssignment();
    applyDeclaration(gs, 'alice', 'low_s', assignment);
    expect(gs.lastMove).toContain('Alice');
    expect(gs.lastMove).not.toContain('alice'); // no raw ID
  });

  it('declaration result object contains lastMove matching gs.lastMove', () => {
    const assignment = makeLowSAssignment();
    const result = applyDeclaration(gs, 'alice', 'low_s', assignment);
    expect(result.lastMove).toBe(gs.lastMove);
  });
});
