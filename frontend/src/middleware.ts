/**
 * Next.js Middleware — Session Refresh
 *
 * Intercepts every request and silently refreshes the Supabase session
 * if the access token is about to expire. This keeps users logged in
 * without requiring a full re-authentication.
 *
 * The middleware only reads/writes cookies — it never redirects users
 * or blocks requests. Auth-gating is handled by individual pages.
 *
 * References:
 *   https://supabase.com/docs/guides/auth/server-side/nextjs
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Skip if Supabase is not configured (e.g. CI without env vars).
  if (!supabaseUrl || !supabaseAnonKey) {
    return supabaseResponse;
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Propagate cookie updates to both the outgoing request and response.
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  // Calling getUser() triggers a token refresh if needed.
  // Do NOT remove or call getSession() here — it won't refresh.
  await supabase.auth.getUser();

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     *   - _next/static  (Next.js static files)
     *   - _next/image   (Next.js image optimisation)
     *   - favicon.ico   (favicon)
     *   - public files with extensions (.png, .svg, .ico, etc.)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
