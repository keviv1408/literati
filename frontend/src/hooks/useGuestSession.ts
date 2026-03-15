'use client';

/**
 * useGuestSession
 *
 * Convenience hook that exposes the guest session and a helper to ensure
 * the user has entered a display name before proceeding (e.g. clicking
 * "Join Game").
 *
 * Usage:
 *   const { guestSession, ensureGuestName } = useGuestSession();
 *
 *   async function handleJoin() {
 *     const session = await ensureGuestName();
 *     if (!session) return; // user dismissed the modal
 *     // proceed with session.displayName / session.sessionId
 *   }
 */

import { useGuest } from '@/contexts/GuestContext';
import type { GuestSession } from '@/types/user';

interface UseGuestSessionReturn {
  /** The current guest session, or null if not yet set */
  guestSession: GuestSession | null;
  /** Whether a display name has been set */
  hasName: boolean;
  /** Open the modal to (re-)enter a display name */
  openGuestModal: () => void;
  /**
   * Ensure the user has a display name.
   * - If already set, resolves immediately.
   * - If not set, opens the modal and waits for the user to submit.
   * - Returns null if the user dismisses the modal.
   */
  ensureGuestName: () => Promise<GuestSession | null>;
}

export function useGuestSession(): UseGuestSessionReturn {
  const { guestSession, openModal, requireGuestName } = useGuest();

  return {
    guestSession,
    hasName: guestSession !== null,
    openGuestModal: openModal,
    ensureGuestName: requireGuestName,
  };
}
