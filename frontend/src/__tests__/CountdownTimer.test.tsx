/**
 * @jest-environment jsdom
 *
 * Tests for CountdownTimer — Sub-AC 36.2: reusable countdown timer component
 * that subscribes to countdown WebSocket events and renders the current
 * remaining seconds, displayed in the game UI for every connected client.
 *
 * Coverage:
 *   Rendering:
 *     • Renders the data-testid="countdown-timer" wrapper
 *     • Renders a progress bar fill element (data-testid="countdown-timer-fill")
 *     • Renders a timer role element (data-testid="countdown-timer-bar")
 *     • Renders a seconds label element (data-testid="countdown-timer-seconds")
 *     • Renders a label text element (data-testid="countdown-timer-label")
 *   Seconds display:
 *     • Shows correct ceiling of remaining seconds (e.g. 20000ms → 20s)
 *     • Shows full duration seconds when timer is fresh
 *     • Rounds up partial seconds (e.g. 15500ms → 16s)
 *   Timer content — my timer (isMyTimer=true):
 *     • Fill element uses emerald colour class when plenty of time remains
 *     • Label renders the provided label prop text
 *   Timer content — other player / spectator (isMyTimer=false):
 *     • Fill element uses slate colour class when time > warning threshold
 *     • Seconds text is rendered with base slate colour above warning threshold
 *   Warning state (≤ WARNING_THRESHOLD_S seconds remaining):
 *     • Fill switches to red colour class in warning zone
 *     • Seconds label gains animate-pulse class in warning zone
 *     • Label gains animate-pulse class in warning zone
 *     • Fill uses red even when isMyTimer=false in warning zone
 *   Already-expired timer:
 *     • Renders without crashing when expiresAt is already in the past
 *     • Shows "0s" countdown
 *     • Fill width is 0%
 *   onExpiry callback:
 *     • onExpiry is NOT called immediately when timer is rendered with time remaining
 *     • onExpiry IS called when timer is already expired on mount
 *   Accessibility:
 *     • timer element has correct aria-valuenow in seconds
 *     • timer element aria-valuemin is 0
 *     • timer element aria-valuemax matches durationMs/1000
 *     • seconds label has aria-label with remaining seconds
 *   Custom className:
 *     • Extra className is forwarded to the outer wrapper
 *   WARNING_THRESHOLD_S export:
 *     • Exported constant has the expected value
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react';
import CountdownTimer, { WARNING_THRESHOLD_S } from '@/components/CountdownTimer';

// ---------------------------------------------------------------------------
// Mock requestAnimationFrame so the RAF loop doesn't run in JSDOM tests
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

/** Build CountdownTimer props with `remainingMs` left before expiry. */
function buildProps(
  remainingMs: number,
  overrides: Partial<{
    durationMs: number;
    label: string;
    isMyTimer: boolean;
    onExpiry: () => void;
    className: string;
  }> = {}
) {
  return {
    expiresAt: Date.now() + remainingMs,
    durationMs: overrides.durationMs ?? DURATION_MS,
    label: overrides.label ?? 'Turn timer',
    isMyTimer: overrides.isMyTimer ?? false,
    onExpiry: overrides.onExpiry,
    className: overrides.className,
  };
}

/** Render CountdownTimer with defaults. */
function renderTimer(
  remainingMs = 20_000,
  overrides: Partial<{
    durationMs: number;
    label: string;
    isMyTimer: boolean;
    onExpiry: () => void;
    className: string;
  }> = {}
) {
  const props = buildProps(remainingMs, overrides);
  return { props, ...render(<CountdownTimer {...props} />) };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('CountdownTimer — rendering', () => {
  it('renders the countdown-timer wrapper', () => {
    renderTimer();
    expect(screen.getByTestId('countdown-timer')).toBeTruthy();
  });

  it('renders a progress bar fill element', () => {
    renderTimer();
    expect(screen.getByTestId('countdown-timer-fill')).toBeTruthy();
  });

  it('renders a timer bar element', () => {
    renderTimer();
    expect(screen.getByTestId('countdown-timer-bar')).toBeTruthy();
  });

  it('renders a seconds label element', () => {
    renderTimer();
    expect(screen.getByTestId('countdown-timer-seconds')).toBeTruthy();
  });

  it('renders a label text element', () => {
    renderTimer(20_000, { label: 'Turn timer' });
    expect(screen.getByTestId('countdown-timer-label')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Seconds display
// ---------------------------------------------------------------------------

describe('CountdownTimer — seconds display', () => {
  it('shows correct ceiling of remaining seconds (20000ms → 20s)', () => {
    renderTimer(20_000);
    expect(screen.getByTestId('countdown-timer-seconds').textContent).toBe('20s');
  });

  it('shows full duration when timer is fresh (30000ms → 30s)', () => {
    renderTimer(30_000);
    expect(screen.getByTestId('countdown-timer-seconds').textContent).toBe('30s');
  });

  it('rounds up partial seconds (15500ms → 16s)', () => {
    renderTimer(15_500);
    expect(screen.getByTestId('countdown-timer-seconds').textContent).toBe('16s');
  });

  it('shows 1s when 500ms remains (ceil(500/1000)=1)', () => {
    renderTimer(500);
    expect(screen.getByTestId('countdown-timer-seconds').textContent).toBe('1s');
  });
});

// ---------------------------------------------------------------------------
// Timer content — my timer (isMyTimer=true)
// ---------------------------------------------------------------------------

describe('CountdownTimer — my timer (isMyTimer=true)', () => {
  it('fill element has an emerald colour class when time is well above warning threshold', () => {
    // 20 s of 30 s = ~66 %, well above the 10 s warning threshold
    renderTimer(20_000, { isMyTimer: true });
    const fill = screen.getByTestId('countdown-timer-fill');
    expect(fill.className).toContain('bg-emerald-400');
  });

  it('renders the provided label text', () => {
    renderTimer(20_000, { isMyTimer: true, label: 'Your turn' });
    expect(screen.getByTestId('countdown-timer-label').textContent).toBe('Your turn');
  });

  it('fill is NOT emerald when in warning zone (even for my timer)', () => {
    // 5 s → ≤ 10 s = warning zone → red overrides emerald
    renderTimer(5_000, { isMyTimer: true });
    const fill = screen.getByTestId('countdown-timer-fill');
    expect(fill.className).not.toContain('bg-emerald-400');
    expect(fill.className).toContain('bg-red-500');
  });
});

// ---------------------------------------------------------------------------
// Timer content — other player / spectator (isMyTimer=false)
// ---------------------------------------------------------------------------

describe('CountdownTimer — other player timer (isMyTimer=false)', () => {
  it('fill element has slate colour class when time is above warning threshold', () => {
    renderTimer(20_000, { isMyTimer: false });
    const fill = screen.getByTestId('countdown-timer-fill');
    expect(fill.className).toContain('bg-slate-500');
  });

  it('renders the provided label text', () => {
    renderTimer(20_000, { isMyTimer: false, label: 'Turn timer' });
    expect(screen.getByTestId('countdown-timer-label').textContent).toBe('Turn timer');
  });
});

// ---------------------------------------------------------------------------
// Warning state (≤ WARNING_THRESHOLD_S seconds remaining)
// ---------------------------------------------------------------------------

describe('CountdownTimer — warning state', () => {
  const WARNING_MS = WARNING_THRESHOLD_S * 1000; // e.g. 10 000 ms

  it('fill switches to red-500 class at the warning threshold', () => {
    renderTimer(WARNING_MS);
    const fill = screen.getByTestId('countdown-timer-fill');
    expect(fill.className).toContain('bg-red-500');
  });

  it('seconds label gains animate-pulse class in warning zone', () => {
    renderTimer(5_000);
    const secsEl = screen.getByTestId('countdown-timer-seconds');
    expect(secsEl.className).toContain('animate-pulse');
  });

  it('label element gains animate-pulse class in warning zone', () => {
    renderTimer(5_000);
    const labelEl = screen.getByTestId('countdown-timer-label');
    expect(labelEl.className).toContain('animate-pulse');
  });

  it('fill uses red even when isMyTimer=false in warning zone', () => {
    renderTimer(3_000, { isMyTimer: false });
    const fill = screen.getByTestId('countdown-timer-fill');
    expect(fill.className).toContain('bg-red-500');
    expect(fill.className).not.toContain('bg-slate-500');
  });

  it('seconds label does NOT have animate-pulse when above warning threshold', () => {
    renderTimer(20_000);
    const secsEl = screen.getByTestId('countdown-timer-seconds');
    expect(secsEl.className).not.toContain('animate-pulse');
  });
});

// ---------------------------------------------------------------------------
// Already-expired timer
// ---------------------------------------------------------------------------

describe('CountdownTimer — already expired', () => {
  it('renders without crashing when expiresAt is already in the past', () => {
    const props = {
      expiresAt: Date.now() - 5_000,
      durationMs: DURATION_MS,
    };
    expect(() => render(<CountdownTimer {...props} />)).not.toThrow();
  });

  it('shows "0s" when timer has already expired', () => {
    const props = {
      expiresAt: Date.now() - 5_000,
      durationMs: DURATION_MS,
    };
    render(<CountdownTimer {...props} />);
    expect(screen.getByTestId('countdown-timer-seconds').textContent).toBe('0s');
  });

  it('fill width is 0% when timer is expired', () => {
    const props = {
      expiresAt: Date.now() - 5_000,
      durationMs: DURATION_MS,
    };
    render(<CountdownTimer {...props} />);
    const fill = screen.getByTestId('countdown-timer-fill');
    expect(fill.getAttribute('style')).toContain('width: 0%');
  });
});

// ---------------------------------------------------------------------------
// onExpiry callback
// ---------------------------------------------------------------------------

describe('CountdownTimer — onExpiry callback', () => {
  it('onExpiry is NOT called immediately when timer has remaining time', () => {
    const onExpiry = jest.fn();
    renderTimer(20_000, { onExpiry });
    expect(onExpiry).not.toHaveBeenCalled();
  });

  it('onExpiry IS called when timer is already expired on mount (expiresAt in past)', () => {
    const onExpiry = jest.fn();
    // requestAnimationFrame is mocked to call the callback synchronously here;
    // since the RAF mock returns 0 immediately, the tick runs once and triggers expiry.
    // We need to mock RAF to actually invoke the callback to test expiry.
    (window.requestAnimationFrame as jest.Mock).mockImplementationOnce((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });

    const props = {
      expiresAt: Date.now() - 1_000, // already expired
      durationMs: DURATION_MS,
      onExpiry,
    };
    render(<CountdownTimer {...props} />);
    expect(onExpiry).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe('CountdownTimer — accessibility', () => {
  it('timer bar has correct aria-valuenow in seconds', () => {
    renderTimer(20_000);
    const bar = screen.getByTestId('countdown-timer-bar');
    // ceil(20000/1000) = 20
    expect(Number(bar.getAttribute('aria-valuenow'))).toBe(20);
  });

  it('timer bar aria-valuemin is 0', () => {
    renderTimer();
    const bar = screen.getByTestId('countdown-timer-bar');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
  });

  it('timer bar aria-valuemax matches durationMs/1000', () => {
    renderTimer(20_000, { durationMs: DURATION_MS });
    const bar = screen.getByTestId('countdown-timer-bar');
    expect(bar.getAttribute('aria-valuemax')).toBe(String(DURATION_MS / 1000)); // 30
  });

  it('seconds label has aria-label with remaining seconds', () => {
    renderTimer(15_000);
    const secsEl = screen.getByTestId('countdown-timer-seconds');
    expect(secsEl.getAttribute('aria-label')).toMatch(/15 seconds remaining/i);
  });

  it('timer bar has aria-label with remaining seconds', () => {
    renderTimer(10_000);
    const bar = screen.getByTestId('countdown-timer-bar');
    expect(bar.getAttribute('aria-label')).toMatch(/10 seconds remaining/i);
  });
});

// ---------------------------------------------------------------------------
// Custom className
// ---------------------------------------------------------------------------

describe('CountdownTimer — className forwarding', () => {
  it('applies extra className to the outer wrapper', () => {
    renderTimer(20_000, { className: 'mt-3 custom-cls' });
    const wrapper = screen.getByTestId('countdown-timer');
    expect(wrapper.className).toContain('mt-3');
    expect(wrapper.className).toContain('custom-cls');
  });
});

// ---------------------------------------------------------------------------
// WARNING_THRESHOLD_S export
// ---------------------------------------------------------------------------

describe('CountdownTimer — exports', () => {
  it('exports WARNING_THRESHOLD_S as a positive number', () => {
    expect(typeof WARNING_THRESHOLD_S).toBe('number');
    expect(WARNING_THRESHOLD_S).toBeGreaterThan(0);
  });

  it('WARNING_THRESHOLD_S is 10 seconds', () => {
    expect(WARNING_THRESHOLD_S).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Integration — both timer flavours (my-timer + spectator)
// ---------------------------------------------------------------------------

describe('CountdownTimer — integration scenarios', () => {
  it('renders correctly as a "my turn" timer (isMyTimer=true, 20 s remaining)', () => {
    renderTimer(20_000, { isMyTimer: true, label: 'Your turn' });
    expect(screen.getByTestId('countdown-timer-label').textContent).toBe('Your turn');
    expect(screen.getByTestId('countdown-timer-fill').className).toContain('bg-emerald-400');
    expect(screen.getByTestId('countdown-timer-seconds').textContent).toBe('20s');
  });

  it('renders correctly as a spectator timer (isMyTimer=false, 25 s remaining)', () => {
    renderTimer(25_000, { isMyTimer: false, label: 'Turn timer' });
    expect(screen.getByTestId('countdown-timer-label').textContent).toBe('Turn timer');
    expect(screen.getByTestId('countdown-timer-fill').className).toContain('bg-slate-500');
    expect(screen.getByTestId('countdown-timer-seconds').textContent).toBe('25s');
  });

  it('both my-timer and spectator-timer show red in warning zone', () => {
    const { unmount } = renderTimer(8_000, { isMyTimer: true });
    expect(screen.getByTestId('countdown-timer-fill').className).toContain('bg-red-500');
    unmount();

    renderTimer(8_000, { isMyTimer: false });
    expect(screen.getByTestId('countdown-timer-fill').className).toContain('bg-red-500');
  });
});
