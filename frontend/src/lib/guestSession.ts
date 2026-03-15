/**
 * Guest session persistence utilities.
 * Guest sessions are stored in localStorage so the display name
 * survives page refreshes within the same browser session.
 */

import type { GuestSession } from '@/types/user';

const STORAGE_KEY = 'literati_guest_session';

/** Generate a simple random session ID (no external dependency needed) */
function generateSessionId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function loadGuestSession(): GuestSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GuestSession;
    // Basic shape validation
    if (
      parsed.type === 'guest' &&
      typeof parsed.displayName === 'string' &&
      typeof parsed.sessionId === 'string'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveGuestSession(displayName: string): GuestSession {
  const session: GuestSession = {
    type: 'guest',
    displayName: displayName.trim(),
    sessionId: generateSessionId(),
    createdAt: Date.now(),
  };
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }
  return session;
}

export function clearGuestSession(): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}
