'use strict';

/**
 * Unit tests for gameState.js
 *
 * Coverage:
 *   createGameState:
 *     1. Deals 48 cards total (6 players × 8 each)
 *     2. Assigns players to alternating teams (seat order: T1,T2,T1,T2...)
 *   serializePublicState:
 *     3. Does NOT include any hand data
 *     4. Includes required fields: status, currentTurnPlayerId, scores, lastMove, declaredSuits, winner
 *   serializeForPlayer:
 *     5. Includes myHand array for the requesting player
 *     6. Includes correct myPlayerId
 *   getPlayerTeam:
 *     7. Returns correct team for each player
 *   getHand:
 *     8. Returns a Set of cards for a player
 */

const {
  createGameState,
  serializePublicState,
  serializeForPlayer,
  serializePlayers,
  buildPersistedSnapshot,
  restoreGameState,
  getPlayerTeam,
  getHand,
} = require('../game/gameState');

// ---------------------------------------------------------------------------
// Helper: build a standard 6-player seat list with alternating teams
// ---------------------------------------------------------------------------

function makeSeats() {
  return [
    { seatIndex: 0, playerId: 'p1', displayName: 'Player 1', avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 1, playerId: 'p2', displayName: 'Player 2', avatarId: null, teamId: 2, isBot: false, isGuest: false },
    { seatIndex: 2, playerId: 'p3', displayName: 'Player 3', avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 3, playerId: 'p4', displayName: 'Player 4', avatarId: null, teamId: 2, isBot: false, isGuest: false },
    { seatIndex: 4, playerId: 'p5', displayName: 'Player 5', avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 5, playerId: 'p6', displayName: 'Player 6', avatarId: null, teamId: 2, isBot: false, isGuest: false },
  ];
}

function makeGame() {
  return createGameState({
    roomCode: 'TESTX',
    roomId: 'room-uuid-001',
    variant: 'remove_7s',
    playerCount: 6,
    seats: makeSeats(),
  });
}

// ---------------------------------------------------------------------------
// createGameState
// ---------------------------------------------------------------------------

describe('createGameState', () => {
  let gs;

  beforeEach(() => {
    gs = makeGame();
  });

  it('deals 48 total cards across 6 players (8 each)', () => {
    let total = 0;
    for (const [, hand] of gs.hands) {
      total += hand.size;
    }
    expect(total).toBe(48);
    for (const seat of makeSeats()) {
      expect(gs.hands.get(seat.playerId).size).toBe(8);
    }
  });

  it('all dealt cards are unique (no duplicates)', () => {
    const allCards = [];
    for (const [, hand] of gs.hands) {
      allCards.push(...hand);
    }
    expect(new Set(allCards).size).toBe(48);
  });

  it('assigns players to their specified teams', () => {
    const seats = makeSeats();
    for (const seat of seats) {
      const player = gs.players.find((p) => p.playerId === seat.playerId);
      expect(player).toBeDefined();
      expect(player.teamId).toBe(seat.teamId);
    }
  });

  it('alternating seats have alternating teams (T1,T2,T1,T2...)', () => {
    const teams = gs.players.map((p) => p.teamId);
    expect(teams).toEqual([1, 2, 1, 2, 1, 2]);
  });

  it('status is "active"', () => {
    expect(gs.status).toBe('active');
  });

  it('firstTurnPlayerId is the player in seat 0', () => {
    expect(gs.currentTurnPlayerId).toBe('p1');
  });

  it('scores start at 0-0', () => {
    expect(gs.scores).toEqual({ team1: 0, team2: 0 });
  });

  it('declaredSuits starts empty', () => {
    expect(gs.declaredSuits.size).toBe(0);
  });

  it('winner starts as null', () => {
    expect(gs.winner).toBeNull();
  });

  it('moveHistory starts empty', () => {
    expect(gs.moveHistory).toEqual([]);
  });

  it('teamIntentMemory starts as an empty Map', () => {
    expect(gs.teamIntentMemory).toBeInstanceOf(Map);
    expect(gs.teamIntentMemory.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// serializePublicState
// ---------------------------------------------------------------------------

describe('serializePublicState', () => {
  let gs;

  beforeEach(() => {
    gs = makeGame();
  });

  it('does NOT include any hand data', () => {
    const pub = serializePublicState(gs);
    expect(pub.hands).toBeUndefined();
    expect(pub.myHand).toBeUndefined();
  });

  it('includes "status"', () => {
    const pub = serializePublicState(gs);
    expect(pub).toHaveProperty('status', 'active');
  });

  it('includes "currentTurnPlayerId"', () => {
    const pub = serializePublicState(gs);
    expect(pub).toHaveProperty('currentTurnPlayerId', 'p1');
  });

  it('includes "scores"', () => {
    const pub = serializePublicState(gs);
    expect(pub).toHaveProperty('scores');
    expect(pub.scores).toEqual({ team1: 0, team2: 0 });
  });

  it('includes "lastMove" (null initially)', () => {
    const pub = serializePublicState(gs);
    expect(pub).toHaveProperty('lastMove', null);
  });

  it('includes "declaredSuits" as an array', () => {
    const pub = serializePublicState(gs);
    expect(pub).toHaveProperty('declaredSuits');
    expect(Array.isArray(pub.declaredSuits)).toBe(true);
  });

  it('includes "winner" (null initially)', () => {
    const pub = serializePublicState(gs);
    expect(pub).toHaveProperty('winner', null);
  });

  it('does NOT include botKnowledge', () => {
    const pub = serializePublicState(gs);
    expect(pub.botKnowledge).toBeUndefined();
  });

  it('does NOT include teamIntentMemory', () => {
    const pub = serializePublicState(gs);
    expect(pub.teamIntentMemory).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// serializeForPlayer
// ---------------------------------------------------------------------------

describe('serializeForPlayer', () => {
  let gs;

  beforeEach(() => {
    gs = makeGame();
  });

  it('includes myHand array for the requesting player', () => {
    const result = serializeForPlayer(gs, 'p1');
    expect(result).toHaveProperty('myHand');
    expect(Array.isArray(result.myHand)).toBe(true);
    expect(result.myHand).toHaveLength(8);
  });

  it('myHand matches the actual hand Set', () => {
    const result = serializeForPlayer(gs, 'p1');
    const hand = getHand(gs, 'p1');
    expect(new Set(result.myHand)).toEqual(hand);
  });

  it('includes correct myPlayerId', () => {
    const result = serializeForPlayer(gs, 'p3');
    expect(result.myPlayerId).toBe('p3');
  });

  it('includes gameState (public state)', () => {
    const result = serializeForPlayer(gs, 'p1');
    expect(result).toHaveProperty('gameState');
    expect(result.gameState).toHaveProperty('status');
    expect(result.gameState.hands).toBeUndefined();
  });

  it('includes players list', () => {
    const result = serializeForPlayer(gs, 'p1');
    expect(Array.isArray(result.players)).toBe(true);
    expect(result.players).toHaveLength(6);
  });

  it('players list does NOT include raw hand cards (only cardCount)', () => {
    const result = serializeForPlayer(gs, 'p1');
    for (const p of result.players) {
      expect(p.hand).toBeUndefined();
      expect(p).toHaveProperty('cardCount');
    }
  });

  it('different players get different myHand arrays', () => {
    const r1 = serializeForPlayer(gs, 'p1');
    const r2 = serializeForPlayer(gs, 'p2');
    // Hands are different sets
    expect(r1.myHand.sort()).not.toEqual(r2.myHand.sort());
  });
});

// ---------------------------------------------------------------------------
// Persist / restore
// ---------------------------------------------------------------------------

describe('buildPersistedSnapshot / restoreGameState', () => {
  it('preserves teamIntentMemory across persistence', () => {
    const gs = makeGame();
    gs.teamIntentMemory.set(1, new Map([
      ['high_s', {
        strength: 4,
        lastUpdatedMoveIndex: 9,
        sourcePlayerId: 'p5',
        focusCardId: '11_s',
        lastOutcome: 'success',
      }],
    ]));

    const snapshot = buildPersistedSnapshot(gs);
    const restored = restoreGameState(snapshot, gs.roomCode, gs.roomId);

    expect(restored.teamIntentMemory.get(1).get('high_s')).toEqual({
      strength: 4,
      lastUpdatedMoveIndex: 9,
      sourcePlayerId: 'p5',
      focusCardId: '11_s',
      lastOutcome: 'success',
    });
  });
});

// ---------------------------------------------------------------------------
// getPlayerTeam
// ---------------------------------------------------------------------------

describe('getPlayerTeam', () => {
  let gs;

  beforeEach(() => {
    gs = makeGame();
  });

  it('returns team 1 for p1', () => {
    expect(getPlayerTeam(gs, 'p1')).toBe(1);
  });

  it('returns team 2 for p2', () => {
    expect(getPlayerTeam(gs, 'p2')).toBe(2);
  });

  it('returns team 1 for p3', () => {
    expect(getPlayerTeam(gs, 'p3')).toBe(1);
  });

  it('returns team 2 for p4', () => {
    expect(getPlayerTeam(gs, 'p4')).toBe(2);
  });

  it('returns null for unknown player', () => {
    expect(getPlayerTeam(gs, 'unknown')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getHand
// ---------------------------------------------------------------------------

describe('getHand', () => {
  let gs;

  beforeEach(() => {
    gs = makeGame();
  });

  it('returns a Set of cards for a player', () => {
    const hand = getHand(gs, 'p1');
    expect(hand).toBeInstanceOf(Set);
    expect(hand.size).toBe(8);
  });

  it('returns an empty Set for unknown player', () => {
    const hand = getHand(gs, 'nobody');
    expect(hand).toBeInstanceOf(Set);
    expect(hand.size).toBe(0);
  });

  it('returned Set is the live hand (mutations visible)', () => {
    const hand = getHand(gs, 'p1');
    const firstCard = [...hand][0];
    hand.delete(firstCard);
    expect(getHand(gs, 'p1').size).toBe(7);
  });
});
