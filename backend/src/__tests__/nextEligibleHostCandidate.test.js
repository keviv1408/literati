'use strict';

/**
 * nextEligibleHostCandidate.test.js
 *
 * Sub-AC 40b: Utility function that traverses the player list clockwise from
 * the current host to find the next eligible host candidate.
 *
 * Eligibility rules:
 *   - NOT a bot  (isBot === false)
 *   - NOT eliminated  (playerId not in gs.eliminatedPlayerIds)
 *
 * "Clockwise" = ascending seatIndex with wrap-around.
 *
 * Coverage:
 *   1.  Basic: next clockwise human (non-bot, non-eliminated) is returned
 *   2.  Skips bots; returns first human after the host
 *   3.  Skips eliminated players; returns first non-eliminated human
 *   4.  Skips both bots AND eliminated players together
 *   5.  Wrap-around: host is at the last seat, candidate wraps to seat 0
 *   6.  Multiple candidates available: returns the CLOCKWISE-NEAREST one
 *   7.  All other players are bots → returns null
 *   8.  All other players are eliminated → returns null
 *   9.  All other players are bots or eliminated → returns null
 *  10.  currentHostId not in player list → starts from seat 0 (defensive)
 *  11.  gs.eliminatedPlayerIds is undefined (older state shape) → treated as empty
 *  12.  gs.eliminatedPlayerIds is null → treated as empty (no crash)
 *  13.  Empty players array → returns null
 *  14.  gs is null/undefined → returns null
 *  15.  8-player game: correct clockwise traversal across all 8 seats
 *  16.  Host itself is eliminated and is a bot — should NOT be returned
 *  17.  Host is eliminated; next clockwise human (non-eliminated) is returned
 *  18.  Only one player in the list (the host) → returns null
 *  19.  All players are bots (including the host) → returns null
 */

const { nextEligibleHostCandidate } = require('../game/gameEngine');

// ---------------------------------------------------------------------------
// Seat layout helpers
// ---------------------------------------------------------------------------

/**
 * Build a 6-player GameState stub.
 *
 * Clockwise seat order:
 *   host(T1,0) → bot1(T2,1) → p2(T1,2) → p3(T2,3) → p4(T1,4) → p5(T2,5)
 */
function buildGs6(overrides = {}) {
  const players = [
    { playerId: 'host', displayName: 'Host',  teamId: 1, seatIndex: 0, isBot: false, isGuest: false },
    { playerId: 'bot1', displayName: 'bot1',  teamId: 2, seatIndex: 1, isBot: true,  isGuest: false },
    { playerId: 'p2',   displayName: 'P2',    teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
    { playerId: 'p3',   displayName: 'P3',    teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
    { playerId: 'p4',   displayName: 'P4',    teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
    { playerId: 'p5',   displayName: 'P5',    teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
  ];

  const gs = {
    roomCode:  'TEST1',
    variant:   'remove_7s',
    playerCount: 6,
    status:    'active',
    players,
    hands: new Map(players.map((p) => [p.playerId, new Set(['1_s'])])),
    eliminatedPlayerIds: new Set(),
    ...overrides,
  };
  return gs;
}

/**
 * Build an 8-player GameState stub.
 *
 * Clockwise seat order:
 *   p0(T1,0) → p1(T2,1) → p2(T1,2) → p3(T2,3)
 *   p4(T1,4) → p5(T2,5) → p6(T1,6) → p7(T2,7)
 *
 * p1, p3, p5, p7 are bots.
 */
function buildGs8(overrides = {}) {
  const players = [
    { playerId: 'p0', displayName: 'P0', teamId: 1, seatIndex: 0, isBot: false, isGuest: false },
    { playerId: 'p1', displayName: 'p1', teamId: 2, seatIndex: 1, isBot: true,  isGuest: false },
    { playerId: 'p2', displayName: 'P2', teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
    { playerId: 'p3', displayName: 'p3', teamId: 2, seatIndex: 3, isBot: true,  isGuest: false },
    { playerId: 'p4', displayName: 'P4', teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
    { playerId: 'p5', displayName: 'p5', teamId: 2, seatIndex: 5, isBot: true,  isGuest: false },
    { playerId: 'p6', displayName: 'P6', teamId: 1, seatIndex: 6, isBot: false, isGuest: false },
    { playerId: 'p7', displayName: 'p7', teamId: 2, seatIndex: 7, isBot: true,  isGuest: false },
  ];

  const gs = {
    roomCode:  'TEST2',
    variant:   'remove_7s',
    playerCount: 8,
    status:    'active',
    players,
    hands: new Map(players.map((p) => [p.playerId, new Set(['1_s'])])),
    eliminatedPlayerIds: new Set(),
    ...overrides,
  };
  return gs;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('nextEligibleHostCandidate — Sub-AC 40b', () => {
  // ── Basic happy-path ────────────────────────────────────────────────────

  it('1. returns the next clockwise human player when they are immediately adjacent', () => {
    // All players are humans.  Clockwise from host(0): bot1(1) skipped, p2(2) is first human.
    const gs = buildGs6();
    // Make all players human for this test (override bot1)
    gs.players[1].isBot = false;

    const result = nextEligibleHostCandidate(gs, 'host');
    // Next clockwise from seat 0 is seat 1 (now human, non-eliminated)
    expect(result).toBe('bot1');
  });

  it('2. skips bots and returns the first human after the host', () => {
    // Default gs6: seat 1 is bot1 (isBot=true), seat 2 is p2 (human).
    const gs = buildGs6();
    const result = nextEligibleHostCandidate(gs, 'host');
    expect(result).toBe('p2'); // skips bot1 at seat 1
  });

  it('3. skips eliminated players; returns first non-eliminated human', () => {
    const gs = buildGs6();
    // Eliminate p2 (seat 2), the first human after the host.
    gs.eliminatedPlayerIds.add('p2');

    const result = nextEligibleHostCandidate(gs, 'host');
    // bot1(1) skipped (bot), p2(2) skipped (eliminated), p3(3) is eligible
    expect(result).toBe('p3');
  });

  it('4. skips both bots and eliminated players together', () => {
    const gs = buildGs6();
    // Eliminate p2 (seat 2) AND p3 (seat 3).
    gs.eliminatedPlayerIds.add('p2');
    gs.eliminatedPlayerIds.add('p3');

    const result = nextEligibleHostCandidate(gs, 'host');
    // bot1(1) skipped, p2(2) skipped, p3(3) skipped, p4(4) is eligible
    expect(result).toBe('p4');
  });

  // ── Wrap-around ─────────────────────────────────────────────────────────

  it('5. wraps around: host at last seat, candidate at seat 0', () => {
    const gs = buildGs6();
    // Make p5 (seat 5) the current host, make all earlier seats bots except 'host' (seat 0).
    gs.players[1].isBot = true;  // bot1 already bot
    gs.players[2].isBot = true;  // p2 → bot
    gs.players[3].isBot = true;  // p3 → bot
    gs.players[4].isBot = true;  // p4 → bot
    // p5(5)=host, bot1(1), p2(2)→bot, p3(3)→bot, p4(4)→bot
    // Clockwise from p5(5): host(0) is the first human after wrap.
    const result = nextEligibleHostCandidate(gs, 'p5');
    expect(result).toBe('host');
  });

  it('6. multiple candidates available: returns the clockwise-nearest one', () => {
    const gs = buildGs6();
    // Clockwise from host(0): bot1(1) skip, p2(2) first human ← should be chosen
    // (not p4 at 4 or p5 at 5)
    const result = nextEligibleHostCandidate(gs, 'host');
    expect(result).toBe('p2');
  });

  // ── All-ineligible edge cases ────────────────────────────────────────────

  it('7. all other players are bots → returns null', () => {
    const gs = buildGs6();
    // Make everyone except the host a bot.
    for (const p of gs.players) {
      if (p.playerId !== 'host') p.isBot = true;
    }
    expect(nextEligibleHostCandidate(gs, 'host')).toBeNull();
  });

  it('8. all other players are eliminated → returns null', () => {
    const gs = buildGs6();
    // All players share the same hand (1_s), but we eliminate all non-hosts.
    for (const p of gs.players) {
      if (p.playerId !== 'host') gs.eliminatedPlayerIds.add(p.playerId);
    }
    expect(nextEligibleHostCandidate(gs, 'host')).toBeNull();
  });

  it('9. all other players are bots or eliminated → returns null', () => {
    const gs = buildGs6();
    // bot1(1) = bot already; eliminate everyone else except host.
    gs.eliminatedPlayerIds.add('p2');
    gs.eliminatedPlayerIds.add('p3');
    gs.eliminatedPlayerIds.add('p4');
    gs.eliminatedPlayerIds.add('p5');
    expect(nextEligibleHostCandidate(gs, 'host')).toBeNull();
  });

  // ── Defensive / edge cases ───────────────────────────────────────────────

  it('10. currentHostId not found → starts search from seat 0, returns first eligible', () => {
    const gs = buildGs6();
    // 'unknown-id' is not in the player list.  startIdx defaults to 0.
    // From index 0 we search i=1..5: bot1(1)=skip, p2(2)=eligible.
    // But wait — startIdx=0 means we start from host(seat 0) notionally,
    // so the loop starts at i=1 → seat 1 (bot1) skip → seat 2 (p2) eligible.
    const result = nextEligibleHostCandidate(gs, 'unknown-id');
    // First non-bot, non-eliminated from the beginning of the sorted list (excluding idx 0):
    // sorted[0]=host(0), [1]=bot1(1), [2]=p2(2)
    // fromIdx=-1 → startIdx=0 → i=1 → bot1(skip), i=2 → p2 ✓
    expect(result).toBe('p2');
  });

  it('11. eliminatedPlayerIds is undefined → treated as empty (no crash)', () => {
    const gs = buildGs6();
    delete gs.eliminatedPlayerIds; // old-format state

    // Should still traverse and return the first human after host.
    const result = nextEligibleHostCandidate(gs, 'host');
    expect(result).toBe('p2'); // bot1(1) skip, p2(2) eligible
  });

  it('12. eliminatedPlayerIds is null → treated as empty (no crash)', () => {
    const gs = buildGs6();
    gs.eliminatedPlayerIds = null;

    const result = nextEligibleHostCandidate(gs, 'host');
    expect(result).toBe('p2');
  });

  it('13. empty players array → returns null', () => {
    const gs = buildGs6();
    gs.players = [];
    expect(nextEligibleHostCandidate(gs, 'host')).toBeNull();
  });

  it('14a. gs is null → returns null', () => {
    expect(nextEligibleHostCandidate(null, 'host')).toBeNull();
  });

  it('14b. gs is undefined → returns null', () => {
    expect(nextEligibleHostCandidate(undefined, 'host')).toBeNull();
  });

  // ── 8-player game ────────────────────────────────────────────────────────

  it('15. 8-player: skips all bot seats, returns clockwise-nearest human from host', () => {
    const gs = buildGs8();
    // Seat order: p0(0) p1-bot(1) p2(2) p3-bot(3) p4(4) p5-bot(5) p6(6) p7-bot(7)
    // Clockwise from p0(0): p1(1)=bot skip, p2(2)=human ✓
    const result = nextEligibleHostCandidate(gs, 'p0');
    expect(result).toBe('p2');
  });

  it('15b. 8-player: from p6(6), wraps around: p7(7)=bot, p0(0)=human ✓', () => {
    const gs = buildGs8();
    const result = nextEligibleHostCandidate(gs, 'p6');
    expect(result).toBe('p0'); // p7(7)=bot skip, p0(0)=human
  });

  it('15c. 8-player: from p4(4), skips p5-bot and finds p6(6)', () => {
    const gs = buildGs8();
    const result = nextEligibleHostCandidate(gs, 'p4');
    expect(result).toBe('p6'); // p5(5)=bot skip, p6(6)=human ✓
  });

  // ── Host themselves eliminated / bot ─────────────────────────────────────

  it('16. host is a bot (edge case) — does not return the host themselves', () => {
    const gs = buildGs6();
    // Mark the host as a bot (shouldn't happen in practice, but function is pure).
    gs.players[0].isBot = true;
    // Clockwise from host(0): bot1(1)=bot skip, p2(2) ✓
    const result = nextEligibleHostCandidate(gs, 'host');
    expect(result).toBe('p2');
  });

  it('17. host is eliminated — does not return the host themselves', () => {
    const gs = buildGs6();
    gs.eliminatedPlayerIds.add('host');
    // Clockwise from host(0): bot1(1) skip, p2(2) ✓ (even though host is eliminated, we skip it by design — we never return currentHostId)
    const result = nextEligibleHostCandidate(gs, 'host');
    expect(result).toBe('p2');
  });

  it('18. only one player in the list (the host) → returns null', () => {
    const gs = buildGs6();
    gs.players = [{ playerId: 'host', displayName: 'Host', teamId: 1, seatIndex: 0, isBot: false, isGuest: false }];
    expect(nextEligibleHostCandidate(gs, 'host')).toBeNull();
  });

  it('19. all players are bots (including host) → returns null', () => {
    const gs = buildGs6();
    for (const p of gs.players) p.isBot = true;
    expect(nextEligibleHostCandidate(gs, 'host')).toBeNull();
  });

  // ── Correctness of seatIndex ordering ───────────────────────────────────

  it('20. unsorted players array: function sorts by seatIndex before traversal', () => {
    // Deliberately provide players in reverse seatIndex order.
    const players = [
      { playerId: 'p5', displayName: 'P5', teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
      { playerId: 'p4', displayName: 'P4', teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
      { playerId: 'p3', displayName: 'P3', teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
      { playerId: 'bot1', displayName: 'bot1', teamId: 2, seatIndex: 1, isBot: true,  isGuest: false },
      { playerId: 'p2', displayName: 'P2', teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
      { playerId: 'host', displayName: 'Host', teamId: 1, seatIndex: 0, isBot: false, isGuest: false },
    ];

    const gs = {
      players,
      eliminatedPlayerIds: new Set(),
    };

    // After sorting by seatIndex: host(0) bot1(1) p2(2) p3(3) p4(4) p5(5)
    // Clockwise from host(0): bot1(1)=bot skip → p2(2) ✓
    const result = nextEligibleHostCandidate(gs, 'host');
    expect(result).toBe('p2');
  });

  it('21. host at seat 2 (middle): clockwise traversal continues forward, wraps back', () => {
    const gs = buildGs6();
    // Clockwise from p2(seat 2): p3(3) ✓ (non-bot, non-eliminated)
    const result = nextEligibleHostCandidate(gs, 'p2');
    expect(result).toBe('p3');
  });
});
