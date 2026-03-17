/**
 * @jest-environment jsdom
 *
 * Integration tests for the Live Games page component.
 *
 * Scenarios:
 *   - Renders the page heading and connecting state
 *   - Shows "No active games" when the list is empty
 *   - Renders a row for each active game
 *   - Each row shows player count, variant, room code
 *   - Each row shows scores (team1 vs team2)
 *   - Each row has a Spectate button that navigates to the provided spectator URL
 *   - Renders a live "In Progress" badge for in_progress games
 *   - Renders "Starting Soon" badge for waiting games
 *   - Game disappears when game_removed message arrives
 *   - Displays "Live" indicator when WebSocket is connected
 */

import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import LiveGamesPage from '@/app/live-games/page';

// ── Mock next/navigation ─────────────────────────────────────────────────────

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => ({ get: () => null }),
}));

// ── Mock WebSocket ─────────────────────────────────────────────────────────

interface MockWsInstance {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  close: jest.Mock;
  send: jest.Mock;
  readyState: number;
}

const wsInstances: MockWsInstance[] = [];

class MockWebSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  readyState: number = 1; // OPEN
  close = jest.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  send = jest.fn();
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  constructor(_url: string) {
    wsInstances.push(this as unknown as MockWsInstance);
  }
}

Object.defineProperty(global, 'WebSocket', { value: MockWebSocket, writable: true });

// ── Mock fetch (not needed for WS-driven tests, but silences warnings) ───────

global.fetch = jest.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ games: [], total: 0 }),
} as unknown as Response);

// ── Helpers ────────────────────────────────────────────────────────────────

function latestWs(): MockWsInstance {
  return wsInstances[wsInstances.length - 1];
}

function sendWs(ws: MockWsInstance, data: unknown) {
  ws.onmessage?.({ data: JSON.stringify(data) });
}

const GAME_1 = {
  roomCode: 'ABCD12',
  playerCount: 6,
  currentPlayers: 6,
  cardVariant: 'remove_7s',
  spectatorUrl: '/game/ABCD12?spectatorToken=token-abcd12',
  scores: { team1: 3, team2: 2 },
  status: 'in_progress',
  createdAt: Date.now() - 900_000,
  startedAt: Date.now() - 600_000,
  elapsedMs: 600_000,
};

const GAME_2 = {
  roomCode: 'XYZ789',
  playerCount: 8,
  currentPlayers: 4,
  cardVariant: 'remove_2s',
  spectatorUrl: '/game/XYZ789?spectatorToken=token-xyz789',
  scores: { team1: 0, team2: 0 },
  status: 'waiting',
  createdAt: Date.now() - 60_000,
  startedAt: null,
  elapsedMs: 60_000,
};

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  wsInstances.length = 0;
  mockPush.mockReset();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.runAllTimers();
  jest.useRealTimers();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('LiveGamesPage', () => {
  it('renders the "Live Games" heading', () => {
    render(<LiveGamesPage />);
    expect(screen.getByText('Live Games')).toBeDefined();
  });

  it('shows "Connecting…" before the socket opens', () => {
    render(<LiveGamesPage />);
    expect(screen.getByText('Connecting…')).toBeDefined();
  });

  it('shows "Live" indicator when WebSocket connects', () => {
    render(<LiveGamesPage />);
    act(() => {
      latestWs().onopen?.();
    });
    expect(screen.getByText('Live')).toBeDefined();
  });

  it('shows "No active games" when the game list is empty', () => {
    render(<LiveGamesPage />);
    act(() => {
      latestWs().onopen?.();
      sendWs(latestWs(), { type: 'live_games_init', games: [] });
    });
    expect(screen.getByTestId('live-games-empty')).toBeDefined();
  });

  it('renders a row for each active game', () => {
    render(<LiveGamesPage />);
    act(() => {
      latestWs().onopen?.();
      sendWs(latestWs(), { type: 'live_games_init', games: [GAME_1, GAME_2] });
    });
    expect(screen.getByTestId('live-game-row-ABCD12')).toBeDefined();
    expect(screen.getByTestId('live-game-row-XYZ789')).toBeDefined();
  });

  it('shows room code for each game', () => {
    render(<LiveGamesPage />);
    act(() => {
      latestWs().onopen?.();
      sendWs(latestWs(), { type: 'live_games_init', games: [GAME_1] });
    });
    expect(screen.getByText('ABCD12')).toBeDefined();
  });

  it('shows player count badge', () => {
    render(<LiveGamesPage />);
    act(() => {
      latestWs().onopen?.();
      sendWs(latestWs(), { type: 'live_games_init', games: [GAME_1] });
    });
    expect(screen.getByText('6-player')).toBeDefined();
  });

  it('shows variant badge', () => {
    render(<LiveGamesPage />);
    act(() => {
      latestWs().onopen?.();
      sendWs(latestWs(), { type: 'live_games_init', games: [GAME_1] });
    });
    expect(screen.getByText('Remove 7s (Classic)')).toBeDefined();
  });

  it('shows score for in_progress game', () => {
    render(<LiveGamesPage />);
    act(() => {
      latestWs().onopen?.();
      sendWs(latestWs(), { type: 'live_games_init', games: [GAME_1] });
    });
    // Scores: 3 vs 2
    const scoreEl = screen.getAllByRole('generic').find((el) =>
      el.getAttribute('aria-label')?.includes('Score: Team 1 has 3')
    );
    expect(scoreEl).toBeDefined();
  });

  it('shows "In Progress" badge for in_progress games', () => {
    render(<LiveGamesPage />);
    act(() => {
      latestWs().onopen?.();
      sendWs(latestWs(), { type: 'live_games_init', games: [GAME_1] });
    });
    expect(screen.getByText('In Progress')).toBeDefined();
  });

  it('shows "Starting Soon" badge for waiting games', () => {
    render(<LiveGamesPage />);
    act(() => {
      latestWs().onopen?.();
      sendWs(latestWs(), { type: 'live_games_init', games: [GAME_2] });
    });
    expect(screen.getByText('Starting Soon')).toBeDefined();
  });

  it('has a Spectate button that navigates to the game spectator URL', () => {
    render(<LiveGamesPage />);
    act(() => {
      latestWs().onopen?.();
      sendWs(latestWs(), { type: 'live_games_init', games: [GAME_1] });
    });
    const btn = screen.getByRole('button', { name: /Spectate game ABCD12/i });
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(mockPush).toHaveBeenCalledWith('/game/ABCD12?spectatorToken=token-abcd12');
  });

  it('removes a game row when live_game_removed arrives', () => {
    render(<LiveGamesPage />);
    act(() => {
      latestWs().onopen?.();
      sendWs(latestWs(), { type: 'live_games_init', games: [GAME_1, GAME_2] });
    });
    // Both rows present
    expect(screen.getByTestId('live-game-row-ABCD12')).toBeDefined();

    act(() => {
      sendWs(latestWs(), { type: 'live_game_removed', roomCode: 'ABCD12' });
    });

    // Row for ABCD12 should be gone
    expect(screen.queryByTestId('live-game-row-ABCD12')).toBeNull();
    // Row for XYZ789 should remain
    expect(screen.getByTestId('live-game-row-XYZ789')).toBeDefined();
  });

  it('updates score when live_game_updated arrives', () => {
    render(<LiveGamesPage />);
    act(() => {
      latestWs().onopen?.();
      sendWs(latestWs(), { type: 'live_games_init', games: [GAME_1] });
    });

    act(() => {
      sendWs(latestWs(), {
        type: 'live_game_updated',
        game: { ...GAME_1, scores: { team1: 5, team2: 3 } },
      });
    });

    const scoreEl = screen.getAllByRole('generic').find((el) =>
      el.getAttribute('aria-label')?.includes('Score: Team 1 has 5')
    );
    expect(scoreEl).toBeDefined();
  });

  it('shows the total active game count', () => {
    render(<LiveGamesPage />);
    act(() => {
      latestWs().onopen?.();
      sendWs(latestWs(), { type: 'live_games_init', games: [GAME_1, GAME_2] });
    });
    expect(screen.getByText(/2 active games/i)).toBeDefined();
  });

  it('navigates home when Back button is clicked', () => {
    render(<LiveGamesPage />);
    const backBtn = screen.getByText('← Back to Home');
    fireEvent.click(backBtn);
    expect(mockPush).toHaveBeenCalledWith('/');
  });
});
