/**
 * @jest-environment jsdom
 *
 * Unit tests for GamePlayerSeat — Sub-AC 13b.
 *
 * Covers:
 *  • Empty seat rendering (null player)
 *  • Occupied seat: avatar initials fallback, display name, team colour
 *  • Bot player: BotBadge rendered instead of plain name
 *  • "You" pill: shown only for myPlayerId match
 *  • Current-turn ring: shown when currentTurnPlayerId matches
 *  • isCurrentTurn flag on GamePlayer also triggers turn ring
 *  • Card count badge (value + zero state)
 *  • Team dot colour attribute (data-team)
 *  • Aria-label composition (name, you, bot, turn)
 *  • data-seat-index and data-player-id attributes
 *  • className forwarding
 *  • Team 2 (violet) style applied correctly
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import GamePlayerSeat from '@/components/GamePlayerSeat';
import type { GamePlayer } from '@/types/game';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePlayer(overrides: Partial<GamePlayer> = {}): GamePlayer {
  return {
    playerId: 'player-1',
    displayName: 'Alice',
    avatarId: null,
    teamId: 1,
    seatIndex: 0,
    cardCount: 6,
    isBot: false,
    isGuest: false,
    isCurrentTurn: false,
    ...overrides,
  };
}

// ── Empty seat ────────────────────────────────────────────────────────────────

describe('GamePlayerSeat — empty seat (player=null)', () => {
  it('renders the waiting placeholder', () => {
    render(
      <GamePlayerSeat
        seatIndex={3}
        player={null}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    expect(screen.getByText('Waiting…')).toBeDefined();
  });

  it('has the correct aria-label for the empty slot', () => {
    render(
      <GamePlayerSeat
        seatIndex={3}
        player={null}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    expect(screen.getByLabelText('Seat 4 — waiting for player')).toBeDefined();
  });

  it('has data-testid="game-player-seat-empty"', () => {
    const { container } = render(
      <GamePlayerSeat seatIndex={0} player={null} myPlayerId={null} currentTurnPlayerId={null} />,
    );
    expect(container.querySelector('[data-testid="game-player-seat-empty"]')).not.toBeNull();
  });

  it('applies the correct data-seat-index attribute', () => {
    const { container } = render(
      <GamePlayerSeat seatIndex={5} player={null} myPlayerId={null} currentTurnPlayerId={null} />,
    );
    const el = container.querySelector('[data-seat-index]') as HTMLElement;
    expect(el.getAttribute('data-seat-index')).toBe('5');
  });

  it('shows the pulsing hourglass emoji', () => {
    render(
      <GamePlayerSeat seatIndex={0} player={null} myPlayerId={null} currentTurnPlayerId={null} />,
    );
    expect(screen.getByText('⌛')).toBeDefined();
  });

  it('does not render a turn ring for an empty seat', () => {
    const { container } = render(
      <GamePlayerSeat seatIndex={0} player={null} myPlayerId={null} currentTurnPlayerId={null} />,
    );
    expect(container.querySelector('[data-testid="turn-ring"]')).toBeNull();
  });

  it('does not render a "You" pill for an empty seat', () => {
    render(
      <GamePlayerSeat seatIndex={0} player={null} myPlayerId="p1" currentTurnPlayerId={null} />,
    );
    expect(screen.queryByText('You')).toBeNull();
  });
});

// ── Occupied seat — basic ─────────────────────────────────────────────────────

describe('GamePlayerSeat — occupied seat', () => {
  it('renders the player display name', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ displayName: 'Alice' })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    expect(screen.getByText('Alice')).toBeDefined();
  });

  it('has data-testid="game-player-seat"', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    expect(container.querySelector('[data-testid="game-player-seat"]')).not.toBeNull();
  });

  it('sets data-seat-index correctly', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={4}
        player={makePlayer({ seatIndex: 4 })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    const el = container.querySelector('[data-seat-index]') as HTMLElement;
    expect(el.getAttribute('data-seat-index')).toBe('4');
  });

  it('sets data-player-id to player.playerId', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'p-xyz' })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    const el = container.querySelector('[data-player-id]') as HTMLElement;
    expect(el.getAttribute('data-player-id')).toBe('p-xyz');
  });

  it('includes displayName in aria-label', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ displayName: 'Bob' })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    // aria-label is on the outer div
    const el = screen.getByRole('listitem');
    expect(el.getAttribute('aria-label')).toContain('Bob');
  });

  it('renders voice indicators and exposes them in the aria-label', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ displayName: 'Bob' })}
        myPlayerId={null}
        currentTurnPlayerId={null}
        voiceState={{ connected: true, muted: true, speaking: true, local: false }}
      />,
    );

    const el = screen.getByRole('listitem');
    expect(el.getAttribute('aria-label')).toContain('in voice');
    expect(el.getAttribute('aria-label')).toContain('mic muted');
    expect(el.getAttribute('aria-label')).toContain('speaking');
    expect(screen.getByTestId('voice-seat-indicators')).toBeDefined();
  });
});

// ── Avatar / initials ─────────────────────────────────────────────────────────

describe('GamePlayerSeat — avatar rendering', () => {
  it('renders an Avatar element (role="img") for human players', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ avatarId: null })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    // Avatar component renders role="img"
    const avatars = screen.getAllByRole('img');
    expect(avatars.length).toBeGreaterThanOrEqual(1);
  });

  it('renders initials inside the avatar when avatarId is null', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ displayName: 'Alice Nguyen', avatarId: null })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    // Avatar with initials: text "AN" should appear in the DOM
    expect(screen.getByText('AN')).toBeDefined();
  });

  it('renders an <img> tag when avatarId is a URL', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ avatarId: 'https://example.com/avatar.png', displayName: 'Carol' })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    expect(container.querySelector('img')).not.toBeNull();
  });
});

// ── Card count badge ──────────────────────────────────────────────────────────

describe('GamePlayerSeat — card count badge', () => {
  it('displays the correct card count', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ cardCount: 7 })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    const badge = container.querySelector('[data-testid="card-count-badge"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('7');
  });

  it('shows 0 card count when player has no cards', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ cardCount: 0 })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    const badge = container.querySelector('[data-testid="card-count-badge"]') as HTMLElement;
    expect(badge.textContent).toBe('0');
  });

  it('badge aria-label says "7 cards" for cardCount=7', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ cardCount: 7 })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    const badge = container.querySelector('[data-testid="card-count-badge"]') as HTMLElement;
    expect(badge.getAttribute('aria-label')).toBe('7 cards');
  });

  it('badge aria-label says "1 card" (singular) for cardCount=1', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ cardCount: 1 })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    const badge = container.querySelector('[data-testid="card-count-badge"]') as HTMLElement;
    expect(badge.getAttribute('aria-label')).toBe('1 card');
  });
});

// ── "You" pill ────────────────────────────────────────────────────────────────

describe('GamePlayerSeat — "You" pill', () => {
  it('renders the "You" pill when player.playerId === myPlayerId', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'me' })}
        myPlayerId="me"
        currentTurnPlayerId={null}
      />,
    );
    expect(screen.getByTestId('you-pill')).toBeDefined();
    expect(screen.getByText('You')).toBeDefined();
  });

  it('does not render the "You" pill for other players', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'other' })}
        myPlayerId="me"
        currentTurnPlayerId={null}
      />,
    );
    expect(screen.queryByTestId('you-pill')).toBeNull();
  });

  it('does not render the "You" pill when myPlayerId is null', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'p1' })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    expect(screen.queryByText('You')).toBeNull();
  });

  it('aria-label includes ", you" for the current user', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'me', displayName: 'Alice' })}
        myPlayerId="me"
        currentTurnPlayerId={null}
      />,
    );
    const el = screen.getByRole('listitem');
    expect(el.getAttribute('aria-label')).toContain(', you');
  });
});

// ── Current-turn ring ─────────────────────────────────────────────────────────

describe('GamePlayerSeat — current-turn ring', () => {
  it('shows the pulsing turn ring when currentTurnPlayerId matches', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'p1' })}
        myPlayerId={null}
        currentTurnPlayerId="p1"
      />,
    );
    expect(container.querySelector('[data-testid="turn-ring"]')).not.toBeNull();
  });

  it('shows the turn ring via player.isCurrentTurn flag', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'p1', isCurrentTurn: true })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    expect(container.querySelector('[data-testid="turn-ring"]')).not.toBeNull();
  });

  it('does not show turn ring for a non-current player', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'p1' })}
        myPlayerId={null}
        currentTurnPlayerId="other-player"
      />,
    );
    expect(container.querySelector('[data-testid="turn-ring"]')).toBeNull();
  });

  it('aria-label includes ", current turn" when it is this player\'s turn', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'p1', displayName: 'Dave' })}
        myPlayerId={null}
        currentTurnPlayerId="p1"
      />,
    );
    const el = screen.getByRole('listitem');
    expect(el.getAttribute('aria-label')).toContain(', current turn');
  });
});

// ── Active-turn glow animation ────────────────────────────────────────────────

describe('GamePlayerSeat — active-turn glow animation (animate-seat-glow)', () => {
  it('applies animate-seat-glow class to the outer container when currentTurnPlayerId matches', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'p1' })}
        myPlayerId={null}
        currentTurnPlayerId="p1"
      />,
    );
    const seat = container.querySelector('[data-testid="game-player-seat"]') as HTMLElement;
    expect(seat.className).toContain('animate-seat-glow');
  });

  it('does not apply animate-seat-glow when it is not this player\'s turn', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'p1' })}
        myPlayerId={null}
        currentTurnPlayerId="other"
      />,
    );
    const seat = container.querySelector('[data-testid="game-player-seat"]') as HTMLElement;
    expect(seat.className).not.toContain('animate-seat-glow');
  });

  it('applies animate-seat-glow via the explicit isActiveTurn=true prop', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'p1' })}
        myPlayerId={null}
        currentTurnPlayerId={null}
        isActiveTurn={true}
      />,
    );
    const seat = container.querySelector('[data-testid="game-player-seat"]') as HTMLElement;
    expect(seat.className).toContain('animate-seat-glow');
  });

  it('does not apply animate-seat-glow when isActiveTurn=false overrides currentTurnPlayerId match', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'p1' })}
        myPlayerId={null}
        currentTurnPlayerId="p1"
        isActiveTurn={false}
      />,
    );
    const seat = container.querySelector('[data-testid="game-player-seat"]') as HTMLElement;
    expect(seat.className).not.toContain('animate-seat-glow');
  });

  it('applies animate-seat-glow when player.isCurrentTurn is true', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'p1', isCurrentTurn: true })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    const seat = container.querySelector('[data-testid="game-player-seat"]') as HTMLElement;
    expect(seat.className).toContain('animate-seat-glow');
  });

  it('sets data-active-turn="true" when it is this player\'s turn', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'p1' })}
        myPlayerId={null}
        currentTurnPlayerId="p1"
      />,
    );
    const seat = container.querySelector('[data-testid="game-player-seat"]') as HTMLElement;
    expect(seat.getAttribute('data-active-turn')).toBe('true');
  });

  it('does not set data-active-turn when it is not this player\'s turn', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'p1' })}
        myPlayerId={null}
        currentTurnPlayerId="other"
      />,
    );
    const seat = container.querySelector('[data-testid="game-player-seat"]') as HTMLElement;
    expect(seat.getAttribute('data-active-turn')).toBeNull();
  });

  it('applies scale-110 z-10 classes when active turn', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'p1' })}
        myPlayerId={null}
        currentTurnPlayerId="p1"
      />,
    );
    const seat = container.querySelector('[data-testid="game-player-seat"]') as HTMLElement;
    expect(seat.className).toContain('scale-110');
    expect(seat.className).toContain('z-10');
  });

  it('does not apply scale-110 when not active turn', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'p1' })}
        myPlayerId={null}
        currentTurnPlayerId="other"
      />,
    );
    const seat = container.querySelector('[data-testid="game-player-seat"]') as HTMLElement;
    expect(seat.className).not.toContain('scale-110');
  });

  it('clears animate-seat-glow and data-active-turn when turn advances to another player', () => {
    // Initial render: p1 is active
    const { container, rerender } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'p1' })}
        myPlayerId={null}
        currentTurnPlayerId="p1"
      />,
    );
    const seat = container.querySelector('[data-testid="game-player-seat"]') as HTMLElement;
    expect(seat.className).toContain('animate-seat-glow');
    expect(seat.getAttribute('data-active-turn')).toBe('true');

    // Simulate turn advancing to p2 (player takes an action)
    rerender(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ playerId: 'p1' })}
        myPlayerId={null}
        currentTurnPlayerId="p2"
      />,
    );
    expect(seat.className).not.toContain('animate-seat-glow');
    expect(seat.getAttribute('data-active-turn')).toBeNull();
  });
});

// ── Bot player ────────────────────────────────────────────────────────────────

describe('GamePlayerSeat — bot player', () => {
  it('renders a BotBadge (robot SVG icon) for a bot', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ isBot: true, displayName: 'Quirky Turing' })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('renders the bot name via BotBadge', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ isBot: true, displayName: 'Elegant Curie' })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    expect(screen.getByText('Elegant Curie')).toBeDefined();
  });

  it('does NOT render a plain <span> name for a bot (uses BotBadge instead)', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ isBot: true, displayName: 'Bold Feynman' })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    // data-testid="player-display-name" is only on the non-bot span
    expect(screen.queryByTestId('player-display-name')).toBeNull();
  });

  it('aria-label includes "(bot)" for bot players', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ isBot: true, displayName: 'Clever Darwin' })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    const el = screen.getByRole('listitem');
    expect(el.getAttribute('aria-label')).toContain('(bot)');
  });
});

// ── Team colours ──────────────────────────────────────────────────────────────

describe('GamePlayerSeat — team colour', () => {
  it('sets data-team=1 for Team 1', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ teamId: 1 })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    const el = container.querySelector('[data-team]') as HTMLElement;
    expect(el.getAttribute('data-team')).toBe('1');
  });

  it('sets data-team=2 for Team 2', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={1}
        player={makePlayer({ teamId: 2 })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    const el = container.querySelector('[data-team]') as HTMLElement;
    expect(el.getAttribute('data-team')).toBe('2');
  });

  it('does not render a team dot element', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ teamId: 1 })}
        myPlayerId={null}
        currentTurnPlayerId={null}
      />,
    );
    expect(container.querySelector('[data-testid="team-dot"]')).toBeNull();
  });
});

// ── className forwarding ──────────────────────────────────────────────────────

describe('GamePlayerSeat — className forwarding', () => {
  it('forwards className to the outer element (occupied)', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId={null}
        currentTurnPlayerId={null}
        className="custom-seat-class"
      />,
    );
    expect(container.querySelector('.custom-seat-class')).not.toBeNull();
  });

  it('forwards className to the outer element (empty)', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={null}
        myPlayerId={null}
        currentTurnPlayerId={null}
        className="empty-custom"
      />,
    );
    expect(container.querySelector('.empty-custom')).not.toBeNull();
  });
});

// ── Combined aria-label composition ──────────────────────────────────────────

describe('GamePlayerSeat — aria-label composition', () => {
  it('full label: name + you + bot + current-turn', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({
          playerId: 'p1',
          displayName: 'Eve',
          isBot: true,
          isCurrentTurn: true,
        })}
        myPlayerId="p1"
        currentTurnPlayerId="p1"
      />,
    );
    const el = screen.getByRole('listitem');
    const label = el.getAttribute('aria-label') ?? '';
    expect(label).toContain('Eve');
    expect(label).toContain(', you');
    expect(label).toContain('(bot)');
    expect(label).toContain(', current turn');
  });

  it('minimal label: name only (no you, no bot, no turn)', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ displayName: 'Frank', playerId: 'p2' })}
        myPlayerId="p1"
        currentTurnPlayerId="p3"
      />,
    );
    const el = screen.getByRole('listitem');
    const label = el.getAttribute('aria-label') ?? '';
    expect(label).toContain('Frank');
    expect(label).not.toContain('you');
    expect(label).not.toContain('bot');
    expect(label).not.toContain('current turn');
  });
});

// ── Eliminated player (Sub-AC 27b) ────────────────────────────────────────────

describe('GamePlayerSeat — eliminated player', () => {
  it('renders the eliminated badge when isEliminated is true', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ isEliminated: true, cardCount: 0 })}
        myPlayerId="other"
        currentTurnPlayerId={null}
      />,
    );
    expect(screen.getByTestId('eliminated-badge')).toBeInTheDocument();
  });

  it('does NOT render the eliminated badge when isEliminated is false', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ isEliminated: false })}
        myPlayerId="other"
        currentTurnPlayerId={null}
      />,
    );
    expect(screen.queryByTestId('eliminated-badge')).not.toBeInTheDocument();
  });

  it('does NOT render the eliminated badge when isEliminated is undefined', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
      />,
    );
    expect(screen.queryByTestId('eliminated-badge')).not.toBeInTheDocument();
  });

  it('sets data-eliminated="true" on the seat when isEliminated is true', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ isEliminated: true, cardCount: 0 })}
        myPlayerId="other"
        currentTurnPlayerId={null}
      />,
    );
    expect(screen.getByTestId('game-player-seat')).toHaveAttribute('data-eliminated', 'true');
  });

  it('does NOT set data-eliminated when isEliminated is false', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ isEliminated: false })}
        myPlayerId="other"
        currentTurnPlayerId={null}
      />,
    );
    expect(screen.getByTestId('game-player-seat')).not.toHaveAttribute('data-eliminated');
  });

  it('includes ", eliminated" in aria-label when isEliminated is true', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ isEliminated: true, displayName: 'Alice', cardCount: 0 })}
        myPlayerId="other"
        currentTurnPlayerId={null}
      />,
    );
    const label = screen.getByTestId('game-player-seat').getAttribute('aria-label') ?? '';
    expect(label).toContain(', eliminated');
  });

  it('does NOT show the turn ring for an eliminated player even if it is their turn', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ isEliminated: true, playerId: 'p1', cardCount: 0 })}
        myPlayerId="other"
        currentTurnPlayerId="p1"
      />,
    );
    // Turn ring should not be rendered because the player is eliminated
    expect(screen.queryByTestId('turn-ring')).not.toBeInTheDocument();
  });

  it('applies pointer-events-none to the seat container when isEliminated is true', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ isEliminated: true, cardCount: 0 })}
        myPlayerId="other"
        currentTurnPlayerId={null}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.className).toContain('pointer-events-none');
  });

  it('does NOT apply pointer-events-none when isEliminated is false', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ isEliminated: false })}
        myPlayerId="other"
        currentTurnPlayerId={null}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.className).not.toContain('pointer-events-none');
  });

  it('does NOT apply pointer-events-none when isEliminated is undefined', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.className).not.toContain('pointer-events-none');
  });

  it('seat remains in the DOM (visible) when isEliminated is true', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ isEliminated: true, cardCount: 0, displayName: 'Alice' })}
        myPlayerId="other"
        currentTurnPlayerId={null}
      />,
    );
    // Seat must be present in the DOM (not unmounted/hidden)
    expect(screen.getByTestId('game-player-seat')).toBeInTheDocument();
    // Name is still visible
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('applies opacity-50 and grayscale to dim the eliminated seat', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ isEliminated: true, cardCount: 0 })}
        myPlayerId="other"
        currentTurnPlayerId={null}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.className).toContain('opacity-50');
    expect(seat.className).toContain('grayscale');
  });

  it('does NOT apply opacity-50 or grayscale for a non-eliminated player', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ isEliminated: false })}
        myPlayerId="other"
        currentTurnPlayerId={null}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.className).not.toContain('opacity-50');
    expect(seat.className).not.toContain('grayscale');
  });
});

// ── Sub-AC 28b: post-declaration seat highlight ─────────────────────────────

describe('GamePlayerSeat — Sub-AC 28b highlight ring', () => {
  it('renders a cyan highlight ring when isHighlighted=true', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={true}
      />,
    );
    expect(screen.getByTestId('highlight-ring')).toBeInTheDocument();
  });

  it('does NOT render a highlight ring when isHighlighted=false', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={false}
      />,
    );
    expect(screen.queryByTestId('highlight-ring')).toBeNull();
  });

  it('does NOT render a highlight ring by default (isHighlighted omitted)', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
      />,
    );
    expect(screen.queryByTestId('highlight-ring')).toBeNull();
  });

  it('sets data-highlighted="true" on the seat element when highlighted', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={true}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.getAttribute('data-highlighted')).toBe('true');
  });

  it('does not set data-highlighted on the seat when not highlighted', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={false}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.getAttribute('data-highlighted')).toBeNull();
  });

  it('renders with role="button" and tabIndex=0 when highlighted with click handler', () => {
    const handleClick = jest.fn();
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={true}
        onHighlightClick={handleClick}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.getAttribute('role')).toBe('button');
    expect(seat.getAttribute('tabindex')).toBe('0');
  });

  it('calls onHighlightClick when the highlighted seat is clicked', () => {
    const handleClick = jest.fn();
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={true}
        onHighlightClick={handleClick}
      />,
    );
    screen.getByTestId('game-player-seat').click();
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onHighlightClick when isHighlighted=false', () => {
    const handleClick = jest.fn();
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={false}
        onHighlightClick={handleClick}
      />,
    );
    screen.getByTestId('game-player-seat').click();
    expect(handleClick).not.toHaveBeenCalled();
  });

  it('does NOT show highlight ring when player is eliminated even if isHighlighted=true', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ isEliminated: true })}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={true}
      />,
    );
    // Eliminated seats suppress the highlight
    expect(screen.queryByTestId('highlight-ring')).toBeNull();
  });

  it('includes "eligible for next turn" in aria-label when highlighted and not eliminated', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ displayName: 'Bob' })}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={true}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.getAttribute('aria-label')).toContain('eligible for next turn');
  });

  it('does not include "eligible for next turn" in aria-label when not highlighted', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ displayName: 'Bob' })}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={false}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.getAttribute('aria-label')).not.toContain('eligible for next turn');
  });
});

// ── AC 55: Mobile tap-target enlargement during turn-pass selection ───────────
//
// When a seat is both highlighted AND has a click handler (turn-pass selection
// mode), the seat must enlarge on mobile to ensure a minimum 44 px tap-target
// height, and the avatar must upgrade from 'sm' (32 px) to 'md' (40 px).
// On desktop (md breakpoint and above) the scale resets to normal so the
// compact oval-table layout is preserved.
//
// Spec requirements:
//  • min-h-[2.75rem]  → guarantees ≥44 px height on all viewports
//  • scale-110        → mobile: seat is statically enlarged
//  • md:scale-100     → desktop: base scale reset to 1.0
//  • md:hover:scale-105 → desktop: subtle hover feedback only
//  • Avatar size 'md' (w-10 h-10 = 40 px) when isClickable
//  • data-mobile-tap-target="true" for e2e / a11y tooling

describe('GamePlayerSeat — AC 55 mobile tap-target enlargement', () => {
  it('applies min-h-[2.75rem] to guaranteed ≥44px tap-target height when highlighted+clickable', () => {
    const handleClick = jest.fn();
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={true}
        onHighlightClick={handleClick}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.className).toContain('min-h-[2.75rem]');
  });

  it('applies scale-110 (mobile static enlargement) when highlighted+clickable', () => {
    const handleClick = jest.fn();
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={true}
        onHighlightClick={handleClick}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.className).toContain('scale-110');
  });

  it('applies md:scale-100 (desktop scale reset) when highlighted+clickable', () => {
    const handleClick = jest.fn();
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={true}
        onHighlightClick={handleClick}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.className).toContain('md:scale-100');
  });

  it('applies md:hover:scale-105 (desktop hover feedback) when highlighted+clickable', () => {
    const handleClick = jest.fn();
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={true}
        onHighlightClick={handleClick}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.className).toContain('md:hover:scale-105');
  });

  it('sets data-mobile-tap-target="true" when highlighted+clickable', () => {
    const handleClick = jest.fn();
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={true}
        onHighlightClick={handleClick}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.getAttribute('data-mobile-tap-target')).toBe('true');
  });

  it('does NOT apply min-h-[2.75rem] when isHighlighted=false', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={false}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.className).not.toContain('min-h-[2.75rem]');
  });

  it('does NOT apply min-h-[2.75rem] when highlighted but no click handler', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={true}
        // onHighlightClick intentionally omitted
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.className).not.toContain('min-h-[2.75rem]');
  });

  it('does NOT apply mobile enlargement when player is eliminated even if highlighted+clickable', () => {
    const handleClick = jest.fn();
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ isEliminated: true })}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={true}
        onHighlightClick={handleClick}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    // isClickable is false for eliminated players → no tap-target enlargement
    expect(seat.className).not.toContain('min-h-[2.75rem]');
    expect(seat.getAttribute('data-mobile-tap-target')).toBeNull();
  });

  it('does NOT set data-mobile-tap-target when not highlighted', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={false}
      />,
    );
    const seat = screen.getByTestId('game-player-seat');
    expect(seat.getAttribute('data-mobile-tap-target')).toBeNull();
  });

  it('renders the Avatar at md size (w-10 h-10 = 40px) when highlighted+clickable', () => {
    const handleClick = jest.fn();
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ avatarId: null })}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={true}
        onHighlightClick={handleClick}
      />,
    );
    // Avatar md size uses Tailwind classes w-10 h-10
    const avatarEl = container.querySelector('[role="img"]') as HTMLElement;
    expect(avatarEl).not.toBeNull();
    expect(avatarEl.className).toContain('w-10');
    expect(avatarEl.className).toContain('h-10');
  });

  it('renders the Avatar at sm size (w-8 h-8 = 32px) when NOT highlighted', () => {
    const { container } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ avatarId: null })}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={false}
      />,
    );
    const avatarEl = container.querySelector('[role="img"]') as HTMLElement;
    expect(avatarEl).not.toBeNull();
    expect(avatarEl.className).toContain('w-8');
    expect(avatarEl.className).toContain('h-8');
  });

  it('renders Avatar at sm size when highlighted but no click handler (read-only highlight)', () => {
    render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer({ avatarId: null })}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={true}
        // No onHighlightClick — other players see cyan ring but cannot click
      />,
    );
    const avatarEl = document.querySelector('[role="img"]') as HTMLElement;
    expect(avatarEl).not.toBeNull();
    // isClickable=false → avatarSize='sm'
    expect(avatarEl.className).toContain('w-8');
    expect(avatarEl.className).toContain('h-8');
  });

  it('enlargement classes are removed when turn-pass selection ends (isHighlighted reverts to false)', () => {
    const handleClick = jest.fn();
    const { rerender } = render(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={true}
        onHighlightClick={handleClick}
      />,
    );
    // Verify tap-target present during selection mode
    expect(screen.getByTestId('game-player-seat').className).toContain('min-h-[2.75rem]');

    // Simulate selection complete — isHighlighted clears
    rerender(
      <GamePlayerSeat
        seatIndex={0}
        player={makePlayer()}
        myPlayerId="other"
        currentTurnPlayerId={null}
        isHighlighted={false}
      />,
    );
    expect(screen.getByTestId('game-player-seat').className).not.toContain('min-h-[2.75rem]');
    expect(screen.getByTestId('game-player-seat').getAttribute('data-mobile-tap-target')).toBeNull();
  });
});

describe('GamePlayerSeat — inline ask target mode', () => {
  it('renders ask-target affordances and fires onAskTargetClick when tapped', () => {
    const onAskTargetClick = jest.fn();

    render(
      <GamePlayerSeat
        seatIndex={1}
        player={makePlayer({ playerId: 'p4', displayName: 'Carol', teamId: 2 })}
        myPlayerId="p1"
        currentTurnPlayerId="p1"
        isAskTargetable={true}
        onAskTargetClick={onAskTargetClick}
      />,
    );

    const seat = screen.getByRole('button', { name: /Carol.*ask target/i });
    expect(seat.getAttribute('data-ask-targetable')).toBe('true');
    expect(screen.getByTestId('ask-target-ring')).toBeTruthy();

    fireEvent.click(seat);
    expect(onAskTargetClick).toHaveBeenCalledTimes(1);
  });
});
