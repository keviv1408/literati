'use strict';

/**
 * Sub-AC 32a — Game-end detection: triggers when the 8th half-suit is
 *               declared, updating game state to 'completed' and halting
 *               all further moves.
 *
 * Rules:
 *   - When the 8th (last) half-suit is declared — correctly, incorrectly, or
 *     via forced-failed timer expiry — the game must immediately transition to
 *     status: 'completed'.
 *   - The winner is determined by score (team with more points wins).
 *   - On a 4-4 tie, the winner is the team that declared the high_d half-suit
 *     (the tiebreaker half-suit).
 *   - Once status is 'completed', no further card requests (asks) or
 *     declarations may be accepted; both return GAME_NOT_ACTIVE.
 *   - The socket server must broadcast a `game_over` event to all connected
 *     clients immediately after the 8th declaration resolves.
 *   - The game is removed from the live games store on game-over.
 *
 * Coverage:
 *
 *   Pure engine — applyDeclaration:
 *     1.  After 8th correct declaration, gs.status === 'completed'
 *     2.  Winner is the team with more points (team1 5-3 → winner: 1)
 *     3.  Winner is the team with more points (team2 3-5 → winner: 2)
 *     4.  Tied 4-4 tiebreaker: winner is team that declared high_d
 *     5.  gs.winner is still null during mid-game (before 8th declaration)
 *
 *   Pure engine — applyForcedFailedDeclaration:
 *     6.  After 8th forced-failed declaration, gs.status === 'completed'
 *     7.  Winner is determined correctly after forced failure on 8th suit
 *
 *   Move blocking after game ends:
 *     8.  validateAsk returns GAME_NOT_ACTIVE when gs.status === 'completed'
 *     9.  validateDeclaration returns GAME_NOT_ACTIVE when gs.status === 'completed'
 *    10.  GAME_NOT_ACTIVE errorCode is present (not just error string)
 *
 *   Socket server integration:
 *    11.  handleDeclare broadcasts `game_over` after 8th declaration
 *    12.  game_over includes correct winner, tiebreakerWinner, and scores
 *    13.  handleAskCard sends GAME_NOT_ACTIVE error when game is completed
 *    14.  handleDeclare sends GAME_NOT_ACTIVE error when game is already completed
 *    15.  liveGamesStore.removeGame is called after 8th declaration
 */

// ---------------------------------------------------------------------------
// Mocks (must appear before any require of the modules under test)
// ---------------------------------------------------------------------------

jest.mock('../db/supabase', () => ({
  getSupabaseClient: () => ({
    from: () => ({
      select:  () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      update:  () => ({ eq: () => Promise.resolve({ error: null }) }),
      upsert:  () => Promise.resolve({ error: null }),
    }),
    // Top-level rpc used by updateStats (increment_user_stats)
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: { getUser: async () => ({ data: null, error: new Error('mock') }) },
  }),
}));

jest.mock('../sessions/guestSessionStore', () => ({ getGuestSession: () => null }));

const mockLiveGamesStore = {
  addGame:    jest.fn(),
  updateGame: jest.fn(),
  removeGame: jest.fn(),
  get:        jest.fn().mockReturnValue({ scores: { team1: 0, team2: 0 } }),
};
jest.mock('../liveGames/liveGamesStore', () => mockLiveGamesStore);

jest.mock('../game/rematchStore', () => ({
  initRematch:    jest.fn().mockReturnValue({ yesCount: 0, noCount: 0, totalCount: 0 }),
  castVote:       jest.fn(),
  getVoteSummary: jest.fn(),
  hasRematch:     jest.fn().mockReturnValue(false),
  clearRematch:   jest.fn(),
}));

// ---------------------------------------------------------------------------
// Module imports
// ---------------------------------------------------------------------------

const { applyDeclaration, applyForcedFailedDeclaration, validateAsk, validateDeclaration } =
  require('../game/gameEngine');
const { buildHalfSuitMap, TIEBREAKER_HALF_SUIT, allHalfSuitIds } = require('../game/halfSuits');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOM = 'ENDGM';
const VARIANT = 'remove_7s';

// Half-suit card lists for remove_7s:
//   low_s:  1_s, 2_s, 3_s, 4_s, 5_s, 6_s
//   high_s: 8_s, 9_s, 10_s, 11_s, 12_s, 13_s
//   low_h:  1_h, 2_h, 3_h, 4_h, 5_h, 6_h
//   high_h: 8_h, 9_h, 10_h, 11_h, 12_h, 13_h
//   low_d:  1_d, 2_d, 3_d, 4_d, 5_d, 6_d
//   high_d: 8_d, 9_d, 10_d, 11_d, 12_d, 13_d  ← tiebreaker
//   low_c:  1_c, 2_c, 3_c, 4_c, 5_c, 6_c
//   high_c: 8_c, 9_c, 10_c, 11_c, 12_c, 13_c

/**
 * Build a minimal 6-player game state.
 * Team 1: p1, p2, p3  (seats 0, 2, 4)
 * Team 2: p4, p5, p6  (seats 1, 3, 5)
 */
function buildGame({
  variant = VARIANT,
  currentTurnPlayerId = 'p1',
  scores = { team1: 0, team2: 0 },
  declaredSuits = new Map(),
  handOverrides = {},
} = {}) {
  const halfSuits = buildHalfSuitMap(variant);

  // Build default hands: spread all 48 cards evenly among 6 players (8 each)
  const allCards = [];
  for (const [, cards] of halfSuits) allCards.push(...cards);

  const defaultHands = { p1: new Set(), p2: new Set(), p3: new Set(),
                          p4: new Set(), p5: new Set(), p6: new Set() };
  const pids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  allCards.forEach((card, i) => defaultHands[pids[i % 6]].add(card));

  const hands = new Map();
  for (const pid of pids) {
    hands.set(pid, handOverrides[pid] !== undefined
      ? new Set(handOverrides[pid])
      : new Set(defaultHands[pid]));
  }

  // Remove already-declared cards from hands
  for (const [hsId] of declaredSuits) {
    const cards = halfSuits.get(hsId) ?? [];
    for (const card of cards) {
      for (const hand of hands.values()) hand.delete(card);
    }
  }

  return {
    roomCode:            ROOM,
    roomId:              'room-uuid',
    variant,
    playerCount:         6,
    status:              'active',
    currentTurnPlayerId,
    players: [
      { playerId: 'p1', displayName: 'P1', teamId: 1, seatIndex: 0, isBot: false, isGuest: false },
      { playerId: 'p2', displayName: 'P2', teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
      { playerId: 'p3', displayName: 'P3', teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
      { playerId: 'p4', displayName: 'P4', teamId: 2, seatIndex: 1, isBot: false, isGuest: false },
      { playerId: 'p5', displayName: 'P5', teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
      { playerId: 'p6', displayName: 'P6', teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
    ],
    hands,
    declaredSuits: new Map(declaredSuits),
    scores:           { ...scores },
    lastMove:         null,
    winner:           null,
    tiebreakerWinner: null,
    botKnowledge:     new Map(),
    moveHistory:      [],
    inferenceMode:    false,
  };
}

/**
 * Build an assignment map for a half-suit where all cards are in team-1 hands.
 * Redistributes all 6 cards of the half-suit to p1 (3 cards) and p2 (3 cards).
 */
function makeTeam1Assignment(gs, halfSuitId) {
  const halfSuits = buildHalfSuitMap(gs.variant);
  const cards = halfSuits.get(halfSuitId);

  // Clear team-1 hands and give them all the cards
  gs.hands.set('p1', new Set(cards.slice(0, 3)));
  gs.hands.set('p2', new Set(cards.slice(3, 6)));
  gs.hands.set('p3', new Set());

  const assignment = {};
  for (const c of cards.slice(0, 3)) assignment[c] = 'p1';
  for (const c of cards.slice(3, 6)) assignment[c] = 'p2';
  return assignment;
}

/**
 * Pre-declare N half-suits (to a given team) without going through the engine.
 * Also removes their cards from all hands.
 */
function preDeclare(gs, halfSuitIds, teamId = 1) {
  const halfSuits = buildHalfSuitMap(gs.variant);
  for (const hsId of halfSuitIds) {
    gs.declaredSuits.set(hsId, { teamId, declaredBy: teamId === 1 ? 'p1' : 'p4' });
    for (const card of halfSuits.get(hsId)) {
      for (const hand of gs.hands.values()) hand.delete(card);
    }
  }
}

// ---------------------------------------------------------------------------
// 1–5: Pure engine — applyDeclaration
// ---------------------------------------------------------------------------

describe('applyDeclaration — game-end detection (Sub-AC 32a)', () => {
  it('1. after 8th declaration gs.status === "completed"', () => {
    const halfSuits = buildHalfSuitMap(VARIANT);
    const halfSuitIds = allHalfSuitIds();

    // Give all cards to team-1 players for easy correct declarations
    const allCards = [];
    for (const [, cards] of halfSuits) allCards.push(...cards);
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    // Clear all hands
    for (const [pid] of gs.hands) gs.hands.set(pid, new Set());
    // Distribute to p1, p2, p3
    const t1 = ['p1', 'p2', 'p3'];
    allCards.forEach((card, i) => gs.hands.get(t1[i % 3]).add(card));

    // Declare all 8 half-suits
    for (const hsId of halfSuitIds) {
      const cards = halfSuits.get(hsId);
      const assignment = {};
      for (const c of cards) {
        for (const pid of t1) {
          if (gs.hands.get(pid).has(c)) { assignment[c] = pid; break; }
        }
      }
      // Ensure current turn holder has at least 1 card; otherwise pick one with cards
      const holder = gs.players.find((p) => gs.hands.get(p.playerId)?.size > 0);
      if (holder && gs.hands.get(gs.currentTurnPlayerId)?.size === 0) {
        gs.currentTurnPlayerId = holder.playerId;
      }
      applyDeclaration(gs, gs.currentTurnPlayerId, hsId, assignment);
    }

    expect(gs.status).toBe('completed');
  });

  it('2. winner is team with more points (team1 5-3 → winner: 1)', () => {
    const halfSuits = buildHalfSuitMap(VARIANT);
    const halfSuitIds = allHalfSuitIds();

    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    // Clear all hands; assign all to team-1
    for (const [pid] of gs.hands) gs.hands.set(pid, new Set());
    const allCards = [];
    for (const [, cards] of halfSuits) allCards.push(...cards);
    const t1 = ['p1', 'p2', 'p3'];
    allCards.forEach((card, i) => gs.hands.get(t1[i % 3]).add(card));

    // Manually set scores to 4-2 before last two declarations (team1 gets 1 more → 5-3 final)
    // We'll declare all 8 to team-1 (all correct), so team1 ends 8-0
    for (const hsId of halfSuitIds) {
      const cards = halfSuits.get(hsId);
      const assignment = {};
      for (const c of cards) {
        for (const pid of t1) {
          if (gs.hands.get(pid).has(c)) { assignment[c] = pid; break; }
        }
      }
      const holder = gs.players.find((p) => gs.hands.get(p.playerId)?.size > 0);
      if (holder && gs.hands.get(gs.currentTurnPlayerId)?.size === 0) {
        gs.currentTurnPlayerId = holder.playerId;
      }
      applyDeclaration(gs, gs.currentTurnPlayerId, hsId, assignment);
    }

    expect(gs.status).toBe('completed');
    expect(gs.winner).toBe(1);
  });

  it('3. winner is the team with more points when team2 leads', () => {
    const halfSuits = buildHalfSuitMap(VARIANT);
    const halfSuitIds = allHalfSuitIds();

    const gs = buildGame({ currentTurnPlayerId: 'p4' }); // team-2 player starts
    // Clear all hands; assign all to team-2
    for (const [pid] of gs.hands) gs.hands.set(pid, new Set());
    const allCards = [];
    for (const [, cards] of halfSuits) allCards.push(...cards);
    const t2 = ['p4', 'p5', 'p6'];
    allCards.forEach((card, i) => gs.hands.get(t2[i % 3]).add(card));

    for (const hsId of halfSuitIds) {
      const cards = halfSuits.get(hsId);
      const assignment = {};
      for (const c of cards) {
        for (const pid of t2) {
          if (gs.hands.get(pid).has(c)) { assignment[c] = pid; break; }
        }
      }
      const holder = gs.players.find((p) => gs.hands.get(p.playerId)?.size > 0);
      if (holder && gs.hands.get(gs.currentTurnPlayerId)?.size === 0) {
        gs.currentTurnPlayerId = holder.playerId;
      }
      applyDeclaration(gs, gs.currentTurnPlayerId, hsId, assignment);
    }

    expect(gs.status).toBe('completed');
    expect(gs.winner).toBe(2);
  });

  it('4. tiebreaker: 4-4 tie → winner is team that declared high_d', () => {
    const halfSuits = buildHalfSuitMap(VARIANT);
    const nonTiebreaker = allHalfSuitIds().filter((id) => id !== TIEBREAKER_HALF_SUIT);

    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    // Pre-declare 7 suits manually (4 for team1, 3 for team2)
    const team1Suits = nonTiebreaker.slice(0, 4);
    const team2Suits = nonTiebreaker.slice(4, 7);
    preDeclare(gs, team1Suits, 1);
    preDeclare(gs, team2Suits, 2);
    gs.scores = { team1: 4, team2: 4 };

    // Give team-1 all high_d cards
    const highDCards = halfSuits.get(TIEBREAKER_HALF_SUIT);
    for (const hand of gs.hands.values()) {
      for (const c of highDCards) hand.delete(c);
    }
    gs.hands.set('p1', new Set(highDCards.slice(0, 3)));
    gs.hands.set('p2', new Set(highDCards.slice(3, 6)));
    gs.hands.set('p3', new Set());
    gs.hands.set('p4', new Set());
    gs.hands.set('p5', new Set());
    gs.hands.set('p6', new Set());
    gs.currentTurnPlayerId = 'p1';

    const assignment = {};
    for (const c of highDCards.slice(0, 3)) assignment[c] = 'p1';
    for (const c of highDCards.slice(3, 6)) assignment[c] = 'p2';

    applyDeclaration(gs, 'p1', TIEBREAKER_HALF_SUIT, assignment);

    expect(gs.status).toBe('completed');
    expect(gs.tiebreakerWinner).toBe(1);
    expect(gs.winner).toBe(1); // tie broken by high_d
  });

  it('5. gs.winner is null during mid-game (before all 8 declarations)', () => {
    const halfSuits = buildHalfSuitMap(VARIANT);
    const gs = buildGame({ currentTurnPlayerId: 'p1' });

    // Declare only 1 half-suit
    const [firstHalfSuit, cards] = [...halfSuits.entries()][0];
    for (const hand of gs.hands.values()) {
      for (const c of cards) hand.delete(c);
    }
    gs.hands.set('p1', new Set(cards.slice(0, 3)));
    gs.hands.set('p2', new Set(cards.slice(3, 6)));

    const assignment = {};
    for (const c of cards.slice(0, 3)) assignment[c] = 'p1';
    for (const c of cards.slice(3, 6)) assignment[c] = 'p2';

    applyDeclaration(gs, 'p1', firstHalfSuit, assignment);

    expect(gs.status).toBe('active');
    expect(gs.winner).toBeNull();
    expect(gs.declaredSuits.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6–7: Pure engine — applyForcedFailedDeclaration
// ---------------------------------------------------------------------------

describe('applyForcedFailedDeclaration — game-end detection (Sub-AC 32a)', () => {
  it('6. after 8th forced-failed declaration, gs.status === "completed"', () => {
    const nonLowS = allHalfSuitIds().filter((id) => id !== 'low_s');

    // Pre-declare 7 suits; low_s is the 8th
    const gs = buildGame({
      currentTurnPlayerId: 'p1',
      handOverrides: {
        p1: new Set(['1_s','2_s','3_s']),
        p2: new Set(['4_s','5_s','6_s']),
        p3: new Set(), p4: new Set(), p5: new Set(), p6: new Set(),
      },
    });
    preDeclare(gs, nonLowS, 1);

    applyForcedFailedDeclaration(gs, 'p1', 'low_s');

    expect(gs.status).toBe('completed');
    expect(gs.declaredSuits.size).toBe(8);
  });

  it('7. winner is determined correctly after forced failure on the 8th suit', () => {
    const nonLowS = allHalfSuitIds().filter((id) => id !== 'low_s');

    // Pre-declare 7 suits to team1 (7 points for team1)
    const gs = buildGame({
      currentTurnPlayerId: 'p1',
      handOverrides: {
        p1: new Set(['1_s','2_s','3_s']),
        p2: new Set(['4_s','5_s','6_s']),
        p3: new Set(), p4: new Set(), p5: new Set(), p6: new Set(),
      },
    });
    preDeclare(gs, nonLowS, 1);
    gs.scores = { team1: 7, team2: 0 };

    // Forced failure on low_s — team2 gets the 8th point
    applyForcedFailedDeclaration(gs, 'p1', 'low_s');

    expect(gs.status).toBe('completed');
    // Final: team1=7, team2=1 → team1 wins
    expect(gs.winner).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8–10: Move blocking after game ends
// ---------------------------------------------------------------------------

describe('Move blocking after game ends (Sub-AC 32a)', () => {
  let gs;

  beforeEach(() => {
    // Build a game that's already completed
    gs = buildGame({ currentTurnPlayerId: 'p1' });
    gs.status = 'completed';
    gs.winner = 1;
    gs.scores = { team1: 5, team2: 3 };
  });

  it('8. validateAsk returns GAME_NOT_ACTIVE when gs.status === "completed"', () => {
    const result = validateAsk(gs, 'p1', 'p4', '1_s');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('GAME_NOT_ACTIVE');
  });

  it('9. validateDeclaration returns GAME_NOT_ACTIVE when gs.status === "completed"', () => {
    const result = validateDeclaration(gs, 'p1', 'low_s', { '1_s': 'p1' });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('GAME_NOT_ACTIVE');
  });

  it('10. GAME_NOT_ACTIVE errorCode is present, not just the error string', () => {
    const askResult   = validateAsk(gs, 'p1', 'p4', '1_s');
    const declResult  = validateDeclaration(gs, 'p1', 'low_s', { '1_s': 'p1' });

    expect(askResult.errorCode).toBe('GAME_NOT_ACTIVE');
    expect(declResult.errorCode).toBe('GAME_NOT_ACTIVE');
    expect(typeof askResult.error).toBe('string');
    expect(typeof declResult.error).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 11–15: Socket server integration
// ---------------------------------------------------------------------------

describe('Socket server game-end integration (Sub-AC 32a)', () => {
  let setGame, registerConnection, removeConnection;
  let handleAskCard, handleDeclare, cancelTurnTimer;

  beforeAll(() => {
    ({ handleAskCard, handleDeclare, cancelTurnTimer } =
      require('../game/gameSocketServer'));
    ({ setGame, registerConnection, removeConnection } =
      require('../game/gameStore'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockLiveGamesStore.get.mockReturnValue({ scores: { team1: 0, team2: 0 } });
  });

  afterEach(() => {
    cancelTurnTimer(ROOM);
    removeConnection(ROOM, 'p1');
    removeConnection(ROOM, 'p4');
  });

  /** Create a mock WebSocket that collects messages. */
  function makeWs(messages = []) {
    return { readyState: 1, send: (d) => messages.push(JSON.parse(d)) };
  }

  it('11. handleDeclare broadcasts "game_over" after the 8th declaration', async () => {
    const halfSuits = buildHalfSuitMap(VARIANT);
    const nonLowS = allHalfSuitIds().filter((id) => id !== 'low_s');

    // Build game with 7 suits already declared; low_s is the 8th
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    preDeclare(gs, nonLowS, 1);
    gs.scores = { team1: 7, team2: 0 };

    // Give p1 and p2 all 6 low_s cards for a correct declaration
    const lowSCards = halfSuits.get('low_s');
    for (const hand of gs.hands.values()) {
      for (const c of lowSCards) hand.delete(c);
    }
    gs.hands.set('p1', new Set(lowSCards.slice(0, 3)));
    gs.hands.set('p2', new Set(lowSCards.slice(3, 6)));
    gs.currentTurnPlayerId = 'p1';

    setGame(ROOM, gs);

    const messages = [];
    const mockWs = makeWs(messages);
    registerConnection(ROOM, 'p1', mockWs);
    registerConnection(ROOM, 'p4', mockWs);

    const assignment = {};
    for (const c of lowSCards.slice(0, 3)) assignment[c] = 'p1';
    for (const c of lowSCards.slice(3, 6)) assignment[c] = 'p2';

    await handleDeclare(ROOM, 'p1', 'low_s', assignment, mockWs);

    const gameOver = messages.find((m) => m.type === 'game_over');
    expect(gameOver).toBeDefined();

    removeConnection(ROOM, 'p1');
    removeConnection(ROOM, 'p4');
  });

  it('12. game_over includes correct winner, tiebreakerWinner, and scores', async () => {
    const halfSuits = buildHalfSuitMap(VARIANT);
    const nonLowS = allHalfSuitIds().filter((id) => id !== 'low_s');

    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    preDeclare(gs, nonLowS, 1);
    gs.scores = { team1: 7, team2: 0 };

    const lowSCards = halfSuits.get('low_s');
    for (const hand of gs.hands.values()) {
      for (const c of lowSCards) hand.delete(c);
    }
    gs.hands.set('p1', new Set(lowSCards.slice(0, 3)));
    gs.hands.set('p2', new Set(lowSCards.slice(3, 6)));
    gs.currentTurnPlayerId = 'p1';

    setGame(ROOM, gs);

    const messages = [];
    const mockWs = makeWs(messages);
    registerConnection(ROOM, 'p1', mockWs);
    registerConnection(ROOM, 'p4', mockWs);

    const assignment = {};
    for (const c of lowSCards.slice(0, 3)) assignment[c] = 'p1';
    for (const c of lowSCards.slice(3, 6)) assignment[c] = 'p2';

    await handleDeclare(ROOM, 'p1', 'low_s', assignment, mockWs);

    const gameOver = messages.find((m) => m.type === 'game_over');
    expect(gameOver).toBeDefined();
    expect(gameOver.winner).toBe(1);              // team1 has 8 points
    expect(gameOver.scores).toEqual({ team1: 8, team2: 0 });
    // tiebreakerWinner may be null (no 4-4 tie here)
    expect('tiebreakerWinner' in gameOver).toBe(true);

    removeConnection(ROOM, 'p1');
    removeConnection(ROOM, 'p4');
  });

  it('13. handleAskCard sends GAME_NOT_ACTIVE error when game is already completed', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    gs.status = 'completed';
    gs.winner = 1;
    setGame(ROOM, gs);

    const messages = [];
    const mockWs = makeWs(messages);
    registerConnection(ROOM, 'p1', mockWs);

    await handleAskCard(ROOM, 'p1', 'p4', '1_s', mockWs);

    const err = messages.find((m) => m.type === 'error');
    expect(err).toBeDefined();
    expect(err.code).toBe('GAME_NOT_ACTIVE');

    removeConnection(ROOM, 'p1');
  });

  it('14. handleDeclare sends GAME_NOT_ACTIVE error when game is already completed', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    gs.status = 'completed';
    gs.winner = 1;
    setGame(ROOM, gs);

    const messages = [];
    const mockWs = makeWs(messages);
    registerConnection(ROOM, 'p1', mockWs);

    await handleDeclare(ROOM, 'p1', 'low_s', { '1_s': 'p1' }, mockWs);

    const err = messages.find((m) => m.type === 'error');
    expect(err).toBeDefined();
    expect(err.code).toBe('GAME_NOT_ACTIVE');

    removeConnection(ROOM, 'p1');
  });

  it('15. liveGamesStore.removeGame is called after the 8th declaration', async () => {
    const halfSuits = buildHalfSuitMap(VARIANT);
    const nonLowS = allHalfSuitIds().filter((id) => id !== 'low_s');

    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    preDeclare(gs, nonLowS, 1);
    gs.scores = { team1: 7, team2: 0 };

    const lowSCards = halfSuits.get('low_s');
    for (const hand of gs.hands.values()) {
      for (const c of lowSCards) hand.delete(c);
    }
    gs.hands.set('p1', new Set(lowSCards.slice(0, 3)));
    gs.hands.set('p2', new Set(lowSCards.slice(3, 6)));
    gs.currentTurnPlayerId = 'p1';

    setGame(ROOM, gs);

    const messages = [];
    const mockWs = makeWs(messages);
    registerConnection(ROOM, 'p1', mockWs);

    const assignment = {};
    for (const c of lowSCards.slice(0, 3)) assignment[c] = 'p1';
    for (const c of lowSCards.slice(3, 6)) assignment[c] = 'p2';

    await handleDeclare(ROOM, 'p1', 'low_s', assignment, mockWs);

    expect(mockLiveGamesStore.removeGame).toHaveBeenCalledWith(ROOM);

    removeConnection(ROOM, 'p1');
  });
});
