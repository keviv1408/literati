'use strict';

/**
 * Tests for Revision broadcast via handleDeclareProgress.
 *
 * When the declarant changes (revises) a card assignment before submitting,
 * the frontend calls onDeclareProgress with the updated assignment map.
 * The server broadcasts the revised state to all other connected clients.
 *
 * These tests verify that:
 * 1. A second declare_progress broadcast (revision) correctly overwrites the
 * first from all non-declarant clients' perspective
 * 2. The revised assignment map is fully reflected in the broadcast payload
 * 3. Revising a single card in a 6-card assignment is broadcast correctly
 * 4. Revising back to the original assignment is broadcast correctly
 * 5. Sequential revisions produce independent broadcasts (server is stateless
 * for progress — no caching of previous assignment)
 * 6. A revision with a different halfSuitId (back → different suit) after
 * cancellation re-starts the progress correctly
 * 7. Broadcast continues to exclude the declarant across all revisions
 * 8. assignedCount reflects the revised assignment count correctly
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

function makeGame(roomCode = 'REVTEST') {
  return createGameState({
    roomCode,
    roomId:      'room-uuid-rev-001',
    variant:     'remove_7s',
    playerCount: 6,
    seats:       makeSeats(),
  });
}

function mockWs() {
  const sent = [];
  return {
    readyState: 1,
    send: (data) => { sent.push(JSON.parse(data)); },
    _sent: sent,
    _clear() { sent.length = 0; },
  };
}

function getProgressMsgs(ws) {
  return ws._sent.filter(m => m.type === 'declare_progress');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const ROOM = 'REVTEST';
let gs, wsP1, wsP2, wsP3, wsSpectator;

beforeEach(() => {
  _clearAll();
  gs = makeGame(ROOM);
  setGame(ROOM, gs);

  wsP1        = mockWs();
  wsP2        = mockWs();
  wsP3        = mockWs();
  wsSpectator = mockWs();

  registerConnection(ROOM, 'p1', wsP1);
  registerConnection(ROOM, 'p2', wsP2);
  registerConnection(ROOM, 'p3', wsP3);
  registerConnection(ROOM, 'spectator_rev01', wsSpectator);
});

afterEach(() => {
  _clearAll();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('declare_progress revision broadcast ', () => {
  // p1 = current-turn player (seat 0)

  test('1. second broadcast (revision) reflects updated assignment on receiver side', () => {
    // Initial assignment
    handleDeclareProgress(ROOM, 'p1', 'low_s', {
      '1_s': 'p1', '2_s': 'p3', '3_s': 'p5',
      '4_s': 'p3', '5_s': 'p5', '6_s': 'p1',
    });

    // Revision: reassign 2_s from p3 → p5
    handleDeclareProgress(ROOM, 'p1', 'low_s', {
      '1_s': 'p1', '2_s': 'p5', '3_s': 'p5',
      '4_s': 'p3', '5_s': 'p5', '6_s': 'p1',
    });

    const msgs = getProgressMsgs(wsP2);
    // Two separate broadcasts sent
    expect(msgs).toHaveLength(2);
    // Second message (revision) should show 2_s → p5
    expect(msgs[1].assignment['2_s']).toBe('p5');
  });

  test('2. revised assignment map is fully reflected in broadcast payload', () => {
    const revisedAssignment = {
      '1_s': 'p1', '2_s': 'p5', '3_s': 'p3',
      '4_s': 'p1', '5_s': 'p5', '6_s': 'p3',
    };

    handleDeclareProgress(ROOM, 'p1', 'low_s', revisedAssignment);

    const msg = wsP2._sent.find(m => m.type === 'declare_progress');
    expect(msg).toBeDefined();
    expect(msg.assignment).toEqual(revisedAssignment);
  });

  test('3. revising a single card in a 6-card assignment broadcasts the full updated map', () => {
    // Original: all to p1
    const original = {
      '1_s': 'p1', '2_s': 'p1', '3_s': 'p1',
      '4_s': 'p1', '5_s': 'p1', '6_s': 'p1',
    };
    handleDeclareProgress(ROOM, 'p1', 'low_s', original);
    wsP2._clear();

    // Revise: change 3_s from p1 → p3
    const revised = { ...original, '3_s': 'p3' };
    handleDeclareProgress(ROOM, 'p1', 'low_s', revised);

    const msgs = getProgressMsgs(wsP2);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].assignment).toEqual(revised);
    expect(msgs[0].assignment['3_s']).toBe('p3');
  });

  test('4. revising back to original assignment broadcasts correctly', () => {
    const original = {
      '1_s': 'p1', '2_s': 'p3', '3_s': 'p5',
      '4_s': 'p1', '5_s': 'p3', '6_s': 'p5',
    };
    handleDeclareProgress(ROOM, 'p1', 'low_s', original);

    // Change 2_s to p5
    handleDeclareProgress(ROOM, 'p1', 'low_s', { ...original, '2_s': 'p5' });

    // Revert 2_s back to p3
    handleDeclareProgress(ROOM, 'p1', 'low_s', original);

    const msgs = getProgressMsgs(wsP2);
    expect(msgs).toHaveLength(3);
    // Final broadcast matches original
    expect(msgs[2].assignment).toEqual(original);
  });

  test('5. sequential revisions produce independent broadcasts (server is stateless)', () => {
    const base = {
      '1_s': 'p1', '2_s': 'p3', '3_s': 'p5',
      '4_s': 'p1', '5_s': 'p3', '6_s': 'p5',
    };

    // 4 rapid revisions
    for (let i = 0; i < 4; i++) {
      const assignment = { ...base };
      assignment['2_s'] = i % 2 === 0 ? 'p3' : 'p5';
      handleDeclareProgress(ROOM, 'p1', 'low_s', assignment);
    }

    // Each call produces one broadcast per connected non-declarant
    expect(getProgressMsgs(wsP2)).toHaveLength(4);
    expect(getProgressMsgs(wsP3)).toHaveLength(4);
    expect(getProgressMsgs(wsSpectator)).toHaveLength(4);
    // Declarant (p1) never receives any
    expect(getProgressMsgs(wsP1)).toHaveLength(0);
  });

  test('6. cancellation then new suit selection works as fresh revision sequence', () => {
    // Start declaring low_s
    handleDeclareProgress(ROOM, 'p1', 'low_s', { '1_s': 'p1', '2_s': 'p3' });

    // Cancel (halfSuitId: null)
    handleDeclareProgress(ROOM, 'p1', null, {});

    // Start fresh with high_d
    handleDeclareProgress(ROOM, 'p1', 'high_d', { '8_d': 'p1', '9_d': 'p3' });

    const msgs = getProgressMsgs(wsP2);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].halfSuitId).toBe('low_s');
    expect(msgs[1].halfSuitId).toBeNull();
    expect(msgs[2].halfSuitId).toBe('high_d');
  });

  test('7. declarant never receives any revision broadcast', () => {
    const assignment = {
      '1_s': 'p1', '2_s': 'p3', '3_s': 'p5',
      '4_s': 'p1', '5_s': 'p3', '6_s': 'p5',
    };

    // 5 revisions
    for (let i = 0; i < 5; i++) {
      handleDeclareProgress(ROOM, 'p1', 'low_s', { ...assignment, '4_s': i % 2 === 0 ? 'p1' : 'p3' });
    }

    // p1 (declarant) should receive ZERO declare_progress messages across all revisions
    expect(getProgressMsgs(wsP1)).toHaveLength(0);
  });

  test('8. assignedCount reflects the revised assignment count correctly', () => {
    // 3 cards assigned in revision
    handleDeclareProgress(ROOM, 'p1', 'low_s', { '1_s': 'p1', '2_s': 'p3', '3_s': 'p5' });
    const msg3 = wsP2._sent.find(m => m.type === 'declare_progress');
    expect(msg3.assignedCount).toBe(3);
    wsP2._clear();

    // 6 cards assigned in next revision (fully assigned)
    handleDeclareProgress(ROOM, 'p1', 'low_s', {
      '1_s': 'p1', '2_s': 'p3', '3_s': 'p5',
      '4_s': 'p1', '5_s': 'p3', '6_s': 'p5',
    });
    const msg6 = wsP2._sent.find(m => m.type === 'declare_progress');
    expect(msg6.assignedCount).toBe(6);
  });
});
