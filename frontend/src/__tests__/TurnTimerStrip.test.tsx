/**
 * @jest-environment jsdom
 *
 * Tests for TurnTimerStrip — (continuous 30-second turn timer
 * visible inside ask/declare modals throughout the card-request flow).
 *
 * Coverage:
 * Rendering:
 * • Renders the data-testid="turn-timer-strip" wrapper
 * • Renders a progress bar fill element (data-testid="turn-timer-strip-fill")
 * • Renders a progressbar role element with correct aria-valuemax
 * • Shows the correct remaining seconds label (data-testid="turn-timer-seconds")
 * Timer content (my timer):
 * • Shows "Your turn" label when isMyTimer=true
 * • Uses emerald fill colour when isMyTimer=true and plenty of time remains
 * Timer content (other player's timer):
 * • Shows "Turn timer" label when isMyTimer=false
 * • Uses slate fill colour when isMyTimer=false
 * Danger zone (< 25%):
 * • Fill uses red colour class when remaining is below 25% of duration
 * Already-expired timer:
 * • Renders without crashing when expiresAt is already in the past
 * • Shows "0s" countdown
 * • Fill width is 0%
 * Accessibility:
 * • progressbar has correct aria-valuenow
 * • seconds label has aria-label with remaining seconds
 * Custom className:
 * • Extra className is forwarded to the outer wrapper
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import TurnTimerStrip from '@/components/TurnTimerStrip';
import type { TurnTimerPayload } from '@/hooks/useGameSocket';

// ---------------------------------------------------------------------------
// Mock requestAnimationFrame so the RAF loop doesn't run in tests
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

/** Build a TurnTimerPayload with `remainingMs` left before expiry. */
function buildTimer(remainingMs: number, playerId = 'p1'): TurnTimerPayload {
  return {
    type: 'turn_timer',
    playerId,
    durationMs: DURATION_MS,
    expiresAt:  Date.now() + remainingMs,
  };
}

/** Render TurnTimerStrip with defaults. */
function renderStrip(
  overrides: Partial<{
    remainingMs: number;
    isMyTimer: boolean;
    className: string;
  }> = {}
) {
  const {
    remainingMs = 20_000,
    isMyTimer   = true,
    className   = undefined,
  } = overrides;

  const turnTimer = buildTimer(remainingMs);
  return {
    turnTimer,
    ...render(
      <TurnTimerStrip
        turnTimer={turnTimer}
        isMyTimer={isMyTimer}
        className={className}
      />
    ),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('TurnTimerStrip — rendering', () => {
  it('renders the turn-timer-strip wrapper', () => {
    renderStrip();
    expect(screen.getByTestId('turn-timer-strip')).toBeTruthy();
  });

  it('renders the progress bar fill element', () => {
    renderStrip();
    expect(screen.getByTestId('turn-timer-strip-fill')).toBeTruthy();
  });

  it('renders a progressbar role element', () => {
    renderStrip();
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('progressbar has correct aria-valuemax matching durationMs in seconds', () => {
    renderStrip();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemax')).toBe(String(DURATION_MS / 1000)); // 30
  });

  it('renders a seconds label element', () => {
    renderStrip();
    expect(screen.getByTestId('turn-timer-seconds')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Timer content — my timer
// ---------------------------------------------------------------------------

describe('TurnTimerStrip — my timer (isMyTimer=true)', () => {
  it('shows "Your turn" label when isMyTimer=true', () => {
    renderStrip({ isMyTimer: true });
    expect(screen.getByText('Your turn')).toBeTruthy();
  });

  it('fill element has an emerald colour class when time is > 50%', () => {
    // 20 s of 30 s = ~66%, well above danger/warning thresholds
    renderStrip({ isMyTimer: true, remainingMs: 20_000 });
    const fill = screen.getByTestId('turn-timer-strip-fill');
    expect(fill.className).toContain('bg-emerald-400');
  });
});

// ---------------------------------------------------------------------------
// Timer content — other player's timer
// ---------------------------------------------------------------------------

describe('TurnTimerStrip — other player timer (isMyTimer=false)', () => {
  it('shows "Turn timer" label when isMyTimer=false', () => {
    renderStrip({ isMyTimer: false });
    expect(screen.getByText('Turn timer')).toBeTruthy();
  });

  it('fill element has slate colour class when time is > 50% and not my timer', () => {
    renderStrip({ isMyTimer: false, remainingMs: 20_000 });
    const fill = screen.getByTestId('turn-timer-strip-fill');
    expect(fill.className).toContain('bg-slate-500');
  });
});

// ---------------------------------------------------------------------------
// Danger zone (< 25% = less than 7.5 s of 30 s)
// ---------------------------------------------------------------------------

describe('TurnTimerStrip — danger zone', () => {
  it('fill uses red-500 colour when remaining < 25% of duration', () => {
    // 5 s of 30 s ≈ 16.7% → danger
    renderStrip({ remainingMs: 5_000 });
    const fill = screen.getByTestId('turn-timer-strip-fill');
    expect(fill.className).toContain('bg-red-500');
  });

  it('fill uses red-500 even when not my timer in danger zone', () => {
    renderStrip({ remainingMs: 3_000, isMyTimer: false });
    const fill = screen.getByTestId('turn-timer-strip-fill');
    expect(fill.className).toContain('bg-red-500');
  });
});

// ---------------------------------------------------------------------------
// Already-expired timer
// ---------------------------------------------------------------------------

describe('TurnTimerStrip — already expired', () => {
  it('renders without crashing when expiresAt is already in the past', () => {
    const expiredTimer: TurnTimerPayload = {
      type: 'turn_timer',
      playerId: 'p1',
      durationMs: DURATION_MS,
      expiresAt: Date.now() - 5000, // 5 seconds ago
    };
    expect(() => render(
      <TurnTimerStrip turnTimer={expiredTimer} isMyTimer={true} />
    )).not.toThrow();
  });

  it('shows "0s" when timer has already expired', () => {
    const expiredTimer: TurnTimerPayload = {
      type: 'turn_timer',
      playerId: 'p1',
      durationMs: DURATION_MS,
      expiresAt: Date.now() - 5000,
    };
    render(<TurnTimerStrip turnTimer={expiredTimer} isMyTimer={true} />);
    expect(screen.getByTestId('turn-timer-seconds').textContent).toBe('0s');
  });

  it('fill width is 0% when timer is expired', () => {
    const expiredTimer: TurnTimerPayload = {
      type: 'turn_timer',
      playerId: 'p1',
      durationMs: DURATION_MS,
      expiresAt: Date.now() - 5000,
    };
    render(<TurnTimerStrip turnTimer={expiredTimer} isMyTimer={true} />);
    const fill = screen.getByTestId('turn-timer-strip-fill');
    expect(fill.getAttribute('style')).toContain('width: 0%');
  });
});

// ---------------------------------------------------------------------------
// Seconds display
// ---------------------------------------------------------------------------

describe('TurnTimerStrip — seconds display', () => {
  it('shows correct ceiling of remaining seconds (20000ms → 20s)', () => {
    renderStrip({ remainingMs: 20_000 });
    // Math.ceil(20000 1000) = 20
    expect(screen.getByTestId('turn-timer-seconds').textContent).toBe('20s');
  });

  it('shows 30s when full duration remains', () => {
    renderStrip({ remainingMs: 30_000 });
    expect(screen.getByTestId('turn-timer-seconds').textContent).toBe('30s');
  });

  it('shows ceiling for partial seconds (e.g. 15500ms → 16s)', () => {
    renderStrip({ remainingMs: 15_500 });
    expect(screen.getByTestId('turn-timer-seconds').textContent).toBe('16s');
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe('TurnTimerStrip — accessibility', () => {
  it('progressbar has correct aria-valuenow in seconds', () => {
    renderStrip({ remainingMs: 20_000 });
    const bar = screen.getByRole('progressbar');
    // ceil(20000/1000) = 20
    expect(Number(bar.getAttribute('aria-valuenow'))).toBe(20);
  });

  it('progressbar aria-valuemin is 0', () => {
    renderStrip();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
  });

  it('seconds label has aria-label with remaining seconds', () => {
    renderStrip({ remainingMs: 15_000 });
    // The seconds span element carries aria-label="15 seconds remaining"
    const secondsEl = screen.getByTestId('turn-timer-seconds');
    expect(secondsEl.getAttribute('aria-label')).toMatch(/15 seconds remaining/i);
  });
});

// ---------------------------------------------------------------------------
// Custom className
// ---------------------------------------------------------------------------

describe('TurnTimerStrip — className forwarding', () => {
  it('applies extra className to the outer wrapper', () => {
    renderStrip({ className: 'mt-3 custom-cls' });
    const wrapper = screen.getByTestId('turn-timer-strip');
    expect(wrapper.className).toContain('mt-3');
    expect(wrapper.className).toContain('custom-cls');
  });
});
