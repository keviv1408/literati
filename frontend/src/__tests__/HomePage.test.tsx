/**
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react';

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

describe('Home entry points', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('offers Private Room as the only way to play', () => {
    render(<Home />);
    expect(screen.getByRole('button', { name: /Private Room/ })).toBeInTheDocument();
    expect(screen.queryByText(/Find Online Match/)).toBeNull();
    expect(screen.queryByText(/Spectate Live Games/)).toBeNull();
    expect(screen.queryByText('Spectators')).toBeNull();
    expect(screen.getByText('Smart Bots')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Begin Interactive Tutorial/ })).toHaveAttribute('href', '/tutorial');
  });
});
