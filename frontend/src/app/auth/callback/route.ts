/**
 * OAuth Callback Route Handler.
 *
 * Supabase redirects here after the user completes the Google OAuth flow.
 * URL shape: /auth/callback?code=<auth_code>&next=<redirect_path>
 *
 * This handler:
 *   1. Exchanges the one-time authorization code for a Supabase session.
 *   2. Stores the access + refresh tokens in HttpOnly cookies.
 *   3. Upserts the user profile row in `user_profiles` so the application
 *      always has a display name for the user (first sign-in only; existing
 *      rows are left untouched to preserve user-customised settings).
 *   4. Redirects the browser to `next` (defaults to '/') on success, or to
 *      '/auth/error' with an error code on failure.
 *
 * Security notes:
 *   - The authorization code is single-use; exchangeCodeForSession() consumes it.
 *   - We validate `next` to prevent open-redirect attacks (only relative paths).
 *   - All cookie options are set by @supabase/ssr with Secure + SameSite defaults.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/** Only allow relative redirects to prevent open-redirect attacks. */
function sanitizeNext(next: string | null): string {
  if (!next) return '/';
  try {
    // Reject anything that resolves to an absolute URL
    const url = new URL(next, 'http://localhost');
    if (url.origin !== 'http://localhost') return '/';
    return url.pathname + url.search;
  } catch {
    return '/';
  }
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = sanitizeNext(searchParams.get('next'));

  // If there's no code something went wrong upstream — redirect to error page.
  if (!code) {
    return NextResponse.redirect(
      `${origin}/auth/error?reason=missing_code`,
      { status: 302 }
    );
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.redirect(
      `${origin}/auth/error?reason=misconfigured`,
      { status: 302 }
    );
  }

  // We need to mutate the response cookies, so we build the response first
  // and pass the cookie helpers to the Supabase client.
  const response = NextResponse.redirect(`${origin}${next}`, { status: 302 });

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  // Exchange the authorization code for a session.
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.session) {
    const reason = encodeURIComponent(error?.message ?? 'exchange_failed');
    return NextResponse.redirect(
      `${origin}/auth/error?reason=${reason}`,
      { status: 302 }
    );
  }

  // ── Upsert the user's profile ──────────────────────────────────────────────
  //
  // On first OAuth sign-in we insert a `user_profiles` row so the app always
  // has a display name for the user. Google's full_name / email prefix is used
  // as the initial display name; the user can change it later.
  //
  // ignoreDuplicates: true means we skip the write if a row already exists,
  // preserving any display name / avatar the user has manually set.
  //
  // This is a best-effort operation — a failure here must not block sign-in.
  try {
    const { user } = data.session;
    const meta = user.user_metadata ?? {};

    // Derive a sensible default display name from Google metadata.
    // Truncate to 20 chars to satisfy the VARCHAR(20) constraint.
    const rawName: string =
      meta.full_name ||
      meta.name ||
      (user.email ? user.email.split('@')[0] : 'Player');
    const displayName = rawName.slice(0, 20).trim() || 'Player';

    await supabase.from('user_profiles').upsert(
      {
        id: user.id,
        display_name: displayName,
        // Use the default avatar ID; the user can customise this in their profile.
        avatar_id: 'avatar-1',
      },
      {
        onConflict: 'id',
        // Don't overwrite the profile if it already exists (preserves any
        // display name / avatar the user has previously customised).
        ignoreDuplicates: true,
      }
    );
  } catch {
    // Profile upsert failure is non-fatal; the user is still signed in.
  }

  return response;
}
