'use strict';

/**
 * illegalCardRequests.test.js
 *
 * AC 16: Server blocks all illegal card requests regardless of inference mode state.
 *
 * The server's validateAsk() is the authoritative gate for every card request.
 * It must reject every illegal ask consistently regardless of whether
 * gs.inferenceMode is true or false — the client-side inference-highlight UI
 * state must NOT influence server-side rule enforcement.
 *
 * Test matrix:
 *   For each illegal scenario, the validation is run twice:
 *     • inferenceMode: false  (default)
 *     • inferenceMode: true   (enabled by host or matchmaking)
 *   Both runs must return:
 *     a) the same .valid value (false for illegal moves), and
 *     b) the same .errorCode string.
 *
 * Illegal scenarios covered:
 *   1.  GAME_NOT_ACTIVE    — ask when game is completed / not in progress
 *   2.  NOT_YOUR_TURN      — ask when it is another player's turn
 *   3.  SAME_TEAM          — ask a teammate
 *   4.  SELF_ASK           — ask yourself  (fires as SAME_TEAM since team check runs first)
 *   5.  TARGET_EMPTY       — ask a player who has no cards
 *   6.  INVALID_CARD       — ask for a card removed by the variant (e.g. 7_s in remove_7s)
 *   7.  SUIT_DECLARED      — ask for a card whose half-suit has already been declared
 *   8.  ALREADY_HELD       — ask for a card the asker already holds
 *   9.  NO_HALF_SUIT_CARD  — ask for a card in a half-suit the asker has no cards in
 *   10. PLAYER_NOT_FOUND   — ask targeting a player ID that is not in the game
 *
 * Legal scenario:
 *   11. Valid ask succeeds in both inference modes
 *
 * Consistency invariant:
 *   For EVERY test scenario the error code produced with inferenceMode:true
 *   must be STRICTLY EQUAL to the error code produced with inferenceMode:false.
 */

const { validateAsk } = require('../game/gameEngine');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal 6-player GameState with deterministic hands.
 *
 * Card layout (remove_7s variant):
 *   low_s  = 1_s 2_s 3_s 4_s 5_s 6_s
 *   high_s = 8_s 9_s 10_s 11_s 12_s 13_s
 *   low_h  = 1_h 2_h 3_h 4_h 5_h 6_h
 *
 * Team 1: p1, p2, p3   |   Team 2: p4, p5, p6
 *   p1 holds 1_s 2_s 3_s    (low_s, Team 1)
 *   p2 holds 4_s 5_s 6_s    (low_s, Team 1)
 *   p3 holds 8_s 9_s 10_s   (high_s, Team 1)
 *   p4 holds 11_s 12_s 13_s (high_s, Team 2)
 *   p5 holds 1_h 2_h 3_h    (low_h, Team 2)
 *   p6 holds 4_h 5_h 6_h    (low_h, Team 2)
 *
 * @param {boolean} inferenceMode
 * @returns {Object} GameState
 */
function buildTestGame(inferenceMode = false) {
  const players = [
    { playerId: 'p1', displayName: 'P1', avatarId: null, teamId: 1, seatIndex: 0, isBot: false, isGuest: false },
    { playerId: 'p2', displayName: 'P2', avatarId: null, teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
    { playerId: 'p3', displayName: 'P3', avatarId: null, teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
    { playerId: 'p4', displayName: 'P4', avatarId: null, teamId: 2, seatIndex: 1, isBot: false, isGuest: false },
    { playerId: 'p5', displayName: 'P5', avatarId: null, teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
    { playerId: 'p6', displayName: 'P6', avatarId: null, teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
  ];

  return {
    roomCode:            'ILLGL1',
    roomId:              'room-illgl-01',
    variant:             'remove_7s',
    playerCount:         6,
    status:              'active',
    currentTurnPlayerId: 'p1',
    players,
    hands: new Map([
      ['p1', new Set(['1_s', '2_s', '3_s'])],    // Team 1 — low_s
      ['p2', new Set(['4_s', '5_s', '6_s'])],    // Team 1 — low_s
      ['p3', new Set(['8_s', '9_s', '10_s'])],   // Team 1 — high_s
      ['p4', new Set(['11_s', '12_s', '13_s'])], // Team 2 — high_s
      ['p5', new Set(['1_h', '2_h', '3_h'])],    // Team 2 — low_h
      ['p6', new Set(['4_h', '5_h', '6_h'])],    // Team 2 — low_h
    ]),
    declaredSuits:   new Map(),
    scores:          { team1: 0, team2: 0 },
    lastMove:        null,
    winner:          null,
    tiebreakerWinner: null,
    botKnowledge:    new Map(),
    moveHistory:     [],
    inferenceMode,   // ← the field under test
  };
}

/**
 * Run a validateAsk scenario with inferenceMode:false AND inferenceMode:true,
 * then assert both results match `expectedValid` and `expectedErrorCode`.
 *
 * @param {(inferenceMode: boolean) => {gs, askerId, targetId, cardId}} buildScenario
 * @param {boolean}      expectedValid
 * @param {string|null}  expectedErrorCode  (null for valid-ask assertions)
 */
function expectConsistentAcrossModes(buildScenario, expectedValid, expectedErrorCode) {
  const { gs: gsOff, askerId: aOff, targetId: tOff, cardId: cOff } = buildScenario(false);
  const { gs: gsOn,  askerId: aOn,  targetId: tOn,  cardId: cOn  } = buildScenario(true);

  const resultOff = validateAsk(gsOff, aOff, tOff, cOff);
  const resultOn  = validateAsk(gsOn,  aOn,  tOn,  cOn);

  // Both modes must produce the same validity outcome
  expect(resultOff.valid).toBe(expectedValid);
  expect(resultOn.valid).toBe(expectedValid);

  if (expectedErrorCode !== null) {
    expect(resultOff.errorCode).toBe(expectedErrorCode);
    expect(resultOn.errorCode).toBe(expectedErrorCode);
  }

  // Critical invariant: error codes must be identical regardless of inferenceMode
  expect(resultOff.errorCode).toBe(resultOn.errorCode);
}

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------

describe('AC 16 — Server blocks illegal card requests regardless of inference mode', () => {

  // ── 1. GAME_NOT_ACTIVE ──────────────────────────────────────────────────

  it('GAME_NOT_ACTIVE: blocks ask when game is completed — same result with inference off/on', () => {
    expectConsistentAcrossModes(
      (inferenceMode) => {
        const gs = buildTestGame(inferenceMode);
        gs.status = 'completed';
        return { gs, askerId: 'p1', targetId: 'p4', cardId: '4_s' };
      },
      false,
      'GAME_NOT_ACTIVE',
    );
  });

  // ── 2. NOT_YOUR_TURN ────────────────────────────────────────────────────

  it('NOT_YOUR_TURN: blocks ask when it is not the sender\'s turn — same result with inference off/on', () => {
    expectConsistentAcrossModes(
      (inferenceMode) => {
        const gs = buildTestGame(inferenceMode);
        gs.currentTurnPlayerId = 'p4'; // p4's turn, not p1's
        return { gs, askerId: 'p1', targetId: 'p4', cardId: '4_s' };
      },
      false,
      'NOT_YOUR_TURN',
    );
  });

  it('NOT_YOUR_TURN: returns correct error message regardless of inference mode', () => {
    const gsOff = buildTestGame(false);
    const gsOn  = buildTestGame(true);
    gsOff.currentTurnPlayerId = 'p4';
    gsOn.currentTurnPlayerId  = 'p4';

    const resultOff = validateAsk(gsOff, 'p1', 'p4', '4_s');
    const resultOn  = validateAsk(gsOn,  'p1', 'p4', '4_s');

    expect(resultOff.error).toBe(resultOn.error);
  });

  // ── 3. SAME_TEAM ────────────────────────────────────────────────────────

  it('SAME_TEAM: blocks ask targeting a teammate — same result with inference off/on', () => {
    expectConsistentAcrossModes(
      (inferenceMode) => {
        const gs = buildTestGame(inferenceMode);
        // p1 (Team 1) asks p2 (Team 1) — both on the same team
        return { gs, askerId: 'p1', targetId: 'p2', cardId: '4_s' };
      },
      false,
      'SAME_TEAM',
    );
  });

  it('SAME_TEAM: blocks ask targeting any teammate (p3) — same result with inference off/on', () => {
    expectConsistentAcrossModes(
      (inferenceMode) => {
        const gs = buildTestGame(inferenceMode);
        // p1 asks p3 — both Team 1
        return { gs, askerId: 'p1', targetId: 'p3', cardId: '8_s' };
      },
      false,
      'SAME_TEAM',
    );
  });

  // ── 4. SELF_ASK ─────────────────────────────────────────────────────────
  // Note: SAME_TEAM (check 5) fires before SELF_ASK (check 6) in validateAsk,
  // so asking yourself returns SAME_TEAM in the current implementation.
  // The important property is that the result is consistent across inference modes.

  it('self-ask: asking yourself is rejected consistently in both inference modes', () => {
    expectConsistentAcrossModes(
      (inferenceMode) => {
        const gs = buildTestGame(inferenceMode);
        return { gs, askerId: 'p1', targetId: 'p1', cardId: '4_s' };
      },
      false,
      'SAME_TEAM', // SAME_TEAM check runs before SELF_ASK in validateAsk
    );
  });

  // ── 5. TARGET_EMPTY ─────────────────────────────────────────────────────

  it('TARGET_EMPTY: blocks ask when target has no cards — same result with inference off/on', () => {
    expectConsistentAcrossModes(
      (inferenceMode) => {
        const gs = buildTestGame(inferenceMode);
        gs.hands.set('p4', new Set()); // clear p4's hand
        return { gs, askerId: 'p1', targetId: 'p4', cardId: '4_s' };
      },
      false,
      'TARGET_EMPTY',
    );
  });

  it('TARGET_EMPTY: message is identical regardless of inference mode', () => {
    const gsOff = buildTestGame(false);
    const gsOn  = buildTestGame(true);
    gsOff.hands.set('p4', new Set());
    gsOn.hands.set('p4',  new Set());

    const resultOff = validateAsk(gsOff, 'p1', 'p4', '4_s');
    const resultOn  = validateAsk(gsOn,  'p1', 'p4', '4_s');

    expect(resultOff.error).toBe(resultOn.error);
  });

  // ── 6. INVALID_CARD ─────────────────────────────────────────────────────

  it('INVALID_CARD: blocks ask for a removed-variant card (7_s in remove_7s) — both modes', () => {
    expectConsistentAcrossModes(
      (inferenceMode) => {
        const gs = buildTestGame(inferenceMode);
        return { gs, askerId: 'p1', targetId: 'p4', cardId: '7_s' };
      },
      false,
      'INVALID_CARD',
    );
  });

  it('INVALID_CARD: blocks ask for a completely nonexistent card ID — both modes', () => {
    expectConsistentAcrossModes(
      (inferenceMode) => {
        const gs = buildTestGame(inferenceMode);
        return { gs, askerId: 'p1', targetId: 'p4', cardId: 'joker_r' };
      },
      false,
      'INVALID_CARD',
    );
  });

  // ── 7. SUIT_DECLARED ────────────────────────────────────────────────────

  it('SUIT_DECLARED: blocks ask for card in an already-declared half-suit — both modes', () => {
    expectConsistentAcrossModes(
      (inferenceMode) => {
        const gs = buildTestGame(inferenceMode);
        gs.declaredSuits.set('low_s', { teamId: 1, declaredBy: 'p1' });
        // 4_s is in low_s — now declared
        return { gs, askerId: 'p1', targetId: 'p4', cardId: '4_s' };
      },
      false,
      'SUIT_DECLARED',
    );
  });

  it('SUIT_DECLARED: blocks ask for any card in the declared suit — both modes', () => {
    expectConsistentAcrossModes(
      (inferenceMode) => {
        const gs = buildTestGame(inferenceMode);
        gs.declaredSuits.set('high_s', { teamId: 2, declaredBy: 'p4' });
        // 11_s is in high_s — now declared
        return { gs, askerId: 'p1', targetId: 'p4', cardId: '11_s' };
      },
      false,
      'SUIT_DECLARED',
    );
  });

  // ── 8. ALREADY_HELD ─────────────────────────────────────────────────────

  it('ALREADY_HELD: blocks ask for a card the asker already holds — both modes', () => {
    expectConsistentAcrossModes(
      (inferenceMode) => {
        const gs = buildTestGame(inferenceMode);
        // p1 holds 1_s — must not be allowed to ask for it
        return { gs, askerId: 'p1', targetId: 'p4', cardId: '1_s' };
      },
      false,
      'ALREADY_HELD',
    );
  });

  it('ALREADY_HELD: blocks ask for any card the asker holds — both modes', () => {
    expectConsistentAcrossModes(
      (inferenceMode) => {
        const gs = buildTestGame(inferenceMode);
        // p1 holds 2_s and 3_s as well
        return { gs, askerId: 'p1', targetId: 'p4', cardId: '3_s' };
      },
      false,
      'ALREADY_HELD',
    );
  });

  // ── 9. NO_HALF_SUIT_CARD ─────────────────────────────────────────────────

  it('NO_HALF_SUIT_CARD: blocks ask for a card in a half-suit the asker has no cards in — both modes', () => {
    expectConsistentAcrossModes(
      (inferenceMode) => {
        const gs = buildTestGame(inferenceMode);
        // p1 holds only low_s cards. 8_h is in high_h — p1 has no high_h cards.
        return { gs, askerId: 'p1', targetId: 'p5', cardId: '8_h' };
      },
      false,
      'NO_HALF_SUIT_CARD',
    );
  });

  it('NO_HALF_SUIT_CARD: blocks cross-suit ask (low_s holder cannot ask for high_s) — both modes', () => {
    expectConsistentAcrossModes(
      (inferenceMode) => {
        const gs = buildTestGame(inferenceMode);
        // p1 holds low_s cards only. 11_s is in high_s.
        // p4 holds 11_s (opponent), but p1 has no high_s cards.
        return { gs, askerId: 'p1', targetId: 'p4', cardId: '11_s' };
      },
      false,
      'NO_HALF_SUIT_CARD',
    );
  });

  it('NO_HALF_SUIT_CARD: error message is identical in both inference modes', () => {
    const gsOff = buildTestGame(false);
    const gsOn  = buildTestGame(true);

    const resultOff = validateAsk(gsOff, 'p1', 'p5', '8_h');
    const resultOn  = validateAsk(gsOn,  'p1', 'p5', '8_h');

    expect(resultOff.error).toBe(resultOn.error);
  });

  // ── 10. PLAYER_NOT_FOUND (target) ────────────────────────────────────────

  it('PLAYER_NOT_FOUND: blocks ask targeting a player not in the game — both modes', () => {
    expectConsistentAcrossModes(
      (inferenceMode) => {
        const gs = buildTestGame(inferenceMode);
        return { gs, askerId: 'p1', targetId: 'ghost-player', cardId: '4_s' };
      },
      false,
      'PLAYER_NOT_FOUND',
    );
  });

  // ── 11. Valid ask succeeds in BOTH modes ─────────────────────────────────

  it('valid ask: succeeds with inferenceMode:false', () => {
    const gs = buildTestGame(false);
    // p4 holds high_s (11_s,12_s,13_s). Add 8_s to p1 so p1 holds ≥1 high_s card,
    // then ask p4 for 11_s. Both asker (high_s: 8_s) and target (high_s: 11_s) qualify.
    gs.hands.get('p1').add('8_s');
    const result = validateAsk(gs, 'p1', 'p4', '11_s');
    expect(result).toEqual({ valid: true });
  });

  it('valid ask: succeeds with inferenceMode:true', () => {
    const gs = buildTestGame(true);
    gs.hands.get('p1').add('8_s'); // same setup as false-mode test
    const result = validateAsk(gs, 'p1', 'p4', '11_s');
    expect(result).toEqual({ valid: true });
  });

  it('valid ask: identical result with inference off and on', () => {
    const gsOff = buildTestGame(false);
    const gsOn  = buildTestGame(true);
    gsOff.hands.get('p1').add('8_s');
    gsOn.hands.get('p1').add('8_s');

    const resultOff = validateAsk(gsOff, 'p1', 'p4', '11_s');
    const resultOn  = validateAsk(gsOn,  'p1', 'p4', '11_s');

    expect(resultOff).toEqual(resultOn);
  });

  // ── 12. Exhaustive consistency check ────────────────────────────────────
  //
  // For every combination of invalid ask, the error code produced with
  // inferenceMode:true must be STRICTLY EQUAL to inferenceMode:false.
  // This is the core invariant of AC 16.

  describe('exhaustive consistency: every error code matches across both inference modes', () => {
    const scenarios = [
      {
        label:    'game completed',
        setup:    (im) => {
          const gs = buildTestGame(im);
          gs.status = 'completed';
          return { gs, askerId: 'p1', targetId: 'p4', cardId: '4_s' };
        },
      },
      {
        label:    'wrong turn (p4 turn, p1 asks)',
        setup:    (im) => {
          const gs = buildTestGame(im);
          gs.currentTurnPlayerId = 'p4';
          return { gs, askerId: 'p1', targetId: 'p4', cardId: '4_s' };
        },
      },
      {
        label:    'teammate ask (p1 → p2)',
        setup:    (im) => ({ gs: buildTestGame(im), askerId: 'p1', targetId: 'p2', cardId: '4_s' }),
      },
      {
        label:    'teammate ask (p1 → p3)',
        setup:    (im) => ({ gs: buildTestGame(im), askerId: 'p1', targetId: 'p3', cardId: '8_s' }),
      },
      {
        label:    'self-ask (p1 → p1)',
        setup:    (im) => ({ gs: buildTestGame(im), askerId: 'p1', targetId: 'p1', cardId: '4_s' }),
      },
      {
        label:    'target empty (p4 has no cards)',
        setup:    (im) => {
          const gs = buildTestGame(im);
          gs.hands.set('p4', new Set());
          return { gs, askerId: 'p1', targetId: 'p4', cardId: '4_s' };
        },
      },
      {
        label:    'removed variant card (7_s in remove_7s)',
        setup:    (im) => ({ gs: buildTestGame(im), askerId: 'p1', targetId: 'p4', cardId: '7_s' }),
      },
      {
        label:    'nonexistent card',
        setup:    (im) => ({ gs: buildTestGame(im), askerId: 'p1', targetId: 'p4', cardId: 'xx_x' }),
      },
      {
        label:    'declared half-suit (low_s)',
        setup:    (im) => {
          const gs = buildTestGame(im);
          gs.declaredSuits.set('low_s', { teamId: 1, declaredBy: 'p1' });
          return { gs, askerId: 'p1', targetId: 'p4', cardId: '4_s' };
        },
      },
      {
        label:    'declared half-suit (high_s)',
        setup:    (im) => {
          const gs = buildTestGame(im);
          gs.declaredSuits.set('high_s', { teamId: 2, declaredBy: 'p4' });
          return { gs, askerId: 'p1', targetId: 'p4', cardId: '11_s' };
        },
      },
      {
        label:    'card already held (1_s)',
        setup:    (im) => ({ gs: buildTestGame(im), askerId: 'p1', targetId: 'p4', cardId: '1_s' }),
      },
      {
        label:    'card already held (2_s)',
        setup:    (im) => ({ gs: buildTestGame(im), askerId: 'p1', targetId: 'p4', cardId: '2_s' }),
      },
      {
        label:    'no half-suit card (ask high_h, hold none)',
        setup:    (im) => ({ gs: buildTestGame(im), askerId: 'p1', targetId: 'p5', cardId: '8_h' }),
      },
      {
        label:    'no half-suit card (ask high_s cross-group)',
        setup:    (im) => ({ gs: buildTestGame(im), askerId: 'p1', targetId: 'p4', cardId: '11_s' }),
      },
      {
        label:    'unknown target player',
        setup:    (im) => ({ gs: buildTestGame(im), askerId: 'p1', targetId: 'nobody', cardId: '4_s' }),
      },
    ];

    for (const { label, setup } of scenarios) {
      it(`[${label}]: error code identical with inference off and on`, () => {
        const { gs: gsOff, askerId: aOff, targetId: tOff, cardId: cOff } = setup(false);
        const { gs: gsOn,  askerId: aOn,  targetId: tOn,  cardId: cOn  } = setup(true);

        const resultOff = validateAsk(gsOff, aOff, tOff, cOff);
        const resultOn  = validateAsk(gsOn,  aOn,  tOn,  cOn);

        // Both modes must agree on legality
        expect(resultOff.valid).toBe(resultOn.valid);

        // Both must be invalid for these error scenarios
        expect(resultOff.valid).toBe(false);
        expect(resultOn.valid).toBe(false);

        // The error code must be identical — inferenceMode is irrelevant to validation
        expect(resultOff.errorCode).toBe(resultOn.errorCode);

        // The error message text must also be identical
        expect(resultOff.error).toBe(resultOn.error);
      });
    }
  });

  // ── 13. inferenceMode is not consulted by validateAsk ───────────────────
  //
  // Direct structural assertion: after toggling inferenceMode on the
  // game-state object, validateAsk must never change its verdict.

  describe('inferenceMode field does not influence validateAsk output', () => {
    const askScenarios = [
      {
        label:    'valid ask (p1 → p4 for high_s)',
        askerId:  'p1',
        targetId: 'p4',
        cardId:   '11_s', // p4 holds high_s; p1 must also hold a high_s card
        modify:   (gs) => gs.hands.get('p1').add('8_s'),
      },
      {
        label:    'invalid ask: NOT_YOUR_TURN',
        askerId:  'p2',
        targetId: 'p4',
        cardId:   '4_s',
        modify:   () => {},
      },
      {
        label:    'invalid ask: SAME_TEAM',
        askerId:  'p1',
        targetId: 'p2',
        cardId:   '4_s',
        modify:   () => {},
      },
      {
        label:    'invalid ask: ALREADY_HELD',
        askerId:  'p1',
        targetId: 'p4',
        cardId:   '1_s',
        modify:   () => {},
      },
      {
        label:    'invalid ask: NO_HALF_SUIT_CARD',
        askerId:  'p1',
        targetId: 'p5',
        cardId:   '8_h',
        modify:   () => {},
      },
    ];

    for (const { label, askerId, targetId, cardId, modify } of askScenarios) {
      it(`[${label}]: toggling inferenceMode after game creation never changes the result`, () => {
        const gs = buildTestGame(false);
        modify(gs);

        const resultBefore = validateAsk(gs, askerId, targetId, cardId);

        // Flip inferenceMode on the SAME object
        gs.inferenceMode = true;
        const resultAfter = validateAsk(gs, askerId, targetId, cardId);

        expect(resultBefore.valid).toBe(resultAfter.valid);
        expect(resultBefore.errorCode).toBe(resultAfter.errorCode);
        expect(resultBefore.error).toBe(resultAfter.error);
      });
    }
  });
});
