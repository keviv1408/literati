/**
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('@/hooks/useGuestSession', () => ({
  useGuestSession: () => ({
    guestSession: null,
    hasName: false,
    ensureGuestName: jest.fn(),
  }),
}));

jest.mock('@/contexts/GuestContext', () => ({
  useGuest: () => ({ clearGuest: jest.fn() }),
}));

jest.mock('@/lib/api', () => ({ API_URL: 'http://api.test' }));

jest.mock('@/components/CreateRoomModal', () => ({
  __esModule: true,
  default: () => null,
}));

import Home from '@/app/page';

describe('Home wake-up notice', () => {
  const originalFetch = global.fetch;
  let resolveHealth: () => void;

  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = jest.fn(
      () => new Promise<Response>((resolve) => {
        resolveHealth = () => resolve({ ok: true } as Response);
      }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  it('pings /health on mount', () => {
    render(<Home />);
    expect(global.fetch).toHaveBeenCalledWith('http://api.test/health');
  });

  it('shows the notice only once the health ping has been slow', async () => {
    render(<Home />);
    expect(screen.queryByRole('status')).toBeNull();

    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('status')).toHaveTextContent(/waking up the table/i);

    await act(async () => {
      resolveHealth();
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('never shows the notice when the ping answers quickly', async () => {
    render(<Home />);

    await act(async () => {
      resolveHealth();
    });
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
