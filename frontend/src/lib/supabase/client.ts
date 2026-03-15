/**
 * Supabase browser client.
 *
 * Use this client in Client Components and browser-side code.
 * It stores the session in cookies (via @supabase/ssr) so the session
 * is available on both the client and the server without a round-trip.
 *
 * Singleton pattern — one instance per browser tab.
 */

import { createBrowserClient } from '@supabase/ssr';

let _client: ReturnType<typeof createBrowserClient> | null = null;

export function getSupabaseBrowserClient() {
  if (_client) return _client;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://hsjbxavihobponmrysfk.supabase.co';
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzamJ4YXZpaG9icG9ubXJ5c2ZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0MDQ1NzgsImV4cCI6MjA4ODk4MDU3OH0.FbTCGAMz7dJyRyucWei41b5WdZF0P1CG6DDYhrqGH8o';

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY'
    );
  }

  _client = createBrowserClient(supabaseUrl, supabaseAnonKey);
  return _client;
}

/** Alias for convenience in hooks */
export const supabase = {
  get client() {
    return getSupabaseBrowserClient();
  },
};

/** Reset the singleton — used in unit tests */
export function _resetSupabaseClient() {
  _client = null;
}
