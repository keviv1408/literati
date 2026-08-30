/**
 * @jest-environment jsdom
 */

import type { CreateRoomPayload } from '@/types/room';

const mockGetCachedToken = jest.fn<string | null, [string]>();
const mockSaveToken = jest.fn<void, [string, number, string, string | undefined]>();
const mockClearToken = jest.fn<void, []>();

jest.mock('@/lib/backendSession', () => ({
  getCachedToken: (...args: [string]) => mockGetCachedToken(...args),
  saveToken: (...args: [string, number, string, string | undefined]) => mockSaveToken(...args),
  clearToken: () => mockClearToken(),
}));

import { ApiError, createRoom, getGuestBearerToken } from '@/lib/api';

const payload: CreateRoomPayload = {
  playerCount: 6,
  cardRemovalVariant: 'remove_7s',
};

describe('createRoom', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockGetCachedToken.mockReset();
    mockSaveToken.mockReset();
    mockClearToken.mockReset();
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('retries once with a fresh guest token after a 401 from a stale cached token', async () => {
    mockGetCachedToken
      .mockReturnValueOnce('stale-guest-token')
      .mockReturnValueOnce(null);

    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Unauthorized' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          token: 'fresh-guest-token',
          session: {
            sessionId: 'guest-session-1',
            displayName: 'Viv',
            avatarId: 'avatar-1',
            isGuest: true,
            expiresAt: 1_900_000_000_000,
          },
          validAvatarIds: [],
          sessionTtlMs: 86_400_000,
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          room: {
            id: 'room-1',
            code: 'ABC123',
            invite_code: 'invite-code',
            spectator_token: 'spectator-token',
            host_user_id: null,
            player_count: 6,
            card_removal_variant: 'remove_7s',
            status: 'waiting',
            created_at: '2026-03-16T00:00:00.000Z',
            updated_at: '2026-03-16T00:00:00.000Z',
          },
        }),
      } as Response);

    const result = await createRoom(payload, 'Viv');

    expect(result.room.code).toBe('ABC123');
    expect(mockClearToken).toHaveBeenCalledTimes(1);
    expect(mockSaveToken).toHaveBeenCalledWith(
      'fresh-guest-token',
      1_900_000_000_000,
      'Viv',
      undefined,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/api/rooms'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer stale-guest-token',
        }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/api/auth/guest'),
      expect.objectContaining({
        method: 'POST',
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('/api/rooms'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer fresh-guest-token',
        }),
      })
    );
  });

  it('does not retry registered-user room creation after a 401', async () => {
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized' }),
    } as Response);

    await expect(
      createRoom(payload, 'Viv', 'registered-user-jwt')
    ).rejects.toEqual(new ApiError(401, 'Unauthorized', { error: 'Unauthorized' }));

    expect(mockClearToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('getGuestBearerToken', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockGetCachedToken.mockReset();
    mockSaveToken.mockReset();
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  const guestResponse = (token: string) =>
    ({
      ok: true,
      status: 201,
      json: async () => ({
        token,
        session: {
          sessionId: 'guest-session-1',
          displayName: 'Viv',
          avatarId: 'avatar-1',
          isGuest: true,
          expiresAt: 1_900_000_000_000,
        },
        validAvatarIds: ['avatar-1'],
        sessionTtlMs: 86_400_000,
      }),
    }) as Response;

  it('shares one registration between concurrent callers', async () => {
    mockGetCachedToken.mockReturnValue(null);
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValue(guestResponse('guest-token-1'));

    const [a, b] = await Promise.all([
      getGuestBearerToken('Viv', 'rk'),
      getGuestBearerToken('Viv', 'rk'),
    ]);

    expect(a).toBe('guest-token-1');
    expect(b).toBe('guest-token-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockSaveToken).toHaveBeenCalledTimes(1);
  });

  it('registers again once the previous call has settled', async () => {
    mockGetCachedToken.mockReturnValue(null);
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock
      .mockResolvedValueOnce(guestResponse('guest-token-1'))
      .mockResolvedValueOnce(guestResponse('guest-token-2'));

    await expect(getGuestBearerToken('Viv', 'rk')).resolves.toBe('guest-token-1');
    await expect(getGuestBearerToken('Viv', 'rk')).resolves.toBe('guest-token-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not share a registration across different identities', async () => {
    mockGetCachedToken.mockReturnValue(null);
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock
      .mockResolvedValueOnce(guestResponse('guest-token-viv'))
      .mockResolvedValueOnce(guestResponse('guest-token-ada'));

    const [viv, ada] = await Promise.all([
      getGuestBearerToken('Viv', 'rk'),
      getGuestBearerToken('Ada', 'rk'),
    ]);

    expect(viv).toBe('guest-token-viv');
    expect(ada).toBe('guest-token-ada');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
