'use strict';

/**
 * Sub-AC 10a: Card Dealing Tests
 *
 * Verifies that the server-side card dealing logic:
 *   1. Builds a correct 48-card deck for each variant (remove_2s, remove_7s, remove_8s)
 *   2. Distributes 8 cards to each of 6 players (6-player game)
 *   3. Distributes 6 cards to each of 8 players (8-player game)
 *   4. Produces no duplicate cards across all hands
 *   5. Emits each player's dealt hand in the `game_init` WebSocket message
 *   6. Emits only the requesting player's hand (not others')
 *   7. createGame stores the dealt state and sendGameInit sends correct hand
 *   8. All 48 variant cards are present across the full set of hands
 */

const {
  buildDeck,
  shuffleDeck,
  dealCards,
  cardId,
  parseCardId,
} = require('../game/deck');

const {
  createGameState,
  serializeForPlayer,
  getHand,
  getCardCount,
} = require('../game/gameState');

const {
  createGame,
  sendGameInit,
} = require('../game/gameSocketServer');

const { _clearAll, setGame, registerConnection, getRoomConnections } = require('../game/gameStore');

// ---------------------------------------------------------------------------
// Mock liveGamesStore (used by createGame)
// ---------------------------------------------------------------------------
jest.mock('../liveGames/liveGamesStore', () => ({
  addGame: jest.fn(),
  updateGame: jest.fn(),
  removeGame: jest.fn(),
  get: jest.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Mock Supabase
// ---------------------------------------------------------------------------
jest.mock('../db/supabase', () => ({
  getSupabaseClient: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq:     jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    })),
    auth: { getUser: jest.fn().mockResolvedValue({ data: null, error: new Error('no user') }) },
  })),
}));

// ---------------------------------------------------------------------------
// WebSocket mock
// ---------------------------------------------------------------------------
const { WebSocket } = require('ws');
const WS_OPEN = WebSocket ? WebSocket.OPEN : 1;

function createMockWs(readyState = WS_OPEN) {
  return {
    readyState,
    send: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
  };
}

function parseSent(mockWs) {
  return mockWs.send.mock.calls.map((c) => JSON.parse(c[0]));
}

function lastSent(mockWs) {
  const calls = mockWs.send.mock.calls;
  return calls.length ? JSON.parse(calls[calls.length - 1][0]) : null;
}

// ---------------------------------------------------------------------------
// Seat builders
// ---------------------------------------------------------------------------

function makeSeats6() {
  const players = [];
  for (let i = 0; i < 6; i++) {
    players.push({
      seatIndex:   i,
      playerId:    `p${i + 1}`,
      displayName: `Player ${i + 1}`,
      avatarId:    null,
      teamId:      (i % 2 === 0) ? 1 : 2,
      isBot:       false,
      isGuest:     false,
    });
  }
  return players;
}

function makeSeats8() {
  const players = [];
  for (let i = 0; i < 8; i++) {
    players.push({
      seatIndex:   i,
      playerId:    `p${i + 1}`,
      displayName: `Player ${i + 1}`,
      avatarId:    null,
      teamId:      (i % 2 === 0) ? 1 : 2,
      isBot:       false,
      isGuest:     false,
    });
  }
  return players;
}

// ---------------------------------------------------------------------------
// 1. buildDeck — correct 48-card deck for each variant
// ---------------------------------------------------------------------------

describe('buildDeck()', () => {
  const SUITS = ['s', 'h', 'd', 'c'];

  it('produces exactly 48 cards for remove_2s', () => {
    expect(buildDeck('remove_2s')).toHaveLength(48);
  });

  it('produces exactly 48 cards for remove_7s', () => {
    expect(buildDeck('remove_7s')).toHaveLength(48);
  });

  it('produces exactly 48 cards for remove_8s', () => {
    expect(buildDeck('remove_8s')).toHaveLength(48);
  });

  it('does NOT include any 2s in remove_2s variant', () => {
    const deck = buildDeck('remove_2s');
    for (const suit of SUITS) {
      expect(deck).not.toContain(cardId(2, suit));
    }
  });

  it('does NOT include any 7s in remove_7s variant', () => {
    const deck = buildDeck('remove_7s');
    for (const suit of SUITS) {
      expect(deck).not.toContain(cardId(7, suit));
    }
  });

  it('does NOT include any 8s in remove_8s variant', () => {
    const deck = buildDeck('remove_8s');
    for (const suit of SUITS) {
      expect(deck).not.toContain(cardId(8, suit));
    }
  });

  it('includes all 4 suits and 12 ranks for remove_2s', () => {
    const deck = buildDeck('remove_2s');
    const cardSet = new Set(deck);
    // All ranks except 2 should be present in all suits
    const expectedRanks = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    for (const suit of SUITS) {
      for (const rank of expectedRanks) {
        expect(cardSet.has(cardId(rank, suit))).toBe(true);
      }
    }
  });

  it('includes all 4 suits and 12 ranks for remove_7s', () => {
    const deck = buildDeck('remove_7s');
    const cardSet = new Set(deck);
    const expectedRanks = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13];
    for (const suit of SUITS) {
      for (const rank of expectedRanks) {
        expect(cardSet.has(cardId(rank, suit))).toBe(true);
      }
    }
  });

  it('includes all 4 suits and 12 ranks for remove_8s', () => {
    const deck = buildDeck('remove_8s');
    const cardSet = new Set(deck);
    const expectedRanks = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13];
    for (const suit of SUITS) {
      for (const rank of expectedRanks) {
        expect(cardSet.has(cardId(rank, suit))).toBe(true);
      }
    }
  });

  it('has no duplicate cards', () => {
    const deck = buildDeck('remove_7s');
    expect(new Set(deck).size).toBe(48);
  });

  it('throws for unknown variant', () => {
    expect(() => buildDeck('remove_jokers')).toThrow(/unknown variant/i);
  });

  it('all card IDs parse to valid rank and suit', () => {
    const deck = buildDeck('remove_7s');
    for (const card of deck) {
      const { rank, suit } = parseCardId(card);
      expect(typeof rank).toBe('number');
      expect(rank).toBeGreaterThanOrEqual(1);
      expect(rank).toBeLessThanOrEqual(13);
      expect(['s', 'h', 'd', 'c']).toContain(suit);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. shuffleDeck()
// ---------------------------------------------------------------------------

describe('shuffleDeck()', () => {
  it('returns the same array reference (in-place shuffle)', () => {
    const deck = buildDeck('remove_7s');
    const ref = deck;
    expect(shuffleDeck(deck)).toBe(ref);
  });

  it('preserves all 48 cards after shuffle', () => {
    const deck = buildDeck('remove_7s');
    const original = new Set(deck);
    shuffleDeck(deck);
    const shuffled = new Set(deck);
    expect(shuffled).toEqual(original);
  });

  it('preserves array length', () => {
    const deck = buildDeck('remove_2s');
    shuffleDeck(deck);
    expect(deck).toHaveLength(48);
  });

  it('produces different orderings across multiple shuffles (probabilistic)', () => {
    // Run 10 shuffles; at least one should differ from the original order.
    const original = buildDeck('remove_7s');
    const origStr = [...original].join(',');
    let diffFound = false;
    for (let i = 0; i < 10; i++) {
      const d = [...original]; // fresh copy
      shuffleDeck(d);
      if (d.join(',') !== origStr) {
        diffFound = true;
        break;
      }
    }
    expect(diffFound).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. dealCards() — correct distribution for 6 and 8 players
// ---------------------------------------------------------------------------

describe('dealCards()', () => {
  describe('6-player game (8 cards each)', () => {
    let deck;
    let hands;

    beforeEach(() => {
      deck = buildDeck('remove_7s');
      hands = dealCards(deck, 6);
    });

    it('returns exactly 6 hands', () => {
      expect(hands).toHaveLength(6);
    });

    it('each hand contains exactly 8 cards', () => {
      for (const hand of hands) {
        expect(hand).toHaveLength(8);
      }
    });

    it('all 48 cards are distributed (total = 48)', () => {
      const total = hands.reduce((acc, h) => acc + h.length, 0);
      expect(total).toBe(48);
    });

    it('no card appears in more than one hand', () => {
      const seen = new Set();
      for (const hand of hands) {
        for (const card of hand) {
          expect(seen.has(card)).toBe(false);
          seen.add(card);
        }
      }
    });

    it('all original deck cards are present across all hands', () => {
      const originalSet = new Set(deck);
      const dealtSet    = new Set(hands.flat());
      expect(dealtSet).toEqual(originalSet);
    });
  });

  describe('8-player game (6 cards each)', () => {
    let deck;
    let hands;

    beforeEach(() => {
      deck = buildDeck('remove_2s');
      hands = dealCards(deck, 8);
    });

    it('returns exactly 8 hands', () => {
      expect(hands).toHaveLength(8);
    });

    it('each hand contains exactly 6 cards', () => {
      for (const hand of hands) {
        expect(hand).toHaveLength(6);
      }
    });

    it('all 48 cards are distributed (total = 48)', () => {
      const total = hands.reduce((acc, h) => acc + h.length, 0);
      expect(total).toBe(48);
    });

    it('no card appears in more than one hand', () => {
      const seen = new Set();
      for (const hand of hands) {
        for (const card of hand) {
          expect(seen.has(card)).toBe(false);
          seen.add(card);
        }
      }
    });

    it('all original deck cards are present across all hands', () => {
      const originalSet = new Set(deck);
      const dealtSet    = new Set(hands.flat());
      expect(dealtSet).toEqual(originalSet);
    });
  });

  it('works for all three variants with 6 players', () => {
    for (const variant of ['remove_2s', 'remove_7s', 'remove_8s']) {
      const deck = buildDeck(variant);
      const hands = dealCards(deck, 6);
      expect(hands).toHaveLength(6);
      hands.forEach((h) => expect(h).toHaveLength(8));
      expect(new Set(hands.flat()).size).toBe(48);
    }
  });

  it('works for all three variants with 8 players', () => {
    for (const variant of ['remove_2s', 'remove_7s', 'remove_8s']) {
      const deck = buildDeck(variant);
      const hands = dealCards(deck, 8);
      expect(hands).toHaveLength(8);
      hands.forEach((h) => expect(h).toHaveLength(6));
      expect(new Set(hands.flat()).size).toBe(48);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. createGameState() — dealing inside game state (6-player)
// ---------------------------------------------------------------------------

describe('createGameState() dealing — 6-player', () => {
  let gs;
  const seats = makeSeats6();

  beforeEach(() => {
    gs = createGameState({
      roomCode:    'TEST01',
      roomId:      'room-uuid-1',
      variant:     'remove_7s',
      playerCount: 6,
      seats,
    });
  });

  it('creates exactly 6 player hand entries', () => {
    expect(gs.hands.size).toBe(6);
  });

  it('each player receives exactly 8 cards', () => {
    for (const seat of seats) {
      expect(gs.hands.get(seat.playerId).size).toBe(8);
    }
  });

  it('total card count across all hands is 48', () => {
    let total = 0;
    for (const [, hand] of gs.hands) total += hand.size;
    expect(total).toBe(48);
  });

  it('no card is duplicated across hands', () => {
    const allCards = [];
    for (const [, hand] of gs.hands) allCards.push(...hand);
    expect(new Set(allCards).size).toBe(48);
  });

  it('all 48 variant cards are present', () => {
    const deck = new Set(buildDeck('remove_7s'));
    const dealt = new Set();
    for (const [, hand] of gs.hands) for (const c of hand) dealt.add(c);
    expect(dealt).toEqual(deck);
  });

  it('getCardCount() returns 8 for each player', () => {
    for (const seat of seats) {
      expect(getCardCount(gs, seat.playerId)).toBe(8);
    }
  });

  it('getHand() returns a Set for each player', () => {
    for (const seat of seats) {
      expect(getHand(gs, seat.playerId)).toBeInstanceOf(Set);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. createGameState() — dealing inside game state (8-player)
// ---------------------------------------------------------------------------

describe('createGameState() dealing — 8-player', () => {
  let gs;
  const seats = makeSeats8();

  beforeEach(() => {
    gs = createGameState({
      roomCode:    'TEST02',
      roomId:      'room-uuid-2',
      variant:     'remove_2s',
      playerCount: 8,
      seats,
    });
  });

  it('creates exactly 8 player hand entries', () => {
    expect(gs.hands.size).toBe(8);
  });

  it('each player receives exactly 6 cards', () => {
    for (const seat of seats) {
      expect(gs.hands.get(seat.playerId).size).toBe(6);
    }
  });

  it('total card count across all hands is 48', () => {
    let total = 0;
    for (const [, hand] of gs.hands) total += hand.size;
    expect(total).toBe(48);
  });

  it('no card is duplicated across 8 player hands', () => {
    const allCards = [];
    for (const [, hand] of gs.hands) allCards.push(...hand);
    expect(new Set(allCards).size).toBe(48);
  });

  it('all 48 variant cards are present', () => {
    const deck = new Set(buildDeck('remove_2s'));
    const dealt = new Set();
    for (const [, hand] of gs.hands) for (const c of hand) dealt.add(c);
    expect(dealt).toEqual(deck);
  });

  it('getCardCount() returns 6 for each player', () => {
    for (const seat of seats) {
      expect(getCardCount(gs, seat.playerId)).toBe(6);
    }
  });

  it('team 1 has exactly 4 players (8-player)', () => {
    const t1 = gs.players.filter((p) => p.teamId === 1);
    expect(t1).toHaveLength(4);
  });

  it('team 2 has exactly 4 players (8-player)', () => {
    const t2 = gs.players.filter((p) => p.teamId === 2);
    expect(t2).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 6. serializeForPlayer() — correct hand included in game_init payload
// ---------------------------------------------------------------------------

describe('serializeForPlayer() — game_init hand emission', () => {
  describe('6-player game', () => {
    let gs;
    const seats = makeSeats6();

    beforeEach(() => {
      gs = createGameState({
        roomCode:    'EMITXX',
        roomId:      'room-uuid-emit',
        variant:     'remove_8s',
        playerCount: 6,
        seats,
      });
    });

    it('message type is "game_init"', () => {
      const msg = serializeForPlayer(gs, 'p1');
      expect(msg.type).toBe('game_init');
    });

    it('includes myPlayerId matching the requested player', () => {
      expect(serializeForPlayer(gs, 'p1').myPlayerId).toBe('p1');
      expect(serializeForPlayer(gs, 'p3').myPlayerId).toBe('p3');
    });

    it('myHand is an array of exactly 8 cards for 6-player game', () => {
      for (const seat of seats) {
        const msg = serializeForPlayer(gs, seat.playerId);
        expect(Array.isArray(msg.myHand)).toBe(true);
        expect(msg.myHand).toHaveLength(8);
      }
    });

    it('myHand contains only valid card IDs from the variant deck', () => {
      const deckSet = new Set(buildDeck('remove_8s'));
      const msg = serializeForPlayer(gs, 'p1');
      for (const card of msg.myHand) {
        expect(deckSet.has(card)).toBe(true);
      }
    });

    it('myHand matches the server-side hand Set exactly', () => {
      const serverHand = getHand(gs, 'p2');
      const msg = serializeForPlayer(gs, 'p2');
      expect(new Set(msg.myHand)).toEqual(serverHand);
    });

    it('different players receive different hands', () => {
      const h1 = serializeForPlayer(gs, 'p1').myHand.slice().sort().join(',');
      const h2 = serializeForPlayer(gs, 'p2').myHand.slice().sort().join(',');
      expect(h1).not.toBe(h2);
    });

    it('message includes players list with cardCount (not raw hands)', () => {
      const msg = serializeForPlayer(gs, 'p1');
      expect(Array.isArray(msg.players)).toBe(true);
      for (const p of msg.players) {
        expect(p).toHaveProperty('cardCount');
        expect(p.hand).toBeUndefined();
      }
    });

    it('message includes variant and playerCount', () => {
      const msg = serializeForPlayer(gs, 'p1');
      expect(msg.variant).toBe('remove_8s');
      expect(msg.playerCount).toBe(6);
    });

    it('message includes roomCode', () => {
      const msg = serializeForPlayer(gs, 'p1');
      expect(msg.roomCode).toBe('EMITXX');
    });

    it('message includes gameState without hand data', () => {
      const msg = serializeForPlayer(gs, 'p1');
      expect(msg.gameState).toBeDefined();
      expect(msg.gameState.hands).toBeUndefined();
      expect(msg.gameState.myHand).toBeUndefined();
    });
  });

  describe('8-player game', () => {
    let gs;
    const seats = makeSeats8();

    beforeEach(() => {
      gs = createGameState({
        roomCode:    'EMIT8P',
        roomId:      'room-uuid-emit-8',
        variant:     'remove_7s',
        playerCount: 8,
        seats,
      });
    });

    it('myHand is an array of exactly 6 cards for 8-player game', () => {
      for (const seat of seats) {
        const msg = serializeForPlayer(gs, seat.playerId);
        expect(Array.isArray(msg.myHand)).toBe(true);
        expect(msg.myHand).toHaveLength(6);
      }
    });

    it('cardCount in players list is 6 for each player at game start', () => {
      const msg = serializeForPlayer(gs, 'p1');
      for (const p of msg.players) {
        expect(p.cardCount).toBe(6);
      }
    });

    it('all 8 players are present in the players list', () => {
      const msg = serializeForPlayer(gs, 'p1');
      expect(msg.players).toHaveLength(8);
    });

    it('playerCount in message is 8', () => {
      expect(serializeForPlayer(gs, 'p1').playerCount).toBe(8);
    });
  });
});

// ---------------------------------------------------------------------------
// 7. sendGameInit() — emits game_init via WebSocket to a single player
// ---------------------------------------------------------------------------

describe('sendGameInit() — WebSocket emission', () => {
  beforeEach(() => {
    _clearAll();
  });

  afterEach(() => {
    _clearAll();
  });

  it('sends a game_init message to the player WebSocket (6-player)', () => {
    const gs = createGameState({
      roomCode:    'SEND01',
      roomId:      'room-uuid-send',
      variant:     'remove_7s',
      playerCount: 6,
      seats:       makeSeats6(),
    });
    setGame('SEND01', gs);

    const ws = createMockWs();
    sendGameInit(gs, 'p1', ws);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(ws.send.mock.calls[0][0]);
    expect(msg.type).toBe('game_init');
  });

  it('sent message contains myHand with 8 cards (6-player)', () => {
    const gs = createGameState({
      roomCode:    'SEND02',
      roomId:      'room-uuid-send2',
      variant:     'remove_7s',
      playerCount: 6,
      seats:       makeSeats6(),
    });
    setGame('SEND02', gs);

    const ws = createMockWs();
    sendGameInit(gs, 'p2', ws);

    const msg = JSON.parse(ws.send.mock.calls[0][0]);
    expect(msg.myHand).toHaveLength(8);
  });

  it('sent message contains myHand with 6 cards (8-player)', () => {
    const gs = createGameState({
      roomCode:    'SEND03',
      roomId:      'room-uuid-send3',
      variant:     'remove_2s',
      playerCount: 8,
      seats:       makeSeats8(),
    });
    setGame('SEND03', gs);

    const ws = createMockWs();
    sendGameInit(gs, 'p3', ws);

    const msg = JSON.parse(ws.send.mock.calls[0][0]);
    expect(msg.myHand).toHaveLength(6);
  });

  it('each player in a 6-player game receives a unique hand via sendGameInit', () => {
    const gs = createGameState({
      roomCode:    'SEND04',
      roomId:      'room-uuid-send4',
      variant:     'remove_8s',
      playerCount: 6,
      seats:       makeSeats6(),
    });
    setGame('SEND04', gs);

    const handSets = [];
    for (let i = 1; i <= 6; i++) {
      const ws = createMockWs();
      sendGameInit(gs, `p${i}`, ws);
      const msg = JSON.parse(ws.send.mock.calls[0][0]);
      handSets.push(msg.myHand.slice().sort().join(','));
    }

    // All hands should be distinct
    expect(new Set(handSets).size).toBe(6);
  });

  it('each player in an 8-player game receives a unique hand via sendGameInit', () => {
    const gs = createGameState({
      roomCode:    'SEND05',
      roomId:      'room-uuid-send5',
      variant:     'remove_7s',
      playerCount: 8,
      seats:       makeSeats8(),
    });
    setGame('SEND05', gs);

    const handSets = [];
    for (let i = 1; i <= 8; i++) {
      const ws = createMockWs();
      sendGameInit(gs, `p${i}`, ws);
      const msg = JSON.parse(ws.send.mock.calls[0][0]);
      handSets.push(msg.myHand.slice().sort().join(','));
    }

    expect(new Set(handSets).size).toBe(8);
  });

  it('does NOT send to a closed WebSocket (readyState !== OPEN)', () => {
    const gs = createGameState({
      roomCode:    'SEND06',
      roomId:      'room-uuid-send6',
      variant:     'remove_7s',
      playerCount: 6,
      seats:       makeSeats6(),
    });
    setGame('SEND06', gs);

    const closedWs = createMockWs(3 /* CLOSED */);
    sendGameInit(gs, 'p1', closedWs);
    expect(closedWs.send).not.toHaveBeenCalled();
  });

  it('game_init message includes all required fields', () => {
    const gs = createGameState({
      roomCode:    'SEND07',
      roomId:      'room-uuid-send7',
      variant:     'remove_2s',
      playerCount: 6,
      seats:       makeSeats6(),
    });
    setGame('SEND07', gs);

    const ws = createMockWs();
    sendGameInit(gs, 'p1', ws);
    const msg = JSON.parse(ws.send.mock.calls[0][0]);

    expect(msg).toHaveProperty('type', 'game_init');
    expect(msg).toHaveProperty('roomCode', 'SEND07');
    expect(msg).toHaveProperty('variant', 'remove_2s');
    expect(msg).toHaveProperty('playerCount', 6);
    expect(msg).toHaveProperty('myPlayerId', 'p1');
    expect(msg).toHaveProperty('myHand');
    expect(msg).toHaveProperty('players');
    expect(msg).toHaveProperty('gameState');
  });
});

// ---------------------------------------------------------------------------
// 8. createGame() — dealing through the full game creation pipeline
// ---------------------------------------------------------------------------

describe('createGame() — full deal-and-store pipeline', () => {
  beforeEach(() => {
    _clearAll();
  });

  afterEach(() => {
    _clearAll();
  });

  it('returns a game state with 6 player hands for a 6-player room', () => {
    const gs = createGame({
      roomCode:    'CG6P01',
      roomId:      'room-uuid-cg6p',
      variant:     'remove_7s',
      playerCount: 6,
      seats:       makeSeats6(),
    });

    expect(gs.hands.size).toBe(6);
    for (let i = 1; i <= 6; i++) {
      expect(gs.hands.get(`p${i}`)).toBeInstanceOf(Set);
      expect(gs.hands.get(`p${i}`).size).toBe(8);
    }
  });

  it('returns a game state with 8 player hands for an 8-player room', () => {
    const gs = createGame({
      roomCode:    'CG8P01',
      roomId:      'room-uuid-cg8p',
      variant:     'remove_2s',
      playerCount: 8,
      seats:       makeSeats8(),
    });

    expect(gs.hands.size).toBe(8);
    for (let i = 1; i <= 8; i++) {
      expect(gs.hands.get(`p${i}`)).toBeInstanceOf(Set);
      expect(gs.hands.get(`p${i}`).size).toBe(6);
    }
  });

  it('all 48 cards are present after createGame() for 6-player', () => {
    const gs = createGame({
      roomCode:    'CG6P02',
      roomId:      'room-uuid-cg6p2',
      variant:     'remove_8s',
      playerCount: 6,
      seats:       makeSeats6(),
    });

    const dealtCards = new Set();
    for (const [, hand] of gs.hands) for (const c of hand) dealtCards.add(c);
    expect(dealtCards.size).toBe(48);
    expect(dealtCards).toEqual(new Set(buildDeck('remove_8s')));
  });

  it('all 48 cards are present after createGame() for 8-player', () => {
    const gs = createGame({
      roomCode:    'CG8P02',
      roomId:      'room-uuid-cg8p2',
      variant:     'remove_7s',
      playerCount: 8,
      seats:       makeSeats8(),
    });

    const dealtCards = new Set();
    for (const [, hand] of gs.hands) for (const c of hand) dealtCards.add(c);
    expect(dealtCards.size).toBe(48);
    expect(dealtCards).toEqual(new Set(buildDeck('remove_7s')));
  });

  it('sendGameInit after createGame sends correct player hand (6-player)', () => {
    const gs = createGame({
      roomCode:    'CG6P03',
      roomId:      'room-uuid-cg6p3',
      variant:     'remove_7s',
      playerCount: 6,
      seats:       makeSeats6(),
    });

    const ws = createMockWs();
    sendGameInit(gs, 'p4', ws);
    const msg = JSON.parse(ws.send.mock.calls[0][0]);

    expect(msg.type).toBe('game_init');
    expect(msg.myPlayerId).toBe('p4');
    expect(msg.myHand).toHaveLength(8);
    // Verify the hand matches what's in the game state
    expect(new Set(msg.myHand)).toEqual(gs.hands.get('p4'));
  });

  it('sendGameInit after createGame sends correct player hand (8-player)', () => {
    const gs = createGame({
      roomCode:    'CG8P03',
      roomId:      'room-uuid-cg8p3',
      variant:     'remove_2s',
      playerCount: 8,
      seats:       makeSeats8(),
    });

    const ws = createMockWs();
    sendGameInit(gs, 'p7', ws);
    const msg = JSON.parse(ws.send.mock.calls[0][0]);

    expect(msg.type).toBe('game_init');
    expect(msg.myPlayerId).toBe('p7');
    expect(msg.myHand).toHaveLength(6);
    expect(new Set(msg.myHand)).toEqual(gs.hands.get('p7'));
  });
});

// ---------------------------------------------------------------------------
// 9. Cross-variant dealing — each variant produces correct 8 half-suits
// ---------------------------------------------------------------------------

describe('Dealing produces complete half-suit sets per variant', () => {
  const { buildHalfSuitMap } = require('../game/halfSuits');

  function countCardsInHalfSuits(variant, allCards) {
    const halfSuitMap = buildHalfSuitMap(variant);
    const results = {};
    for (const [hsId, cards] of halfSuitMap) {
      results[hsId] = cards.filter((c) => allCards.has(c)).length;
    }
    return results;
  }

  it('remove_7s: 6-player deal covers all 8 half-suits completely', () => {
    const gs = createGameState({
      roomCode: 'HSTEST1', roomId: 'r1', variant: 'remove_7s',
      playerCount: 6, seats: makeSeats6(),
    });
    const allCards = new Set();
    for (const [, hand] of gs.hands) for (const c of hand) allCards.add(c);

    const coverage = countCardsInHalfSuits('remove_7s', allCards);
    for (const [hsId, count] of Object.entries(coverage)) {
      expect(count).toBe(6); // Each half-suit has 6 cards
    }
  });

  it('remove_2s: 8-player deal covers all 8 half-suits completely', () => {
    const gs = createGameState({
      roomCode: 'HSTEST2', roomId: 'r2', variant: 'remove_2s',
      playerCount: 8, seats: makeSeats8(),
    });
    const allCards = new Set();
    for (const [, hand] of gs.hands) for (const c of hand) allCards.add(c);

    const coverage = countCardsInHalfSuits('remove_2s', allCards);
    for (const [hsId, count] of Object.entries(coverage)) {
      expect(count).toBe(6);
    }
  });

  it('remove_8s: 6-player deal covers all 8 half-suits completely', () => {
    const gs = createGameState({
      roomCode: 'HSTEST3', roomId: 'r3', variant: 'remove_8s',
      playerCount: 6, seats: makeSeats6(),
    });
    const allCards = new Set();
    for (const [, hand] of gs.hands) for (const c of hand) allCards.add(c);

    const coverage = countCardsInHalfSuits('remove_8s', allCards);
    for (const [hsId, count] of Object.entries(coverage)) {
      expect(count).toBe(6);
    }
  });
});
