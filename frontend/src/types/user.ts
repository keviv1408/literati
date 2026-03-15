/**
 * Represents the user identity — either a Supabase-authenticated user
 * or an unauthenticated guest session.
 */

export interface GuestSession {
  type: 'guest';
  /** Ephemeral display name chosen by the user */
  displayName: string;
  /** Random ID generated client-side for this browser session */
  sessionId: string;
  /** Unix timestamp (ms) when the guest session was created */
  createdAt: number;
}

export interface AuthedUser {
  type: 'authed';
  id: string;
  displayName: string;
  email: string;
  avatarUrl?: string;
}

export type UserIdentity = GuestSession | AuthedUser;

// Validation constants
export const DISPLAY_NAME_MIN_LENGTH = 1;
export const DISPLAY_NAME_MAX_LENGTH = 20;
export const DISPLAY_NAME_PATTERN = /^[a-zA-Z0-9 _\-'.]+$/;

export function validateDisplayName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < DISPLAY_NAME_MIN_LENGTH) {
    return 'Display name cannot be empty.';
  }
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    return `Display name must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`;
  }
  if (!DISPLAY_NAME_PATTERN.test(trimmed)) {
    return "Only letters, numbers, spaces, and _ - ' . are allowed.";
  }
  return null;
}
