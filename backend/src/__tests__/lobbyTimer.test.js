'use strict';

/**
 * Unit tests for /matchmaking/lobbyTimer.js
 *
 * Tests the core timer API:
 *   - startLobbyTimer: starts a timer, returns { started, expiresAt }
 *   - cancelLobbyTimer: cancels a timer, returns true/false
 *   - getLobbyTimerRemaining: ms remaining until timer fires
 *   - isLobbyTimerActive: boolean check
 *   - getLobbyTimerExpiry: epoch-ms expiry timestamp
 *   - Idempotency (double-start, double-cancel)
 *   - Case-insensitivity of roomCode
 *   - Timer fires callback with the uppercase roomCode
 *   - Cancelled timer does NOT fire callback
 *   - Async onExpiry error is caught without crashing
 *   - Sync onExpiry error is caught without crashing
 *
 * Uses Jest's fake timers so the tests run instantly.
 */

const {
  LOBBY_FILL_TIMEOUT_MS,
  startLobbyTimer,
  cancelLobbyTimer,
  getLobbyTimerRemaining,
  isLobbyTimerActive,
  getLobbyTimerExpiry,
  _clearAllTimers,
  _getTimerStore,
} = require('../matchmaking/lobbyTimer');

// ---------------------------------------------------------------------------
// Timer isolation
// ---------------------------------------------------------------------------

beforeEach(() => {
  _clearAllTimers();
  jest.useFakeTimers();
});

afterEach(() => {
  _clearAllTimers();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('LOBBY_FILL_TIMEOUT_MS', () => {
  it('is exactly 2 minutes', () => {
    expect(LOBBY_FILL_TIMEOUT_MS).toBe(2 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// startLobbyTimer
// ---------------------------------------------------------------------------

describe('startLobbyTimer', () => {
  it('returns started=true and a future expiresAt when no timer exists', () => {
    const onExpiry = jest.fn();
    const before = Date.now();
    const { started, expiresAt } = startLobbyTimer('ABCDEF', onExpiry);

    expect(started).toBe(true);
    expect(expiresAt).toBeGreaterThanOrEqual(before + LOBBY_FILL_TIMEOUT_MS);
  });

  it('returns started=false when a timer already exists (idempotent)', () => {
    const onExpiry = jest.fn();
    startLobbyTimer('ABCDEF', onExpiry);
    const { started } = startLobbyTimer('ABCDEF', jest.fn());
    expect(started).toBe(false);
  });

  it('returns the existing expiresAt when called a second time for the same room', () => {
    const onExpiry = jest.fn();
    const { expiresAt: first } = startLobbyTimer('ABCDEF', onExpiry);
    const { expiresAt: second } = startLobbyTimer('ABCDEF', jest.fn());
    expect(second).toBe(first);
  });

  it('treats roomCode as case-insensitive (lowercase same as uppercase)', () => {
    startLobbyTimer('abcdef', jest.fn());
    const { started } = startLobbyTimer('ABCDEF', jest.fn());
    expect(started).toBe(false);
  });

  it('allows different rooms to have independent timers', () => {
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    const r1 = startLobbyTimer('ROOM01', cb1, 1000);
    const r2 = startLobbyTimer('ROOM02', cb2, 1000);
    expect(r1.started).toBe(true);
    expect(r2.started).toBe(true);
    // Both timers must be independently active
    expect(isLobbyTimerActive('ROOM01')).toBe(true);
    expect(isLobbyTimerActive('ROOM02')).toBe(true);
    // Each fires its own callback with the correct room code
    jest.advanceTimersByTime(1100);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb1).toHaveBeenCalledWith('ROOM01');
    expect(cb2).toHaveBeenCalledWith('ROOM02');
  });

  it('fires the callback after the timeout elapses', () => {
    const onExpiry = jest.fn();
    startLobbyTimer('ABCDEF', onExpiry, 5000);

    expect(onExpiry).not.toHaveBeenCalled();
    jest.advanceTimersByTime(5001);
    expect(onExpiry).toHaveBeenCalledTimes(1);
  });

  it('passes the uppercase roomCode to the callback', () => {
    const onExpiry = jest.fn();
    startLobbyTimer('abcdef', onExpiry, 100);
    jest.advanceTimersByTime(200);
    expect(onExpiry).toHaveBeenCalledWith('ABCDEF');
  });

  it('removes the timer from the store before calling onExpiry', () => {
    let activeInsideCallback;
    startLobbyTimer('ABCDEF', (code) => {
      activeInsideCallback = isLobbyTimerActive(code);
    }, 100);

    jest.advanceTimersByTime(200);
    expect(activeInsideCallback).toBe(false);
  });

  it('supports a custom timeoutMs override', () => {
    const onExpiry = jest.fn();
    startLobbyTimer('CUSTOM', onExpiry, 1000);

    jest.advanceTimersByTime(999);
    expect(onExpiry).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2);
    expect(onExpiry).toHaveBeenCalledTimes(1);
  });

  it('catches and does not re-throw a sync error from onExpiry', () => {
    const throwing = jest.fn(() => { throw new Error('sync boom'); });
    startLobbyTimer('SYNC_ERR', throwing, 50);

    // Should not throw in the test process.
    expect(() => jest.advanceTimersByTime(100)).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it('catches and does not re-throw a rejected Promise from async onExpiry', async () => {
    const asyncThrowing = jest.fn(async () => { throw new Error('async boom'); });
    startLobbyTimer('ASYNC_ERR', asyncThrowing, 50);

    jest.advanceTimersByTime(100);

    // Flush microtask queue so the Promise rejection handler runs.
    await Promise.resolve();
    // No uncaught rejection — test passes if we reach here.
    expect(asyncThrowing).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// cancelLobbyTimer
// ---------------------------------------------------------------------------

describe('cancelLobbyTimer', () => {
  it('returns true when a timer was found and cancelled', () => {
    startLobbyTimer('ABCDEF', jest.fn());
    expect(cancelLobbyTimer('ABCDEF')).toBe(true);
  });

  it('returns false when no timer is active', () => {
    expect(cancelLobbyTimer('ZZZZZZ')).toBe(false);
  });

  it('prevents the callback from firing after cancellation', () => {
    const onExpiry = jest.fn();
    startLobbyTimer('ABCDEF', onExpiry, 5000);
    cancelLobbyTimer('ABCDEF');
    jest.advanceTimersByTime(10000);
    expect(onExpiry).not.toHaveBeenCalled();
  });

  it('removes the timer from the store', () => {
    startLobbyTimer('ABCDEF', jest.fn());
    cancelLobbyTimer('ABCDEF');
    expect(isLobbyTimerActive('ABCDEF')).toBe(false);
    expect(_getTimerStore().has('ABCDEF')).toBe(false);
  });

  it('is idempotent (second cancel returns false, no error)', () => {
    startLobbyTimer('ABCDEF', jest.fn());
    cancelLobbyTimer('ABCDEF');
    expect(() => cancelLobbyTimer('ABCDEF')).not.toThrow();
    expect(cancelLobbyTimer('ABCDEF')).toBe(false);
  });

  it('is case-insensitive', () => {
    startLobbyTimer('abcdef', jest.fn());
    expect(cancelLobbyTimer('ABCDEF')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getLobbyTimerRemaining
// ---------------------------------------------------------------------------

describe('getLobbyTimerRemaining', () => {
  it('returns null when no timer is active', () => {
    expect(getLobbyTimerRemaining('ABCDEF')).toBeNull();
  });

  it('returns a positive number close to the timeout when timer just started', () => {
    startLobbyTimer('ABCDEF', jest.fn(), 10000);
    const remaining = getLobbyTimerRemaining('ABCDEF');
    expect(remaining).toBeGreaterThan(9000);
    expect(remaining).toBeLessThanOrEqual(10000);
  });

  it('decreases as time passes', () => {
    startLobbyTimer('ABCDEF', jest.fn(), 10000);
    jest.advanceTimersByTime(3000);
    const remaining = getLobbyTimerRemaining('ABCDEF');
    expect(remaining).toBeLessThan(8000);
  });

  it('returns null after the timer fires', () => {
    startLobbyTimer('ABCDEF', jest.fn(), 1000);
    jest.advanceTimersByTime(2000);
    expect(getLobbyTimerRemaining('ABCDEF')).toBeNull();
  });

  it('returns null after the timer is cancelled', () => {
    startLobbyTimer('ABCDEF', jest.fn());
    cancelLobbyTimer('ABCDEF');
    expect(getLobbyTimerRemaining('ABCDEF')).toBeNull();
  });

  it('clamps to 0 (does not return negative values)', () => {
    // Create a timer with a short timeout.  Advance past expiry but the
    // callback fires and removes the record, so we should get null.  The
    // clamp-to-0 path is tested by directly manipulating the stored record.
    startLobbyTimer('CLAMP', jest.fn(), 1000);
    // Manually set expiresAt to the past to test the Math.max(0, ...) guard.
    const store = _getTimerStore();
    const record = store.get('CLAMP');
    record.expiresAt = Date.now() - 5000; // artificially in the past
    expect(getLobbyTimerRemaining('CLAMP')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isLobbyTimerActive
// ---------------------------------------------------------------------------

describe('isLobbyTimerActive', () => {
  it('returns false when no timer exists', () => {
    expect(isLobbyTimerActive('ABCDEF')).toBe(false);
  });

  it('returns true after a timer is started', () => {
    startLobbyTimer('ABCDEF', jest.fn());
    expect(isLobbyTimerActive('ABCDEF')).toBe(true);
  });

  it('returns false after the timer fires', () => {
    startLobbyTimer('ABCDEF', jest.fn(), 500);
    jest.advanceTimersByTime(600);
    expect(isLobbyTimerActive('ABCDEF')).toBe(false);
  });

  it('returns false after the timer is cancelled', () => {
    startLobbyTimer('ABCDEF', jest.fn());
    cancelLobbyTimer('ABCDEF');
    expect(isLobbyTimerActive('ABCDEF')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getLobbyTimerExpiry
// ---------------------------------------------------------------------------

describe('getLobbyTimerExpiry', () => {
  it('returns null when no timer is active', () => {
    expect(getLobbyTimerExpiry('ABCDEF')).toBeNull();
  });

  it('returns the epoch-ms timestamp when the timer will fire', () => {
    const before = Date.now();
    startLobbyTimer('ABCDEF', jest.fn(), 5000);
    const expiry = getLobbyTimerExpiry('ABCDEF');
    expect(expiry).toBeGreaterThanOrEqual(before + 5000);
  });

  it('returns null after timer fires', () => {
    startLobbyTimer('ABCDEF', jest.fn(), 200);
    jest.advanceTimersByTime(300);
    expect(getLobbyTimerExpiry('ABCDEF')).toBeNull();
  });

  it('matches the expiresAt returned by startLobbyTimer', () => {
    const { expiresAt } = startLobbyTimer('ABCDEF', jest.fn(), 3000);
    expect(getLobbyTimerExpiry('ABCDEF')).toBe(expiresAt);
  });
});

// ---------------------------------------------------------------------------
// _clearAllTimers (test helper)
// ---------------------------------------------------------------------------

describe('_clearAllTimers', () => {
  it('cancels all active timers and empties the store', () => {
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    startLobbyTimer('ROOM01', cb1, 5000);
    startLobbyTimer('ROOM02', cb2, 5000);

    _clearAllTimers();

    expect(_getTimerStore().size).toBe(0);
    jest.advanceTimersByTime(10000);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it('is safe to call when no timers are active', () => {
    expect(() => _clearAllTimers()).not.toThrow();
  });
});
