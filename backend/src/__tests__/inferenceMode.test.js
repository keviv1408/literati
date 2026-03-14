'use strict';

/**
 * Tests for shared global inference-mode state (Sub-AC 37b).
 *
 * Coverage:
 *   handleToggleInference:
 *     1. Toggles inferenceMode from false → true on first call
 *     2. Toggles inferenceMode from true → false on second call
 *     3. Broadcasts inference_mode_changed to all connections in the room
 *     4. Broadcasts enabled=true when mode is toggled on
 *     5. Broadcasts enabled=false when mode is toggled off
 *     6. Broadcasts toggledBy with the correct playerId
 *     7. Does nothing (no crash) if no game exists for roomCode
 *     8. Also broadcasts to spectator connections
 *   serializePublicState:
 *     9. Includes inferenceMode: false by default
 *    10. Reflects inferenceMode: true after toggle
 *   createGameState:
 *    11. Initializes inferenceMode: false
 *   restoreGameState:
 *    12. Restores inferenceMode from snapshot
 *    13. Defaults to false if snapshot has no inferenceMode field
 */

const { setGame, getGame, registerConnection, _clearAll } = require('../game/gameStore');
const { handleToggleInference } = require('../game/gameSocketServer');
const { createGameState, serializePublicState, restoreGameState } = require('../game/gameState');

// ---------------------------------------------------------------------------
// Helper: minimal seat list for a 6-player game
// ---------------------------------------------------------------------------

function makeSeats() {
  return [
    { seatIndex: 0, playerId: 'p1', displayName: 'Alice',  avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 1, playerId: 'p2', displayName: 'Bob',    avatarId: null, teamId: 2, isBot: false, isGuest: false },
    { seatIndex: 2, playerId: 'p3', displayName: 'Carol',  avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 3, playerId: 'p4', displayName: 'Dave',   avatarId: null, teamId: 2, isBot: false, isGuest: false },
    { seatIndex: 4, playerId: 'p5', displayName: 'Eve',    avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 5, playerId: 'p6', displayName: 'Frank',  avatarId: null, teamId: 2, isBot: false, isGuest: false },
  ];
}

function makeGame(roomCode = 'INFER1') {
  return createGameState({
    roomCode,
    roomId:      'room-uuid-001',
    variant:     'remove_7s',
    playerCount: 6,
    seats:       makeSeats(),
  });
}

/**
 * Build a mock WebSocket object that records sent messages.
 */
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

const ROOM = 'INFER1';

beforeEach(() => {
  _clearAll();
  const gs = makeGame(ROOM);
  setGame(ROOM, gs);
});

afterEach(() => {
  _clearAll();
});

// ---------------------------------------------------------------------------
// createGameState — inferenceMode initialisation
// ---------------------------------------------------------------------------

describe('createGameState — inferenceMode', () => {
  it('initialises inferenceMode to false', () => {
    const gs = makeGame('INIT01');
    expect(gs.inferenceMode).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// serializePublicState — inferenceMode field
// ---------------------------------------------------------------------------

describe('serializePublicState — inferenceMode', () => {
  it('includes inferenceMode: false when not toggled', () => {
    const gs = getGame(ROOM);
    const state = serializePublicState(gs);
    expect(state).toHaveProperty('inferenceMode', false);
  });

  it('reflects inferenceMode: true after toggling', () => {
    const gs = getGame(ROOM);
    gs.inferenceMode = true;
    const state = serializePublicState(gs);
    expect(state).toHaveProperty('inferenceMode', true);
  });
});

// ---------------------------------------------------------------------------
// restoreGameState — inferenceMode field
// ---------------------------------------------------------------------------

describe('restoreGameState — inferenceMode', () => {
  it('restores inferenceMode from snapshot when present', () => {
    const snapshot = {
      variant: 'remove_7s',
      playerCount: 6,
      status: 'active',
      currentTurnPlayerId: 'p1',
      players: makeSeats(),
      hands: { p1: [], p2: [], p3: [], p4: [], p5: [], p6: [] },
      declaredSuits: {},
      scores: { team1: 0, team2: 0 },
      lastMove: null,
      winner: null,
      tiebreakerWinner: null,
      moveHistory: [],
      inferenceMode: true,
    };
    const gs = restoreGameState(snapshot, 'RESTORE1', 'room-uuid-restore');
    expect(gs.inferenceMode).toBe(true);
  });

  it('defaults inferenceMode to false when not in snapshot', () => {
    const snapshot = {
      variant: 'remove_7s',
      playerCount: 6,
      status: 'active',
      currentTurnPlayerId: 'p1',
      players: makeSeats(),
      hands: { p1: [], p2: [], p3: [], p4: [], p5: [], p6: [] },
      declaredSuits: {},
      scores: { team1: 0, team2: 0 },
      lastMove: null,
      winner: null,
      tiebreakerWinner: null,
      moveHistory: [],
      // inferenceMode intentionally absent
    };
    const gs = restoreGameState(snapshot, 'RESTORE2', 'room-uuid-restore2');
    expect(gs.inferenceMode).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleToggleInference
// ---------------------------------------------------------------------------

describe('handleToggleInference', () => {
  it('toggles inferenceMode from false to true on first call', () => {
    handleToggleInference(ROOM, 'p1');
    expect(getGame(ROOM).inferenceMode).toBe(true);
  });

  it('toggles inferenceMode back to false on second call', () => {
    handleToggleInference(ROOM, 'p1');
    handleToggleInference(ROOM, 'p1');
    expect(getGame(ROOM).inferenceMode).toBe(false);
  });

  it('does not throw if no game exists for the room code', () => {
    expect(() => handleToggleInference('NOROOM', 'p1')).not.toThrow();
  });

  describe('broadcast behaviour', () => {
    let ws1, ws2;

    beforeEach(() => {
      ws1 = mockWs();
      ws2 = mockWs();
      registerConnection(ROOM, 'p1', ws1);
      registerConnection(ROOM, 'p2', ws2);
    });

    it('broadcasts inference_mode_changed to all connected players', () => {
      handleToggleInference(ROOM, 'p1');
      expect(ws1._sent).toHaveLength(1);
      expect(ws2._sent).toHaveLength(1);
    });

    it('broadcasts enabled: true when turning on', () => {
      handleToggleInference(ROOM, 'p1');
      expect(ws1._sent[0]).toMatchObject({ type: 'inference_mode_changed', enabled: true });
      expect(ws2._sent[0]).toMatchObject({ type: 'inference_mode_changed', enabled: true });
    });

    it('broadcasts enabled: false when turning off', () => {
      handleToggleInference(ROOM, 'p1'); // on
      handleToggleInference(ROOM, 'p1'); // off
      expect(ws1._sent[1]).toMatchObject({ type: 'inference_mode_changed', enabled: false });
      expect(ws2._sent[1]).toMatchObject({ type: 'inference_mode_changed', enabled: false });
    });

    it('broadcasts toggledBy with the correct playerId', () => {
      handleToggleInference(ROOM, 'p2');
      expect(ws1._sent[0]).toMatchObject({ type: 'inference_mode_changed', toggledBy: 'p2' });
      expect(ws2._sent[0]).toMatchObject({ type: 'inference_mode_changed', toggledBy: 'p2' });
    });

    it('broadcasts to spectator connections in the room', () => {
      const spectatorWs = mockWs();
      registerConnection(ROOM, 'spectator-xyz', spectatorWs);

      handleToggleInference(ROOM, 'p1');

      expect(spectatorWs._sent).toHaveLength(1);
      expect(spectatorWs._sent[0]).toMatchObject({
        type: 'inference_mode_changed',
        enabled: true,
      });
    });

    it('each toggle broadcasts exactly one message per connection', () => {
      handleToggleInference(ROOM, 'p1');
      expect(ws1._sent).toHaveLength(1);
      expect(ws2._sent).toHaveLength(1);

      handleToggleInference(ROOM, 'p2');
      expect(ws1._sent).toHaveLength(2);
      expect(ws2._sent).toHaveLength(2);
    });
  });
});
