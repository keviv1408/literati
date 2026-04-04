'use strict';

/**
 * Unit tests for * 30-second server-side countdown timer on bot takeover of a declaration.
 *
 * When a human player's turn timer fires while they are mid-declaration, the
 * server broadcasts `bot_takeover`, then starts a BOT_DECLARATION_TAKEOVER_MS
 * (30 s) countdown before auto-submitting the completed assignment.
 *
 * Coverage:
 *
 * startBotDeclarationCountdown:
 * 1. Broadcasts `bot_declaration_timer` to ALL clients with duration/expiresAt
 * 2. Timer duration is exactly BOT_DECLARATION_TAKEOVER_MS (30 000 ms)
 * 3. Emits `bot_declaration_timer_tick` events to ALL clients every TIMER_TICK_INTERVAL_MS
 * 4. Does NOT include the assignment in the `bot_declaration_timer` broadcast (privacy)
 * 5. After 30 s, calls handleDeclare and broadcasts `declaration_result`
 * 6. `declaration_result` arrives AFTER `bot_declaration_timer` in message queue
 * 7. Does nothing if game is no longer active when timer fires
 * 8. Does nothing if turn has passed to another player when timer fires
 *
 * executeTimedOutTurn → startBotDeclarationCountdown integration:
 * 9. Declaration with complete 6-card assignment → countdown starts (not immediate)
 * 10. Declaration with disconnected player → countdown starts (not immediate)
 * 11. `bot_takeover` is broadcast BEFORE `bot_declaration_timer`
 * 12. `bot_declaration_timer` is broadcast BEFORE `declaration_result`
 *
 * cancelBotDeclarationTimer:
 * 13. Cancels an active bot-declaration timer so handleDeclare does not fire
 * 14. No-op when no timer is active (safe to call unconditionally)
 */

const {
  executeTimedOutTurn,
  cancelTurnTimer,
  startBotDeclarationCountdown,
  cancelBotDeclarationTimer,
  handleAskCard,
  handleDeclare,
  _reconnectWindows,
  _declarationSelections,
  _botDeclarationTimers,
  BOT_DECLARATION_TAKEOVER_MS,
  TIMER_TICK_INTERVAL_MS,
} = require('../game/gameSocketServer');
const {
  updateKnowledgeAfterAsk,
  updateTeamIntentAfterAsk,
} = require('../game/botLogic');

const { setGame, getGame, registerConnection, removeConnection } = require('../game/gameStore');
const { createGameState } = require('../game/gameState');
const { setPartialSelection, _clearAll: clearAllPartial } = require('../game/partialSelectionStore');

// ---------------------------------------------------------------------------
// Mocks
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
// Test game-state builder
// ---------------------------------------------------------------------------
/**
 * Builds a 6-player game (remove_7s variant).
 *
 * Team 1: p1(seat 0), p2(seat 2), p3(seat 4)
 * Team 2: p4(seat 1), p5(seat 3), p6(seat 5)
 *
 * low_s = 1_s, 2_s, 3_s, 4_s, 5_s, 6_s
 * p1 holds 1_s,2_s,3_s | p2 holds 4_s,5_s,6_s
 *
 * All 6 low_s cards are on Team 1, so a correct full assignment is possible.
 */
const ROOM = 'BOTDCL';

function buildGame({ currentTurnPlayerId = 'p1' } = {}) {
  const seats = [
    { seatIndex: 0, playerId: 'p1', displayName: 'P1', avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 1, playerId: 'p4', displayName: 'P4', avatarId: null, teamId: 2, isBot: false, isGuest: false },
    { seatIndex: 2, playerId: 'p2', displayName: 'P2', avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 3, playerId: 'p5', displayName: 'P5', avatarId: null, teamId: 2, isBot: false, isGuest: false },
    { seatIndex: 4, playerId: 'p3', displayName: 'P3', avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 5, playerId: 'p6', displayName: 'P6', avatarId: null, teamId: 2, isBot: false, isGuest: false },
  ];

  const gs = createGameState({
    roomCode:    ROOM,
    roomId:      'room-uuid-botdcl',
    variant:     'remove_7s',
    playerCount: 6,
    seats,
  });
  gs.status              = 'active';
  gs.currentTurnPlayerId = currentTurnPlayerId;

  // Assign known hands: p1 holds low_s 1-3, p2 holds low_s 4-6
  // (all low_s cards are on Team 1 for a correct declaration)
  for (const pid of ['p1','p2','p3','p4','p5','p6']) {
    gs.hands.set(pid, new Set());
  }
  gs.hands.get('p1').add('1_s'); gs.hands.get('p1').add('2_s'); gs.hands.get('p1').add('3_s');
  gs.hands.get('p2').add('4_s'); gs.hands.get('p2').add('5_s'); gs.hands.get('p2').add('6_s');
  gs.hands.get('p3').add('1_h'); gs.hands.get('p3').add('2_h');
  gs.hands.get('p4').add('8_s'); gs.hands.get('p4').add('9_s');
  gs.hands.get('p5').add('10_s'); gs.hands.get('p5').add('11_s');
  gs.hands.get('p6').add('12_s'); gs.hands.get('p6').add('13_s');

  return gs;
}

/** Complete correct assignment for low_s. */
const COMPLETE_ASSIGNMENT = {
  '1_s': 'p1', '2_s': 'p1', '3_s': 'p1',
  '4_s': 'p2', '5_s': 'p2', '6_s': 'p2',
};

function makeMockWs() {
  const msgs = [];
  return {
    readyState: 1,
    send: (data) => msgs.push(JSON.parse(data)),
    _messages: msgs,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  clearAllPartial();
  _reconnectWindows.clear();
  _declarationSelections.clear();
  try { setGame(ROOM, null); } catch { /* ok */ }
});

afterEach(() => {
  jest.useRealTimers();
  cancelTurnTimer(ROOM);
  cancelBotDeclarationTimer(ROOM);
  _reconnectWindows.clear();
  _declarationSelections.clear();
  for (const pid of ['p1','p2','p3','p4','p5','p6']) {
    removeConnection(ROOM, pid);
  }
  clearAllPartial();
});

// ---------------------------------------------------------------------------
// startBotDeclarationCountdown — direct unit tests
// ---------------------------------------------------------------------------

describe('startBotDeclarationCountdown', () => {
  it('1. broadcasts bot_declaration_timer to ALL connected clients', async () => {
    const gs = buildGame();
    setGame(ROOM, gs);

    const ws1 = makeMockWs();
    const ws2 = makeMockWs();
    const ws4 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);
    registerConnection(ROOM, 'p2', ws2);
    registerConnection(ROOM, 'p4', ws4);

    await startBotDeclarationCountdown(ROOM, 'p1', {
      flow: 'declare',
      halfSuitId: 'low_s',
      assignment: { ...COMPLETE_ASSIGNMENT },
    });

    expect(ws1._messages.some((m) => m.type === 'bot_declaration_timer')).toBe(true);
    expect(ws2._messages.some((m) => m.type === 'bot_declaration_timer')).toBe(true);
    expect(ws4._messages.some((m) => m.type === 'bot_declaration_timer')).toBe(true);
  });

  it('2. timer duration is exactly BOT_DECLARATION_TAKEOVER_MS (30 000 ms)', async () => {
    const gs = buildGame();
    setGame(ROOM, gs);

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    const before = Date.now();
    await startBotDeclarationCountdown(ROOM, 'p1', {
      flow: 'declare', halfSuitId: 'low_s', assignment: { ...COMPLETE_ASSIGNMENT },
    });

    const timerMsg = ws1._messages.find((m) => m.type === 'bot_declaration_timer');
    expect(timerMsg).toBeDefined();
    expect(timerMsg.durationMs).toBe(BOT_DECLARATION_TAKEOVER_MS);
    expect(timerMsg.expiresAt).toBeGreaterThanOrEqual(before + BOT_DECLARATION_TAKEOVER_MS - 50);
    expect(timerMsg.playerId).toBe('p1');
  });

  it('3. emits bot_declaration_timer_tick events every TIMER_TICK_INTERVAL_MS to ALL clients', async () => {
    const gs = buildGame();
    setGame(ROOM, gs);

    const ws1 = makeMockWs();
    const ws2 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);
    registerConnection(ROOM, 'p2', ws2);

    await startBotDeclarationCountdown(ROOM, 'p1', {
      flow: 'declare', halfSuitId: 'low_s', assignment: { ...COMPLETE_ASSIGNMENT },
    });

    // Advance by one tick interval
    jest.advanceTimersByTime(TIMER_TICK_INTERVAL_MS);

    expect(ws1._messages.some((m) => m.type === 'bot_declaration_timer_tick')).toBe(true);
    expect(ws2._messages.some((m) => m.type === 'bot_declaration_timer_tick')).toBe(true);

    const tick = ws1._messages.find((m) => m.type === 'bot_declaration_timer_tick');
    expect(tick.playerId).toBe('p1');
    expect(tick.remainingMs).toBeLessThanOrEqual(BOT_DECLARATION_TAKEOVER_MS);
    expect(tick.expiresAt).toBeDefined();
  });

  it('4. does NOT include assignment in bot_declaration_timer broadcast (privacy)', async () => {
    const gs = buildGame();
    setGame(ROOM, gs);

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    await startBotDeclarationCountdown(ROOM, 'p1', {
      flow: 'declare', halfSuitId: 'low_s', assignment: { ...COMPLETE_ASSIGNMENT },
    });

    const timerMsg = ws1._messages.find((m) => m.type === 'bot_declaration_timer');
    expect(timerMsg).toBeDefined();
    // Must NOT expose the assignment or halfSuitId
    expect(timerMsg.assignment).toBeUndefined();
    expect(timerMsg.halfSuitId).toBeUndefined();
  });

  it('5. after BOT_DECLARATION_TAKEOVER_MS, declaration_result is broadcast to all clients', async () => {
    const gs = buildGame();
    setGame(ROOM, gs);

    const ws1 = makeMockWs();
    const ws2 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);
    registerConnection(ROOM, 'p2', ws2);

    await startBotDeclarationCountdown(ROOM, 'p1', {
      flow: 'declare', halfSuitId: 'low_s', assignment: { ...COMPLETE_ASSIGNMENT },
    });

    // No declaration_result yet
    expect(ws1._messages.some((m) => m.type === 'declaration_result')).toBe(false);

    // Advance past the countdown
    await jest.advanceTimersByTimeAsync(BOT_DECLARATION_TAKEOVER_MS);

    expect(ws1._messages.some((m) => m.type === 'declaration_result')).toBe(true);
    expect(ws2._messages.some((m) => m.type === 'declaration_result')).toBe(true);

    const result = ws1._messages.find((m) => m.type === 'declaration_result');
    expect(result.correct).toBe(true);
    expect(result.halfSuitId).toBe('low_s');
    expect(result.declarerId).toBe('p1');
  });

  it('6. declaration_result arrives AFTER bot_declaration_timer in the message queue', async () => {
    const gs = buildGame();
    setGame(ROOM, gs);

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    await startBotDeclarationCountdown(ROOM, 'p1', {
      flow: 'declare', halfSuitId: 'low_s', assignment: { ...COMPLETE_ASSIGNMENT },
    });
    await jest.advanceTimersByTimeAsync(BOT_DECLARATION_TAKEOVER_MS);

    const timerIdx  = ws1._messages.findIndex((m) => m.type === 'bot_declaration_timer');
    const resultIdx = ws1._messages.findIndex((m) => m.type === 'declaration_result');
    expect(timerIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThanOrEqual(0);
    expect(timerIdx).toBeLessThan(resultIdx);
  });

  it('7. does nothing if game is no longer active when timer fires', async () => {
    const gs = buildGame();
    setGame(ROOM, gs);

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    await startBotDeclarationCountdown(ROOM, 'p1', {
      flow: 'declare', halfSuitId: 'low_s', assignment: { ...COMPLETE_ASSIGNMENT },
    });

    // Simulate game ending before timer fires
    gs.status = 'completed';

    await jest.advanceTimersByTimeAsync(BOT_DECLARATION_TAKEOVER_MS);

    // No declaration_result should have been broadcast
    expect(ws1._messages.some((m) => m.type === 'declaration_result')).toBe(false);
  });

  it('8. does nothing if turn has passed to another player when timer fires', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame(ROOM, gs);

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    await startBotDeclarationCountdown(ROOM, 'p1', {
      flow: 'declare', halfSuitId: 'low_s', assignment: { ...COMPLETE_ASSIGNMENT },
    });

    // Simulate turn passing to p2 before timer fires
    gs.currentTurnPlayerId = 'p2';

    await jest.advanceTimersByTimeAsync(BOT_DECLARATION_TAKEOVER_MS);

    expect(ws1._messages.some((m) => m.type === 'declaration_result')).toBe(false);
  });

  it('8b. auto-submitted bot-controlled declarations can hand the turn to a blocked teammate', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    gs.hands.set('p2', new Set(['4_s', '5_s', '6_s', '1_h', '8_h']));
    setGame(ROOM, gs);

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    updateKnowledgeAfterAsk(gs, 'p2', 'p4', '2_h', true);
    updateKnowledgeAfterAsk(gs, 'p2', 'p5', '3_h', true);
    updateKnowledgeAfterAsk(gs, 'p2', 'p6', '4_h', true);
    updateTeamIntentAfterAsk(gs, 'p2', '4_h', true);

    await startBotDeclarationCountdown(ROOM, 'p1', {
      flow: 'declare',
      halfSuitId: 'low_s',
      assignment: { ...COMPLETE_ASSIGNMENT },
    });

    await jest.advanceTimersByTimeAsync(BOT_DECLARATION_TAKEOVER_MS);

    const resultMsg = ws1._messages.find((m) => m.type === 'declaration_result');
    expect(resultMsg).toBeDefined();
    expect(resultMsg.newTurnPlayerId).toBe('p2');
    expect(getGame(ROOM).currentTurnPlayerId).toBe('p2');
  });
});

// ---------------------------------------------------------------------------
// executeTimedOutTurn → startBotDeclarationCountdown integration
// ---------------------------------------------------------------------------

describe('executeTimedOutTurn → bot declaration countdown integration', () => {
  it('9. declaration with complete 6-card assignment → countdown starts (not immediate)', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame(ROOM, gs);

    setPartialSelection(ROOM, 'p1', {
      flow: 'declare', halfSuitId: 'low_s', assignment: { ...COMPLETE_ASSIGNMENT },
    });

    const ws1 = makeMockWs();
    const ws2 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);
    registerConnection(ROOM, 'p2', ws2);

    await executeTimedOutTurn(ROOM, 'p1');

    // Declaration should NOT have happened yet — countdown is running
    expect(ws1._messages.some((m) => m.type === 'declaration_result')).toBe(false);
    // But bot_declaration_timer must have been broadcast
    expect(ws1._messages.some((m) => m.type === 'bot_declaration_timer')).toBe(true);

    // Advance past countdown to trigger auto-submit
    await jest.advanceTimersByTimeAsync(BOT_DECLARATION_TAKEOVER_MS);
    expect(ws1._messages.some((m) => m.type === 'declaration_result')).toBe(true);
  });

  it('10. disconnected player mid-declaration → countdown starts (not immediate)', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame(ROOM, gs);

    // Mark p1 as disconnected (in reconnect window)
    _reconnectWindows.set('p1', {
      roomCode: ROOM,
      originalDisplayName: 'P1',
      originalAvatarId: null,
      originalIsGuest: false,
      timerId: setTimeout(() => {}, 60000),
      expiresAt: Date.now() + 60000,
    });

    // Partial (incomplete) assignment — disconnected so bypasses forced-failure
    setPartialSelection(ROOM, 'p1', {
      flow: 'declare', halfSuitId: 'low_s',
      assignment: { '1_s': 'p1', '2_s': 'p1' },
    });

    const ws1 = makeMockWs();
    const ws2 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);
    registerConnection(ROOM, 'p2', ws2);

    await executeTimedOutTurn(ROOM, 'p1');

    // Countdown should have started — no immediate result
    expect(ws1._messages.some((m) => m.type === 'declaration_result')).toBe(false);
    expect(ws1._messages.some((m) => m.type === 'bot_declaration_timer')).toBe(true);

    // Advance past countdown
    await jest.advanceTimersByTimeAsync(BOT_DECLARATION_TAKEOVER_MS);
    expect(ws1._messages.some((m) => m.type === 'declaration_result')).toBe(true);

    // Cleanup reconnect window
    const entry = _reconnectWindows.get('p1');
    if (entry?.timerId) clearTimeout(entry.timerId);
    _reconnectWindows.delete('p1');
  });

  it('11. bot_takeover is broadcast BEFORE bot_declaration_timer', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame(ROOM, gs);

    setPartialSelection(ROOM, 'p1', {
      flow: 'declare', halfSuitId: 'low_s', assignment: { ...COMPLETE_ASSIGNMENT },
    });

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    await executeTimedOutTurn(ROOM, 'p1');

    const takeoverIdx = ws1._messages.findIndex((m) => m.type === 'bot_takeover');
    const timerIdx    = ws1._messages.findIndex((m) => m.type === 'bot_declaration_timer');

    expect(takeoverIdx).toBeGreaterThanOrEqual(0);
    expect(timerIdx).toBeGreaterThanOrEqual(0);
    expect(takeoverIdx).toBeLessThan(timerIdx);
  });

  it('12. bot_declaration_timer is broadcast BEFORE declaration_result', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame(ROOM, gs);

    setPartialSelection(ROOM, 'p1', {
      flow: 'declare', halfSuitId: 'low_s', assignment: { ...COMPLETE_ASSIGNMENT },
    });

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    await executeTimedOutTurn(ROOM, 'p1');
    await jest.advanceTimersByTimeAsync(BOT_DECLARATION_TAKEOVER_MS);

    const timerIdx  = ws1._messages.findIndex((m) => m.type === 'bot_declaration_timer');
    const resultIdx = ws1._messages.findIndex((m) => m.type === 'declaration_result');

    expect(timerIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThanOrEqual(0);
    expect(timerIdx).toBeLessThan(resultIdx);
  });

  it('12b. immediate timeout declarations also hand the turn to a blocked teammate', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame(ROOM, gs);

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    gs.botKnowledge.set('p2', new Map([
      ['4_s', true],
      ['5_s', true],
      ['6_s', true],
    ]));

    updateKnowledgeAfterAsk(gs, 'p3', 'p4', '3_h', true);
    updateKnowledgeAfterAsk(gs, 'p3', 'p5', '4_h', true);
    updateKnowledgeAfterAsk(gs, 'p3', 'p6', '5_h', true);
    updateTeamIntentAfterAsk(gs, 'p3', '5_h', true);

    await executeTimedOutTurn(ROOM, 'p1');

    const resultMsg = ws1._messages.find((m) => m.type === 'declaration_result');
    expect(resultMsg).toBeDefined();
    expect(resultMsg.newTurnPlayerId).toBe('p3');
    expect(getGame(ROOM).currentTurnPlayerId).toBe('p3');
  });
});

// ---------------------------------------------------------------------------
// cancelBotDeclarationTimer
// ---------------------------------------------------------------------------

describe('cancelBotDeclarationTimer', () => {
  it('13. cancels an active timer so declaration_result does not fire', async () => {
    const gs = buildGame({ currentTurnPlayerId: 'p1' });
    setGame(ROOM, gs);

    const ws1 = makeMockWs();
    registerConnection(ROOM, 'p1', ws1);

    await startBotDeclarationCountdown(ROOM, 'p1', {
      flow: 'declare', halfSuitId: 'low_s', assignment: { ...COMPLETE_ASSIGNMENT },
    });

    // Timer is now active
    expect(_botDeclarationTimers.has(ROOM)).toBe(true);

    // Cancel it
    cancelBotDeclarationTimer(ROOM);
    expect(_botDeclarationTimers.has(ROOM)).toBe(false);

    // Advance past countdown — nothing should fire
    await jest.advanceTimersByTimeAsync(BOT_DECLARATION_TAKEOVER_MS);
    expect(ws1._messages.some((m) => m.type === 'declaration_result')).toBe(false);
  });

  it('14. no-op when no timer is active (safe to call unconditionally)', () => {
    expect(() => cancelBotDeclarationTimer(ROOM)).not.toThrow();
    expect(() => cancelBotDeclarationTimer('NONEXISTENT')).not.toThrow();
  });
});
