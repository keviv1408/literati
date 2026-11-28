import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname === '/' && ['code', 'error', 'error_code'].some(key => request.nextUrl.searchParams.has(key))) {
    const callback = request.nextUrl.clone();
    callback.pathname = '/auth/callback';
    return NextResponse.rewrite(callback);
  }
  const backend = process.env.NEXT_PUBLIC_API_URL;
  if (process.env.NEXT_PUBLIC_VERCEL_ENV === 'preview' && backend &&
      (pathname.startsWith('/api/') || pathname === '/health')) {
    // The game API uses bearer tokens. Keep the preview's Supabase cookies on the web host.
    const headers = new Headers();
    for (const name of ['authorization', 'content-type', 'accept']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    return NextResponse.rewrite(new URL(pathname + search, backend), { request: { headers } });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/', '/api/:path*', '/health'],
};
