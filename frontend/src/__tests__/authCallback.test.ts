/** @jest-environment node */
import { GET } from '@/app/auth/callback/route';

const mockExchange = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServerClient: async () => ({ auth: { exchangeCodeForSession: mockExchange } }),
}));

describe('Google callback', () => {
  beforeEach(() => mockExchange.mockReset());

  it('exchanges the code and redirects to the app on success', async () => {
    mockExchange.mockResolvedValue({ error: null });
    const result = await GET(new Request('https://cards.example/auth/callback?code=sample'));
    expect(mockExchange).toHaveBeenCalledWith('sample');
    expect(result.headers.get('location')).toBe('/');
    expect(result.headers.get('cache-control')).toContain('no-store');
  });

  it.each(['', '?error=access_denied', '?code=used'])('offers a retry after an incomplete callback %s', async query => {
    mockExchange.mockResolvedValue({ error: { message: 'Code already used' } });
    const result = await GET(new Request('https://cards.example/auth/callback' + query));
    expect(result.headers.get('location')).toBe('/?signin=failed');
  });
});
