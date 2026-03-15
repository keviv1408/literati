'use strict';

/**
 * Tests for real-time declaration-progress broadcast (Sub-AC 21b).
 *
 * Coverage:
 *   handleDeclareProgress:
 *     1. Broadcasts declare_progress to all OTHER connections (excludes declarant)
 *     2. Broadcasts to spectator connections too
 *     3. Does nothing if game not found for roomCode
 *     4. Does nothing if game status is not 'active'
 *     5. Does nothing if sender is not the current-turn player
 *     6. Broadcast includes correct declarerId, halfSuitId, assignedCount, totalCards, assignment
 *     7. assignedCount reflects the number of entries in the assignment object
 *     8. Handles null halfSuitId (cancellation signal) — broadcasts with halfSuitId: null
 *     9. Handles empty assignment gracefully (assignedCount = 0)
 *    10. Does NOT send back to the declarant's own connection
 */

const { setGame, getGame, registerConnection, _clearAll } = require('../game/gameStore');
const { handleDeclareProgress } = require('../game/gameSocketServer');
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

function makeGame(roomCode = 'DECPG1') {
  return createGameState({
    roomCode,
    roomId:      'room-uuid-001',
    variant:     'remove_7s',
    playerCount: 6,
    seats:       makeSeats(),
  });
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
// Setup / teardown
// ---------------------------------------------------------------------------

const ROOM = 'DECPG1';
let gs;
let wsP1, wsP2, wsP3, wsSpectator;

beforeEach(() => {
  _clearAll();
  gs = makeGame(ROOM);
  setGame(ROOM, gs);

  // Register connections for all 6 players + 1 spectator
  wsP1        = mockWs();
  wsP2        = mockWs();
  wsP3        = mockWs();
  wsSpectator = mockWs();

  registerConnection(ROOM, 'p1', wsP1);
  registerConnection(ROOM, 'p2', wsP2);
  registerConnection(ROOM, 'p3', wsP3);
  // Spectator uses a synthetic spectator_ prefixed id (mirrors gameSocketServer.js)
  registerConnection(ROOM, 'spectator_abc123', wsSpectator);
});

afterEach(() => {
  _clearAll();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleDeclareProgress', () => {
  // p1 is always seat 0 (Team 1) and is typically the current-turn player
  // after createGameState (first player at seat 0).

  test('1. broadcasts declare_progress to all OTHER connections (excludes declarant)', () => {
    const assignment = { '1_s': 'p1', '2_s': 'p3' };
    handleDeclareProgress(ROOM, 'p1', 'low_s', assignment);

    // p1 (the declarant) should NOT receive the broadcast
    expect(wsP1._sent.filter(m => m.type === 'declare_progress')).toHaveLength(0);

    // p2 and p3 should each receive exactly one declare_progress message
    expect(wsP2._sent.filter(m => m.type === 'declare_progress')).toHaveLength(1);
    expect(wsP3._sent.filter(m => m.type === 'declare_progress')).toHaveLength(1);
  });

  test('2. broadcasts to spectator connections too', () => {
    handleDeclareProgress(ROOM, 'p1', 'low_s', { '1_s': 'p1' });
    const spectatorMsgs = wsSpectator._sent.filter(m => m.type === 'declare_progress');
    expect(spectatorMsgs).toHaveLength(1);
  });

  test('3. does nothing if game not found for roomCode', () => {
    // Should not throw
    expect(() => handleDeclareProgress('NOPE99', 'p1', 'low_s', {})).not.toThrow();
    // No messages sent
    expect(wsP2._sent).toHaveLength(0);
  });

  test('4. does nothing if game status is not active', () => {
    gs.status = 'completed';
    handleDeclareProgress(ROOM, 'p1', 'low_s', { '1_s': 'p1' });
    expect(wsP2._sent.filter(m => m.type === 'declare_progress')).toHaveLength(0);
  });

  test('5. does nothing if sender is not the current-turn player', () => {
    // p2 is not the current-turn player (p1 is)
    handleDeclareProgress(ROOM, 'p2', 'low_s', { '1_s': 'p1' });
    expect(wsP1._sent.filter(m => m.type === 'declare_progress')).toHaveLength(0);
    expect(wsP3._sent.filter(m => m.type === 'declare_progress')).toHaveLength(0);
  });

  test('6. broadcast includes correct declarerId, halfSuitId, assignedCount, totalCards, assignment', () => {
    const assignment = { '1_s': 'p1', '2_s': 'p3', '3_s': 'p5' };
    handleDeclareProgress(ROOM, 'p1', 'low_s', assignment);

    const msg = wsP2._sent.find(m => m.type === 'declare_progress');
    expect(msg).toBeDefined();
    expect(msg.declarerId).toBe('p1');
    expect(msg.halfSuitId).toBe('low_s');
    expect(msg.assignedCount).toBe(3);
    expect(msg.totalCards).toBe(6);
    expect(msg.assignment).toEqual(assignment);
  });

  test('7. assignedCount reflects number of entries in assignment object', () => {
    // 2 entries
    handleDeclareProgress(ROOM, 'p1', 'low_s', { '1_s': 'p1', '2_s': 'p3' });
    const msg2 = wsP2._sent.find(m => m.type === 'declare_progress');
    expect(msg2.assignedCount).toBe(2);

    wsP2._sent.length = 0;

    // 6 entries (fully assigned)
    handleDeclareProgress(ROOM, 'p1', 'low_s', {
      '1_s': 'p1', '2_s': 'p3', '3_s': 'p5',
      '4_s': 'p1', '5_s': 'p3', '6_s': 'p5',
    });
    const msg6 = wsP2._sent.find(m => m.type === 'declare_progress');
    expect(msg6.assignedCount).toBe(6);
  });

  test('8. handles null halfSuitId (cancellation signal) — broadcasts with halfSuitId: null', () => {
    handleDeclareProgress(ROOM, 'p1', null, {});

    const msg = wsP2._sent.find(m => m.type === 'declare_progress');
    expect(msg).toBeDefined();
    expect(msg.halfSuitId).toBeNull();
    expect(msg.assignedCount).toBe(0);
    expect(msg.assignment).toEqual({});
  });

  test('9. handles empty assignment gracefully (assignedCount = 0)', () => {
    handleDeclareProgress(ROOM, 'p1', 'low_s', {});

    const msg = wsP2._sent.find(m => m.type === 'declare_progress');
    expect(msg).toBeDefined();
    expect(msg.assignedCount).toBe(0);
    expect(msg.assignment).toEqual({});
  });

  test('10. does NOT send back to the declarant own connection (double-check isolation)', () => {
    handleDeclareProgress(ROOM, 'p1', 'high_d', { '8_d': 'p1', '9_d': 'p3' });

    // p1 should receive 0 declare_progress messages
    const p1Msgs = wsP1._sent.filter(m => m.type === 'declare_progress');
    expect(p1Msgs).toHaveLength(0);

    // All other registered connections should receive exactly 1
    expect(wsP2._sent.filter(m => m.type === 'declare_progress')).toHaveLength(1);
    expect(wsP3._sent.filter(m => m.type === 'declare_progress')).toHaveLength(1);
    expect(wsSpectator._sent.filter(m => m.type === 'declare_progress')).toHaveLength(1);
  });
});
