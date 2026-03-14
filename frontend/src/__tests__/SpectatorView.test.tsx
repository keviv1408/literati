/**
 * @jest-environment jsdom
 *
 * Tests for SpectatorView — Sub-AC 42c (spectator view component).
 *
 * Coverage:
 *   • Connecting state shows spinner, not the main game table.
 *   • Error/disconnected state shows "Connection Lost" message.
 *   • Connected state renders spectator-view + spectator-banner (read-only marker).
 *   • Turn indicator shows whose turn it is.
 *   • Last move text is rendered when present.
 *   • Score display shows team scores.
 *   • Both team rows are rendered.
 *   • Spectator footer shows the read-only note.
 *   • Inference banner is always visible for spectators.
 *   • Declared suit badges are rendered when suits are declared.
 *   • No ask/declare controls are rendered (read-only enforcement).
 *   • Room code is shown in the header.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Lightweight mock for GamePlayerSeat — the real component renders SVG icons
// and complex styles that aren't relevant to spectator-view tests.
// ---------------------------------------------------------------------------
jest.mock('@/components/GamePlayerSeat', () => ({
  __esModule: true,
  default: ({ player }: { player: { displayName: string } | null }) => (
    <div data-testid="mock-player-seat">
      {player ? player.displayName : 'Empty'}
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Import component under test after mocks are set up
// ---------------------------------------------------------------------------
import SpectatorView from '@/components/SpectatorView';
import type { SpectatorViewProps } from '@/components/SpectatorView';
import type { GamePlayer, PublicGameState } from '@/types/game';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlayer(
  playerId: string,
  displayName: string,
  teamId: 1 | 2,
  seatIndex: number,
): GamePlayer {
  return {
    playerId,
    displayName,
    teamId,
    seatIndex,
    cardCount: 8,
    isBot: false,
    avatarId: null,
  };
}

function makeGameState(overrides: Partial<PublicGameState> = {}): PublicGameState {
  return {
    status: 'active',
    currentTurnPlayerId: 'p1',
    scores: { team1: 2, team2: 1 },
    lastMove: null,
    winner: null,
    tiebreakerWinner: null,
    declaredSuits: [],
    inferenceMode: false,
    ...overrides,
  };
}

const SIX_PLAYERS: GamePlayer[] = [
  makePlayer('p1', 'Alice', 1, 0),
  makePlayer('p2', 'Bob', 2, 1),
  makePlayer('p3', 'Carol', 1, 2),
  makePlayer('p4', 'Dave', 2, 3),
  makePlayer('p5', 'Eve', 1, 4),
  makePlayer('p6', 'Frank', 2, 5),
];

function buildProps(
  overrides: Partial<SpectatorViewProps> = {},
): SpectatorViewProps {
  return {
    wsStatus: 'connected',
    players: SIX_PLAYERS,
    gameState: makeGameState(),
    variant: 'remove_7s',
    playerCount: 6,
    turnTimer: null,
    lastAskResult: null,
    lastDeclareResult: null,
    roomCode: 'ABC123',
    cardRemovalVariant: 'remove_7s',
    gamePlayerCount: 6,
    onGoHome: jest.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SpectatorView', () => {
  describe('connecting state', () => {
    it('renders spectator-connecting spinner when wsStatus is "connecting"', () => {
      render(<SpectatorView {...buildProps({ wsStatus: 'connecting' })} />);
      expect(screen.getByTestId('spectator-connecting')).toBeTruthy();
      expect(screen.queryByTestId('spectator-view')).toBeNull();
    });

    it('renders spectator-connecting spinner when wsStatus is "idle"', () => {
      render(<SpectatorView {...buildProps({ wsStatus: 'idle' })} />);
      expect(screen.getByTestId('spectator-connecting')).toBeTruthy();
    });

    it('shows "Connecting to game…" text while connecting', () => {
      render(<SpectatorView {...buildProps({ wsStatus: 'connecting' })} />);
      expect(screen.getByText('Connecting to game…')).toBeTruthy();
    });
  });

  describe('error / disconnected state', () => {
    it('renders spectator-error when wsStatus is "error"', () => {
      render(<SpectatorView {...buildProps({ wsStatus: 'error' })} />);
      expect(screen.getByTestId('spectator-error')).toBeTruthy();
      expect(screen.queryByTestId('spectator-view')).toBeNull();
    });

    it('renders spectator-error when wsStatus is "disconnected"', () => {
      render(<SpectatorView {...buildProps({ wsStatus: 'disconnected' })} />);
      expect(screen.getByTestId('spectator-error')).toBeTruthy();
    });

    it('shows "Connection Lost" message when disconnected', () => {
      render(<SpectatorView {...buildProps({ wsStatus: 'disconnected' })} />);
      expect(screen.getByText('Connection Lost')).toBeTruthy();
    });
  });

  describe('main spectator view (connected)', () => {
    it('renders spectator-view testid in the connected state', () => {
      render(<SpectatorView {...buildProps()} />);
      expect(screen.getByTestId('spectator-view')).toBeTruthy();
    });

    it('renders the spectator banner (prominent read-only indicator)', () => {
      render(<SpectatorView {...buildProps()} />);
      const banner = screen.getByTestId('spectator-banner');
      expect(banner).toBeTruthy();
      expect(banner.textContent).toContain('Spectating');
    });

    it('spectator banner has role="status" for accessibility', () => {
      render(<SpectatorView {...buildProps()} />);
      const banner = screen.getByTestId('spectator-banner');
      expect(banner.getAttribute('role')).toBe('status');
    });

    it('renders spectator footer with read-only note', () => {
      render(<SpectatorView {...buildProps()} />);
      expect(screen.getByTestId('spectator-footer')).toBeTruthy();
      expect(screen.getByTestId('spectator-readonly-note')).toBeTruthy();
      expect(screen.getByTestId('spectator-readonly-note').textContent).toContain(
        'spectating',
      );
    });
  });

  describe('header', () => {
    it('shows the room code in the header', () => {
      render(<SpectatorView {...buildProps({ roomCode: 'XYZ999' })} />);
      expect(screen.getByText('XYZ999')).toBeTruthy();
    });

    it('shows scores in the header', () => {
      render(
        <SpectatorView
          {...buildProps({
            gameState: makeGameState({ scores: { team1: 3, team2: 5 } }),
          })}
        />,
      );
      // The score display shows T1 and T2 with their scores
      expect(screen.getByText(/T1/)).toBeTruthy();
      expect(screen.getByText(/T2/)).toBeTruthy();
    });
  });

  describe('turn indicator', () => {
    it('shows whose turn it is when gameState is present', () => {
      render(
        <SpectatorView
          {...buildProps({
            gameState: makeGameState({ currentTurnPlayerId: 'p1' }),
          })}
        />,
      );
      const indicator = screen.getByTestId('spectator-turn-indicator');
      expect(indicator).toBeTruthy();
      expect(indicator.textContent).toContain('Alice');
    });

    it('shows "Waiting for game to start…" when no current turn player', () => {
      render(
        <SpectatorView
          {...buildProps({
            gameState: makeGameState({ currentTurnPlayerId: null }),
          })}
        />,
      );
      expect(
        screen.getByText('Waiting for game to start…'),
      ).toBeTruthy();
    });

    it('does not render turn indicator when gameState is null', () => {
      render(<SpectatorView {...buildProps({ gameState: null })} />);
      expect(screen.queryByTestId('spectator-turn-indicator')).toBeNull();
    });
  });

  describe('last move display', () => {
    it('shows last-move text from gameState when present', () => {
      render(
        <SpectatorView
          {...buildProps({
            gameState: makeGameState({ lastMove: 'Alice asked Bob for 5♥ — No!' }),
          })}
        />,
      );
      const lastMove = screen.getByTestId('spectator-last-move');
      expect(lastMove.textContent).toContain('Alice asked Bob');
    });

    it('does not render last-move element when lastMove is null', () => {
      render(
        <SpectatorView
          {...buildProps({ gameState: makeGameState({ lastMove: null }) })}
        />,
      );
      expect(screen.queryByTestId('spectator-last-move')).toBeNull();
    });
  });

  describe('team rows', () => {
    it('renders both team rows', () => {
      render(<SpectatorView {...buildProps()} />);
      expect(screen.getByTestId('spectator-team1-row')).toBeTruthy();
      expect(screen.getByTestId('spectator-team2-row')).toBeTruthy();
    });

    it('renders player seat chips for each player', () => {
      render(<SpectatorView {...buildProps()} />);
      // 6 players should produce 6 mock seat elements
      const seats = screen.getAllByTestId('mock-player-seat');
      expect(seats.length).toBe(6);
    });

    it('renders team label text for Team 1 and Team 2', () => {
      render(<SpectatorView {...buildProps()} />);
      expect(screen.getByText('Team 2')).toBeTruthy();
      expect(screen.getByText('Team 1')).toBeTruthy();
    });
  });

  describe('inference mode', () => {
    it('renders the inference banner (always on for spectators)', () => {
      render(<SpectatorView {...buildProps()} />);
      expect(screen.getByTestId('spectator-inference-banner')).toBeTruthy();
    });
  });

  describe('declared suits', () => {
    it('renders declared suit badges when suits have been declared', () => {
      render(
        <SpectatorView
          {...buildProps({
            gameState: makeGameState({
              declaredSuits: [
                { halfSuitId: 'low_s', teamId: 1 },
                { halfSuitId: 'high_h', teamId: 2 },
              ],
            }),
          })}
        />,
      );
      const badges = screen.getAllByTestId('spectator-declared-badge');
      expect(badges.length).toBe(2);
    });

    it('does not render declared suits section when none are declared', () => {
      render(
        <SpectatorView
          {...buildProps({
            gameState: makeGameState({ declaredSuits: [] }),
          })}
        />,
      );
      expect(screen.queryByTestId('spectator-declared-suits')).toBeNull();
    });
  });

  describe('read-only enforcement (no action controls)', () => {
    it('does not render a declare button', () => {
      render(<SpectatorView {...buildProps()} />);
      expect(screen.queryByTestId('declare-button')).toBeNull();
      expect(screen.queryByText(/Declare/)).toBeNull();
    });

    it('does not render a card hand area', () => {
      render(<SpectatorView {...buildProps()} />);
      expect(screen.queryByTestId('player-hand-area')).toBeNull();
    });

    it('does not render an ask-card modal', () => {
      render(<SpectatorView {...buildProps()} />);
      expect(screen.queryByTestId('ask-card-modal')).toBeNull();
    });

    it('does not render an inference mode toggle button', () => {
      render(<SpectatorView {...buildProps()} />);
      // The regular game view has a data-testid="inference-toggle" — spectator view should NOT
      expect(screen.queryByTestId('inference-toggle')).toBeNull();
    });
  });

  describe('center table', () => {
    it('renders the table center element', () => {
      render(<SpectatorView {...buildProps()} />);
      expect(screen.getByTestId('spectator-table-center')).toBeTruthy();
    });
  });
});
