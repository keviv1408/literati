/**
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import Home from '@/app/page';

const mockPush = jest.fn();
const mockEnsureGuestName = jest.fn();
const mockGetReturningRoom = jest.fn();
let mockGuest: { displayName: string; sessionId: string } | null = null;

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

jest.mock('@/hooks/useGuestSession', () => ({
  useGuestSession: () => ({
    guestSession: mockGuest,
    hasName: !!mockGuest,
    ensureGuestName: mockEnsureGuestName,
  }),
}));

jest.mock('@/contexts/GuestContext', () => ({
  useGuest: () => ({ clearGuest: jest.fn() }),
}));

jest.mock('@/lib/api', () => ({ API_URL: 'http://api.test', getReturningRoom: (...args: unknown[]) => mockGetReturningRoom(...args) }));

jest.mock('@/components/CreateRoomModal', () => ({
  __esModule: true,
  default: () => null,
}));

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

  it('shows the tutorial link without advertising the avatar demo', () => {
    render(<Home />);
    expect(screen.getByRole('link', { name: /full interactive tutorial/i })).toBeVisible();
    expect(screen.queryByRole('link', { name: /preview avatar animations/i })).toBeNull();
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
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.FRONTEND_URL;
    delete process.env.NEXT_PUBLIC_BUILD_TARGET;
    global.fetch = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it('offers a clear way to create a private room', () => {
    render(<Home />);
    expect(screen.getByRole('button', { name: /Create Private Room/ })).toBeInTheDocument();
    expect(screen.queryByText(/Find Online Match/)).toBeNull();
    expect(screen.queryByText(/Spectate Live Games/)).toBeNull();
    expect(screen.queryByText('Spectators')).toBeNull();
    expect(screen.getByText('Smart Bots')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Literature', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start a short tutorial to learn the basics/ })).toBeInTheDocument();
    expect(screen.queryByTitle(/tutorial video/i)).toBeNull();
    expect(screen.getByRole('link', { name: /full interactive tutorial/i })).toHaveAttribute('href', '/tutorial');
  });

  it.each([
    ['  abc123  ', '/room/ABC123'],
    [' https://literati-ochre.vercel.app/room/def456 ', '/room/DEF456'],
    ['http://localhost/room/ghi789', '/room/GHI789'],
  ])('opens the player lobby for %s', (input, path) => {
    render(<Home />);

    _submitJoin(input);

    expect(mockPush).toHaveBeenCalledWith(path);
    expect(mockEnsureGuestName).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('opens the Android lobby when given a public invite', () => {
    process.env.NEXT_PUBLIC_BUILD_TARGET = 'android';
    render(<Home />);

    _submitJoin('https://literati-ochre.vercel.app/room/abc123');

    expect(mockPush).toHaveBeenCalledWith('/?room=ABC123');
  });

  it('opens a player invite from the configured Android deployment', () => {
    process.env.NEXT_PUBLIC_BUILD_TARGET = 'android';
    process.env.FRONTEND_URL = 'https://cards.example.org:8443';
    render(<Home />);

    _submitJoin('https://cards.example.org:8443/room/abc123');
    expect(mockPush).toHaveBeenCalledWith('/?room=ABC123');
  });

  it.each([
    'https://cards.example.org/room/ABC123',
    'https://cards.example.org.evil.example:8443/room/ABC123',
    'http://localhost/room/ABC123',
  ])('rejects an invite outside the configured Android origin: %s', (invite) => {
    process.env.NEXT_PUBLIC_BUILD_TARGET = 'android';
    process.env.FRONTEND_URL = 'https://cards.example.org:8443';
    render(<Home />);

    expect(_submitJoin(invite)).toHaveAttribute('aria-invalid', 'true');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'ABC12',
    'AB C12',
    'ſBC123',
    '/room/ABC123',
    'https://example.com/room/ABC123',
    'https://literati-ochre.vercel.app.example.com/room/ABC123',
    'https://user@literati-ochre.vercel.app/room/ABC123',
    'https://literati-ochre.vercel.app/room/ABC12',
    'https://literati-ochre.vercel.app/spectate/ABC123',
    'https://literati-ochre.vercel.app/room/ABC123?spectate=1',
    'https://literati-ochre.vercel.app/live/../room/ABC123',
  ])('shows an inline error without navigating for %s', (input) => {
    render(<Home />);

    const field = _submitJoin(input);

    expect(screen.getByRole('alert')).toHaveTextContent(/room code or invite link/i);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(/room code or invite link/i);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockEnsureGuestName).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Home room recovery', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: true })) as unknown as typeof fetch;
    mockGuest = { displayName: 'Ada', sessionId: 'current' };
    mockGetReturningRoom.mockReset();
    mockPush.mockClear();
  });

  afterEach(() => {
    mockGuest = null;
    global.fetch = originalFetch;
  });

  it('waits for the owner lookup before allowing creation and opens the validated game', async () => {
    let resolve!: (value: unknown) => void;
    mockGetReturningRoom.mockReturnValue(new Promise(done => { resolve = done; }));
    render(<Home />);
    expect(screen.getByRole('button', { name: /Checking your room/ })).toBeDisabled();
    await act(async () => resolve({ room: { code: 'ABC123', destination: 'game' }, hosting: true }));
    expect(screen.queryByRole('button', { name: /Create Private Room/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Return to game/ }));
    expect(mockPush).toHaveBeenCalledWith('/game/ABC123');
  });

  it('offers both the recent game and the distinct owned lobby', async () => {
    mockGetReturningRoom.mockResolvedValue({
      room: { code: 'JOIN02', destination: 'game' }, hosting: true, hostedLobby: 'HOST01',
    });
    render(<Home />);
    expect(await screen.findByRole('button', { name: /Return to game · JOIN02/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Create Private Room/ })).toBeNull();
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /Return to hosted lobby · HOST01/ }));
    expect(mockPush).toHaveBeenCalledWith('/room/HOST01');
    confirm.mockRestore();
  });

  it('keeps the room usable during refresh and ignores a superseded response', async () => {
    jest.useFakeTimers();
    try {
      const room = { code: 'ABC123', destination: 'lobby' };
      let resolveSlow!: (value: unknown) => void;
      mockGetReturningRoom.mockResolvedValueOnce({ room, hosting: true })
        .mockReturnValueOnce(new Promise(done => { resolveSlow = done; }))
        .mockResolvedValueOnce({ room: null, hosting: false });
      render(<Home />);
      await act(async () => {});
      await act(async () => { jest.advanceTimersByTime(15000); });
      expect(screen.getByRole('button', { name: /Return to lobby/ })).toBeEnabled();
      expect(mockGetReturningRoom).toHaveBeenCalledTimes(2);
      await act(async () => { window.dispatchEvent(new Event('focus')); });
      expect(screen.getByRole('button', { name: /Create Private Room/ })).toBeEnabled();
      await act(async () => resolveSlow({ room, hosting: true }));
      expect(screen.queryByRole('button', { name: /Return to lobby/ })).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('can retry a failed lookup and rejects a cancelled switch from a guest lobby', async () => {
    mockGetReturningRoom.mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ room: { code: 'ABC123', destination: 'lobby' }, hosting: false });
    render(<Home />);
    fireEvent.click(await screen.findByRole('button', { name: /Retry/ }));
    expect(await screen.findByRole('button', { name: /Return to lobby/ })).toBeVisible();
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    _submitJoin('DEF456');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

function _submitJoin(input: string) {
  const field = screen.getByRole('textbox', { name: /Join by code/i });
  fireEvent.change(field, { target: { value: input } });
  fireEvent.click(screen.getByRole('button', { name: 'Join room' }));
  return field;
}
