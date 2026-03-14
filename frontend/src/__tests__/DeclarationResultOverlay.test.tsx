/**
 * @jest-environment jsdom
 *
 * Tests for DeclarationResultOverlay — Sub-AC 26c:
 * 3-second auto-dismiss countdown with visible timer, cancellable by an
 * explicit Dismiss button.  On dismiss, parent dispatches game-advance.
 *
 * Coverage:
 *   Rendering:
 *     • Mounts with data-testid="declaration-result-overlay"
 *     • Renders the result card wrapper
 *     • Shows ✅ icon for correct declaration
 *     • Shows ❌ icon for incorrect declaration
 *     • Shows "Correct Declaration!" headline for correct result
 *     • Shows "Incorrect Declaration!" headline for incorrect result
 *     • Shows declarer's display name
 *     • Shows the half-suit label
 *     • Shows the lastMove text
 *     • Renders the countdown pill with the initial countdown value
 *     • Renders the Dismiss button
 *   Countdown display:
 *     • Countdown pill shows "3s" initially (default 3 000 ms)
 *     • Countdown pill shows "2s" after 1 tick
 *     • Countdown pill shows "1s" after 2 ticks
 *   Auto-dismiss:
 *     • onDismiss NOT called on initial render
 *     • onDismiss called after countdown reaches 0
 *     • onDismiss called exactly once (no double-fire)
 *   Manual dismiss:
 *     • Pressing Dismiss calls onDismiss immediately
 *     • Pressing Dismiss cancels the interval (onDismiss not called again)
 *   Team display:
 *     • Shows "Your team scores! 🎉" when myTeamId matches winningTeam
 *     • Shows "Opponent team scores" when myTeamId does not match winningTeam
 *     • Shows generic "Team N scores!" for spectators (myTeamId null)
 *   Accessibility:
 *     • Overlay has role="dialog" and aria-modal="true"
 *     • Countdown pill has aria-live="polite"
 *     • Dismiss button has accessible aria-label
 */

import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import DeclarationResultOverlay from '@/components/DeclarationResultOverlay';
import type { DeclarationResultPayload, GamePlayer } from '@/types/game';

// ---------------------------------------------------------------------------
// Suppress console.error for act() warnings in tests
// ---------------------------------------------------------------------------
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  jest.restoreAllMocks();
});

// Use fake timers so we can control setInterval ticks
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAYERS: GamePlayer[] = [
  {
    playerId: 'p1',
    displayName: 'Alice',
    avatarId: null,
    teamId: 1,
    seatIndex: 0,
    cardCount: 5,
    isBot: false,
    isGuest: false,
    isCurrentTurn: false,
  },
  {
    playerId: 'p2',
    displayName: 'Bob',
    avatarId: null,
    teamId: 2,
    seatIndex: 1,
    cardCount: 5,
    isBot: false,
    isGuest: false,
    isCurrentTurn: false,
  },
];

function makeResult(overrides: Partial<DeclarationResultPayload> = {}): DeclarationResultPayload {
  return {
    type: 'declaration_result',
    declarerId: 'p1',
    halfSuitId: 'low_s',
    correct: true,
    winningTeam: 1,
    newTurnPlayerId: 'p2',
    assignment: {},
    lastMove: 'Alice declared Low Spades — correct!',
    ...overrides,
  };
}

function renderOverlay(
  result: DeclarationResultPayload = makeResult(),
  myTeamId: 1 | 2 | null = 1,
  onDismiss: jest.Mock = jest.fn(),
  autoDismissMs = 3_000,
) {
  return render(
    <DeclarationResultOverlay
      result={result}
      players={PLAYERS}
      myTeamId={myTeamId}
      onDismiss={onDismiss}
      autoDismissMs={autoDismissMs}
    />,
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('DeclarationResultOverlay — rendering', () => {
  it('renders the overlay wrapper', () => {
    renderOverlay();
    expect(screen.getByTestId('declaration-result-overlay')).toBeTruthy();
  });

  it('renders the result card', () => {
    renderOverlay();
    expect(screen.getByTestId('declaration-result-card')).toBeTruthy();
  });

  it('shows ✅ icon for correct declaration', () => {
    renderOverlay(makeResult({ correct: true }));
    expect(screen.getByTestId('declaration-result-icon').textContent).toBe('✅');
  });

  it('shows ❌ icon for incorrect declaration', () => {
    renderOverlay(makeResult({ correct: false, winningTeam: 2 }));
    expect(screen.getByTestId('declaration-result-icon').textContent).toBe('❌');
  });

  it('shows "Correct Declaration!" headline for correct result', () => {
    renderOverlay(makeResult({ correct: true }));
    expect(screen.getByTestId('declaration-result-headline').textContent).toContain('Correct Declaration!');
  });

  it('shows "Incorrect Declaration!" headline for incorrect result', () => {
    renderOverlay(makeResult({ correct: false, winningTeam: 2 }));
    expect(screen.getByTestId('declaration-result-headline').textContent).toContain('Incorrect Declaration!');
  });

  it("shows the declarer's display name", () => {
    renderOverlay();
    expect(screen.getByTestId('declaration-result-declarer').textContent).toContain('Alice');
  });

  it('shows the half-suit label', () => {
    renderOverlay(makeResult({ halfSuitId: 'low_s' }));
    // halfSuitLabel('low_s') → 'Low Spades'
    expect(screen.getByTestId('declaration-result-suit').textContent).toContain('Low Spades');
  });

  it('shows the lastMove text', () => {
    const lastMove = 'Alice declared Low Spades — correct!';
    renderOverlay(makeResult({ lastMove }));
    expect(screen.getByTestId('declaration-result-last-move').textContent).toContain(lastMove);
  });

  it('renders the countdown pill with initial value 3s', () => {
    renderOverlay(makeResult(), 1, jest.fn(), 3_000);
    expect(screen.getByTestId('declaration-result-countdown').textContent).toBe('3s');
  });

  it('renders the Dismiss button', () => {
    renderOverlay();
    expect(screen.getByTestId('declaration-result-dismiss-btn')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Countdown display
// ---------------------------------------------------------------------------

describe('DeclarationResultOverlay — countdown display', () => {
  it('countdown shows "3s" initially', () => {
    renderOverlay(makeResult(), 1, jest.fn(), 3_000);
    expect(screen.getByTestId('declaration-result-countdown').textContent).toBe('3s');
  });

  it('countdown shows "2s" after 1 tick (1 000 ms)', () => {
    renderOverlay(makeResult(), 1, jest.fn(), 3_000);
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(screen.getByTestId('declaration-result-countdown').textContent).toBe('2s');
  });

  it('countdown shows "1s" after 2 ticks (2 000 ms)', () => {
    renderOverlay(makeResult(), 1, jest.fn(), 3_000);
    act(() => { jest.advanceTimersByTime(2_000); });
    expect(screen.getByTestId('declaration-result-countdown').textContent).toBe('1s');
  });
});

// ---------------------------------------------------------------------------
// Auto-dismiss
// ---------------------------------------------------------------------------

describe('DeclarationResultOverlay — auto-dismiss', () => {
  it('onDismiss is NOT called on initial render', () => {
    const onDismiss = jest.fn();
    renderOverlay(makeResult(), 1, onDismiss);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('onDismiss is called after the countdown expires (3 000 ms)', () => {
    const onDismiss = jest.fn();
    renderOverlay(makeResult(), 1, onDismiss, 3_000);
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(3_100); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('onDismiss is called exactly once (no double-fire)', () => {
    const onDismiss = jest.fn();
    renderOverlay(makeResult(), 1, onDismiss, 3_000);
    act(() => { jest.advanceTimersByTime(6_000); }); // 2× the countdown
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('onDismiss fires after custom autoDismissMs (1 000 ms)', () => {
    const onDismiss = jest.fn();
    renderOverlay(makeResult(), 1, onDismiss, 1_000);
    act(() => { jest.advanceTimersByTime(1_100); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Manual dismiss via Dismiss button
// ---------------------------------------------------------------------------

describe('DeclarationResultOverlay — manual dismiss', () => {
  it('pressing Dismiss calls onDismiss immediately (before countdown)', () => {
    const onDismiss = jest.fn();
    renderOverlay(makeResult(), 1, onDismiss, 3_000);
    fireEvent.click(screen.getByTestId('declaration-result-dismiss-btn'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('after pressing Dismiss, advancing the timer does NOT call onDismiss again', () => {
    const onDismiss = jest.fn();
    renderOverlay(makeResult(), 1, onDismiss, 3_000);
    fireEvent.click(screen.getByTestId('declaration-result-dismiss-btn'));
    act(() => { jest.advanceTimersByTime(5_000); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('onDismiss is called exactly once when Dismiss is clicked before countdown', () => {
    const onDismiss = jest.fn();
    renderOverlay(makeResult(), 1, onDismiss, 3_000);
    // Click twice in rapid succession
    fireEvent.click(screen.getByTestId('declaration-result-dismiss-btn'));
    fireEvent.click(screen.getByTestId('declaration-result-dismiss-btn'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Team display
// ---------------------------------------------------------------------------

describe('DeclarationResultOverlay — team display', () => {
  it('shows "Your team scores! 🎉" when myTeamId matches winningTeam', () => {
    renderOverlay(makeResult({ winningTeam: 1 }), 1);
    expect(screen.getByTestId('declaration-result-team').textContent).toContain('Your team scores!');
  });

  it('shows "Opponent team scores" when myTeamId does not match winningTeam', () => {
    renderOverlay(makeResult({ winningTeam: 1 }), 2);
    expect(screen.getByTestId('declaration-result-team').textContent).toContain('Opponent team scores');
  });

  it('shows "Team 1 scores!" for spectators (myTeamId null, winningTeam 1)', () => {
    renderOverlay(makeResult({ winningTeam: 1 }), null);
    expect(screen.getByTestId('declaration-result-team').textContent).toContain('Team 1 scores!');
  });

  it('shows "Team 2 scores!" for spectators (myTeamId null, winningTeam 2)', () => {
    renderOverlay(makeResult({ winningTeam: 2, correct: false }), null);
    expect(screen.getByTestId('declaration-result-team').textContent).toContain('Team 2 scores!');
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe('DeclarationResultOverlay — accessibility', () => {
  it('overlay has role="dialog"', () => {
    renderOverlay();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('overlay has aria-modal="true"', () => {
    renderOverlay();
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
  });

  it('countdown pill has aria-live="polite"', () => {
    renderOverlay();
    const countdown = screen.getByTestId('declaration-result-countdown');
    expect(countdown.getAttribute('aria-live')).toBe('polite');
  });

  it('countdown pill has an aria-label mentioning the remaining seconds', () => {
    renderOverlay(makeResult(), 1, jest.fn(), 3_000);
    const countdown = screen.getByTestId('declaration-result-countdown');
    expect(countdown.getAttribute('aria-label')).toMatch(/3 second/);
  });

  it('Dismiss button has an aria-label', () => {
    renderOverlay();
    const btn = screen.getByTestId('declaration-result-dismiss-btn');
    expect(btn.getAttribute('aria-label')).toBeTruthy();
  });
});
