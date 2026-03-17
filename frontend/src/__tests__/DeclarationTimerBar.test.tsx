/**
 * @jest-environment jsdom
 *
 * Tests for DeclarationTimerBar — 60-second countdown timer
 * for the declaration phase, visible to the declarant, with a warning state
 * in the final 10 seconds, and auto-submit on expiry.
 *
 * Coverage:
 * Rendering:
 * • Renders the data-testid="declaration-timer-bar" wrapper
 * • Renders a progress bar (role="progressbar")
 * • Renders the fill element (data-testid="declaration-timer-fill")
 * • Renders the seconds label (data-testid="declaration-timer-seconds")
 * • Renders the label element (data-testid="declaration-timer-label")
 * • aria-valuemax equals durationMs/1000
 * Normal state (> 10 seconds remaining):
 * • Fill uses emerald colour class when plenty of time remains
 * • Label shows "Declaration timer" text
 * • Seconds label shows correct ceiling seconds
 * Warning state (≤ 10 seconds remaining):
 * • Fill uses amber colour class at 10 seconds
 * • Label text changes to "⚠ Declare now!" at 10 seconds
 * • Label shows animate-pulse class at 10 seconds
 * Danger state (≤ 5 seconds remaining):
 * • Fill uses red colour class at 5 seconds
 * • Seconds label gains animate-pulse class at 5 seconds
 * Already-expired timer:
 * • Renders without crashing when expiresAt is in the past
 * • Shows "0s" countdown
 * • Fill width is 0%
 * onExpiry callback:
 * • onExpiry is NOT called immediately when timer is rendered with time remaining
 * • onExpiry is called when expiresAt is in the past (expired on mount)
 * Accessibility:
 * • progressbar has aria-valuenow in seconds
 * • progressbar aria-valuemin is 0
 * • progressbar aria-valuemax matches durationMs/1000
 * • seconds label has aria-label with remaining seconds
 * Custom className:
 * • Extra className forwarded to the outer wrapper
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react';
import DeclarationTimerBar from '@/components/DeclarationTimerBar';

// ---------------------------------------------------------------------------
// Mock requestAnimationFrame so the RAF loop doesn't run in JSDOM tests
// ---------------------------------------------------------------------------
beforeAll(() => {
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    // Do NOT invoke cb — keeps remaining frozen at the initial snapshot value
    return 0;
  });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DURATION_MS = 60_000; // 60 seconds

/** Build props with `remainingMs` left before expiry. */
function buildProps(remainingMs: number, overrides: Partial<{
  durationMs: number;
  onExpiry: () => void;
  className: string;
}> = {}) {
  return {
    expiresAt:  Date.now() + remainingMs,
    durationMs: DURATION_MS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('DeclarationTimerBar — rendering', () => {
  it('renders the declaration-timer-bar wrapper', () => {
    render(<DeclarationTimerBar {...buildProps(30_000)} />);
    expect(screen.getByTestId('declaration-timer-bar')).toBeTruthy();
  });

  it('renders a progressbar role element', () => {
    render(<DeclarationTimerBar {...buildProps(30_000)} />);
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('renders the fill element', () => {
    render(<DeclarationTimerBar {...buildProps(30_000)} />);
    expect(screen.getByTestId('declaration-timer-fill')).toBeTruthy();
  });

  it('renders the seconds label element', () => {
    render(<DeclarationTimerBar {...buildProps(30_000)} />);
    expect(screen.getByTestId('declaration-timer-seconds')).toBeTruthy();
  });

  it('renders the timer label element', () => {
    render(<DeclarationTimerBar {...buildProps(30_000)} />);
    expect(screen.getByTestId('declaration-timer-label')).toBeTruthy();
  });

  it('progressbar aria-valuemax equals durationMs / 1000', () => {
    render(<DeclarationTimerBar {...buildProps(30_000)} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemax')).toBe(String(DURATION_MS / 1000));
  });
});

// ---------------------------------------------------------------------------
// Normal state (> 10 seconds remaining)
// ---------------------------------------------------------------------------

describe('DeclarationTimerBar — normal state (> 10s remaining)', () => {
  it('fill uses emerald colour class when plenty of time remains', () => {
    render(<DeclarationTimerBar {...buildProps(30_000)} />);
    const fill = screen.getByTestId('declaration-timer-fill');
    expect(fill.className).toContain('bg-emerald-400');
  });

  it('shows "Declaration timer" label text', () => {
    render(<DeclarationTimerBar {...buildProps(30_000)} />);
    expect(screen.getByTestId('declaration-timer-label').textContent).toContain('Declaration timer');
  });

  it('shows correct ceiling seconds for 30 000 ms', () => {
    render(<DeclarationTimerBar {...buildProps(30_000)} />);
    expect(screen.getByTestId('declaration-timer-seconds').textContent).toBe('30s');
  });

  it('shows correct ceiling seconds for 60 000 ms', () => {
    render(<DeclarationTimerBar {...buildProps(60_000)} />);
    expect(screen.getByTestId('declaration-timer-seconds').textContent).toBe('60s');
  });

  it('shows ceiling for partial seconds (15 500 ms → 16s)', () => {
    render(<DeclarationTimerBar {...buildProps(15_500)} />);
    expect(screen.getByTestId('declaration-timer-seconds').textContent).toBe('16s');
  });
});

// ---------------------------------------------------------------------------
// Warning state (≤ 10 seconds remaining) — red warning matches CountdownTimer
// ---------------------------------------------------------------------------

describe('DeclarationTimerBar — warning state (≤ 10s remaining)', () => {
  it('fill uses red-500 colour class at exactly 10 000 ms', () => {
    render(<DeclarationTimerBar {...buildProps(10_000)} />);
    const fill = screen.getByTestId('declaration-timer-fill');
    expect(fill.className).toContain('bg-red-500');
  });

  it('fill uses red-500 colour class at 9 000 ms', () => {
    render(<DeclarationTimerBar {...buildProps(9_000)} />);
    const fill = screen.getByTestId('declaration-timer-fill');
    expect(fill.className).toContain('bg-red-500');
  });

  it('fill does NOT use amber colour class at 10 000 ms', () => {
    render(<DeclarationTimerBar {...buildProps(10_000)} />);
    const fill = screen.getByTestId('declaration-timer-fill');
    expect(fill.className).not.toContain('bg-amber-400');
  });

  it('label changes to "⚠ Declare now!" at 10 seconds', () => {
    render(<DeclarationTimerBar {...buildProps(10_000)} />);
    expect(screen.getByTestId('declaration-timer-label').textContent).toContain('Declare now!');
  });

  it('label element has animate-pulse class at 10 seconds', () => {
    render(<DeclarationTimerBar {...buildProps(10_000)} />);
    const label = screen.getByTestId('declaration-timer-label');
    expect(label.className).toContain('animate-pulse');
  });

  it('label does NOT show animate-pulse with 11 seconds remaining', () => {
    render(<DeclarationTimerBar {...buildProps(11_000)} />);
    const label = screen.getByTestId('declaration-timer-label');
    expect(label.className).not.toContain('animate-pulse');
  });
});

// ---------------------------------------------------------------------------
// Danger state (≤ 5 seconds remaining)
// ---------------------------------------------------------------------------

describe('DeclarationTimerBar — danger state (≤ 5s remaining)', () => {
  it('fill uses red-500 colour class at exactly 5 000 ms', () => {
    render(<DeclarationTimerBar {...buildProps(5_000)} />);
    const fill = screen.getByTestId('declaration-timer-fill');
    expect(fill.className).toContain('bg-red-500');
  });

  it('fill uses red-500 at 3 000 ms', () => {
    render(<DeclarationTimerBar {...buildProps(3_000)} />);
    const fill = screen.getByTestId('declaration-timer-fill');
    expect(fill.className).toContain('bg-red-500');
  });

  it('seconds label gains animate-pulse at 5 seconds', () => {
    render(<DeclarationTimerBar {...buildProps(5_000)} />);
    const secs = screen.getByTestId('declaration-timer-seconds');
    expect(secs.className).toContain('animate-pulse');
  });

  it('seconds label does NOT have animate-pulse with 6 seconds remaining', () => {
    render(<DeclarationTimerBar {...buildProps(6_000)} />);
    const secs = screen.getByTestId('declaration-timer-seconds');
    expect(secs.className).not.toContain('animate-pulse');
  });
});

// ---------------------------------------------------------------------------
// Already-expired timer
// ---------------------------------------------------------------------------

describe('DeclarationTimerBar — already expired', () => {
  it('renders without crashing when expiresAt is in the past', () => {
    expect(() =>
      render(
        <DeclarationTimerBar
          expiresAt={Date.now() - 5000}
          durationMs={DURATION_MS}
        />
      )
    ).not.toThrow();
  });

  it('shows "0s" when timer has already expired', () => {
    render(
      <DeclarationTimerBar
        expiresAt={Date.now() - 5000}
        durationMs={DURATION_MS}
      />
    );
    expect(screen.getByTestId('declaration-timer-seconds').textContent).toBe('0s');
  });

  it('fill width is 0% when timer is expired', () => {
    render(
      <DeclarationTimerBar
        expiresAt={Date.now() - 5000}
        durationMs={DURATION_MS}
      />
    );
    const fill = screen.getByTestId('declaration-timer-fill');
    expect(fill.getAttribute('style')).toContain('width: 0%');
  });
});

// ---------------------------------------------------------------------------
// onExpiry callback
// ---------------------------------------------------------------------------

describe('DeclarationTimerBar — onExpiry callback', () => {
  it('onExpiry is NOT called when timer still has time remaining', () => {
    const onExpiry = jest.fn();
    render(<DeclarationTimerBar {...buildProps(30_000, { onExpiry })} />);
    expect(onExpiry).not.toHaveBeenCalled();
  });

  it('onExpiry IS called when expiresAt is already in the past on mount', () => {
    // To trigger onExpiry we need RAF to fire with remaining = 0.
    // Restore the mock temporarily so the callback fires.
    (window.requestAnimationFrame as jest.Mock).mockImplementationOnce((cb: FrameRequestCallback) => {
      // Invoke the tick callback once so the component's RAF loop runs
      cb(0);
      return 0;
    });

    const onExpiry = jest.fn();
    act(() => {
      render(
        <DeclarationTimerBar
          expiresAt={Date.now() - 5000}
          durationMs={DURATION_MS}
          onExpiry={onExpiry}
        />
      );
    });
    expect(onExpiry).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe('DeclarationTimerBar — accessibility', () => {
  it('progressbar has correct aria-valuenow in seconds', () => {
    render(<DeclarationTimerBar {...buildProps(20_000)} />);
    const bar = screen.getByRole('progressbar');
    // Math.ceil(20000/1000) = 20
    expect(Number(bar.getAttribute('aria-valuenow'))).toBe(20);
  });

  it('progressbar aria-valuemin is 0', () => {
    render(<DeclarationTimerBar {...buildProps(20_000)} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
  });

  it('progressbar aria-valuemax matches durationMs/1000', () => {
    render(<DeclarationTimerBar {...buildProps(20_000)} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemax')).toBe('60');
  });

  it('seconds label has aria-label mentioning remaining seconds', () => {
    render(<DeclarationTimerBar {...buildProps(20_000)} />);
    const secsEl = screen.getByTestId('declaration-timer-seconds');
    expect(secsEl.getAttribute('aria-label')).toMatch(/20 seconds remaining/i);
  });

  it('progressbar has a descriptive aria-label', () => {
    render(<DeclarationTimerBar {...buildProps(15_000)} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-label')).toMatch(/declaration timer/i);
  });
});

// ---------------------------------------------------------------------------
// Custom className
// ---------------------------------------------------------------------------

describe('DeclarationTimerBar — className forwarding', () => {
  it('applies extra className to the outer wrapper', () => {
    render(<DeclarationTimerBar {...buildProps(30_000, { className: 'mb-4 custom-test-class' })} />);
    const wrapper = screen.getByTestId('declaration-timer-bar');
    expect(wrapper.className).toContain('mb-4');
    expect(wrapper.className).toContain('custom-test-class');
  });
});

// ---------------------------------------------------------------------------
// Progress bar fill percentage
// ---------------------------------------------------------------------------

describe('DeclarationTimerBar — fill percentage', () => {
  it('fill width is 100% when full duration remains', () => {
    render(<DeclarationTimerBar {...buildProps(60_000)} />);
    const fill = screen.getByTestId('declaration-timer-fill');
    expect(fill.getAttribute('style')).toContain('width: 100%');
  });

  it('fill width is approximately 50% when half duration remains', () => {
    render(<DeclarationTimerBar {...buildProps(30_000)} />);
    const fill = screen.getByTestId('declaration-timer-fill');
    // 30000/60000 * 100 = 50%
    expect(fill.getAttribute('style')).toContain('width: 50%');
  });
});
