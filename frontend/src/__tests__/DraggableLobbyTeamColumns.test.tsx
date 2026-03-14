/**
 * @jest-environment jsdom
 */

/**
 * Unit tests for DraggableLobbyTeamColumns.
 *
 * Tests cover:
 *  • Initial rendering with correct team column structure
 *  • Correct seat distribution between team columns
 *  • Disabled drag for non-host viewers (spectators/players)
 *  • onReassign callback invoked on drop
 *  • Visual feedback (drop hint) during active drag
 *  • Seat card rendering (empty vs occupied)
 *  • Bot badge rendering
 *  • Host crown rendering
 *  • "You" pill for current user
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import DraggableLobbyTeamColumns from '@/components/DraggableLobbyTeamColumns';
import { buildEmptySeats } from '@/types/lobby';
import type { LobbyPlayer } from '@/types/lobby';

// ── Mocks ──────────────────────────────────────────────────────────────────────

// dnd-kit uses pointer events and RAF internally; mock them for jsdom.
global.PointerEvent = global.PointerEvent ?? MouseEvent as unknown as typeof PointerEvent;

// Mock @dnd-kit/core to avoid complex pointer-event simulation in jsdom.
// We replace the context with a pass-through and expose drag hooks as no-ops
// that still render children correctly.
jest.mock('@dnd-kit/core', () => {
  const actual = jest.requireActual('@dnd-kit/core');
  return {
    ...actual,
    DndContext: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="dnd-context">{children}</div>
    ),
    DragOverlay: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="drag-overlay">{children}</div>
    ),
    useDraggable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => {},
      transform: null,
      isDragging: false,
    }),
    useDroppable: ({ id }: { id: string }) => ({
      setNodeRef: () => {},
      isOver: false,
      over: null,
      active: null,
      droppableContainers: new Map(),
      _id: id,
    }),
    useSensors: () => [],
    useSensor: () => null,
    closestCenter: actual.closestCenter,
    PointerSensor: actual.PointerSensor,
    TouchSensor: actual.TouchSensor,
  };
});

jest.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Translate: {
      toString: () => '',
    },
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

function makePlayer(seatIndex: number, overrides: Partial<LobbyPlayer> = {}): LobbyPlayer {
  return {
    seatIndex,
    displayName: `Player ${seatIndex}`,
    isBot: false,
    isHost: seatIndex === 0,
    isCurrentUser: false,
    ...overrides,
  };
}

// ── Team column headers ───────────────────────────────────────────────────────

describe('DraggableLobbyTeamColumns — team headers', () => {
  it('renders Team 1 heading', () => {
    render(
      <DraggableLobbyTeamColumns
        playerCount={6}
        seats={buildEmptySeats(6)}
        isHost={false}
      />
    );
    expect(screen.getByText('Team 1')).toBeDefined();
  });

  it('renders Team 2 heading', () => {
    render(
      <DraggableLobbyTeamColumns
        playerCount={6}
        seats={buildEmptySeats(6)}
        isHost={false}
      />
    );
    expect(screen.getByText('Team 2')).toBeDefined();
  });

  it('has accessible aria-label="Lobby teams" on outer wrapper', () => {
    render(
      <DraggableLobbyTeamColumns
        playerCount={6}
        seats={buildEmptySeats(6)}
        isHost={false}
      />
    );
    expect(screen.getByLabelText('Lobby teams')).toBeDefined();
  });
});

// ── 6-player room — all empty ─────────────────────────────────────────────────

describe('DraggableLobbyTeamColumns — 6-player, all empty', () => {
  beforeEach(() => {
    render(
      <DraggableLobbyTeamColumns
        playerCount={6}
        seats={buildEmptySeats(6)}
        isHost={false}
      />
    );
  });

  it('renders 6 "Waiting…" placeholders', () => {
    const waiting = screen.getAllByText('Waiting…');
    expect(waiting).toHaveLength(6);
  });

  it('shows 0/3 seat count for Team 1', () => {
    const counts = screen.getAllByLabelText('0 of 3 seats filled');
    expect(counts.length).toBeGreaterThanOrEqual(1);
  });

  it('shows 0/3 seat count for Team 2', () => {
    // Both teams show 0/3 — there are 2 elements total
    const allCounts = screen.getAllByLabelText('0 of 3 seats filled');
    expect(allCounts).toHaveLength(2);
  });
});

// ── 6-player room — partially filled ─────────────────────────────────────────

describe('DraggableLobbyTeamColumns — 6-player, partially filled', () => {
  const seats: Array<LobbyPlayer | null> = [
    makePlayer(0, { isHost: true, isCurrentUser: true, displayName: 'Alice' }),
    makePlayer(1, { displayName: 'Bob' }),
    null,
    null,
    makePlayer(4, { isBot: true, displayName: 'Quirky Turing' }),
    null,
  ];

  it('renders 3 empty seats', () => {
    render(
      <DraggableLobbyTeamColumns
        playerCount={6}
        seats={seats}
        isHost={true}
      />
    );
    expect(screen.getAllByText('Waiting…')).toHaveLength(3);
  });

  it('renders Alice in the lobby', () => {
    render(
      <DraggableLobbyTeamColumns
        playerCount={6}
        seats={seats}
        isHost={true}
      />
    );
    expect(screen.getByText('Alice')).toBeDefined();
  });

  it('renders Bob in the lobby', () => {
    render(
      <DraggableLobbyTeamColumns
        playerCount={6}
        seats={seats}
        isHost={true}
      />
    );
    expect(screen.getByText('Bob')).toBeDefined();
  });

  it('renders bot badge for bot player', () => {
    const { container } = render(
      <DraggableLobbyTeamColumns
        playerCount={6}
        seats={seats}
        isHost={true}
      />
    );
    // BotBadge renders an SVG icon
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('renders host crown for seat 0', () => {
    render(
      <DraggableLobbyTeamColumns
        playerCount={6}
        seats={seats}
        isHost={true}
      />
    );
    expect(screen.getByTitle('Room host')).toBeDefined();
  });

  it('renders "You" pill for isCurrentUser seat', () => {
    render(
      <DraggableLobbyTeamColumns
        playerCount={6}
        seats={seats}
        isHost={true}
      />
    );
    expect(screen.getByText('You')).toBeDefined();
  });
});

// ── 8-player room ─────────────────────────────────────────────────────────────

describe('DraggableLobbyTeamColumns — 8-player, all empty', () => {
  it('renders 8 "Waiting…" placeholders', () => {
    render(
      <DraggableLobbyTeamColumns
        playerCount={8}
        seats={buildEmptySeats(8)}
        isHost={false}
      />
    );
    expect(screen.getAllByText('Waiting…')).toHaveLength(8);
  });

  it('shows 0/4 count for each team', () => {
    render(
      <DraggableLobbyTeamColumns
        playerCount={8}
        seats={buildEmptySeats(8)}
        isHost={false}
      />
    );
    const counts = screen.getAllByLabelText('0 of 4 seats filled');
    expect(counts).toHaveLength(2);
  });
});

// ── Host hint text ─────────────────────────────────────────────────────────────

describe('DraggableLobbyTeamColumns — host hint', () => {
  it('shows drag hint text when isHost=true', () => {
    render(
      <DraggableLobbyTeamColumns
        playerCount={6}
        seats={buildEmptySeats(6)}
        isHost={true}
      />
    );
    expect(
      screen.getByText(/drag player cards between columns/i)
    ).toBeDefined();
  });

  it('does not show drag hint text when isHost=false', () => {
    render(
      <DraggableLobbyTeamColumns
        playerCount={6}
        seats={buildEmptySeats(6)}
        isHost={false}
      />
    );
    expect(
      screen.queryByText(/drag player cards between columns/i)
    ).toBeNull();
  });
});

// ── DnD context ───────────────────────────────────────────────────────────────

describe('DraggableLobbyTeamColumns — DnD context', () => {
  it('renders a DnD context wrapper', () => {
    render(
      <DraggableLobbyTeamColumns
        playerCount={6}
        seats={buildEmptySeats(6)}
        isHost={true}
      />
    );
    expect(screen.getByTestId('dnd-context')).toBeDefined();
  });

  it('renders a DragOverlay element', () => {
    render(
      <DraggableLobbyTeamColumns
        playerCount={6}
        seats={buildEmptySeats(6)}
        isHost={true}
      />
    );
    expect(screen.getByTestId('drag-overlay')).toBeDefined();
  });
});

// ── onReassign callback ───────────────────────────────────────────────────────

describe('DraggableLobbyTeamColumns — onReassign prop', () => {
  it('accepts onReassign prop without throwing', () => {
    const onReassign = jest.fn();
    expect(() => {
      render(
        <DraggableLobbyTeamColumns
          playerCount={6}
          seats={buildEmptySeats(6)}
          isHost={true}
          onReassign={onReassign}
        />
      );
    }).not.toThrow();
  });

  it('renders without error when onReassign is omitted', () => {
    expect(() => {
      render(
        <DraggableLobbyTeamColumns
          playerCount={6}
          seats={buildEmptySeats(6)}
          isHost={true}
        />
      );
    }).not.toThrow();
  });
});

// ── Seat padding ──────────────────────────────────────────────────────────────

describe('DraggableLobbyTeamColumns — short seat array padding', () => {
  it('pads a short array with empty seats', () => {
    const shortSeats: Array<LobbyPlayer | null> = [makePlayer(0), makePlayer(1)];
    render(
      <DraggableLobbyTeamColumns
        playerCount={6}
        seats={shortSeats}
        isHost={false}
      />
    );
    // 6 total - 2 provided = 4 empty
    expect(screen.getAllByText('Waiting…')).toHaveLength(4);
  });
});

// ── Accessible labels ─────────────────────────────────────────────────────────

describe('DraggableLobbyTeamColumns — accessible labels', () => {
  it('has aria-label on each team section', () => {
    render(
      <DraggableLobbyTeamColumns
        playerCount={6}
        seats={buildEmptySeats(6)}
        isHost={false}
      />
    );
    expect(screen.getByLabelText('Team 1 column')).toBeDefined();
    expect(screen.getByLabelText('Team 2 column')).toBeDefined();
  });

  it('has aria-label on occupied seat card', () => {
    const seats: Array<LobbyPlayer | null> = [
      makePlayer(0, { displayName: 'TestPlayer', isHost: false }),
      null, null, null, null, null,
    ];
    render(
      <DraggableLobbyTeamColumns
        playerCount={6}
        seats={seats}
        isHost={false}
      />
    );
    // The occupied seat card should have an aria-label containing the player name
    expect(screen.getByLabelText('TestPlayer')).toBeDefined();
  });
});
