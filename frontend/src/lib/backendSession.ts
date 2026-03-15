/**
 * Backend bearer-token persistence.
 *
 * When a guest registers with the backend (POST /api/auth/guest) the server
 * returns an opaque 256-bit bearer token that must accompany every subsequent
 * authenticated API request.  This module stores that token in localStorage
 * alongside the display name it was issued for so we can:
 *   1. Reuse the same token across page refreshes (24 h TTL on the server).
 *   2. Detect display-name changes and re-register when needed.
 */

const STORAGE_KEY = 'literati_backend_token';

/** What we persist about the server-issued guest bearer token. */
interface StoredBackendToken {
  /** The raw opaque token (sent as `Authorization: Bearer <token>`). */
  token: string;
  /** Unix ms — the server-side TTL end; token must be refreshed before this. */
  expiresAt: number;
  /** The display name that was used when this token was issued. */
  displayName: string;
}

// ── Private helpers ──────────────────────────────────────────────────────────

function load(): StoredBackendToken | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredBackendToken;
    if (
      typeof parsed.token === 'string' &&
      typeof parsed.expiresAt === 'number' &&
      typeof parsed.displayName === 'string'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function save(data: StoredBackendToken): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage quota exceeded or private-browsing restriction — ignore.
  }
}

function clear(): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Return a valid cached bearer token for `displayName`, or `null` if none
 * exists (not yet registered, expired, or name mismatch).
 *
 * We refresh 60 s before the server-side expiry to avoid race conditions.
 */
export function getCachedToken(displayName: string): string | null {
  const stored = load();
  if (!stored) return null;
  if (stored.displayName !== displayName) return null;
  const BUFFER_MS = 60_000;
  if (Date.now() + BUFFER_MS >= stored.expiresAt) {
    clear();
    return null;
  }
  return stored.token;
}

/**
 * Persist a backend bearer token after a successful guest registration.
 */
export function saveToken(
  token: string,
  expiresAt: number,
  displayName: string
): void {
  save({ token, expiresAt, displayName });
}

/**
 * Invalidate the stored token (e.g. after a 401 response or when the guest
 * clears their session).
 */
export function clearToken(): void {
  clear();
}
