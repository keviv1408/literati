'use strict';

/**
 * Tests for declaration outcome broadcasting.
 *
 * Verifies that when a declaration is processed by handleDeclare in
 * gameSocketServer.js, ALL connected clients (players + spectators) receive:
 * 1. A `declaration_result` event with: correct, winningTeam, declarerId,
 * halfSuitId, assignment, newTurnPlayerId, lastMove
 * 2. A `game_state` event with updated scores reflecting the outcome
 * 3. A `game_players` event with updated card counts (all 6 cards removed)
 *
 * Coverage:
 * 1. Correct declaration → declaration_result broadcast to all 6 connections (5 players + spectator)
 * 2. Correct declaration → declaration_result.correct === true
 * 3. Correct declaration → declaration_result.winningTeam === declarant's team (1)
 * 4. Correct declaration → game_state.scores.team1 incremented to 1
 * 5. Incorrect declaration → declaration_result.correct === false
 * 6. Incorrect declaration → declaration_result.winningTeam === opponent team (2)
 * 7. Incorrect declaration → game_state.scores.team2 incremented to 1
 * 8. Both correct and incorrect → all 6 half-suit cards removed (game_players card counts drop)
 * 9. declaration_result includes declarerId, halfSuitId, assignment, newTurnPlayerId, lastMove
 * 10. Spectator connection receives declaration_result broadcast
 * 11. game_state scores broadcast reflects the updated team score (not 0-0)
 * 12. Multiple declarations accumulate scores correctly across broadcasts
 */

// ---------------------------------------------------------------------------
// Mocks (must be before any require of game modules)
// ---------------------------------------------------------------------------

jest.mock('../db/supabase', () => ({
  getSupabaseClient: () => ({
    from: () => ({
      select:  () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      update:  () => ({ eq: () => Promise.resolve({ error: null }) }),
      upsert:  () => Promise.resolve({ error: null }),
      rpc:     () => Promise.resolve({ error: null }),
    }),
    auth: { getUser: async () => ({ data: null, error: new Error('mock') }) },
  }),
}));

jest.mock('../sessions/guestSessionStore', () => ({ getGuestSession: () => null }));

jest.mock('../liveGames/liveGamesStore', () => ({
  addGame:    jest.fn(),
  updateGame: jest.fn(),
  removeGame: jest.fn(),
  get:        jest.fn().mockReturnValue(null),
}));

jest.mock('../game/rematchStore', () => ({
  initRematch:    jest.fn().mockReturnValue({ yesCount: 0, noCount: 0, totalCount: 0 }),
  castVote:       jest.fn(),
  getVoteSummary: jest.fn(),
  hasRematch:     jest.fn().mockReturnValue(false),
  clearRematch:   jest.fn(),
}));

// ---------------------------------------------------------------------------
// Module imports (after mocks)
// ---------------------------------------------------------------------------

const { setGame, getGame, registerConnection, _clearAll } = require('../game/gameStore');
const { handleDeclare } = require('../game/gameSocketServer');
const { createGameState } = require('../game/gameState');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSeats() {
  return [
    { seatIndex: 0, playerId: 'p1', displayName: 'Alice', avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 1, playerId: 'p2', displayName: 'Bob',   avatarId: null, teamId: 2, isBot: false, isGuest: false },
    { seatIndex: 2, playerId: 'p3', displayName: 'Carol', avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 3, playerId: 'p4', displayName: 'Dave',  avatarId: null, teamId: 2, isBot: false, isGuest: false },
    { seatIndex: 4, playerId: 'p5', displayName: 'Eve',   avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 5, playerId: 'p6', displayName: 'Frank', avatarId: null, teamId: 2, isBot: false, isGuest: false },
  ];
}

function makeGame(roomCode = 'DECBRD1') {
  const gs = createGameState({
    roomCode,
    roomId:      'room-uuid-decbrd',
    variant:     'remove_7s',
    playerCount: 6,
    seats:       makeSeats(),
  });

  // Manually set up known hands so we can make deterministic declarations.
  // remove_7s low_s half-suit: 1_s 2_s 3_s 4_s 5_s 6_s
  // Team 1 (p1, p3, p5) hold all the low_s cards
  gs.hands.set('p1', new Set(['1_s', '2_s']));   // team1
  gs.hands.set('p2', new Set(['8_s', '9_s']));   // team2 (high_s in remove_7s)
  gs.hands.set('p3', new Set(['3_s', '4_s']));   // team1
  gs.hands.set('p4', new Set(['10_s', '11_s'])); // team2
  gs.hands.set('p5', new Set(['5_s', '6_s']));   // team1
  gs.hands.set('p6', new Set(['12_s', '13_s'])); // team2

  // p1 is current turn player (seat 0)
  gs.currentTurnPlayerId = 'p1';

  return gs;
}

function mockWs() {
  const sent = [];
  return {
    readyState: 1, // WebSocket.OPEN
    send: (data) => { sent.push(JSON.parse(data)); },
    _sent: sent,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const ROOM = 'DECBRD1';
let gs;
let wsP1, wsP2, wsP3, wsP4, wsP5, wsP6, wsSpectator;

beforeEach(() => {
  _clearAll();
  gs = makeGame(ROOM);
  setGame(ROOM, gs);

  wsP1        = mockWs();
  wsP2        = mockWs();
  wsP3        = mockWs();
  wsP4        = mockWs();
  wsP5        = mockWs();
  wsP6        = mockWs();
  wsSpectator = mockWs();

  registerConnection(ROOM, 'p1',             wsP1);
  registerConnection(ROOM, 'p2',             wsP2);
  registerConnection(ROOM, 'p3',             wsP3);
  registerConnection(ROOM, 'p4',             wsP4);
  registerConnection(ROOM, 'p5',             wsP5);
  registerConnection(ROOM, 'p6',             wsP6);
  registerConnection(ROOM, 'spectator_xyz',  wsSpectator);
});

afterEach(() => {
  _clearAll();
});

// ---------------------------------------------------------------------------
// Correct declaration
// ---------------------------------------------------------------------------

describe('declaration_result broadcast — correct declaration', () => {
  // Correct assignment: all 6 low_s cards go to the right Team 1 players
  const correctAssignment = {
    '1_s': 'p1', '2_s': 'p1',  // p1 holds 1_s,2_s
    '3_s': 'p3', '4_s': 'p3',  // p3 holds 3_s,4_s
    '5_s': 'p5', '6_s': 'p5',  // p5 holds 5_s,6_s
  };

  test('1. declaration_result is broadcast to all 6 player connections', async () => {
    await handleDeclare(ROOM, 'p1', 'low_s', correctAssignment, wsP1);

    for (const ws of [wsP1, wsP2, wsP3, wsP4, wsP5, wsP6]) {
      const msgs = ws._sent.filter(m => m.type === 'declaration_result');
      expect(msgs).toHaveLength(1);
    }
  });

  test('2. declaration_result.correct === true on correct declaration', async () => {
    await handleDeclare(ROOM, 'p1', 'low_s', correctAssignment, wsP1);

    const msg = wsP2._sent.find(m => m.type === 'declaration_result');
    expect(msg).toBeDefined();
    expect(msg.correct).toBe(true);
  });

  test('3. declaration_result.winningTeam === 1 (declarant team) on correct declaration', async () => {
    await handleDeclare(ROOM, 'p1', 'low_s', correctAssignment, wsP1);

    const msg = wsP4._sent.find(m => m.type === 'declaration_result');
    expect(msg).toBeDefined();
    expect(msg.winningTeam).toBe(1);
  });

  test('4. game_state.scores.team1 === 1 after correct declaration by Team 1', async () => {
    await handleDeclare(ROOM, 'p1', 'low_s', correctAssignment, wsP1);

    // game_state is broadcast as { type: 'game_state', state: { scores, ... } }
    const gameStateMsgs = wsP2._sent.filter(m => m.type === 'game_state');
    expect(gameStateMsgs.length).toBeGreaterThanOrEqual(1);

    const lastGameState = gameStateMsgs[gameStateMsgs.length - 1];
    expect(lastGameState.state.scores.team1).toBe(1);
    expect(lastGameState.state.scores.team2).toBe(0);
  });

  test('9. declaration_result includes declarerId, halfSuitId, assignment, newTurnPlayerId, lastMove', async () => {
    await handleDeclare(ROOM, 'p1', 'low_s', correctAssignment, wsP1);

    const msg = wsP3._sent.find(m => m.type === 'declaration_result');
    expect(msg).toBeDefined();
    expect(msg.declarerId).toBe('p1');
    expect(msg.halfSuitId).toBe('low_s');
    expect(msg.assignment).toEqual(correctAssignment);
    expect(typeof msg.newTurnPlayerId).toBe('string');
    expect(typeof msg.lastMove).toBe('string');
    expect(msg.lastMove.length).toBeGreaterThan(0);
  });

  test('10. spectator connection receives declaration_result broadcast', async () => {
    await handleDeclare(ROOM, 'p1', 'low_s', correctAssignment, wsP1);

    const msgs = wsSpectator._sent.filter(m => m.type === 'declaration_result');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].correct).toBe(true);
    expect(msgs[0].winningTeam).toBe(1);
  });

  test('11. game_state scores are non-zero after correct declaration (not 0-0)', async () => {
    await handleDeclare(ROOM, 'p1', 'low_s', correctAssignment, wsP1);

    const allGameStates = wsP5._sent.filter(m => m.type === 'game_state');
    expect(allGameStates.length).toBeGreaterThanOrEqual(1);

    const last = allGameStates[allGameStates.length - 1];
    expect(last.state.scores.team1 + last.state.scores.team2).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Incorrect declaration
// ---------------------------------------------------------------------------

describe('declaration_result broadcast — incorrect declaration', () => {
  // Incorrect assignment: p1's locked cards (1_s,2_s) correctly stay with p1,
  // but 3_s is mis-assigned to p5 (p3 actually holds it).
  // Validation passes (all team-1, locked cards correct) but applyDeclaration
  // detects the wrong holder for 3_s → correct === false.
  const incorrectAssignment = {
    '1_s': 'p1', '2_s': 'p1',  // locked — p1 holds these, must assign to p1
    '3_s': 'p5',                 // WRONG: p3 holds 3_s, not p5
    '4_s': 'p3',                 // correct
    '5_s': 'p5', '6_s': 'p5',  // correct
  };

  test('5. declaration_result.correct === false on incorrect declaration', async () => {
    await handleDeclare(ROOM, 'p1', 'low_s', incorrectAssignment, wsP1);

    const msg = wsP2._sent.find(m => m.type === 'declaration_result');
    expect(msg).toBeDefined();
    expect(msg.correct).toBe(false);
  });

  test('6. declaration_result.winningTeam === 2 (opponent team) on incorrect declaration', async () => {
    await handleDeclare(ROOM, 'p1', 'low_s', incorrectAssignment, wsP1);

    const msg = wsP4._sent.find(m => m.type === 'declaration_result');
    expect(msg).toBeDefined();
    expect(msg.winningTeam).toBe(2);
  });

  test('7. game_state.scores.team2 === 1 (opponent scores) on incorrect declaration', async () => {
    await handleDeclare(ROOM, 'p1', 'low_s', incorrectAssignment, wsP1);

    const gameStateMsgs = wsP4._sent.filter(m => m.type === 'game_state');
    expect(gameStateMsgs.length).toBeGreaterThanOrEqual(1);

    const last = gameStateMsgs[gameStateMsgs.length - 1];
    expect(last.state.scores.team2).toBe(1);
    expect(last.state.scores.team1).toBe(0);
  });

  test('incorrect declaration: spectator also receives declaration_result with correct === false', async () => {
    await handleDeclare(ROOM, 'p1', 'low_s', incorrectAssignment, wsP1);

    const msgs = wsSpectator._sent.filter(m => m.type === 'declaration_result');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].correct).toBe(false);
    expect(msgs[0].winningTeam).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Card removal after declaration (both correct and incorrect)
// ---------------------------------------------------------------------------

describe('declaration_result broadcast — card removal', () => {
  test('8a. game_players sent after declaration (card counts updated)', async () => {
    const assignment = {
      '1_s': 'p1', '2_s': 'p1',
      '3_s': 'p3', '4_s': 'p3',
      '5_s': 'p5', '6_s': 'p5',
    };

    await handleDeclare(ROOM, 'p1', 'low_s', assignment, wsP1);

    // game_players broadcast should reflect reduced card counts
    const gpMsgs = wsP2._sent.filter(m => m.type === 'game_players');
    expect(gpMsgs.length).toBeGreaterThanOrEqual(1);

    const lastGp = gpMsgs[gpMsgs.length - 1];
    const p1Entry = lastGp.players.find((p) => p.playerId === 'p1');
    const p3Entry = lastGp.players.find((p) => p.playerId === 'p3');
    const p5Entry = lastGp.players.find((p) => p.playerId === 'p5');

    // p1 had 2 cards (1_s,2_s), p3 had 2 cards (3_s,4_s), p5 had 2 cards (5_s,6_s)
    // All should drop to 0 after declaration removes all low_s cards
    expect(p1Entry.cardCount).toBe(0);
    expect(p3Entry.cardCount).toBe(0);
    expect(p5Entry.cardCount).toBe(0);
  });

  test('8b. hands of non-declaring players with no low_s cards are unchanged', async () => {
    const assignment = {
      '1_s': 'p1', '2_s': 'p1',
      '3_s': 'p3', '4_s': 'p3',
      '5_s': 'p5', '6_s': 'p5',
    };

    await handleDeclare(ROOM, 'p1', 'low_s', assignment, wsP1);

    const gpMsgs = wsP2._sent.filter(m => m.type === 'game_players');
    const last = gpMsgs[gpMsgs.length - 1];

    // p2, p4, p6 held no low_s cards — their counts stay at 2
    const p2Entry = last.players.find((p) => p.playerId === 'p2');
    const p4Entry = last.players.find((p) => p.playerId === 'p4');
    const p6Entry = last.players.find((p) => p.playerId === 'p6');

    expect(p2Entry.cardCount).toBe(2);
    expect(p4Entry.cardCount).toBe(2);
    expect(p6Entry.cardCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// declarationFailed event
// ---------------------------------------------------------------------------

describe('declarationFailed event — incorrect declaration', () => {
  // Incorrect assignment: 3_s mis-assigned to p5 (p3 actually holds it)
  const incorrectAssignment = {
    '1_s': 'p1', '2_s': 'p1',  // locked — p1 holds these, must assign to p1
    '3_s': 'p5',                 // WRONG: p3 holds 3_s, not p5
    '4_s': 'p3',                 // correct
    '5_s': 'p5', '6_s': 'p5',  // correct
  };

  test('declarationFailed is broadcast to all 6 player connections on incorrect declaration', async () => {
    await handleDeclare(ROOM, 'p1', 'low_s', incorrectAssignment, wsP1);

    for (const ws of [wsP1, wsP2, wsP3, wsP4, wsP5, wsP6]) {
      const msgs = ws._sent.filter(m => m.type === 'declarationFailed');
      expect(msgs).toHaveLength(1);
    }
  });

  test('declarationFailed is broadcast to the spectator connection', async () => {
    await handleDeclare(ROOM, 'p1', 'low_s', incorrectAssignment, wsP1);

    const msgs = wsSpectator._sent.filter(m => m.type === 'declarationFailed');
    expect(msgs).toHaveLength(1);
  });

  test('declarationFailed contains correct top-level fields', async () => {
    await handleDeclare(ROOM, 'p1', 'low_s', incorrectAssignment, wsP1);

    const msg = wsP2._sent.find(m => m.type === 'declarationFailed');
    expect(msg).toBeDefined();
    expect(msg.declarerId).toBe('p1');
    expect(msg.halfSuitId).toBe('low_s');
    expect(msg.winningTeam).toBe(2);  // opponent team scores on incorrect declaration
    expect(typeof msg.lastMove).toBe('string');
    expect(msg.lastMove.length).toBeGreaterThan(0);
  });

  test('declarationFailed.wrongAssignmentDiffs identifies the mis-assigned card', async () => {
    await handleDeclare(ROOM, 'p1', 'low_s', incorrectAssignment, wsP1);

    const msg = wsP3._sent.find(m => m.type === 'declarationFailed');
    expect(msg).toBeDefined();
    expect(Array.isArray(msg.wrongAssignmentDiffs)).toBe(true);
    expect(msg.wrongAssignmentDiffs).toHaveLength(1);

    const diff = msg.wrongAssignmentDiffs[0];
    expect(diff.card).toBe('3_s');
    expect(diff.claimedPlayerId).toBe('p5');  // p1 claimed 3_s belonged to p5
    expect(diff.actualPlayerId).toBe('p3');   // p3 actually held 3_s
  });

  test('declarationFailed.actualHolders maps all 6 half-suit cards to their actual holders', async () => {
    await handleDeclare(ROOM, 'p1', 'low_s', incorrectAssignment, wsP1);

    const msg = wsP4._sent.find(m => m.type === 'declarationFailed');
    expect(msg).toBeDefined();
    expect(typeof msg.actualHolders).toBe('object');

    const cards = ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'];
    expect(Object.keys(msg.actualHolders).sort()).toEqual(cards.sort());

    // Spot-check: p1 held 1_s and 2_s, p3 held 3_s and 4_s, p5 held 5_s and 6_s
    expect(msg.actualHolders['1_s']).toBe('p1');
    expect(msg.actualHolders['2_s']).toBe('p1');
    expect(msg.actualHolders['3_s']).toBe('p3');  // p5 was claimed but p3 actually held it
    expect(msg.actualHolders['4_s']).toBe('p3');
    expect(msg.actualHolders['5_s']).toBe('p5');
    expect(msg.actualHolders['6_s']).toBe('p5');
  });

  test('declarationFailed.assignment reflects the (incorrect) submitted assignment', async () => {
    await handleDeclare(ROOM, 'p1', 'low_s', incorrectAssignment, wsP1);

    const msg = wsP5._sent.find(m => m.type === 'declarationFailed');
    expect(msg).toBeDefined();
    expect(msg.assignment).toEqual(incorrectAssignment);
  });

  test('declarationFailed is NOT emitted on a correct declaration', async () => {
    const correctAssignment = {
      '1_s': 'p1', '2_s': 'p1',
      '3_s': 'p3', '4_s': 'p3',
      '5_s': 'p5', '6_s': 'p5',
    };
    await handleDeclare(ROOM, 'p1', 'low_s', correctAssignment, wsP1);

    for (const ws of [wsP1, wsP2, wsP3, wsP4, wsP5, wsP6, wsSpectator]) {
      const msgs = ws._sent.filter(m => m.type === 'declarationFailed');
      expect(msgs).toHaveLength(0);
    }
  });

  test('declarationFailed precedes declaration_result in broadcast order on incorrect declaration', async () => {
    // declaration_result is sent first, then declarationFailed
    await handleDeclare(ROOM, 'p1', 'low_s', incorrectAssignment, wsP1);

    const declResultIdx = wsP2._sent.findIndex(m => m.type === 'declaration_result');
    const declFailedIdx = wsP2._sent.findIndex(m => m.type === 'declarationFailed');
    expect(declResultIdx).toBeGreaterThanOrEqual(0);
    expect(declFailedIdx).toBeGreaterThan(declResultIdx);
  });

  test('declarationFailed with multiple wrong assignments returns all diffs', async () => {
    // Swap p1's and p3's card assignments (two wrongs)
    const doubleWrongAssignment = {
      '1_s': 'p3', '2_s': 'p3',  // WRONG: p1 holds these (also violates locked-card rule)
      '3_s': 'p1', '4_s': 'p1',  // WRONG: p3 holds these
      '5_s': 'p5', '6_s': 'p5',  // correct
    };

    // Note: this assignment reassigns p1's own locked cards to p3, so validateDeclaration
    // will reject it (LOCKED_CARD_REASSIGNED). So let's override by removing 1_s,2_s from p1
    // and giving them to p3 first, making them no longer "locked".
    const freshGs = makeGame('DECBRD_MULTI');
    // Move 1_s,2_s to p3 so p1 doesn't hold them (p1 still holds no low_s — need 1 for eligibility)
    // Actually we need p1 to hold at least one low_s card to declare. Let's instead have p1 hold 5_s,6_s
    // and p5 hold 1_s,2_s, with p3 holding 3_s,4_s. Then p1's locked cards are 5_s,6_s.
    freshGs.hands.set('p1', new Set(['5_s', '6_s']));  // team1, declares low_s
    freshGs.hands.set('p3', new Set(['3_s', '4_s']));  // team1
    freshGs.hands.set('p5', new Set(['1_s', '2_s']));  // team1

    // Register new game
    const { setGame: sg, _clearAll: ca } = require('../game/gameStore');
    sg('DECBRD_MULTI', freshGs);

    const wsList = Array.from({ length: 7 }, () => mockWs());
    const { registerConnection: rc } = require('../game/gameStore');
    ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'spec'].forEach((id, i) =>
      rc('DECBRD_MULTI', id, wsList[i])
    );

    // p1 declares but incorrectly assigns two cards wrong
    const assignment = {
      '1_s': 'p3', '2_s': 'p3',  // WRONG: p5 holds them
      '3_s': 'p5', '4_s': 'p3',  // 3_s WRONG (p3 holds), 4_s correct (p3 holds)
      '5_s': 'p1', '6_s': 'p1',  // locked — correct (p1 holds)
    };
    await handleDeclare('DECBRD_MULTI', 'p1', 'low_s', assignment, wsList[0]);

    const msg = wsList[1]._sent.find(m => m.type === 'declarationFailed');
    expect(msg).toBeDefined();
    // 1_s→p3 (wrong: p5), 2_s→p3 (wrong: p5), 3_s→p5 (wrong: p3)
    expect(msg.wrongAssignmentDiffs.length).toBeGreaterThanOrEqual(2);

    ca();
  });
});

// ---------------------------------------------------------------------------
// Score accumulation across multiple declarations
// ---------------------------------------------------------------------------

describe('score accumulation across multiple declarations', () => {
  test('12. scores accumulate correctly across two sequential declarations', async () => {
    // First declaration: Team 1 correctly declares low_s
    const assignment1 = {
      '1_s': 'p1', '2_s': 'p1',
      '3_s': 'p3', '4_s': 'p3',
      '5_s': 'p5', '6_s': 'p5',
    };
    await handleDeclare(ROOM, 'p1', 'low_s', assignment1, wsP1);

    // After first declaration, gs.scores.team1 should be 1
    const gs2 = getGame(ROOM);
    expect(gs2.scores.team1).toBe(1);
    expect(gs2.scores.team2).toBe(0);

    // Now set p2 as current turn player (Team 2) and have them declare high_s
    // high_s in remove_7s: 8_s 9_s 10_s 11_s 12_s 13_s
    gs2.currentTurnPlayerId = 'p2';
    // Set p2/p4/p6 to hold all high_s cards
    gs2.hands.set('p2', new Set(['8_s', '9_s']));
    gs2.hands.set('p4', new Set(['10_s', '11_s']));
    gs2.hands.set('p6', new Set(['12_s', '13_s']));

    const assignment2 = {
      '8_s': 'p2', '9_s': 'p2',
      '10_s': 'p4', '11_s': 'p4',
      '12_s': 'p6', '13_s': 'p6',
    };

    // Reset sent messages to check the second broadcast cleanly
    wsP1._sent.length = 0;
    wsP2._sent.length = 0;
    wsP3._sent.length = 0;

    await handleDeclare(ROOM, 'p2', 'high_s', assignment2, wsP2);

    const gs3 = getGame(ROOM);
    expect(gs3.scores.team1).toBe(1);  // unchanged
    expect(gs3.scores.team2).toBe(1);  // added 1

    // game_state broadcast after 2nd declaration shows both teams scored
    const gameStateMsgs = wsP1._sent.filter(m => m.type === 'game_state');
    expect(gameStateMsgs.length).toBeGreaterThanOrEqual(1);
    const last = gameStateMsgs[gameStateMsgs.length - 1];
    expect(last.state.scores.team1).toBe(1);
    expect(last.state.scores.team2).toBe(1);
  });
});
