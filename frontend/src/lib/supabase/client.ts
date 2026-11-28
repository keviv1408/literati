/**
 * Supabase browser client.
 *
 * Use this client in Client Components and browser-side code.
 * It stores the session in cookies (via @supabase/ssr) so the session
 * is available on both the client and the server without a round-trip.
 *
 * Singleton pattern — one instance per browser tab.
 */

import { supabaseUrl, supabaseAnonKey } from './config';
import { createBrowserClient } from '@supabase/ssr';

let _client: ReturnType<typeof createBrowserClient> | null = null;

export function getSupabaseBrowserClient() {
  if (_client) return _client;

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
