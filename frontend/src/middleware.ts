/**
 * Next.js Middleware — passthrough.
 *
 * Previously handled Supabase session refresh for registered users.
 * Now guest-only: no token refresh needed. Kept as a no-op so the
 * matcher config still excludes static assets from middleware processing.
 */

import { NextResponse } from 'next/server';

export function middleware() {
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
