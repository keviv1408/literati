'use strict';

/**
 * A dropped seat is held for SEAT_HOLD_MS before the disconnect flow (bot flag,
 * player_disconnected, bot move) starts, so a client that reconnects in place
 * gets its seat back untouched.
 */

jest.mock('../db/supabase', () => ({
  getSupabaseClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      upsert: () => Promise.resolve({ error: null }),
      rpc:    () => Promise.resolve({ error: null }),
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

const {
  createGame,
  executeTimedOutTurn,
  cancelTurnTimer,
  cancelBotTimer,
  cancelBotDeclarationTimer,
  _clearAllReconnectWindows,
  _reconnectWindows,
  _botDeclarationTimers,
  _startSeatHold,
  _cancelSeatHold,
  _clearAllSeatHolds,
  _seatHolds,
  SEAT_HOLD_MS,
} = require('../game/gameSocketServer');
const { setGame, getGame, registerConnection, _clearAll } = require('../game/gameStore');
const { setPartialSelection } = require('../game/partialSelectionStore');

const ROOM = 'HOLD01';

function makeGame() {
  const seats = [
    { seatIndex: 0, playerId: 'h1',    displayName: 'H1', avatarId: null, teamId: 1, isBot: false, isGuest: true  },
    { seatIndex: 1, playerId: 'h2',    displayName: 'H2', avatarId: null, teamId: 2, isBot: false, isGuest: true  },
    { seatIndex: 2, playerId: 'bot-1', displayName: 'B1', avatarId: null, teamId: 1, isBot: true,  isGuest: false },
    { seatIndex: 3, playerId: 'bot-2', displayName: 'B2', avatarId: null, teamId: 2, isBot: true,  isGuest: false },
    { seatIndex: 4, playerId: 'bot-3', displayName: 'B3', avatarId: null, teamId: 1, isBot: true,  isGuest: false },
    { seatIndex: 5, playerId: 'bot-4', displayName: 'B4', avatarId: null, teamId: 2, isBot: true,  isGuest: false },
  ];
  const gs = createGame({ roomCode: ROOM, roomId: 'room-uuid-hold', variant: 'remove_7s', playerCount: 6, seats });
  gs.status = 'active';
  gs.currentTurnPlayerId = 'h2';
  return gs;
}

function makeMockWs() {
  const msgs = [];
  return { readyState: 1, send: jest.fn((d) => msgs.push(JSON.parse(d))), _messages: msgs };
}

const h1 = (gs) => gs.players.find((p) => p.playerId === 'h1');

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  _clearAllSeatHolds();
  _clearAllReconnectWindows();
  for (const room of [ROOM, 'DECLTO']) {
    cancelTurnTimer(room);
    cancelBotTimer(room);
    cancelBotDeclarationTimer(room);
  }
  _clearAll();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('seat hold', () => {
  it('starts the disconnect flow only after SEAT_HOLD_MS', () => {
    expect(SEAT_HOLD_MS).toBe(45_000);
    const gs = makeGame();
    const ws2 = makeMockWs();
    registerConnection(ROOM, 'h2', ws2);

    _startSeatHold(ROOM, 'h1');
    jest.advanceTimersByTime(SEAT_HOLD_MS - 1);

    expect(h1(gs).isBot).toBe(false);
    expect(_reconnectWindows.has('h1')).toBe(false);
    expect(ws2._messages.some((m) => m.type === 'player_disconnected')).toBe(false);

    jest.advanceTimersByTime(1);

    expect(h1(gs).isBot).toBe(true);
    expect(_reconnectWindows.has('h1')).toBe(true);
    expect(ws2._messages.some((m) => m.type === 'player_disconnected' && m.playerId === 'h1')).toBe(true);
    expect(_seatHolds.size).toBe(0);
  });

  it('does nothing once cancelled', () => {
    const gs = makeGame();
    const ws2 = makeMockWs();
    registerConnection(ROOM, 'h2', ws2);

    _startSeatHold(ROOM, 'h1');
    jest.advanceTimersByTime(10_000);
    _cancelSeatHold(ROOM, 'h1');
    jest.advanceTimersByTime(60_000);

    expect(h1(gs).isBot).toBe(false);
    expect(_reconnectWindows.has('h1')).toBe(false);
    expect(ws2._messages.some((m) => m.type === 'player_disconnected')).toBe(false);
    expect(_seatHolds.size).toBe(0);
  });

  it('keeps the first deadline when the hold is started again', () => {
    const gs = makeGame();
    registerConnection(ROOM, 'h2', makeMockWs());

    _startSeatHold(ROOM, 'h1');
    jest.advanceTimersByTime(20_000);
    _startSeatHold(ROOM, 'h1');
    jest.advanceTimersByTime(SEAT_HOLD_MS - 20_000);

    expect(h1(gs).isBot).toBe(true);
    expect(_reconnectWindows.has('h1')).toBe(true);
  });

  it('does nothing when the player has a registered connection at fire time', () => {
    const gs = makeGame();
    const ws2 = makeMockWs();
    registerConnection(ROOM, 'h2', ws2);

    _startSeatHold(ROOM, 'h1');
    registerConnection(ROOM, 'h1', makeMockWs());
    jest.advanceTimersByTime(SEAT_HOLD_MS);

    expect(h1(gs).isBot).toBe(false);
    expect(_reconnectWindows.has('h1')).toBe(false);
    expect(ws2._messages.some((m) => m.type === 'player_disconnected')).toBe(false);
  });

  it('does nothing when the game is no longer active at fire time', () => {
    const gs = makeGame();
    const ws2 = makeMockWs();
    registerConnection(ROOM, 'h2', ws2);

    _startSeatHold(ROOM, 'h1');
    gs.status = 'completed';
    jest.advanceTimersByTime(SEAT_HOLD_MS);

    expect(h1(gs).isBot).toBe(false);
    expect(_reconnectWindows.has('h1')).toBe(false);
    expect(ws2._messages.some((m) => m.type === 'player_disconnected')).toBe(false);
    expect(getGame(ROOM)).toBe(gs);
  });

  it('lets the bot finish a held declarer\'s partial declaration instead of forcing a failure', async () => {
    const hands = new Map([
      ['p1', new Set(['1_s', '2_s', '3_s', '8_s', '9_s', '10_s'])],
      ['p2', new Set(['4_s', '5_s', '6_s', '11_s', '12_s', '13_s'])],
      ['p3', new Set(['1_h', '2_h', '3_h', '8_h', '9_h', '10_h'])],
      ['p4', new Set(['4_h', '5_h', '6_h', '11_h', '12_h', '13_h'])],
      ['p5', new Set(['1_d', '2_d', '3_d', '8_d', '9_d', '10_d'])],
      ['p6', new Set(['4_d', '5_d', '6_d', '11_d', '12_d', '13_d'])],
    ]);
    setGame('DECLTO', {
      roomCode:            'DECLTO',
      roomId:              'room-uuid',
      variant:             'remove_7s',
      playerCount:         6,
      status:              'active',
      currentTurnPlayerId: 'p1',
      players: [
        { playerId: 'p1', displayName: 'P1', teamId: 1, seatIndex: 0, isBot: false, isGuest: false },
        { playerId: 'p2', displayName: 'P2', teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
        { playerId: 'p3', displayName: 'P3', teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
        { playerId: 'p4', displayName: 'P4', teamId: 2, seatIndex: 1, isBot: false, isGuest: false },
        { playerId: 'p5', displayName: 'P5', teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
        { playerId: 'p6', displayName: 'P6', teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
      ],
      hands,
      declaredSuits:    new Map(),
      scores:           { team1: 0, team2: 0 },
      lastMove:         null,
      winner:           null,
      tiebreakerWinner: null,
      botKnowledge:     new Map(),
      moveHistory:      [],
    });
    setPartialSelection('DECLTO', 'p1', {
      flow:       'declare',
      halfSuitId: 'low_s',
      assignment: { '1_s': 'p1', '2_s': 'p1', '3_s': 'p1' },
    });
    const observer = makeMockWs();
    registerConnection('DECLTO', 'p4', observer);

    _startSeatHold('DECLTO', 'p1');
    await executeTimedOutTurn('DECLTO', 'p1');

    expect(observer._messages.some((m) => m.type === 'declaration_result' && m.timedOut === true)).toBe(false);
    expect(_botDeclarationTimers.has('DECLTO')).toBe(true);
    expect(observer._messages.some((m) => m.type === 'bot_declaration_timer' && m.playerId === 'p1')).toBe(true);
  });
});
