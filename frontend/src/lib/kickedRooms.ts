/**
 * Kicked-rooms persistence.
 *
 * When the server sends a `player-kicked` event targeting the current
 * client, the affected room code is persisted here so that:
 *   1. The dismissal notice is immediately shown.
 *   2. If the player navigates away and back (or refreshes), they are
 *      still blocked from re-entering the same room.
 *
 * Data lives in localStorage under the key `literati_kicked_rooms`.
 * The value is a JSON array of upper-cased 6-character room codes.
 */

const STORAGE_KEY = 'literati_kicked_rooms';

// ── Internal helpers ──────────────────────────────────────────────────────────

function load(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((c) => typeof c === 'string')) {
      return parsed as string[];
    }
    return [];
  } catch {
    return [];
  }
}

function persist(codes: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(codes));
  } catch {
    // Storage quota or private-browsing — ignore.
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return the list of room codes this browser session has been kicked from.
 * All codes are upper-cased for consistent comparison.
 */
export function getKickedRooms(): string[] {
  return load();
}

/**
 * Returns true if the current browser has been kicked from `roomCode`.
 * Case-insensitive.
 */
export function isKickedFromRoom(roomCode: string): boolean {
  return load().includes(roomCode.toUpperCase());
}

/**
 * Persist the given room code so the user cannot re-enter it.
 * Idempotent — calling with the same code multiple times is safe.
 */
export function addKickedRoom(roomCode: string): void {
  const code = roomCode.toUpperCase();
  const existing = load();
  if (!existing.includes(code)) {
    persist([...existing, code]);
  }
}

/**
 * Remove a room code from the kicked list.
 * Exposed for testing and administrative purposes only; the app itself
 * never calls this — once kicked the block is permanent within the
 * browser session.
 */
export function removeKickedRoom(roomCode: string): void {
  const code = roomCode.toUpperCase();
  persist(load().filter((c) => c !== code));
}

/**
 * Clear all kicked-room records (e.g. when a user logs out or clears data).
 */
export function clearKickedRooms(): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}
