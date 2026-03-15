/**
 * Room membership persistence.
 *
 * Records the client's session-to-room binding in localStorage so the
 * WebSocket connection can be re-established after a page reload without
 * the user needing to re-authenticate or re-join from scratch.
 *
 * Why this module exists (distinct from backendSession.ts):
 *   backendSession.ts caches a single bearer token keyed by *display name*.
 *   If the user changes their display name, the old token is evicted from that
 *   cache and a fresh one is obtained — but the fresh token would represent a
 *   DIFFERENT backend session and would NOT be recognised by the room's WS
 *   server as the same player.
 *
 *   roomMembership.ts caches the *room-specific* token that was accepted by
 *   the WS server for this room, indexed by room code.  On reload the page
 *   uses this cached token to re-authenticate the WS connection with the same
 *   backend identity, preserving the player's seat assignment and host status.
 *
 * Storage key:  `literati_room_<UPPERCASE_CODE>`
 * TTL:          12 hours  (well within the backend guest-session 24-hour TTL,
 *               and long enough to survive mid-game browser restarts)
 *
 * Lifecycle:
 *   save  — called when the WS server confirms the client is an active member
 *            (i.e. the 'connected' event arrives and myPlayerId is set).
 *   load  — called on mount to restore the token before the guest-session
 *            flow, giving a fast reconnection path.
 *   clear — called when the client is kicked (so they cannot sneak back in
 *            using the stored token) or when all sessions are invalidated.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const PREFIX = 'literati_room_';

/** 12-hour TTL — exported so tests can assert against it. */
export const MEMBERSHIP_TTL_MS = 12 * 60 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

/** The role the client holds in the room. */
export type RoomRole = 'host' | 'player' | 'spectator';

/** What we persist about the client's membership in a room. */
export interface RoomMembership {
  /** Upper-cased 6-character room code. */
  roomCode: string;
  /**
   * Backend bearer token that was accepted by the WS server for this room.
   * This is the opaque guest token (from POST /api/auth/guest) or the
   * Supabase JWT for registered users.
   */
  bearerToken: string;
  /**
   * Server-assigned player ID returned in the WebSocket 'connected' event.
   * This is the authoritative backend identity for this room session.
   */
  playerId: string;
  /** The client's role within this room. */
  role: RoomRole;
  /** Unix ms timestamp after which this record should be discarded. */
  expiresAt: number;
}

// ── Private helpers ───────────────────────────────────────────────────────────

function storageKey(roomCode: string): string {
  return `${PREFIX}${roomCode.toUpperCase()}`;
}

function loadRaw(roomCode: string): RoomMembership | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(roomCode));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RoomMembership;
    if (
      typeof parsed.roomCode === 'string' &&
      typeof parsed.bearerToken === 'string' &&
      typeof parsed.playerId === 'string' &&
      typeof parsed.role === 'string' &&
      typeof parsed.expiresAt === 'number'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Persist the client's membership in a room after the WebSocket server
 * confirms authentication via the 'connected' event.
 *
 * Idempotent — safe to call multiple times with the same data (e.g. when the
 * server re-sends a `room_players` snapshot and `amIHost` updates).
 *
 * @param roomCode    6-character room code (cased automatically).
 * @param bearerToken The token that was accepted by the WS server.
 * @param playerId    Server-assigned player ID from the 'connected' event.
 * @param role        The client's role in this room (default: 'player').
 */
export function saveRoomMembership(
  roomCode: string,
  bearerToken: string,
  playerId: string,
  role: RoomRole = 'player'
): RoomMembership {
  const membership: RoomMembership = {
    roomCode: roomCode.toUpperCase(),
    bearerToken,
    playerId,
    role,
    expiresAt: Date.now() + MEMBERSHIP_TTL_MS,
  };
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(storageKey(roomCode), JSON.stringify(membership));
    } catch {
      // Storage quota exceeded or private-browsing restriction — ignore.
    }
  }
  return membership;
}

/**
 * Return a non-expired room membership record for the given room code, or
 * `null` if no record exists, the record is expired, or the data is malformed.
 *
 * Calling this function is the first step in the bearer-token resolution
 * chain on page load:
 *   1. loadRoomMembership(roomCode)      — fastest: room-specific token
 *   2. getCachedToken(displayName)       — generic backendSession.ts cache
 *   3. getGuestBearerToken(displayName)  — network round-trip fallback
 */
export function loadRoomMembership(roomCode: string): RoomMembership | null {
  const stored = loadRaw(roomCode);
  if (!stored) return null;
  if (Date.now() >= stored.expiresAt) {
    // Expired — evict and return null.
    clearRoomMembership(roomCode);
    return null;
  }
  return stored;
}

/**
 * Remove the room membership record for a specific room.
 *
 * Call this when:
 *   • The client is kicked (so the stored token cannot be used to sneak back).
 *   • The room is cancelled or the game ends (optional clean-up).
 */
export function clearRoomMembership(roomCode: string): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(storageKey(roomCode));
  }
}

/**
 * Remove ALL room membership records stored by this browser
 * (e.g. on full logout or when the user clears their session).
 *
 * Iterates over all localStorage keys with the `literati_room_` prefix.
 */
export function clearAllRoomMemberships(): void {
  if (typeof window === 'undefined') return;
  const keysToRemove: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key?.startsWith(PREFIX)) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => window.localStorage.removeItem(key));
}
