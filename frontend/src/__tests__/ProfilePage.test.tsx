/**
 * @jest-environment jsdom
 *
 * (AC 50) — Public profile page at /profile/[username]
 *
 * Tests that the /profile/[username] page:
 * - Fetches profile data via getProfileByUsername
 * - Renders all required stats:
 * total games (gamesCompleted), win rate, total declarations, declaration success rate
 * - Shows appropriate loading and error states
 * - Shows a "not found" message on 404
 */

import React, { Suspense, act } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import ProfilePage from '@/app/profile/[username]/page';
import { ApiError } from '@/lib/api';

// ── Mock next/navigation ──────────────────────────────────────────────────────
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// ── Mock api.ts ───────────────────────────────────────────────────────────────
const mockGetProfileByUsername = jest.fn();
jest.mock('@/lib/api', () => ({
  getProfileByUsername: (...args: unknown[]) => mockGetProfileByUsername(...args),
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildProfile(overrides = {}) {
  return {
    userId: 'uuid-test',
    displayName: 'Alice',
    avatarId: null,
    wins: 10,
    losses: 5,
    gamesCompleted: 15,
    gamesPlayed: 15,
    declarationsCorrect: 6,
    declarationsIncorrect: 2,
    declarationsAttempted: 8,
    winRate: 0.667,
    ...overrides,
  };
}

// Wrap params in a Promise to match the page contract.
async function renderProfile(username = 'Alice') {
  const params = Promise.resolve({ username });
  await act(async () => {
    render(
      <Suspense fallback={<div data-testid="suspense-fallback" />}>
        <ProfilePage params={params} />
      </Suspense>
    );
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProfilePage — /profile/[username]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Loading state ──────────────────────────────────────────────────────────

  it('1. renders a loading spinner while fetching', async () => {
    // Never resolves during this test
    mockGetProfileByUsername.mockReturnValue(new Promise(() => {}));
    await renderProfile('Alice');

    // Spinner should be present
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByLabelText('Loading profile')).toBeTruthy();
  });

  // ── 404 / not-found state ─────────────────────────────────────────────────

  it('2. shows "Profile Not Found" when API returns 404', async () => {
    mockGetProfileByUsername.mockRejectedValue(new ApiError(404, 'Profile not found'));
    await renderProfile('nobody');

    await waitFor(() =>
      expect(screen.getByText('Profile Not Found')).toBeTruthy()
    );
    // Should show the username in the not-found message
    expect(screen.getByText(/nobody/i)).toBeTruthy();
  });

  // ── Error state ────────────────────────────────────────────────────────────

  it('3. shows error message for non-404 API errors', async () => {
    mockGetProfileByUsername.mockRejectedValue(
      new ApiError(500, 'Internal Server Error')
    );
    await renderProfile('Alice');

    await waitFor(() => {
      const alerts = screen.getAllByRole('alert');
      expect(alerts.length).toBeGreaterThan(0);
    });
  });

  it('4. shows generic error for unexpected errors', async () => {
    mockGetProfileByUsername.mockRejectedValue(new Error('Network failed'));
    await renderProfile('Alice');

    await waitFor(() => {
      const alerts = screen.getAllByRole('alert');
      expect(alerts.length).toBeGreaterThan(0);
    });
    // Generic fallback message
    expect(screen.getByText(/Error loading profile/i)).toBeTruthy();
  });

  // ── Successful render ──────────────────────────────────────────────────────

  it('5. renders the player display name as heading', async () => {
    mockGetProfileByUsername.mockResolvedValue({ profile: buildProfile() });
    await renderProfile('Alice');

    await waitFor(() => expect(screen.getByText('Alice')).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'Alice' })).toBeTruthy();
  });

  it('6. renders initials avatar when avatarId is null', async () => {
    mockGetProfileByUsername.mockResolvedValue({
      profile: buildProfile({ avatarId: null, displayName: 'Alice' }),
    });
    await renderProfile('Alice');

    await waitFor(() => expect(screen.getByText('Alice')).toBeTruthy());
    expect(screen.getByText('A')).toBeTruthy();
  });

  it('7. renders Games Completed stat', async () => {
    mockGetProfileByUsername.mockResolvedValue({
      profile: buildProfile({ gamesCompleted: 15 }),
    });
    await renderProfile('Alice');

    await waitFor(() => expect(screen.getByText('Games Completed')).toBeTruthy());
    expect(screen.getByText('15')).toBeTruthy();
  });

  it('8. renders Win Rate as percentage', async () => {
    // winRate 0.667 → "66.7%"
    mockGetProfileByUsername.mockResolvedValue({
      profile: buildProfile({ winRate: 0.667 }),
    });
    await renderProfile('Alice');

    await waitFor(() => expect(screen.getByText('Win Rate')).toBeTruthy());
    expect(screen.getByText('66.7%')).toBeTruthy();
  });

  it('9. renders Total Declarations (declarationsAttempted)', async () => {
    mockGetProfileByUsername.mockResolvedValue({
      profile: buildProfile({ declarationsAttempted: 8 }),
    });
    await renderProfile('Alice');

    await waitFor(() =>
      expect(screen.getByText('Total Declarations')).toBeTruthy()
    );
    // Value 8 should appear somewhere in the card area
    const eights = screen.getAllByText('8');
    expect(eights.length).toBeGreaterThan(0);
  });

  it('10. renders Declaration Success Rate as percentage', async () => {
    // 6 correct out of 8 attempts = 75%
    mockGetProfileByUsername.mockResolvedValue({
      profile: buildProfile({
        declarationsCorrect: 6,
        declarationsAttempted: 8,
      }),
    });
    await renderProfile('Alice');

    await waitFor(() =>
      expect(screen.getByText('Declaration Success Rate')).toBeTruthy()
    );
    expect(screen.getByText('75%')).toBeTruthy();
  });

  it('11. shows em-dash (—) for Declaration Success Rate when declarationsAttempted is 0', async () => {
    mockGetProfileByUsername.mockResolvedValue({
      profile: buildProfile({
        declarationsCorrect: 0,
        declarationsIncorrect: 0,
        declarationsAttempted: 0,
      }),
    });
    await renderProfile('Alice');

    await waitFor(() =>
      expect(screen.getByText('Declaration Success Rate')).toBeTruthy()
    );
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('12. shows 100% success rate when all declarations are correct', async () => {
    mockGetProfileByUsername.mockResolvedValue({
      profile: buildProfile({
        declarationsCorrect: 4,
        declarationsIncorrect: 0,
        declarationsAttempted: 4,
      }),
    });
    await renderProfile('Alice');

    await waitFor(() =>
      expect(screen.getByText('Declaration Success Rate')).toBeTruthy()
    );
    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('13. renders all 8 stat cards when profile loads', async () => {
    mockGetProfileByUsername.mockResolvedValue({ profile: buildProfile() });
    await renderProfile('Alice');

    await waitFor(() => expect(screen.getByText('Alice')).toBeTruthy());
    expect(screen.getByText('Games Completed')).toBeTruthy();
    expect(screen.getByText('Win Rate')).toBeTruthy();
    expect(screen.getByText('Wins')).toBeTruthy();
    expect(screen.getByText('Losses')).toBeTruthy();
    expect(screen.getByText('Total Declarations')).toBeTruthy();
    expect(screen.getByText('Declaration Success Rate')).toBeTruthy();
    expect(screen.getByText('Declarations Correct')).toBeTruthy();
    expect(screen.getByText('Declarations Incorrect')).toBeTruthy();
  });

  it('14. calls getProfileByUsername with the username param', async () => {
    mockGetProfileByUsername.mockResolvedValue({ profile: buildProfile() });
    await renderProfile('TestPlayer');

    await waitFor(() =>
      expect(mockGetProfileByUsername).toHaveBeenCalledWith('TestPlayer')
    );
  });

  it('15. renders profile-page test id for layout verification', async () => {
    mockGetProfileByUsername.mockResolvedValue({ profile: buildProfile() });
    await renderProfile('Alice');

    await waitFor(() => expect(screen.getByTestId('profile-page')).toBeTruthy());
  });
});
