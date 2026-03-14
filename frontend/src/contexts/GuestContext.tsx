'use client';

/**
 * GuestContext — provides guest session state throughout the app.
 *
 * Consumers can:
 *  - Read the current guest session (null if not set)
 *  - Set a guest display name (persists to localStorage)
 *  - Clear the guest session
 *  - Open the name-entry modal programmatically
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import type { GuestSession } from '@/types/user';
import {
  clearGuestSession,
  loadGuestSession,
  saveGuestSession,
} from '@/lib/guestSession';

interface GuestContextValue {
  /** Current guest session, or null if the user hasn't set a name */
  guestSession: GuestSession | null;
  /** Whether the name-entry modal should be shown */
  isModalOpen: boolean;
  /**
   * Set the display name and persist the guest session.
   * Returns the created session.
   */
  setGuestName: (name: string) => GuestSession;
  /** Clear the guest session (e.g. when user logs in) */
  clearGuest: () => void;
  /** Open the guest name modal */
  openModal: () => void;
  /** Close the guest name modal (without setting a name) */
  closeModal: () => void;
  /**
   * Ensure the guest has a display name. If not, opens the modal.
   * Resolves to the session once the user submits, or null if dismissed.
   */
  requireGuestName: () => Promise<GuestSession | null>;
}

const GuestContext = createContext<GuestContextValue | null>(null);

export function GuestProvider({ children }: { children: React.ReactNode }) {
  const [guestSession, setGuestSession] = useState<GuestSession | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  // Pending resolvers for requireGuestName()
  const [pendingResolvers, setPendingResolvers] = useState<
    Array<(s: GuestSession | null) => void>
  >([]);

  // Hydrate from localStorage on mount
  useEffect(() => {
    const existing = loadGuestSession();
    if (existing) {
      setGuestSession(existing);
    }
  }, []);

  const setGuestName = useCallback((name: string): GuestSession => {
    const session = saveGuestSession(name);
    setGuestSession(session);
    setIsModalOpen(false);
    // Resolve any pending promises
    setPendingResolvers((prev) => {
      prev.forEach((resolve) => resolve(session));
      return [];
    });
    return session;
  }, []);

  const clearGuest = useCallback(() => {
    clearGuestSession();
    setGuestSession(null);
    // Reject pending promises
    setPendingResolvers((prev) => {
      prev.forEach((resolve) => resolve(null));
      return [];
    });
  }, []);

  const openModal = useCallback(() => {
    setIsModalOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    setIsModalOpen(false);
    // Reject pending promises
    setPendingResolvers((prev) => {
      prev.forEach((resolve) => resolve(null));
      return [];
    });
  }, []);

  const requireGuestName = useCallback((): Promise<GuestSession | null> => {
    // If already have a session, resolve immediately
    if (guestSession) {
      return Promise.resolve(guestSession);
    }
    // Otherwise open modal and return a promise that resolves when submitted
    setIsModalOpen(true);
    return new Promise<GuestSession | null>((resolve) => {
      setPendingResolvers((prev) => [...prev, resolve]);
    });
  }, [guestSession]);

  return (
    <GuestContext.Provider
      value={{
        guestSession,
        isModalOpen,
        setGuestName,
        clearGuest,
        openModal,
        closeModal,
        requireGuestName,
      }}
    >
      {children}
    </GuestContext.Provider>
  );
}

export function useGuest(): GuestContextValue {
  const ctx = useContext(GuestContext);
  if (!ctx) {
    throw new Error('useGuest must be used within a GuestProvider');
  }
  return ctx;
}
