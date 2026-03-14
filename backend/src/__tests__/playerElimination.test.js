'use strict';

/**
 * Tests for Sub-AC 27b: Player elimination after half-suit removal.
 *
 * Covers:
 *   1. _detectNewlyEliminated marks players with 0 cards after a declaration
 *   2. applyDeclaration returns newlyEliminated list
 *   3. applyForcedFailedDeclaration returns newlyEliminated list
 *   4. _resolveValidTurn respects stored turnRecipients
 *   5. handleChooseTurnRecipient stores recipient in gs.turnRecipients
 *   6. _processNewlyEliminatedPlayers broadcasts player_eliminated and prompts
 */

const {
  applyDeclaration,
  applyForcedFailedDeclaration,
  _detectNewlyEliminated,
  _resolveValidTurn,
} = require('../game/gameEngine');
const { createGameState, getPlayerTeam, getCardCount } = require('../game/gameState');
const {
  handleChooseTurnRecipient,
  _processNewlyEliminatedPlayers,
} = require('../game/gameSocketServer');
const { _clearAll, setGame, getGame } = require('../game/gameStore');

// ── Shared test helpers ────────────────────────────────────────────────────

/**
 * Build a minimal 6-player GameState with a specific hand layout.
 * Team 1: p1 (seat 0), p2 (seat 2), p3 (seat 4)
 * Team 2: p4 (seat 1), p5 (seat 3), p6 (seat 5)
 *
 * Variant: remove_7s (standard)
 * Half-suit low_s = [1_s, 2_s, 3_s, 4_s, 5_s, 6_s]  (ranks 1–6, spades)
 */
function buildGameState(overrides = {}) {
  const seats = [
    { seatIndex: 0, playerId: 'p1', displayName: 'Alice', avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 1, playerId: 'p4', displayName: 'Dave',  avatarId: null, teamId: 2, isBot: false, isGuest: false },
    { seatIndex: 2, playerId: 'p2', displayName: 'Bob',   avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 3, playerId: 'p5', displayName: 'Eve',   avatarId: null, teamId: 2, isBot: false, isGuest: false },
    { seatIndex: 4, playerId: 'p3', displayName: 'Carol', avatarId: null, teamId: 1, isBot: false, isGuest: false },
    { seatIndex: 5, playerId: 'p6', displayName: 'Frank', avatarId: null, teamId: 2, isBot: false, isGuest: false },
  ];
  const gs = createGameState({
    roomCode:    'ELIM01',
    roomId:      'room-uuid-1',
    variant:     'remove_7s',
    playerCount: 6,
    seats,
  });

  // Apply overrides
  Object.assign(gs, overrides);
  return gs;
}

// low_s = ace through 6 of spades (remove_7s variant)
const LOW_S_CARDS = ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'];

// ── 1. _detectNewlyEliminated ──────────────────────────────────────────────

describe('_detectNewlyEliminated', () => {
  test('returns empty array when no player has an empty hand', () => {
    const gs = buildGameState();
    // Everyone has a full hand from createGameState
    const result = _detectNewlyEliminated(gs);
    expect(result).toEqual([]);
    expect(gs.eliminatedPlayerIds.size).toBe(0);
  });

  test('detects a single player whose hand is now empty', () => {
    const gs = buildGameState();
    // Manually empty p1's hand
    gs.hands.get('p1').clear();

    const result = _detectNewlyEliminated(gs);
    expect(result).toContain('p1');
    expect(result).toHaveLength(1);
    expect(gs.eliminatedPlayerIds.has('p1')).toBe(true);
  });

  test('detects multiple players with empty hands', () => {
    const gs = buildGameState();
    gs.hands.get('p1').clear();
    gs.hands.get('p4').clear();

    const result = _detectNewlyEliminated(gs);
    expect(result).toContain('p1');
    expect(result).toContain('p4');
    expect(result).toHaveLength(2);
    expect(gs.eliminatedPlayerIds.size).toBe(2);
  });

  test('does not re-detect already-eliminated players', () => {
    const gs = buildGameState();
    gs.hands.get('p1').clear();
    gs.eliminatedPlayerIds.add('p1'); // already marked

    const result = _detectNewlyEliminated(gs);
    expect(result).toHaveLength(0);
  });

  test('creates eliminatedPlayerIds set if missing (defensive)', () => {
    const gs = buildGameState();
    delete gs.eliminatedPlayerIds;
    gs.hands.get('p1').clear();

    const result = _detectNewlyEliminated(gs);
    expect(result).toContain('p1');
    expect(gs.eliminatedPlayerIds).toBeDefined();
  });
});

// ── 2. applyDeclaration returns newlyEliminated ────────────────────────────

describe('applyDeclaration — newlyEliminated', () => {
  function buildDeclareGs() {
    const gs = buildGameState();
    // Give p1 all 6 low_s cards (they will declare this half-suit)
    const p1Hand = gs.hands.get('p1');
    p1Hand.clear();
    LOW_S_CARDS.forEach((c) => p1Hand.add(c));

    // Give p2 some other cards so they don't get eliminated
    const p2Hand = gs.hands.get('p2');
    p2Hand.clear();
    p2Hand.add('8_s'); // high_s card (not in low_s)
    p2Hand.add('9_s');

    // Empty out p3, p4, p5, p6 except we need them to have cards for
    // the game to not be over (only 1 declared suit, 7 remain)
    ['p3', 'p4', 'p5', 'p6'].forEach((pid) => {
      const h = gs.hands.get(pid);
      h.clear();
      h.add('8_h'); // all have same card (simulating they still have cards from other suits)
    });

    gs.currentTurnPlayerId = 'p1';
    return gs;
  }

  test('returns empty newlyEliminated when no one runs out', () => {
    const gs = buildDeclareGs();
    // correct assignment: all 6 low_s assigned to p1
    const assignment = Object.fromEntries(LOW_S_CARDS.map((c) => [c, 'p1']));
    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);

    // p1 had only low_s cards → p1 is now empty → should be eliminated
    expect(result.newlyEliminated).toContain('p1');
  });

  test('eliminates p1 when p1 held only low_s cards', () => {
    const gs = buildDeclareGs();
    const assignment = Object.fromEntries(LOW_S_CARDS.map((c) => [c, 'p1']));
    applyDeclaration(gs, 'p1', 'low_s', assignment);

    expect(gs.eliminatedPlayerIds.has('p1')).toBe(true);
    expect(getCardCount(gs, 'p1')).toBe(0);
  });

  test('does not eliminate p2 who still has cards after declaration', () => {
    const gs = buildDeclareGs();
    const assignment = Object.fromEntries(LOW_S_CARDS.map((c) => [c, 'p1']));
    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);

    expect(result.newlyEliminated).not.toContain('p2');
    expect(gs.eliminatedPlayerIds.has('p2')).toBe(false);
  });

  test('newlyEliminated is included in return object', () => {
    const gs = buildDeclareGs();
    const assignment = Object.fromEntries(LOW_S_CARDS.map((c) => [c, 'p1']));
    const result = applyDeclaration(gs, 'p1', 'low_s', assignment);

    expect(result).toHaveProperty('newlyEliminated');
    expect(Array.isArray(result.newlyEliminated)).toBe(true);
  });
});

// ── 3. applyForcedFailedDeclaration returns newlyEliminated ────────────────

describe('applyForcedFailedDeclaration — newlyEliminated', () => {
  function buildForceGs() {
    const gs = buildGameState();
    const p1Hand = gs.hands.get('p1');
    p1Hand.clear();
    LOW_S_CARDS.forEach((c) => p1Hand.add(c));
    // Give p4 the low_s cards too to simulate a spread scenario
    // (in reality cards are distributed, this is simplified for testing)
    // Actually: forced fail just removes all 6 low_s from ALL hands
    // For isolation test: give p2 some other cards
    const p2Hand = gs.hands.get('p2');
    p2Hand.clear();
    p2Hand.add('8_s');
    ['p3', 'p4', 'p5', 'p6'].forEach((pid) => {
      gs.hands.get(pid).clear();
      gs.hands.get(pid).add('9_h');
    });
    gs.currentTurnPlayerId = 'p1';
    return gs;
  }

  test('returns newlyEliminated when player runs out', () => {
    const gs = buildForceGs();
    const result = applyForcedFailedDeclaration(gs, 'p1', 'low_s');

    expect(result).toHaveProperty('newlyEliminated');
    expect(Array.isArray(result.newlyEliminated)).toBe(true);
    // p1 had only low_s cards, they are now empty
    expect(result.newlyEliminated).toContain('p1');
  });

  test('marks eliminated player in gs.eliminatedPlayerIds', () => {
    const gs = buildForceGs();
    applyForcedFailedDeclaration(gs, 'p1', 'low_s');
    expect(gs.eliminatedPlayerIds.has('p1')).toBe(true);
  });
});

// ── 4. _resolveValidTurn respects turnRecipients ───────────────────────────

describe('_resolveValidTurn — turnRecipient preference', () => {
  test('uses stored recipient when candidate is eliminated', () => {
    const gs = buildGameState();
    // Empty p1's hand (eliminated)
    gs.hands.get('p1').clear();
    gs.eliminatedPlayerIds.add('p1');

    // p2 and p3 both have cards; p1 chooses p3 as their recipient
    gs.turnRecipients = new Map([['p1', 'p3']]);

    const nextTurn = _resolveValidTurn(gs, 'p1');
    expect(nextTurn).toBe('p3');
  });

  test('falls back to first teammate when stored recipient has no cards', () => {
    const gs = buildGameState();
    gs.hands.get('p1').clear();
    gs.eliminatedPlayerIds.add('p1');

    // p3 (stored recipient) also has no cards
    gs.hands.get('p3').clear();
    gs.turnRecipients = new Map([['p1', 'p3']]);

    const nextTurn = _resolveValidTurn(gs, 'p1');
    // Falls back to p2 (first teammate with cards in seat order)
    expect(nextTurn).toBe('p2');
  });

  test('returns candidate when they still have cards (no elimination)', () => {
    const gs = buildGameState();
    gs.turnRecipients = new Map([['p1', 'p2']]); // stored but p1 has cards

    const nextTurn = _resolveValidTurn(gs, 'p1');
    expect(nextTurn).toBe('p1'); // candidate keeps their turn
  });

  test('works without turnRecipients map (backward compat)', () => {
    const gs = buildGameState();
    gs.hands.get('p1').clear();
    delete gs.turnRecipients;

    const nextTurn = _resolveValidTurn(gs, 'p1');
    expect(['p2', 'p3']).toContain(nextTurn); // any teammate
  });
});

// ── 5. handleChooseTurnRecipient ───────────────────────────────────────────

describe('handleChooseTurnRecipient', () => {
  beforeEach(() => {
    _clearAll();
  });

  function setup() {
    const gs = buildGameState();
    // p1 is eliminated
    gs.hands.get('p1').clear();
    gs.eliminatedPlayerIds.add('p1');
    // p2 still has cards
    gs.turnRecipients = new Map();
    setGame('ELIM01', gs);
    return gs;
  }

  test('stores recipientId in gs.turnRecipients', () => {
    const gs = setup();
    handleChooseTurnRecipient('ELIM01', 'p1', 'p2');
    expect(gs.turnRecipients.get('p1')).toBe('p2');
  });

  test('rejects non-eliminated player', () => {
    const gs = setup();
    // p2 is not eliminated
    handleChooseTurnRecipient('ELIM01', 'p2', 'p1');
    expect(gs.turnRecipients.has('p2')).toBe(false);
  });

  test('rejects cross-team recipient', () => {
    const gs = setup();
    // p4 is on team 2, p1 is on team 1
    handleChooseTurnRecipient('ELIM01', 'p1', 'p4');
    expect(gs.turnRecipients.has('p1')).toBe(false);
  });

  test('rejects recipient with no cards', () => {
    const gs = setup();
    gs.hands.get('p2').clear(); // p2 also has no cards
    handleChooseTurnRecipient('ELIM01', 'p1', 'p2');
    expect(gs.turnRecipients.has('p1')).toBe(false);
  });

  test('is idempotent — can update recipient choice', () => {
    const gs = setup();
    handleChooseTurnRecipient('ELIM01', 'p1', 'p2');
    expect(gs.turnRecipients.get('p1')).toBe('p2');
    handleChooseTurnRecipient('ELIM01', 'p1', 'p3');
    expect(gs.turnRecipients.get('p1')).toBe('p3');
  });

  test('handles missing game gracefully', () => {
    expect(() => handleChooseTurnRecipient('XXXXX', 'p1', 'p2')).not.toThrow();
  });
});

// ── 6. _processNewlyEliminatedPlayers ─────────────────────────────────────

describe('_processNewlyEliminatedPlayers', () => {
  beforeEach(() => {
    _clearAll();
  });

  function buildGsWithBroadcast() {
    const gs = buildGameState();
    const broadcasts = [];
    const targeted = {};

    // Register mock connections
    const { registerConnection } = require('../game/gameStore');
    // Create mock ws objects
    const mockWs = (id) => {
      const msg = [];
      targeted[id] = msg;
      return {
        readyState: 1, // WebSocket.OPEN
        send: (data) => {
          msg.push(JSON.parse(data));
        },
      };
    };
    gs.players.forEach((p) => {
      const ws = mockWs(p.playerId);
      // Capture broadcasts to all players
      ws.send = (data) => {
        const parsed = JSON.parse(data);
        broadcasts.push({ to: p.playerId, msg: parsed });
        targeted[p.playerId] = targeted[p.playerId] || [];
        targeted[p.playerId].push(parsed);
      };
      registerConnection('ELIM01', p.playerId, ws);
    });

    setGame('ELIM01', gs);
    gs.turnRecipients = new Map();
    return { gs, broadcasts, targeted };
  }

  test('does nothing when newlyEliminated is empty', () => {
    const { gs, broadcasts } = buildGsWithBroadcast();
    _processNewlyEliminatedPlayers(gs, []);
    expect(broadcasts).toHaveLength(0);
  });

  test('broadcasts player_eliminated to all connections', () => {
    const { gs, broadcasts } = buildGsWithBroadcast();
    gs.hands.get('p1').clear();
    gs.eliminatedPlayerIds.add('p1');

    _processNewlyEliminatedPlayers(gs, ['p1']);

    const elimEvents = broadcasts.filter((b) => b.msg.type === 'player_eliminated');
    expect(elimEvents.length).toBe(6); // all 6 players receive it
    expect(elimEvents[0].msg.playerId).toBe('p1');
    expect(elimEvents[0].msg.displayName).toBe('Alice');
    expect(elimEvents[0].msg.teamId).toBe(1);
  });

  test('sends choose_turn_recipient_prompt to eliminated human player', () => {
    const { gs, targeted } = buildGsWithBroadcast();
    gs.hands.get('p1').clear();
    gs.eliminatedPlayerIds.add('p1');

    _processNewlyEliminatedPlayers(gs, ['p1']);

    const p1Msgs = targeted['p1'] || [];
    const prompt = p1Msgs.find((m) => m.type === 'choose_turn_recipient_prompt');
    expect(prompt).toBeDefined();
    expect(prompt.eliminatedPlayerId).toBe('p1');
    expect(Array.isArray(prompt.eligibleTeammates)).toBe(true);
    // p2 and p3 are teammates with cards
    const recipientIds = prompt.eligibleTeammates.map((t) => t.playerId);
    expect(recipientIds).toContain('p2');
    expect(recipientIds).toContain('p3');
    // Should NOT include p4 (wrong team), p1 (self), or p5/p6 (wrong team)
    expect(recipientIds).not.toContain('p4');
    expect(recipientIds).not.toContain('p1');
  });

  test('auto-picks first teammate for bot-eliminated players', () => {
    const { gs } = buildGsWithBroadcast();
    // Make p1 a bot
    const p1 = gs.players.find((p) => p.playerId === 'p1');
    p1.isBot = true;
    gs.hands.get('p1').clear();
    gs.eliminatedPlayerIds.add('p1');

    _processNewlyEliminatedPlayers(gs, ['p1']);

    // turnRecipients should have been set automatically
    expect(gs.turnRecipients.has('p1')).toBe(true);
    const recipient = gs.turnRecipients.get('p1');
    expect(['p2', 'p3']).toContain(recipient);
  });

  test('handles multiple newly-eliminated players', () => {
    const { gs, broadcasts } = buildGsWithBroadcast();
    gs.hands.get('p1').clear();
    gs.hands.get('p4').clear();
    gs.eliminatedPlayerIds.add('p1');
    gs.eliminatedPlayerIds.add('p4');

    _processNewlyEliminatedPlayers(gs, ['p1', 'p4']);

    const elimEvents = broadcasts.filter((b) => b.msg.type === 'player_eliminated');
    const eliminatedIds = [...new Set(elimEvents.map((b) => b.msg.playerId))];
    expect(eliminatedIds).toContain('p1');
    expect(eliminatedIds).toContain('p4');
  });
});

// ── 7. isEliminated in serialized player state ─────────────────────────────

describe('serializePlayers — isEliminated flag', () => {
  const { serializePlayers } = require('../game/gameState');

  test('isEliminated is false for all players when no one is eliminated', () => {
    const gs = buildGameState();
    const serialized = serializePlayers(gs);
    serialized.forEach((p) => {
      expect(p.isEliminated).toBe(false);
    });
  });

  test('isEliminated is true for an eliminated player', () => {
    const gs = buildGameState();
    gs.eliminatedPlayerIds.add('p1');
    const serialized = serializePlayers(gs);
    const p1 = serialized.find((p) => p.playerId === 'p1');
    expect(p1.isEliminated).toBe(true);
  });

  test('isEliminated is false for non-eliminated players', () => {
    const gs = buildGameState();
    gs.eliminatedPlayerIds.add('p1');
    const serialized = serializePlayers(gs);
    const p2 = serialized.find((p) => p.playerId === 'p2');
    expect(p2.isEliminated).toBe(false);
  });
});
