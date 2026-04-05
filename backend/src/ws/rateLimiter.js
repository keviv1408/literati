/**
 * Per-connection WebSocket message rate limiter.
 *
 * Uses a sliding-window counter: timestamps of recent messages are stored
 * per connection.  When the window is exceeded the caller receives a
 * `limited` result.  After repeated violations within a short span the
 * caller receives a `disconnect` result so the server can close the socket.
 *
 * Memory is O(windowSize * activeConnections) — negligible for typical
 * game traffic.  Call `cleanup(ws)` on connection close.
 */

// ── Configurable constants ──────────────────────────────────────────────────
const MAX_MESSAGES_PER_SECOND = 10;   // messages allowed per window
const WINDOW_MS               = 1000; // sliding window size (1 second)
const VIOLATION_THRESHOLD      = 3;   // violations before forced disconnect
const VIOLATION_WINDOW_MS      = 10_000; // violations are counted in this span

// ── Internal state ──────────────────────────────────────────────────────────
// WeakMap keyed by the ws object so entries are GC-eligible if we forget to
// call cleanup (belt-and-suspenders).
const _state = new WeakMap();

function _getState(ws) {
  let s = _state.get(ws);
  if (!s) {
    s = {
      timestamps: [],   // message timestamps within the current window
      violations: [],   // timestamps of rate-limit violations
    };
    _state.set(ws, s);
  }
  return s;
}

/**
 * Check whether a message from `ws` should be allowed.
 *
 * @param {WebSocket} ws — the connection to check
 * @returns {'allowed' | 'limited' | 'disconnect'}
 */
function check(ws) {
  const now = Date.now();
  const s   = _getState(ws);

  // Prune timestamps outside the sliding window
  const cutoff = now - WINDOW_MS;
  // Keep only timestamps within the window — small array so filter is fine.
  s.timestamps = s.timestamps.filter((t) => t > cutoff);

  if (s.timestamps.length < MAX_MESSAGES_PER_SECOND) {
    s.timestamps.push(now);
    return 'allowed';
  }

  // ── Over limit — record a violation ─────────────────────────────────────
  const violationCutoff = now - VIOLATION_WINDOW_MS;
  s.violations = s.violations.filter((t) => t > violationCutoff);
  s.violations.push(now);

  if (s.violations.length >= VIOLATION_THRESHOLD) {
    return 'disconnect';
  }

  return 'limited';
}

/**
 * Remove all tracking state for a connection.
 * Call this inside `ws.on('close', ...)`.
 *
 * @param {WebSocket} ws
 */
function cleanup(ws) {
  _state.delete(ws);
}

// ── Error payload sent to clients when rate-limited ─────────────────────────
const RATE_LIMITED_PAYLOAD = JSON.stringify({
  type:    'error',
  message: 'Rate limit exceeded',
  code:    'RATE_LIMITED',
});

/** WebSocket close code used for forced disconnects due to abuse. */
const RATE_LIMIT_CLOSE_CODE = 4008;

module.exports = {
  check,
  cleanup,
  RATE_LIMITED_PAYLOAD,
  RATE_LIMIT_CLOSE_CODE,
  // Exported for testing only
  _constants: {
    MAX_MESSAGES_PER_SECOND,
    WINDOW_MS,
    VIOLATION_THRESHOLD,
    VIOLATION_WINDOW_MS,
  },
};
