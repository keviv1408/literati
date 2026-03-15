const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Service-role client (bypasses RLS; used for admin operations)
// ---------------------------------------------------------------------------

let supabaseClient = null;

/**
 * Returns a Supabase client using the service-role key for server-side operations.
 * Lazily initialised so that tests can override env vars before first use.
 */
function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables'
    );
  }

  supabaseClient = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return supabaseClient;
}

/** Reset for testing — allows tests to inject a mock client. */
function _setSupabaseClient(client) {
  supabaseClient = client;
}

// ---------------------------------------------------------------------------
// Anon-key client (used for user-facing auth flows: sign-in, refresh, etc.)
// ---------------------------------------------------------------------------

let authClient = null;

/**
 * Returns a Supabase client using the anon/public key.
 *
 * This client is used for user-facing authentication operations
 * (signInWithPassword, refreshSession) so that the returned JWT represents a
 * real user session — not the service-role identity.
 *
 * Lazily initialised; tests may inject a mock via _setAuthClient().
 */
function getAuthClient() {
  if (authClient) return authClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables'
    );
  }

  authClient = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return authClient;
}

/** Reset for testing — allows tests to inject a mock anon-key client. */
function _setAuthClient(client) {
  authClient = client;
}

module.exports = {
  getSupabaseClient,
  _setSupabaseClient,
  getAuthClient,
  _setAuthClient,
};
