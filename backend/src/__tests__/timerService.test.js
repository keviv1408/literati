'use strict';

/**
 * Unit tests for the countdown timer service.
 *
 * Validates that timerService:
 * 1. startCountdownTimer broadcasts `timer_start` immediately with correct fields
 * 2. startCountdownTimer broadcasts `timer_tick` every TICK_INTERVAL_MS (1 second)
 * 3. `timer_tick` carries remainingMs, remainingS, phase, playerId, expiresAt
 * 4. `timer_threshold` fires exactly once when remainingS <= TIMER_THRESHOLD_S (10)
 * 5. `timer_threshold` is NOT fired again on subsequent ticks
 * 6. `timer_threshold` carries the correct fields (remainingMs, remainingS, etc.)
 * 7. onExpiry is called when the timer fires
 * 8. cancelCountdownTimer cancels the timer before onExpiry fires
 * 9. cancelCountdownTimer is idempotent (safe to call when no timer exists)
 * 10. Starting a second timer for the same room cancels the first
 * 11. tick events stop once the timer expires
 * 12. getTimerRemaining returns null when no timer, > 0 when active
 * 13. isTimerActive returns false initially, true after start, false after cancel
 * 14. getTimerExpiry returns null when inactive, epoch ms when active
 * 15. getTimerPhase returns null when inactive, 'turn'/'declaration' when active
 * 16. broadcastFn receives ALL three event types (timer_start, timer_tick, timer_threshold)
 * 17. declaration phase timer uses phase: 'declaration'
 * 18. turn phase timer uses phase: 'turn'
 * 19. _clearAllTimers cancels all active timers (test cleanup helper)
 * 20. broadcastFn is called with (roomCode, data) signature
 */

const timerService = require('../game/timerService');

// ---------------------------------------------------------------------------
// Constants under test
// ---------------------------------------------------------------------------

const { TICK_INTERVAL_MS, TIMER_THRESHOLD_S } = timerService;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect broadcast calls into an array. */
function makeBroadcastFn() {
  const calls = [];
  const fn = (roomCode, data) => calls.push({ roomCode, data });
  fn.calls = calls;
  fn.types = () => calls.map((c) => c.data.type);
  fn.ofType = (type) => calls.filter((c) => c.data.type === type).map((c) => c.data);
  fn.lastOfType = (type) => {
    const matches = fn.ofType(type);
    return matches[matches.length - 1] ?? null;
  };
  return fn;
}

const ROOM = 'TIMER1';
const PLAYER = 'p1';
const TURN_DURATION = 30_000;
const DECL_DURATION = 60_000;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers();
  timerService._clearAllTimers();
});

afterEach(() => {
  timerService._clearAllTimers();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// timer_start event
// ---------------------------------------------------------------------------

describe('timer_start event', () => {
  it('1. broadcasts timer_start immediately on startCountdownTimer', () => {
    const broadcast = makeBroadcastFn();
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, broadcast, jest.fn());

    expect(broadcast.ofType('timer_start').length).toBe(1);
  });

  it('broadcasts timer_start with correct phase, playerId, durationMs, expiresAt', () => {
    const broadcast = makeBroadcastFn();
    const before = Date.now();
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, broadcast, jest.fn());
    const after = Date.now();

    const msg = broadcast.ofType('timer_start')[0];
    expect(msg.type).toBe('timer_start');
    expect(msg.phase).toBe('turn');
    expect(msg.playerId).toBe(PLAYER);
    expect(msg.durationMs).toBe(TURN_DURATION);
    expect(msg.expiresAt).toBeGreaterThanOrEqual(before + TURN_DURATION);
    expect(msg.expiresAt).toBeLessThanOrEqual(after + TURN_DURATION + 100);
  });

  it('17. declaration phase uses phase: "declaration"', () => {
    const broadcast = makeBroadcastFn();
    timerService.startCountdownTimer(ROOM, 'declaration', PLAYER, DECL_DURATION, broadcast, jest.fn());

    const msg = broadcast.ofType('timer_start')[0];
    expect(msg.phase).toBe('declaration');
    expect(msg.durationMs).toBe(DECL_DURATION);
  });

  it('18. turn phase uses phase: "turn"', () => {
    const broadcast = makeBroadcastFn();
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, broadcast, jest.fn());

    const msg = broadcast.ofType('timer_start')[0];
    expect(msg.phase).toBe('turn');
  });

  it('20. broadcastFn is called with (roomCode, data) signature', () => {
    const broadcast = makeBroadcastFn();
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, broadcast, jest.fn());

    expect(broadcast.calls.length).toBeGreaterThan(0);
    const [first] = broadcast.calls;
    expect(first.roomCode).toBe(ROOM);
    expect(first.data).toBeDefined();
    expect(first.data.type).toBe('timer_start');
  });
});

// ---------------------------------------------------------------------------
// timer_tick events
// ---------------------------------------------------------------------------

describe('timer_tick events', () => {
  it('2. broadcasts timer_tick every TICK_INTERVAL_MS', () => {
    const broadcast = makeBroadcastFn();
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, broadcast, jest.fn());

    // Advance 5 seconds → expect 5 ticks
    jest.advanceTimersByTime(5 * TICK_INTERVAL_MS);
    const ticks = broadcast.ofType('timer_tick');
    expect(ticks.length).toBe(5);
  });

  it('3. timer_tick carries remainingMs, remainingS, phase, playerId, expiresAt', () => {
    const broadcast = makeBroadcastFn();
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, broadcast, jest.fn());

    jest.advanceTimersByTime(1 * TICK_INTERVAL_MS);
    const tick = broadcast.ofType('timer_tick')[0];

    expect(tick.type).toBe('timer_tick');
    expect(tick.phase).toBe('turn');
    expect(tick.playerId).toBe(PLAYER);
    expect(tick.remainingMs).toBeGreaterThan(0);
    expect(tick.remainingMs).toBeLessThanOrEqual(TURN_DURATION);
    expect(typeof tick.remainingS).toBe('number');
    expect(tick.remainingS).toBeGreaterThan(0);
    expect(tick.expiresAt).toBeDefined();
  });

  it('remainingMs decreases with each tick', () => {
    const broadcast = makeBroadcastFn();
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, broadcast, jest.fn());

    jest.advanceTimersByTime(2 * TICK_INTERVAL_MS);
    const ticks = broadcast.ofType('timer_tick');
    expect(ticks.length).toBe(2);
    expect(ticks[0].remainingMs).toBeGreaterThan(ticks[1].remainingMs);
  });

  it('11. tick events stop once the timer expires', () => {
    const broadcast = makeBroadcastFn();
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, broadcast, jest.fn());

    jest.advanceTimersByTime(TURN_DURATION + 5_000);
    const ticks = broadcast.ofType('timer_tick');
    // Should have at most 30 ticks (one per second for 30 seconds)
    expect(ticks.length).toBeLessThanOrEqual(TURN_DURATION / TICK_INTERVAL_MS);
    // All ticks should have positive remainingMs
    for (const tick of ticks) {
      expect(tick.remainingMs).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// timer_threshold event
// ---------------------------------------------------------------------------

describe('timer_threshold event', () => {
  it('4. timer_threshold fires when remainingS <= TIMER_THRESHOLD_S', () => {
    const broadcast = makeBroadcastFn();
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, broadcast, jest.fn());

    // Advance past the threshold (30s - 10s = 20s)
    jest.advanceTimersByTime((TURN_DURATION - TIMER_THRESHOLD_S * 1000) + TICK_INTERVAL_MS);

    const thresholds = broadcast.ofType('timer_threshold');
    expect(thresholds.length).toBe(1);
  });

  it('5. timer_threshold fires exactly once (not on subsequent ticks)', () => {
    const broadcast = makeBroadcastFn();
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, broadcast, jest.fn());

    // Advance well past threshold
    jest.advanceTimersByTime(TURN_DURATION - 1_000); // stop just before expiry

    const thresholds = broadcast.ofType('timer_threshold');
    expect(thresholds.length).toBe(1); // still exactly once
  });

  it('6. timer_threshold carries phase, playerId, remainingMs, remainingS, expiresAt', () => {
    const broadcast = makeBroadcastFn();
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, broadcast, jest.fn());

    jest.advanceTimersByTime(TURN_DURATION - TIMER_THRESHOLD_S * 1000 + TICK_INTERVAL_MS);

    const threshold = broadcast.ofType('timer_threshold')[0];
    expect(threshold).toBeDefined();
    expect(threshold.type).toBe('timer_threshold');
    expect(threshold.phase).toBe('turn');
    expect(threshold.playerId).toBe(PLAYER);
    expect(threshold.remainingMs).toBeGreaterThan(0);
    expect(threshold.remainingMs).toBeLessThanOrEqual(TIMER_THRESHOLD_S * 1000);
    expect(typeof threshold.remainingS).toBe('number');
    expect(threshold.remainingS).toBeGreaterThanOrEqual(1);
    expect(threshold.remainingS).toBeLessThanOrEqual(TIMER_THRESHOLD_S);
    expect(threshold.expiresAt).toBeDefined();
  });

  it('16. broadcastFn receives all three event types during timer lifecycle', () => {
    const broadcast = makeBroadcastFn();
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, broadcast, jest.fn());

    jest.advanceTimersByTime(TURN_DURATION - 500); // just before expiry

    const eventTypes = new Set(broadcast.types());
    expect(eventTypes.has('timer_start')).toBe(true);
    expect(eventTypes.has('timer_tick')).toBe(true);
    expect(eventTypes.has('timer_threshold')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// onExpiry callback
// ---------------------------------------------------------------------------

describe('onExpiry callback', () => {
  it('7. onExpiry is called when the timer fires', () => {
    const onExpiry = jest.fn();
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, makeBroadcastFn(), onExpiry);

    jest.advanceTimersByTime(TURN_DURATION);

    expect(onExpiry).toHaveBeenCalledTimes(1);
    expect(onExpiry).toHaveBeenCalledWith(ROOM, PLAYER);
  });

  it('onExpiry receives (roomCode, playerId)', () => {
    const onExpiry = jest.fn();
    timerService.startCountdownTimer('ROOM2', 'declaration', 'playerX', DECL_DURATION, makeBroadcastFn(), onExpiry);

    jest.advanceTimersByTime(DECL_DURATION);

    expect(onExpiry).toHaveBeenCalledWith('ROOM2', 'playerX');
  });

  it('onExpiry is NOT called when timer is cancelled before expiry', () => {
    const onExpiry = jest.fn();
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, makeBroadcastFn(), onExpiry);

    timerService.cancelCountdownTimer(ROOM);
    jest.advanceTimersByTime(TURN_DURATION);

    expect(onExpiry).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cancelCountdownTimer
// ---------------------------------------------------------------------------

describe('cancelCountdownTimer', () => {
  it('8. cancels the timer before onExpiry fires', () => {
    const onExpiry = jest.fn();
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, makeBroadcastFn(), onExpiry);

    timerService.cancelCountdownTimer(ROOM);
    jest.advanceTimersByTime(TURN_DURATION + 5_000);

    expect(onExpiry).not.toHaveBeenCalled();
  });

  it('8b. stops tick events after cancellation', () => {
    const broadcast = makeBroadcastFn();
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, broadcast, jest.fn());

    jest.advanceTimersByTime(5 * TICK_INTERVAL_MS); // 5 ticks
    const ticksBefore = broadcast.ofType('timer_tick').length;

    timerService.cancelCountdownTimer(ROOM);

    jest.advanceTimersByTime(10 * TICK_INTERVAL_MS); // 10 more seconds pass
    const ticksAfter = broadcast.ofType('timer_tick').length;

    // No new ticks after cancellation
    expect(ticksAfter).toBe(ticksBefore);
  });

  it('9. cancelCountdownTimer is idempotent (safe when no timer exists)', () => {
    expect(() => timerService.cancelCountdownTimer(ROOM)).not.toThrow();
    expect(() => timerService.cancelCountdownTimer(ROOM)).not.toThrow();
  });

  it('cancelCountdownTimer returns false when no timer exists', () => {
    const result = timerService.cancelCountdownTimer('NONEXISTENT');
    expect(result).toBe(false);
  });

  it('cancelCountdownTimer returns true when a timer is cancelled', () => {
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, makeBroadcastFn(), jest.fn());
    const result = timerService.cancelCountdownTimer(ROOM);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Second timer for same room cancels first
// ---------------------------------------------------------------------------

describe('second timer for same room', () => {
  it('10. starting a second timer for the same room cancels the first', () => {
    const onExpiry1 = jest.fn();
    const onExpiry2 = jest.fn();

    timerService.startCountdownTimer(ROOM, 'turn', 'p1', TURN_DURATION, makeBroadcastFn(), onExpiry1);
    timerService.startCountdownTimer(ROOM, 'declaration', 'p2', DECL_DURATION, makeBroadcastFn(), onExpiry2);

    jest.advanceTimersByTime(TURN_DURATION);

    // First timer should NOT fire (was replaced)
    expect(onExpiry1).not.toHaveBeenCalled();

    jest.advanceTimersByTime(DECL_DURATION);

    // Second timer should fire
    expect(onExpiry2).toHaveBeenCalledTimes(1);
  });

  it('only one active timer per room after re-start', () => {
    timerService.startCountdownTimer(ROOM, 'turn', 'p1', TURN_DURATION, makeBroadcastFn(), jest.fn());
    timerService.startCountdownTimer(ROOM, 'turn', 'p1', TURN_DURATION, makeBroadcastFn(), jest.fn());

    expect(timerService._getTimerStore().size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

describe('getTimerRemaining', () => {
  it('12. returns null when no timer is active', () => {
    expect(timerService.getTimerRemaining(ROOM)).toBeNull();
  });

  it('12b. returns remaining ms (> 0) when a timer is active', () => {
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, makeBroadcastFn(), jest.fn());

    jest.advanceTimersByTime(5_000);
    const remaining = timerService.getTimerRemaining(ROOM);
    expect(remaining).not.toBeNull();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(TURN_DURATION);
  });

  it('returns 0 (not negative) when the timer has just expired', () => {
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, makeBroadcastFn(), jest.fn());

    jest.advanceTimersByTime(TURN_DURATION + 5_000);
    // After expiry the timer is removed from the store
    expect(timerService.getTimerRemaining(ROOM)).toBeNull();
  });
});

describe('isTimerActive', () => {
  it('13. returns false initially', () => {
    expect(timerService.isTimerActive(ROOM)).toBe(false);
  });

  it('13b. returns true after timer is started', () => {
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, makeBroadcastFn(), jest.fn());
    expect(timerService.isTimerActive(ROOM)).toBe(true);
  });

  it('13c. returns false after cancelCountdownTimer', () => {
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, makeBroadcastFn(), jest.fn());
    timerService.cancelCountdownTimer(ROOM);
    expect(timerService.isTimerActive(ROOM)).toBe(false);
  });

  it('returns false after timer expires', () => {
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, makeBroadcastFn(), jest.fn());
    jest.advanceTimersByTime(TURN_DURATION);
    expect(timerService.isTimerActive(ROOM)).toBe(false);
  });
});

describe('getTimerExpiry', () => {
  it('14. returns null when no timer is active', () => {
    expect(timerService.getTimerExpiry(ROOM)).toBeNull();
  });

  it('14b. returns epoch ms when active', () => {
    const before = Date.now();
    timerService.startCountdownTimer(ROOM, 'turn', PLAYER, TURN_DURATION, makeBroadcastFn(), jest.fn());

    const expiry = timerService.getTimerExpiry(ROOM);
    expect(expiry).toBeGreaterThanOrEqual(before + TURN_DURATION);
  });
});

describe('getTimerPhase', () => {
  it('15. returns null when no timer is active', () => {
    expect(timerService.getTimerPhase(ROOM)).toBeNull();
  });

  it('15b. returns the phase string when active', () => {
    timerService.startCountdownTimer(ROOM, 'declaration', PLAYER, DECL_DURATION, makeBroadcastFn(), jest.fn());
    expect(timerService.getTimerPhase(ROOM)).toBe('declaration');
  });
});

// ---------------------------------------------------------------------------
// _clearAllTimers (test helper)
// ---------------------------------------------------------------------------

describe('_clearAllTimers', () => {
  it('19. cancels all active timers and clears the store', () => {
    const onExpiry1 = jest.fn();
    const onExpiry2 = jest.fn();

    timerService.startCountdownTimer('ROOM_A', 'turn', 'p1', TURN_DURATION, makeBroadcastFn(), onExpiry1);
    timerService.startCountdownTimer('ROOM_B', 'turn', 'p2', TURN_DURATION, makeBroadcastFn(), onExpiry2);

    expect(timerService._getTimerStore().size).toBe(2);

    timerService._clearAllTimers();

    expect(timerService._getTimerStore().size).toBe(0);

    jest.advanceTimersByTime(TURN_DURATION + 5_000);
    expect(onExpiry1).not.toHaveBeenCalled();
    expect(onExpiry2).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// startCountdownTimer return value
// ---------------------------------------------------------------------------

describe('return value', () => {
  it('returns { expiresAt: number }', () => {
    const before = Date.now();
    const result = timerService.startCountdownTimer(
      ROOM, 'turn', PLAYER, TURN_DURATION, makeBroadcastFn(), jest.fn(),
    );
    const after = Date.now();

    expect(result).toBeDefined();
    expect(typeof result.expiresAt).toBe('number');
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + TURN_DURATION);
    expect(result.expiresAt).toBeLessThanOrEqual(after + TURN_DURATION + 100);
  });
});
