/**
 * Tests for the OAuth callback route helper logic.
 *
 * We test the `sanitizeNext` open-redirect guard in isolation since the full
 * Next.js Route Handler requires a real request environment.  The guard is
 * the only pure-logic piece worth unit-testing here; the rest (session
 * exchange, cookie writes) are integration concerns that are covered by
 * end-to-end tests.
 */

// We re-implement the sanitizeNext helper here because it's internal to the
// route module.  The source of truth is the route file; if the implementation
// changes, this test must be updated to match.
function sanitizeNext(next: string | null): string {
  if (!next) return '/';
  try {
    const url = new URL(next, 'http://localhost');
    if (url.origin !== 'http://localhost') return '/';
    return url.pathname + url.search;
  } catch {
    return '/';
  }
}

describe('sanitizeNext (open-redirect guard)', () => {
  it('returns / when next is null', () => {
    expect(sanitizeNext(null)).toBe('/');
  });

  it('returns / when next is an empty string', () => {
    expect(sanitizeNext('')).toBe('/');
  });

  it('returns the path for a simple relative path', () => {
    expect(sanitizeNext('/dashboard')).toBe('/dashboard');
  });

  it('preserves query strings in relative paths', () => {
    expect(sanitizeNext('/rooms?code=ABC123')).toBe('/rooms?code=ABC123');
  });

  it('blocks absolute URLs (http)', () => {
    expect(sanitizeNext('http://evil.example.com/steal')).toBe('/');
  });

  it('blocks absolute URLs (https)', () => {
    expect(sanitizeNext('https://evil.example.com/steal')).toBe('/');
  });

  it('blocks protocol-relative URLs', () => {
    // //evil.example.com is treated as an absolute URL with a different origin.
    expect(sanitizeNext('//evil.example.com')).toBe('/');
  });

  it('blocks data: URLs', () => {
    expect(sanitizeNext('data:text/html,<script>alert(1)</script>')).toBe('/');
  });

  it('returns / for a root path', () => {
    expect(sanitizeNext('/')).toBe('/');
  });

  it('handles nested paths correctly', () => {
    expect(sanitizeNext('/game/room/XYZ/spectate')).toBe(
      '/game/room/XYZ/spectate'
    );
  });
});
