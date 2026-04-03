/**
 * @jest-environment jsdom
 *
 * Tests for DeclareModal — drag-and-drop card assignment UI.
 *
 * Coverage:
 * [Step 1 — suit selection]
 * • Renders the half-suit selection step on open
 * • Shows all 8 undeclared half-suit options
 * • Already-declared suits are excluded from the selection grid
 * • Shows "you hold N/6" for each half-suit
 * • Fires onCancel when Cancel is clicked
 *
 * [Step 2 — card assignment]
 * • Selecting a suit navigates to the card assignment step
 * • Back button returns to the suit selection step
 * • Hand cards are auto-assigned and shown in the "You" zone
 * • Non-hand cards appear in the unassigned pool
 * • Teammate drop zones are rendered (one per teammate)
 * • Tap-to-assign: tap a card, then tap a zone to assign
 * • Submit enabled only when all 6 cards assigned
 * • Fires onConfirm with halfSuitId and assignment when confirmed
 * • Works with 6-player and 8-player rosters
 * • Loading state: "Declaring…" button, disabled controls
 * • Progress broadcasting: onDeclareProgress fires on changes
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import DeclareModal from '@/components/DeclareModal';
import type { GamePlayer, DeclaredSuit } from '@/types/game';

// ---------------------------------------------------------------------------
// Mock @dnd-kit — prevent real pointer/touch event simulation in jsdom
// ---------------------------------------------------------------------------

jest.mock('@dnd-kit/core', () => {
  const actual = jest.requireActual('@dnd-kit/core');
  return {
    ...actual,
    DndContext: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="dnd-context">{children}</div>
    ),
    useDraggable: ({ id }: { id: string; disabled?: boolean }) => ({
      attributes: { 'data-draggable-id': id },
      listeners: {},
      setNodeRef: () => {},
      transform: null,
      isDragging: false,
    }),
    useDroppable: () => ({
      setNodeRef: () => {},
      isOver: false,
    }),
    useSensor: (sensor: unknown, config: unknown) => ({ sensor, config }),
    useSensors: (...s: unknown[]) => s,
    DragOverlay: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="drag-overlay">{children}</div>
    ),
  };
});

jest.mock('@dnd-kit/utilities', () => ({
  CSS: { Translate: { toString: () => '' } },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPlayer(overrides: Partial<GamePlayer> = {}): GamePlayer {
  return {
    playerId: 'p1',
    displayName: 'Me',
    avatarId: null,
    teamId: 1,
    seatIndex: 0,
    cardCount: 5,
    isBot: false,
    isGuest: true,
    isCurrentTurn: true,
    ...overrides,
  };
}

function build6Players(): GamePlayer[] {
  return [
    buildPlayer({ playerId: 'p1', displayName: 'Me',    teamId: 1, seatIndex: 0 }),
    buildPlayer({ playerId: 'p2', displayName: 'Alice', teamId: 1, seatIndex: 2 }),
    buildPlayer({ playerId: 'p3', displayName: 'Bob',   teamId: 1, seatIndex: 4 }),
    buildPlayer({ playerId: 'p4', displayName: 'Carol', teamId: 2, seatIndex: 1 }),
    buildPlayer({ playerId: 'p5', displayName: 'Dave',  teamId: 2, seatIndex: 3 }),
    buildPlayer({ playerId: 'p6', displayName: 'Eve',   teamId: 2, seatIndex: 5 }),
  ];
}

function build8Players(): GamePlayer[] {
  return [
    buildPlayer({ playerId: 'p1',  displayName: 'Me',   teamId: 1, seatIndex: 0 }),
    buildPlayer({ playerId: 'p2',  displayName: 'T1B',  teamId: 1, seatIndex: 2 }),
    buildPlayer({ playerId: 'p3',  displayName: 'T1C',  teamId: 1, seatIndex: 4 }),
    buildPlayer({ playerId: 'p4',  displayName: 'T1D',  teamId: 1, seatIndex: 6 }),
    buildPlayer({ playerId: 'p5',  displayName: 'T2A',  teamId: 2, seatIndex: 1 }),
    buildPlayer({ playerId: 'p6',  displayName: 'T2B',  teamId: 2, seatIndex: 3 }),
    buildPlayer({ playerId: 'p7',  displayName: 'T2C',  teamId: 2, seatIndex: 5 }),
    buildPlayer({ playerId: 'p8',  displayName: 'T2D',  teamId: 2, seatIndex: 7 }),
  ];
}

function renderModal(
  overrides: Partial<{
    myPlayerId: string;
    myHand: string[];
    players: GamePlayer[];
    variant: 'remove_2s' | 'remove_7s' | 'remove_8s';
    declaredSuits: DeclaredSuit[];
    onConfirm: jest.Mock;
    onCancel: jest.Mock;
    isLoading: boolean;
    onDeclareProgress: jest.Mock;
    onSuitSelect: jest.Mock;
  }> = {}
) {
  const props = {
    myPlayerId: 'p1',
    myHand: ['1_s'],
    players: build6Players(),
    variant: 'remove_7s' as const,
    declaredSuits: [],
    onConfirm: jest.fn(),
    onCancel: jest.fn(),
    isLoading: false,
    ...overrides,
  };
  return { ...render(<DeclareModal {...props} />), props };
}

function openLowSpades() {
  fireEvent.click(screen.getByRole('button', { name: /Low Spades/i }));
}

// ---------------------------------------------------------------------------
// Suit selection step
// ---------------------------------------------------------------------------

describe('DeclareModal — suit selection step', () => {
  it('renders the "Declare a Half-Suit" heading', () => {
    renderModal();
    expect(screen.getByText('Declare a Half-Suit')).toBeTruthy();
  });

  it('shows the "Select a half-suit to declare" prompt', () => {
    renderModal();
    expect(screen.getByText(/Select a half-suit to declare/i)).toBeTruthy();
  });

  it('renders 8 half-suit buttons when nothing has been declared', () => {
    renderModal({ declaredSuits: [] });
    const suitButtons = screen.getAllByRole('button', { name: /Declare (Low|High)/i });
    expect(suitButtons).toHaveLength(8);
  });

  it('excludes already-declared suits from the selection grid', () => {
    const declared: DeclaredSuit[] = [
      { halfSuitId: 'low_s', teamId: 1, declaredBy: 'p1' },
    ];
    renderModal({ declaredSuits: declared });
    const suitButtons = screen.getAllByRole('button', { name: /Declare (Low|High)/i });
    expect(suitButtons).toHaveLength(7);
    expect(screen.queryByRole('button', { name: /Low Spades/i })).toBeNull();
  });

  it('shows "you hold N/6" count for each undeclared suit', () => {
    const myHand = ['1_h', '3_h'];
    renderModal({ myHand });
    expect(screen.getByRole('button', { name: /Declare Low Hearts.*2\/6/i })).toBeTruthy();
  });

  it('shows "all half-suits declared" message when everything is declared', () => {
    const allSuits: DeclaredSuit[] = [
      'low_s', 'low_h', 'low_d', 'low_c',
      'high_s', 'high_h', 'high_d', 'high_c',
    ].map((halfSuitId) => ({ halfSuitId, teamId: 1 as const, declaredBy: 'p1' }));
    renderModal({ declaredSuits: allSuits });
    expect(screen.getByText(/All half-suits have been declared/i)).toBeTruthy();
  });

  it('fires onCancel when Cancel is clicked from the selection step', () => {
    const onCancel = jest.fn();
    renderModal({ onCancel });
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Card assignment step — structure
// ---------------------------------------------------------------------------

describe('DeclareModal — card assignment step structure', () => {
  it('navigates to card assignment after selecting a suit', () => {
    renderModal();
    openLowSpades();
    expect(screen.getByText(/Low Spades/)).toBeTruthy();
  });

  it('shows "Back" button in the card assignment step', () => {
    renderModal();
    openLowSpades();
    expect(screen.getByRole('button', { name: /Back/i })).toBeTruthy();
  });

  it('clicking Back returns to suit selection', () => {
    renderModal();
    openLowSpades();
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(screen.getByText(/Select a half-suit to declare/i)).toBeTruthy();
  });

  it('renders teammate drop zones (one per same-team player)', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    const zones = screen.getAllByTestId('teammate-drop-zone');
    expect(zones).toHaveLength(3);
  });

  it('teammate zones show player names', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    const zones = screen.getAllByTestId('teammate-drop-zone');
    const zoneText = zones.map((z) => z.textContent ?? '').join(' ');
    expect(zoneText).toMatch(/Me/);
    expect(zoneText).toMatch(/Alice/);
    expect(zoneText).toMatch(/Bob/);
  });

  it('teammate zones do NOT include opponents', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    const zones = screen.getAllByTestId('teammate-drop-zone');
    const zoneText = zones.map((z) => z.textContent ?? '').join(' ');
    expect(zoneText).not.toMatch(/Carol/);
    expect(zoneText).not.toMatch(/Dave/);
    expect(zoneText).not.toMatch(/Eve/);
  });

  it('shows "You" label on the player\'s own zone', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    const myZone = screen.getAllByTestId('teammate-drop-zone')
      .find((z) => z.getAttribute('data-player-id') === 'p1');
    expect(myZone).toBeTruthy();
    expect(myZone!.textContent).toMatch(/You/);
  });

  it('marks the player\'s own zone as disabled because self cards are auto-assigned', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    const myZone = screen.getAllByTestId('teammate-drop-zone')
      .find((z) => z.getAttribute('data-player-id') === 'p1');
    expect(myZone).toBeTruthy();
    expect(myZone).toHaveAttribute('aria-disabled', 'true');
    expect(myZone!.textContent).toMatch(/Auto-assigned/i);
  });

  it('hand cards appear in the "You" zone with a check mark', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    const myZone = screen.getAllByTestId('teammate-drop-zone')
      .find((z) => z.getAttribute('data-player-id') === 'p1');
    expect(myZone).toBeTruthy();
    expect(myZone!.textContent).toMatch(/✓/);
  });

  it('non-hand cards appear in the unassigned pool', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    const pool = screen.getByTestId('unassigned-pool');
    const cards = within(pool).getAllByTestId('draggable-card');
    expect(cards).toHaveLength(5);
  });

  it('shows assigned/total counter', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    expect(screen.getByText(/1\/6 assigned/)).toBeTruthy();
  });

  it('shows 4 teammate zones in 8-player game', () => {
    renderModal({ myHand: ['1_s'], players: build8Players() });
    openLowSpades();
    const zones = screen.getAllByTestId('teammate-drop-zone');
    expect(zones).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Tap-to-assign interaction
// ---------------------------------------------------------------------------

describe('DeclareModal — tap-to-assign', () => {
  it('tapping a card in the unassigned pool shows hint text', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    const pool = screen.getByTestId('unassigned-pool');
    const cards = within(pool).getAllByTestId('draggable-card');
    fireEvent.click(cards[0]);
    expect(screen.getByText(/Tap a teammate above/i)).toBeTruthy();
  });

  it('tapping a teammate zone after selecting a card assigns it', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    const pool = screen.getByTestId('unassigned-pool');
    const cards = within(pool).getAllByTestId('draggable-card');
    fireEvent.click(cards[0]);
    const aliceZone = screen.getAllByTestId('teammate-drop-zone')
      .find((z) => z.getAttribute('data-player-id') === 'p2');
    fireEvent.click(aliceZone!);
    expect(screen.getByText(/2\/6 assigned/)).toBeTruthy();
  });

  it('ignores taps on the disabled self zone after selecting a card', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    const pool = screen.getByTestId('unassigned-pool');
    const cards = within(pool).getAllByTestId('draggable-card');
    fireEvent.click(cards[0]);
    const myZone = screen.getAllByTestId('teammate-drop-zone')
      .find((z) => z.getAttribute('data-player-id') === 'p1');
    fireEvent.click(myZone!);
    expect(screen.getByText(/1\/6 assigned/)).toBeTruthy();
  });

  it('tapping the same card again deselects it', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    const pool = screen.getByTestId('unassigned-pool');
    const cards = within(pool).getAllByTestId('draggable-card');
    fireEvent.click(cards[0]);
    expect(screen.getByText(/Tap a teammate above/i)).toBeTruthy();
    fireEvent.click(cards[0]);
    expect(screen.getByText(/Drag cards to teammates/i)).toBeTruthy();
  });

  it('all-hand-cards case shows "All cards assigned" message', () => {
    renderModal({
      myHand: ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'],
      players: build6Players(),
    });
    openLowSpades();
    expect(screen.getByText(/All cards assigned/i)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Submit behavior
// ---------------------------------------------------------------------------

describe('DeclareModal — submit', () => {
  it('submit button is disabled when not all cards are assigned', () => {
    renderModal({ myHand: ['1_s'], players: build6Players() });
    openLowSpades();
    expect(screen.getByTestId('declare-submit-btn')).toBeDisabled();
  });

  it('submit button is enabled when all 6 cards are assigned', () => {
    renderModal({
      myHand: ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'],
      players: build6Players(),
    });
    openLowSpades();
    expect(screen.getByTestId('declare-submit-btn')).not.toBeDisabled();
  });

  it('fires onConfirm with correct halfSuitId and assignment', () => {
    const onConfirm = jest.fn();
    renderModal({
      myHand: ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'],
      players: build6Players(),
      onConfirm,
    });
    openLowSpades();
    fireEvent.click(screen.getByTestId('declare-submit-btn'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [halfSuitId, assignment] = onConfirm.mock.calls[0];
    expect(halfSuitId).toBe('low_s');
    expect(Object.keys(assignment)).toHaveLength(6);
  });

  it('fires onCancel when Cancel is clicked from assignment step', () => {
    const onCancel = jest.fn();
    renderModal({ onCancel });
    openLowSpades();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('submit button not rendered in Step 1', () => {
    renderModal();
    expect(screen.queryByTestId('declare-submit-btn')).toBeNull();
  });

  it('does NOT fire onConfirm when submit is clicked while isLoading', () => {
    const onConfirm = jest.fn();
    renderModal({
      isLoading: true,
      myHand: ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'],
      onConfirm,
    });
    openLowSpades();
    const btn = screen.getByTestId('declare-submit-btn');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

describe('DeclareModal — loading state', () => {
  it('shows "Declaring…" label when isLoading', () => {
    renderModal({
      isLoading: true,
      myHand: ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'],
    });
    openLowSpades();
    expect(screen.getByText('Declaring…')).toBeTruthy();
  });

  it('submit button is disabled when isLoading', () => {
    renderModal({
      isLoading: true,
      myHand: ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'],
    });
    openLowSpades();
    expect(screen.getByTestId('declare-submit-btn')).toBeDisabled();
  });

  it('cancel button is disabled when isLoading', () => {
    renderModal({
      isLoading: true,
      myHand: ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'],
    });
    openLowSpades();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();
  });

  it('dialog has aria-busy="true" while isLoading', () => {
    renderModal({
      isLoading: true,
      myHand: ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'],
    });
    openLowSpades();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-busy')).toBe('true');
  });

  it('dialog does NOT have aria-busy="true" before submission', () => {
    renderModal({ isLoading: false });
    openLowSpades();
    const dialog = screen.getByRole('dialog');
    const ariaBusy = dialog.getAttribute('aria-busy');
    expect(ariaBusy === null || ariaBusy === 'false').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8-player game
// ---------------------------------------------------------------------------

describe('DeclareModal — 8-player game', () => {
  it('shows all 4 teammate zones with names', () => {
    renderModal({ myHand: ['1_s'], players: build8Players() });
    openLowSpades();
    const zones = screen.getAllByTestId('teammate-drop-zone');
    expect(zones).toHaveLength(4);
    const zoneText = zones.map((z) => z.textContent ?? '').join(' ');
    expect(zoneText).toMatch(/T1B/);
    expect(zoneText).toMatch(/T1C/);
    expect(zoneText).toMatch(/T1D/);
  });

  it('does not show opponent zones', () => {
    renderModal({ myHand: ['1_s'], players: build8Players() });
    openLowSpades();
    const zones = screen.getAllByTestId('teammate-drop-zone');
    const zoneText = zones.map((z) => z.textContent ?? '').join(' ');
    expect(zoneText).not.toMatch(/T2A/);
    expect(zoneText).not.toMatch(/T2B/);
  });
});

// ---------------------------------------------------------------------------
// Progress broadcasting
// ---------------------------------------------------------------------------

describe('DeclareModal — progress broadcasting', () => {
  it('fires onDeclareProgress when suit is selected', () => {
    const onDeclareProgress = jest.fn();
    renderModal({ myHand: ['1_s'], players: build6Players(), onDeclareProgress });
    openLowSpades();
    expect(onDeclareProgress).toHaveBeenCalled();
    const [suitId, assignmentArg] = onDeclareProgress.mock.calls[0];
    expect(suitId).toBe('low_s');
    expect(assignmentArg['1_s']).toBe('p1');
  });

  it('fires onDeclareProgress with null on Back (cancellation)', () => {
    const onDeclareProgress = jest.fn();
    renderModal({ myHand: ['1_s'], players: build6Players(), onDeclareProgress });
    openLowSpades();
    onDeclareProgress.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(onDeclareProgress).toHaveBeenCalledWith(null, {});
  });

  it('fires onSuitSelect with halfSuitId when suit is selected', () => {
    const onSuitSelect = jest.fn();
    renderModal({ myHand: ['1_s'], players: build6Players(), onSuitSelect });
    openLowSpades();
    expect(onSuitSelect).toHaveBeenCalledWith('low_s');
  });

  it('fires onSuitSelect with null on Back', () => {
    const onSuitSelect = jest.fn();
    renderModal({ myHand: ['1_s'], players: build6Players(), onSuitSelect });
    openLowSpades();
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(onSuitSelect).toHaveBeenCalledWith(null);
  });

  it('fires onDeclareProgress when tap-to-assign changes the assignment', () => {
    const onDeclareProgress = jest.fn();
    renderModal({ myHand: ['1_s'], players: build6Players(), onDeclareProgress });
    openLowSpades();
    onDeclareProgress.mockClear();

    // Select a card and assign it
    const pool = screen.getByTestId('unassigned-pool');
    const cards = within(pool).getAllByTestId('draggable-card');
    fireEvent.click(cards[0]);
    const aliceZone = screen.getAllByTestId('teammate-drop-zone')
      .find((z) => z.getAttribute('data-player-id') === 'p2');
    fireEvent.click(aliceZone!);

    expect(onDeclareProgress).toHaveBeenCalled();
    const lastCall = onDeclareProgress.mock.calls[onDeclareProgress.mock.calls.length - 1];
    expect(lastCall[0]).toBe('low_s');
  });
});

// ---------------------------------------------------------------------------
// Bot teammates
// ---------------------------------------------------------------------------

describe('DeclareModal — bot teammates', () => {
  it('shows bot teammates as drop zones', () => {
    const players = build6Players();
    players[1] = { ...players[1], displayName: 'silly_penguin', isBot: true };
    renderModal({ myHand: ['1_s'], players, myPlayerId: 'p1' });
    openLowSpades();
    const zones = screen.getAllByTestId('teammate-drop-zone');
    const zoneText = zones.map((z) => z.textContent ?? '').join(' ');
    expect(zoneText).toMatch(/silly_penguin/i);
  });
});
