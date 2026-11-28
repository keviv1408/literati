/**
 * @jest-environment jsdom
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockPush = jest.fn();
const mockEnsureGuestName = jest.fn();
const mockUseAccount = jest.fn();
const mockSocket = jest.fn();

jest.mock('@/contexts/AccountContext', () => ({ useAccount: () => mockUseAccount() }));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('@/hooks/useGuestSession', () => ({
  useGuestSession: () => ({
    guestSession: { displayName: 'Viv', sessionId: 'guest-session-1' },
    ensureGuestName: mockEnsureGuestName,
  }),
}));

jest.mock('@/hooks/useMatchmakingSocket', () => ({
  useMatchmakingSocket: (options: unknown) => mockSocket(options),
}));

const mockGetGuestBearerToken = jest.fn();
const mockGetMatchmakingQueues = jest.fn();
const mockGetLiveGames = jest.fn();

jest.mock('@/lib/api', () => ({
  getGuestBearerToken: (...args: unknown[]) =>
    mockGetGuestBearerToken(...(args as [string])),
  getMatchmakingQueues: () => mockGetMatchmakingQueues(),
  getLiveGames: () => mockGetLiveGames(),
}));

import MatchmakingPage from '@/app/matchmaking/page';

describe('MatchmakingPage', () => {
  beforeEach(() => {
    mockUseAccount.mockReturnValue({ session: null, loading: false, displayName: null });
    mockSocket.mockImplementation(({ sessionId }) => ({
      status: sessionId ? 'in-queue' : 'idle',
      queueSize: 0,
      leaveQueue: jest.fn(),
    }));
    mockPush.mockReset();
    mockEnsureGuestName.mockReset();
    mockGetGuestBearerToken.mockReset();
    mockGetMatchmakingQueues.mockReset();
    mockGetLiveGames.mockReset();

    mockGetMatchmakingQueues.mockResolvedValue({
      queues: [],
      totalWaiting: 4,
    });
    mockGetLiveGames.mockResolvedValue({
      total: 2,
      games: [
        {
          roomCode: 'ABC123',
          playerCount: 6,
          currentPlayers: 6,
          cardVariant: 'remove_7s',
          scores: { team1: 0, team2: 0 },
          status: 'in_progress',
          createdAt: Date.now(),
          startedAt: Date.now(),
          elapsedMs: 1_000,
        },
        {
          roomCode: 'XYZ789',
          playerCount: 8,
          currentPlayers: 5,
          cardVariant: 'remove_2s',
          scores: { team1: 0, team2: 0 },
          status: 'waiting',
          createdAt: Date.now(),
          startedAt: null,
          elapsedMs: 1_000,
        },
      ],
    });
  });

  it('retains the queue token through account refresh and uses the new one on the next search', async () => {
    const account = (token: string) => ({ session: { user: { id: 'player' }, access_token: token }, displayName: 'Player', loading: false });
    mockUseAccount.mockReturnValue(account('original'));
    const { rerender } = render(<MatchmakingPage />);
    fireEvent.click(screen.getByRole('button', { name: /Find Game/ }));
    await screen.findByRole('button', { name: /Cancel/ });
    expect(mockSocket).toHaveBeenLastCalledWith(expect.objectContaining({ bearerToken: 'original' }));
    mockUseAccount.mockReturnValue(account('refreshed'));
    rerender(<MatchmakingPage />);
    expect(mockSocket).toHaveBeenLastCalledWith(expect.objectContaining({ bearerToken: 'original' }));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    fireEvent.click(screen.getByRole('button', { name: /Find Game/ }));
    await waitFor(() => expect(mockSocket).toHaveBeenLastCalledWith(expect.objectContaining({ bearerToken: 'refreshed' })));
  });

  it('shows a public activity summary using queue + live-game counts', async () => {
    render(<MatchmakingPage />);

    await waitFor(() =>
      expect(screen.getByTestId('matchmaking-activity-summary')).toBeInTheDocument()
    );

    expect(screen.getByText('15 players online now')).toBeInTheDocument();
    expect(
      screen.getByText('4 waiting for a public match · 11 in 2 live public games')
    ).toBeInTheDocument();
  });
});
