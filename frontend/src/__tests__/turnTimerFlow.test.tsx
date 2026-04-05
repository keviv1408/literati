/**
 * @jest-environment jsdom
 *
 * Integration tests for the 30-second turn timer across the card-request flow.
 *
 * Implement a continuous 30-second server-side turn timer for the
 * card request flow that persists across step navigation and triggers an
 * auto-forfeit/skip on expiry.
 *
 * Coverage:
 * AskCardModal with timer:
 * • Renders TurnTimerStrip when turnTimer prop is provided
 * • Does NOT render TurnTimerStrip when turnTimer is null/undefined
 * • Timer strip shows "Your turn" for the local player
 * • Timer strip shows "Turn timer" for another player's timer
 * • Timer strip is visible inside the modal (not obscured by backdrop)
 * DeclareModal with timer:
 * • Renders TurnTimerStrip when turnTimer prop is provided
 * • Does NOT render TurnTimerStrip when turnTimer is null/undefined
 * • Timer strip shows "Your turn" for the local player
 * Timer expiry seconds display:
 * • Correct seconds shown for a 30 s timer with 20 s remaining
 * • Correct seconds shown for a 30 s timer with 5 s remaining (danger zone)
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import AskCardModal from '@/components/AskCardModal';
import DeclareModal from '@/components/DeclareModal';
import type { GamePlayer, DeclaredSuit } from '@/types/game';
import type { TurnTimerPayload } from '@/hooks/useGameSocket';

// ---------------------------------------------------------------------------
// Suppress requestAnimationFrame so timer RAF loop doesn't run
// ---------------------------------------------------------------------------
beforeAll(() => {
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DURATION_MS = 30_000;
const MY_PLAYER_ID = 'p1';

function makeTimer(remainingMs: number, playerId = MY_PLAYER_ID): TurnTimerPayload {
  return {
    type:       'turn_timer',
    playerId,
    durationMs: DURATION_MS,
    expiresAt:  Date.now() + remainingMs,
  };
}

function makePlayer(overrides: Partial<GamePlayer> = {}): GamePlayer {
  return {
    playerId:    'p1',
    displayName: 'TestPlayer',
    avatarId:    null,
    teamId:      1,
    seatIndex:   0,
    cardCount:   6,
    isBot:       false,
    isGuest:     true,
    isCurrentTurn: false,
    ...overrides,
  };
}

/** A minimal 6-player roster: T1 = p1,p2,p3 T2 = p4,p5,p6 */
function make6Players(): GamePlayer[] {
  return [
    makePlayer({ playerId: 'p1', displayName: 'Me',    teamId: 1, seatIndex: 0 }),
    makePlayer({ playerId: 'p2', displayName: 'Alice',  teamId: 1, seatIndex: 2 }),
    makePlayer({ playerId: 'p3', displayName: 'Bob',    teamId: 1, seatIndex: 4 }),
    makePlayer({ playerId: 'p4', displayName: 'Carol',  teamId: 2, seatIndex: 1 }),
    makePlayer({ playerId: 'p5', displayName: 'Dave',   teamId: 2, seatIndex: 3 }),
    makePlayer({ playerId: 'p6', displayName: 'Eve',    teamId: 2, seatIndex: 5 }),
  ];
}

// ---------------------------------------------------------------------------
// AskCardModal — timer prop
// ---------------------------------------------------------------------------

describe('AskCardModal — turnTimer prop', () => {
  const defaultAskProps = {
    selectedCard: '3_h' as const,
    myPlayerId:   MY_PLAYER_ID,
    players:      make6Players(),
    variant:      'remove_7s' as const,
    onConfirm:    jest.fn(),
    onCancel:     jest.fn(),
  };

  it('renders TurnTimerStrip when turnTimer is provided', () => {
    render(
      <AskCardModal
        {...defaultAskProps}
        turnTimer={makeTimer(20_000)}
      />
    );
    expect(screen.getByTestId('turn-timer-strip')).toBeTruthy();
  });

  it('does NOT render TurnTimerStrip when turnTimer is null', () => {
    render(<AskCardModal {...defaultAskProps} turnTimer={null} />);
    expect(screen.queryByTestId('turn-timer-strip')).toBeNull();
  });

  it('does NOT render TurnTimerStrip when turnTimer is omitted', () => {
    render(<AskCardModal {...defaultAskProps} />);
    expect(screen.queryByTestId('turn-timer-strip')).toBeNull();
  });

  it('shows "Your turn" label when timer belongs to the local player', () => {
    render(
      <AskCardModal
        {...defaultAskProps}
        turnTimer={makeTimer(20_000, MY_PLAYER_ID)}
      />
    );
    expect(screen.getByText('Your turn')).toBeTruthy();
  });

  it('shows "Turn timer" label when timer belongs to another player', () => {
    render(
      <AskCardModal
        {...defaultAskProps}
        turnTimer={makeTimer(20_000, 'other-player')}
      />
    );
    expect(screen.getByText('Turn timer')).toBeTruthy();
  });

  it('timer strip is inside the modal dialog element', () => {
    render(
      <AskCardModal
        {...defaultAskProps}
        turnTimer={makeTimer(20_000)}
      />
    );
    const dialog = screen.getByRole('dialog');
    // The strip should be a descendant of the dialog
    const strip = screen.getByTestId('turn-timer-strip');
    expect(dialog.contains(strip)).toBe(true);
  });

  it('shows correct remaining seconds in the strip', () => {
    render(
      <AskCardModal
        {...defaultAskProps}
        turnTimer={makeTimer(20_000)}
      />
    );
    // 20000ms → ceil(20000/1000) = 20s
    expect(screen.getByTestId('turn-timer-seconds').textContent).toBe('20s');
  });

  it('timer still visible and functional alongside opponent list', () => {
    render(
      <AskCardModal
        {...defaultAskProps}
        turnTimer={makeTimer(15_000)}
      />
    );
    // Timer strip should be rendered
    expect(screen.getByTestId('turn-timer-strip')).toBeTruthy();
    // Opponents should still be rendered
    expect(screen.getByRole('button', { name: /Carol/i })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// DeclareModal — timer prop
// ---------------------------------------------------------------------------

describe('DeclareModal — turnTimer prop', () => {
  const defaultDeclareProps = {
    myPlayerId:   MY_PLAYER_ID,
    myHand:       ['3_h', '4_h', '5_h'] as const,
    players:      make6Players(),
    variant:      'remove_7s' as const,
    declaredSuits: [] as DeclaredSuit[],
    onConfirm:    jest.fn(),
    onCancel:     jest.fn(),
  };

  it('renders TurnTimerStrip when turnTimer is provided', () => {
    render(
      <DeclareModal
        {...defaultDeclareProps}
        turnTimer={makeTimer(25_000)}
      />
    );
    expect(screen.getByTestId('turn-timer-strip')).toBeTruthy();
  });

  it('does NOT render TurnTimerStrip when turnTimer is null', () => {
    render(<DeclareModal {...defaultDeclareProps} turnTimer={null} />);
    expect(screen.queryByTestId('turn-timer-strip')).toBeNull();
  });

  it('does NOT render TurnTimerStrip when turnTimer is omitted', () => {
    render(<DeclareModal {...defaultDeclareProps} />);
    expect(screen.queryByTestId('turn-timer-strip')).toBeNull();
  });

  it('shows "Your turn" when timer belongs to local player', () => {
    render(
      <DeclareModal
        {...defaultDeclareProps}
        turnTimer={makeTimer(25_000, MY_PLAYER_ID)}
      />
    );
    expect(screen.getByText('Your turn')).toBeTruthy();
  });

  it('timer strip is inside the modal dialog', () => {
    render(
      <DeclareModal
        {...defaultDeclareProps}
        turnTimer={makeTimer(25_000)}
      />
    );
    const dialog = screen.getByRole('dialog');
    const strip  = screen.getByTestId('turn-timer-strip');
    expect(dialog.contains(strip)).toBe(true);
  });

  it('shows correct remaining seconds', () => {
    render(
      <DeclareModal
        {...defaultDeclareProps}
        turnTimer={makeTimer(25_000)}
      />
    );
    expect(screen.getByTestId('turn-timer-seconds').textContent).toBe('25s');
  });

  it('timer strip remains visible on Step 2 (suit selected) — step navigation', () => {
    render(
      <DeclareModal
        {...defaultDeclareProps}
        myHand={['3_h', '4_h', '5_h', '6_h', '1_h', '2_h']}
        turnTimer={makeTimer(18_000)}
      />
    );
    // Click on a half-suit to navigate to step 2
    const suitButton = screen.getByRole('button', { name: /Low Hearts/i });
    fireEvent.click(suitButton);
    // Timer should still be rendered
    expect(screen.getByTestId('turn-timer-strip')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Danger zone thresholds
// ---------------------------------------------------------------------------

describe('Timer danger zone (< 25%) — visual indicators', () => {
  it('AskCardModal: fill is red when < 25% of duration remains (5 s of 30 s)', () => {
    render(
      <AskCardModal
        selectedCard="3_h"
        myPlayerId={MY_PLAYER_ID}
        players={make6Players()}
        variant="remove_7s"
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        turnTimer={makeTimer(5_000)}
      />
    );
    const fill = screen.getByTestId('turn-timer-strip-fill');
    expect(fill.className).toContain('bg-red-500');
  });

  it('DeclareModal: fill is red when < 25% of duration remains', () => {
    render(
      <DeclareModal
        myPlayerId={MY_PLAYER_ID}
        myHand={['3_h']}
        players={make6Players()}
        variant="remove_7s"
        declaredSuits={[]}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        turnTimer={makeTimer(4_000)}
      />
    );
    const fill = screen.getByTestId('turn-timer-strip-fill');
    expect(fill.className).toContain('bg-red-500');
  });
});
