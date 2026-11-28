/**
 * Supabase server client.
 *
 * Use this in Server Components, Route Handlers, and Middleware.
 * Reads and writes the session from/to cookies so the server always has
 * the same session state as the browser.
 *
 * Must be called inside an async Server Component or Route Handler so that
 * Next.js `cookies()` is available.
 */

import { createServerClient } from '@supabase/ssr';
import { supabaseUrl, supabaseAnonKey } from './config';
import { cookies } from 'next/headers';

export async function getSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options);
        }
      },
    },
  });
}
