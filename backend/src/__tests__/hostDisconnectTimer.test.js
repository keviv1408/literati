'use strict';

/**
 * Unit tests for ws/hostDisconnectTimer.js
 *
 * Tests the core timer API:
 *   - HOST_RECONNECT_WINDOW_MS is exactly 60 seconds
 *   - TICK_INTERVAL_MS is exactly 5 seconds
 *   - startHostDisconnectTimer: starts a timer, returns { started, expiresAt }
 *   - Idempotency (double-start returns started: false)
 *   - Case-insensitivity of roomCode
 *   - Timer fires onExpiry callback with the uppercase roomCode
 *   - Cancelled timer does NOT fire onExpiry callback
 *   - Tick callback fires every TICK_INTERVAL_MS with (roomCode, remainingMs, expiresAt)
 *   - cancelHostDisconnectTimer: returns true when a timer was active
 *   - cancelHostDisconnectTimer: returns false when no timer is active
 *   - cancelHostDisconnectTimer: is idempotent (double-cancel is safe)
 *   - cancelHostDisconnectTimer: is case-insensitive
 *   - getHostDisconnectTimerRemaining: returns null when no timer
 *   - getHostDisconnectTimerRemaining: returns positive number when active
 *   - getHostDisconnectTimerRemaining: decreases as time passes
 *   - getHostDisconnectTimerRemaining: returns null after timer fires
 *   - getHostDisconnectTimerRemaining: returns null after cancellation
 *   - getHostDisconnectTimerRemaining: clamps to 0 (no negative values)
 *   - isHostDisconnectTimerActive: returns false when no timer
 *   - isHostDisconnectTimerActive: returns true after start
 *   - isHostDisconnectTimerActive: returns false after timer fires
 *   - isHostDisconnectTimerActive: returns false after cancellation
 *   - getHostDisconnectTimerExpiry: returns null when no timer
 *   - getHostDisconnectTimerExpiry: returns epoch-ms when active
 *   - getHostDisconnectTimerExpiry: matches expiresAt from startHostDisconnectTimer
 *   - Multiple independent rooms have independent timers
 *   - onExpiry sync error is caught without crashing
 *   - onExpiry async error is caught without crashing
 *   - onTick=null is safe (no tick interval started)
 *   - Timer is removed from store before onExpiry is called (re-entrant safety)
 *   - _clearAllTimers cancels all active timers
 *   - _clearAllTimers is safe when no timers are active
 *
 * Uses Jest's fake timers so the tests run instantly.
 */

const {
  HOST_RECONNECT_WINDOW_MS,
  TICK_INTERVAL_MS,
  startHostDisconnectTimer,
  cancelHostDisconnectTimer,
  getHostDisconnectTimerRemaining,
  isHostDisconnectTimerActive,
  getHostDisconnectTimerExpiry,
  _clearAllTimers,
  _getTimerStore,
} = require('../ws/hostDisconnectTimer');

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

describe('HOST_RECONNECT_WINDOW_MS', () => {
  it('is exactly 60 seconds', () => {
    expect(HOST_RECONNECT_WINDOW_MS).toBe(60_000);
  });
});

describe('TICK_INTERVAL_MS', () => {
  it('is exactly 5 seconds', () => {
    expect(TICK_INTERVAL_MS).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// startHostDisconnectTimer
// ---------------------------------------------------------------------------

describe('startHostDisconnectTimer', () => {
  it('returns started=true and a future expiresAt when no timer exists', () => {
    const before = Date.now();
    const { started, expiresAt } = startHostDisconnectTimer('ABCDEF', null, jest.fn());

    expect(started).toBe(true);
    expect(expiresAt).toBeGreaterThanOrEqual(before + HOST_RECONNECT_WINDOW_MS);
  });

  it('returns started=false when a timer already exists (idempotent)', () => {
    startHostDisconnectTimer('ABCDEF', null, jest.fn());
    const { started } = startHostDisconnectTimer('ABCDEF', null, jest.fn());
    expect(started).toBe(false);
  });

  it('returns the existing expiresAt when called a second time for the same room', () => {
    const { expiresAt: first } = startHostDisconnectTimer('ABCDEF', null, jest.fn());
    const { expiresAt: second } = startHostDisconnectTimer('ABCDEF', null, jest.fn());
    expect(second).toBe(first);
  });

  it('treats roomCode as case-insensitive (lowercase same as uppercase)', () => {
    startHostDisconnectTimer('abcdef', null, jest.fn());
    const { started } = startHostDisconnectTimer('ABCDEF', null, jest.fn());
    expect(started).toBe(false);
  });

  it('allows different rooms to have independent timers', () => {
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    const r1 = startHostDisconnectTimer('ROOM01', null, cb1, 1000);
    const r2 = startHostDisconnectTimer('ROOM02', null, cb2, 1000);
    expect(r1.started).toBe(true);
    expect(r2.started).toBe(true);
    expect(isHostDisconnectTimerActive('ROOM01')).toBe(true);
    expect(isHostDisconnectTimerActive('ROOM02')).toBe(true);
    jest.advanceTimersByTime(1100);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb1).toHaveBeenCalledWith('ROOM01');
    expect(cb2).toHaveBeenCalledWith('ROOM02');
  });

  it('fires the onExpiry callback after the timeout elapses', () => {
    const onExpiry = jest.fn();
    startHostDisconnectTimer('ABCDEF', null, onExpiry, 5000);

    expect(onExpiry).not.toHaveBeenCalled();
    jest.advanceTimersByTime(5001);
    expect(onExpiry).toHaveBeenCalledTimes(1);
  });

  it('passes the uppercase roomCode to the onExpiry callback', () => {
    const onExpiry = jest.fn();
    startHostDisconnectTimer('abcdef', null, onExpiry, 100);
    jest.advanceTimersByTime(200);
    expect(onExpiry).toHaveBeenCalledWith('ABCDEF');
  });

  it('removes the timer from the store before calling onExpiry (re-entrant safety)', () => {
    let activeInsideCallback;
    startHostDisconnectTimer(
      'ABCDEF',
      null,
      (code) => { activeInsideCallback = isHostDisconnectTimerActive(code); },
      100,
    );
    jest.advanceTimersByTime(200);
    expect(activeInsideCallback).toBe(false);
  });

  it('supports a custom timeoutMs override', () => {
    const onExpiry = jest.fn();
    startHostDisconnectTimer('CUSTOM', null, onExpiry, 1000);

    jest.advanceTimersByTime(999);
    expect(onExpiry).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2);
    expect(onExpiry).toHaveBeenCalledTimes(1);
  });

  it('catches and does not re-throw a sync error from onExpiry', () => {
    const throwing = jest.fn(() => { throw new Error('sync boom'); });
    startHostDisconnectTimer('SYNC_ERR', null, throwing, 50);

    expect(() => jest.advanceTimersByTime(100)).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it('catches and does not re-throw a rejected Promise from async onExpiry', async () => {
    const asyncThrowing = jest.fn(async () => { throw new Error('async boom'); });
    startHostDisconnectTimer('ASYNC_ERR', null, asyncThrowing, 50);

    jest.advanceTimersByTime(100);

    await Promise.resolve();
    expect(asyncThrowing).toHaveBeenCalledTimes(1);
  });

  it('null onTick is safe — no tick interval is started', () => {
    const onExpiry = jest.fn();
    const { started } = startHostDisconnectTimer('ABCDEF', null, onExpiry, 5000);

    expect(started).toBe(true);
    // Advance past several tick intervals — should not throw
    expect(() => jest.advanceTimersByTime(4999)).not.toThrow();
    expect(onExpiry).not.toHaveBeenCalled();

    // Timer is still active
    expect(isHostDisconnectTimerActive('ABCDEF')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tick events
// ---------------------------------------------------------------------------

describe('tick events', () => {
  it('calls onTick with (roomCode, remainingMs, expiresAt) every TICK_INTERVAL_MS', () => {
    const onTick = jest.fn();
    const { expiresAt } = startHostDisconnectTimer('TICKS', onTick, jest.fn(), 30_000);

    // No ticks before first interval
    expect(onTick).not.toHaveBeenCalled();

    // First tick after 5 s
    jest.advanceTimersByTime(TICK_INTERVAL_MS);
    expect(onTick).toHaveBeenCalledTimes(1);
    const [code1, remaining1, exp1] = onTick.mock.calls[0];
    expect(code1).toBe('TICKS');
    expect(remaining1).toBeGreaterThan(0);
    expect(exp1).toBe(expiresAt);

    // Second tick after another 5 s
    jest.advanceTimersByTime(TICK_INTERVAL_MS);
    expect(onTick).toHaveBeenCalledTimes(2);
    const [, remaining2] = onTick.mock.calls[1];
    // remainingMs should be less than on the first tick
    expect(remaining2).toBeLessThanOrEqual(remaining1);
  });

  it('passes the uppercase roomCode to onTick', () => {
    const onTick = jest.fn();
    startHostDisconnectTimer('ticks', onTick, jest.fn(), 30_000);
    jest.advanceTimersByTime(TICK_INTERVAL_MS);
    expect(onTick.mock.calls[0][0]).toBe('TICKS');
  });

  it('stops tick after the timer fires', () => {
    const onTick = jest.fn();
    startHostDisconnectTimer('TFIRES', onTick, jest.fn(), 10_000);

    // Two ticks then expiry
    jest.advanceTimersByTime(TICK_INTERVAL_MS * 2 + 1);
    expect(onTick).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(10_000); // well past expiry
    // No additional ticks after expiry
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it('stops tick after the timer is cancelled', () => {
    const onTick = jest.fn();
    startHostDisconnectTimer('TCANCEL', onTick, jest.fn(), 30_000);

    jest.advanceTimersByTime(TICK_INTERVAL_MS); // one tick
    expect(onTick).toHaveBeenCalledTimes(1);

    cancelHostDisconnectTimer('TCANCEL');

    jest.advanceTimersByTime(TICK_INTERVAL_MS * 10); // advance far past
    expect(onTick).toHaveBeenCalledTimes(1); // no additional ticks
  });

  it('catches and does not re-throw a sync error from onTick', () => {
    const badTick = jest.fn(() => { throw new Error('tick boom'); });
    startHostDisconnectTimer('TICKERR', badTick, jest.fn(), 30_000);
    expect(() => jest.advanceTimersByTime(TICK_INTERVAL_MS)).not.toThrow();
    expect(badTick).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// cancelHostDisconnectTimer
// ---------------------------------------------------------------------------

describe('cancelHostDisconnectTimer', () => {
  it('returns true when a timer was found and cancelled', () => {
    startHostDisconnectTimer('ABCDEF', null, jest.fn());
    expect(cancelHostDisconnectTimer('ABCDEF')).toBe(true);
  });

  it('returns false when no timer is active', () => {
    expect(cancelHostDisconnectTimer('ZZZZZZ')).toBe(false);
  });

  it('prevents the onExpiry callback from firing after cancellation', () => {
    const onExpiry = jest.fn();
    startHostDisconnectTimer('ABCDEF', null, onExpiry, 5000);
    cancelHostDisconnectTimer('ABCDEF');
    jest.advanceTimersByTime(10000);
    expect(onExpiry).not.toHaveBeenCalled();
  });

  it('removes the timer from the store', () => {
    startHostDisconnectTimer('ABCDEF', null, jest.fn());
    cancelHostDisconnectTimer('ABCDEF');
    expect(isHostDisconnectTimerActive('ABCDEF')).toBe(false);
    expect(_getTimerStore().has('ABCDEF')).toBe(false);
  });

  it('is idempotent (second cancel returns false, no error)', () => {
    startHostDisconnectTimer('ABCDEF', null, jest.fn());
    cancelHostDisconnectTimer('ABCDEF');
    expect(() => cancelHostDisconnectTimer('ABCDEF')).not.toThrow();
    expect(cancelHostDisconnectTimer('ABCDEF')).toBe(false);
  });

  it('is case-insensitive', () => {
    startHostDisconnectTimer('abcdef', null, jest.fn());
    expect(cancelHostDisconnectTimer('ABCDEF')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getHostDisconnectTimerRemaining
// ---------------------------------------------------------------------------

describe('getHostDisconnectTimerRemaining', () => {
  it('returns null when no timer is active', () => {
    expect(getHostDisconnectTimerRemaining('ABCDEF')).toBeNull();
  });

  it('returns a positive number close to the timeout when timer just started', () => {
    startHostDisconnectTimer('ABCDEF', null, jest.fn(), 10000);
    const remaining = getHostDisconnectTimerRemaining('ABCDEF');
    expect(remaining).toBeGreaterThan(9000);
    expect(remaining).toBeLessThanOrEqual(10000);
  });

  it('decreases as time passes', () => {
    startHostDisconnectTimer('ABCDEF', null, jest.fn(), 10000);
    jest.advanceTimersByTime(3000);
    const remaining = getHostDisconnectTimerRemaining('ABCDEF');
    expect(remaining).toBeLessThan(8000);
  });

  it('returns null after the timer fires', () => {
    startHostDisconnectTimer('ABCDEF', null, jest.fn(), 1000);
    jest.advanceTimersByTime(2000);
    expect(getHostDisconnectTimerRemaining('ABCDEF')).toBeNull();
  });

  it('returns null after the timer is cancelled', () => {
    startHostDisconnectTimer('ABCDEF', null, jest.fn());
    cancelHostDisconnectTimer('ABCDEF');
    expect(getHostDisconnectTimerRemaining('ABCDEF')).toBeNull();
  });

  it('clamps to 0 (does not return negative values)', () => {
    startHostDisconnectTimer('CLAMP', null, jest.fn(), 1000);
    // Manually set expiresAt to the past to test the Math.max(0, ...) guard.
    const store = _getTimerStore();
    const record = store.get('CLAMP');
    record.expiresAt = Date.now() - 5000;
    expect(getHostDisconnectTimerRemaining('CLAMP')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isHostDisconnectTimerActive
// ---------------------------------------------------------------------------

describe('isHostDisconnectTimerActive', () => {
  it('returns false when no timer exists', () => {
    expect(isHostDisconnectTimerActive('ABCDEF')).toBe(false);
  });

  it('returns true after a timer is started', () => {
    startHostDisconnectTimer('ABCDEF', null, jest.fn());
    expect(isHostDisconnectTimerActive('ABCDEF')).toBe(true);
  });

  it('returns false after the timer fires', () => {
    startHostDisconnectTimer('ABCDEF', null, jest.fn(), 500);
    jest.advanceTimersByTime(600);
    expect(isHostDisconnectTimerActive('ABCDEF')).toBe(false);
  });

  it('returns false after the timer is cancelled', () => {
    startHostDisconnectTimer('ABCDEF', null, jest.fn());
    cancelHostDisconnectTimer('ABCDEF');
    expect(isHostDisconnectTimerActive('ABCDEF')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getHostDisconnectTimerExpiry
// ---------------------------------------------------------------------------

describe('getHostDisconnectTimerExpiry', () => {
  it('returns null when no timer is active', () => {
    expect(getHostDisconnectTimerExpiry('ABCDEF')).toBeNull();
  });

  it('returns the epoch-ms timestamp when the timer will fire', () => {
    const before = Date.now();
    startHostDisconnectTimer('ABCDEF', null, jest.fn(), 5000);
    const expiry = getHostDisconnectTimerExpiry('ABCDEF');
    expect(expiry).toBeGreaterThanOrEqual(before + 5000);
  });

  it('returns null after timer fires', () => {
    startHostDisconnectTimer('ABCDEF', null, jest.fn(), 200);
    jest.advanceTimersByTime(300);
    expect(getHostDisconnectTimerExpiry('ABCDEF')).toBeNull();
  });

  it('matches the expiresAt returned by startHostDisconnectTimer', () => {
    const { expiresAt } = startHostDisconnectTimer('ABCDEF', null, jest.fn(), 3000);
    expect(getHostDisconnectTimerExpiry('ABCDEF')).toBe(expiresAt);
  });
});

// ---------------------------------------------------------------------------
// _clearAllTimers (test helper)
// ---------------------------------------------------------------------------

describe('_clearAllTimers', () => {
  it('cancels all active timers and empties the store', () => {
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    startHostDisconnectTimer('ROOM01', null, cb1, 5000);
    startHostDisconnectTimer('ROOM02', null, cb2, 5000);

    _clearAllTimers();

    expect(_getTimerStore().size).toBe(0);
    jest.advanceTimersByTime(10000);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it('is safe to call when no timers are active', () => {
    expect(() => _clearAllTimers()).not.toThrow();
  });

  it('also cancels tick intervals', () => {
    const onTick = jest.fn();
    startHostDisconnectTimer('TICK_CLR', onTick, jest.fn(), 30_000);

    _clearAllTimers();

    jest.advanceTimersByTime(TICK_INTERVAL_MS * 10);
    expect(onTick).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Integration: host disconnect → reconnect cancel flow
// ---------------------------------------------------------------------------

describe('host disconnect → reconnect cancel flow', () => {
  it('timer is active after host disconnects', () => {
    startHostDisconnectTimer('FLOW01', null, jest.fn(), 60_000);
    expect(isHostDisconnectTimerActive('FLOW01')).toBe(true);
  });

  it('timer is inactive after cancel (simulating host reconnect)', () => {
    startHostDisconnectTimer('FLOW02', null, jest.fn(), 60_000);
    cancelHostDisconnectTimer('FLOW02');
    expect(isHostDisconnectTimerActive('FLOW02')).toBe(false);
  });

  it('onExpiry is NOT called if cancelled before 60 s elapse', () => {
    const onExpiry = jest.fn();
    startHostDisconnectTimer('FLOW03', null, onExpiry, 60_000);

    // Advance to 50 s (within window)
    jest.advanceTimersByTime(50_000);
    // Host "reconnects" — cancel the timer
    cancelHostDisconnectTimer('FLOW03');

    // Advance past 60 s — onExpiry must NOT fire
    jest.advanceTimersByTime(15_000);
    expect(onExpiry).not.toHaveBeenCalled();
  });

  it('onExpiry IS called if nobody cancels by 60 s', () => {
    const onExpiry = jest.fn();
    startHostDisconnectTimer('FLOW04', null, onExpiry, 60_000);
    jest.advanceTimersByTime(60_001);
    expect(onExpiry).toHaveBeenCalledTimes(1);
    expect(onExpiry).toHaveBeenCalledWith('FLOW04');
  });

  it('ticks fire every 5 s during the 60-second window', () => {
    const onTick = jest.fn();
    startHostDisconnectTimer('FLOW05', onTick, jest.fn(), 60_000);

    // Advance 30 s — should have fired 6 ticks
    jest.advanceTimersByTime(30_000);
    expect(onTick).toHaveBeenCalledTimes(6);
  });

  it('expiresAt from startHostDisconnectTimer is ~60 s in the future', () => {
    const before = Date.now();
    const { expiresAt } = startHostDisconnectTimer('FLOW06', null, jest.fn());
    expect(expiresAt).toBeGreaterThanOrEqual(before + HOST_RECONNECT_WINDOW_MS);
    expect(expiresAt).toBeLessThan(before + HOST_RECONNECT_WINDOW_MS + 1000);
  });
});
