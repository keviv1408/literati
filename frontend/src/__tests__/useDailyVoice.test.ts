/**
 * @jest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';

const mockJoinRoomVoice = jest.fn();

jest.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  joinRoomVoice: (...args: unknown[]) => mockJoinRoomVoice(...args),
}));

jest.mock('@/contexts/GuestContext', () => ({
  useGuest: () => ({ guestSession: { displayName: 'Viv', sessionId: 'recovery-key-1' } }),
}));

jest.mock('@daily-co/daily-js', () => ({
  __esModule: true,
  default: {
    createCallObject: () => ({
      on: jest.fn(),
      join: jest.fn().mockResolvedValue(undefined),
      setLocalAudio: jest.fn(),
      participants: () => ({}),
    }),
  },
}));

import { useDailyVoice } from '@/hooks/useDailyVoice';

beforeEach(() => {
  mockJoinRoomVoice.mockReset();
  mockJoinRoomVoice.mockResolvedValue({
    roomName: 'room-abc123',
    roomUrl: 'https://example.daily.co/room-abc123',
    meetingToken: 'meeting-token',
    expiresAt: '2026-11-26T01:00:00.000Z',
  });
});

async function _joinAs(isGuest: boolean) {
  const { result } = renderHook(() =>
    useDailyVoice({ roomCode: 'ABC123', bearerToken: 'bearer-token', isGuest }),
  );
  await act(() => result.current.joinVoice());
}

describe('useDailyVoice', () => {
  it('passes the guest identity for a guest session', async () => {
    await _joinAs(true);

    expect(mockJoinRoomVoice).toHaveBeenCalledWith('ABC123', 'bearer-token', {
      displayName: 'Viv',
      recoveryKey: 'recovery-key-1',
    });
  });

  it('passes no guest identity for a registered session, even with a guest session stored', async () => {
    await _joinAs(false);

    expect(mockJoinRoomVoice).toHaveBeenCalledWith('ABC123', 'bearer-token', undefined);
  });
});
