'use client';

/**
 * useAuth — convenience hook for the authenticated user session.
 *
 * Re-exports the AuthContext hook with a cleaner import path, and adds
 * derived helpers for common UI patterns.
 *
 * Usage:
 *   const { isSignedIn, user, signInWithGoogle, signOut, loading } = useAuth();
 */

export { useAuth } from '@/contexts/AuthContext';
export type { AuthContextValue } from '@/contexts/AuthContext';
