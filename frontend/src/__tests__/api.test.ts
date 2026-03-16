/**
 * @jest-environment jsdom
 */

import type { CreateRoomPayload } from '@/types/room';

const mockGetCachedToken = jest.fn<string | null, [string]>();
const mockSaveToken = jest.fn<void, [string, number, string]>();
const mockClearToken = jest.fn<void, []>();

jest.mock('@/lib/backendSession', () => ({
  getCachedToken: (...args: [string]) => mockGetCachedToken(...args),
  saveToken: (...args: [string, number, string]) => mockSaveToken(...args),
  clearToken: () => mockClearToken(),
}));

import { ApiError, createRoom } from '@/lib/api';

const payload: CreateRoomPayload = {
  playerCount: 6,
  cardRemovalVariant: 'remove_7s',
  inferenceMode: true,
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
      'Viv'
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
