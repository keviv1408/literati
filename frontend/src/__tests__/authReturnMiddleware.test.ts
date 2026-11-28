/** @jest-environment node */
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

describe('hosted sign-in', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['code=sample', 'error=access_denied'])('handles a provider return to the site root (%s)', query => {
    const result = middleware(new NextRequest('https://cards.example/?' + query));
    expect(result.headers.get('x-middleware-rewrite')).toBe('https://cards.example/auth/callback?' + query);
  });

  it('forwards preview API requests with their bearer token and keeps session cookies on the frontend', () => {
    jest.replaceProperty(process, 'env', { ...process.env, NEXT_PUBLIC_VERCEL_ENV: 'preview', NEXT_PUBLIC_API_URL: 'https://api.example' });
    const result = middleware(new NextRequest('https://preview.example/api/rooms/return', {
      method: 'POST',
      headers: { authorization: 'Bearer test-player', 'content-type': 'application/json', cookie: 'session=test-cookie' },
    }));
    expect(result.headers.get('x-middleware-rewrite')).toBe('https://api.example/api/rooms/return');
    expect(result.headers.get('x-middleware-request-authorization')).toBe('Bearer test-player');
    expect(result.headers.get('x-middleware-override-headers')?.split(',')).not.toContain('cookie');
  });
});
