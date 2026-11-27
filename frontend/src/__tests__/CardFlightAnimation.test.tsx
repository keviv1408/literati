/**
 * @jest-environment jsdom
 *
 * Tests for CardFlightAnimation (AC 33) — face-up card flight
 * animation triggered after a successful ask_card result.
 *
 * Covers:
 * • Component mounts with correct data-testid
 * • aria-hidden="true" so the overlay is excluded from accessibility tree
 * • pointer-events-none class so game controls are not blocked
 * • absolute + inset-0 classes for a table-relative overlay
 * • The flying card element is present on mount
 * • Card carries the transferred card face so players can identify it
 * • CSS custom properties --flight-dx and --flight-dy are set from props
 * • animate-card-flight class is applied to the flying card element
 * • onComplete fires after FLIGHT_DURATION_MS
 * • onComplete does NOT fire before FLIGHT_DURATION_MS elapses
 * • Component is driven by timer not DOM events — cleanup cancels timer on unmount
 * • animationDuration inline style is set from FLIGHT_DURATION_MS
 * • Card is positioned at (fromX - halfW, fromY - halfH) i.e. centred on source
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react';
import CardFlightAnimation, { FLIGHT_DURATION_MS } from '@/components/CardFlightAnimation';

// ── Fake timers setup ────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

// ── Helper ───────────────────────────────────────────────────────────────────

function renderFlight(overrides?: Partial<React.ComponentProps<typeof CardFlightAnimation>>) {
  const defaults = {
    cardId: '5_s',
    fromX: 100,
    fromY: 200,
    toX:   400,
    toY:   150,
    onComplete: jest.fn(),
  };
  return render(<CardFlightAnimation {...defaults} {...overrides} />);
}

// ── Rendering basics ─────────────────────────────────────────────────────────

describe('CardFlightAnimation — rendering', () => {
  it('renders the overlay with data-testid="card-flight-animation"', () => {
    renderFlight();
    expect(screen.getByTestId('card-flight-animation')).toBeTruthy();
  });

  it('has aria-hidden="true" so it is excluded from the accessibility tree', () => {
    renderFlight();
    const overlay = screen.getByTestId('card-flight-animation');
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
  });

  it('has pointer-events-none class so it does not block game controls', () => {
    renderFlight();
    const overlay = screen.getByTestId('card-flight-animation');
    expect(overlay.className).toContain('pointer-events-none');
  });

  it('has absolute + inset-0 classes for a table-relative overlay', () => {
    renderFlight();
    const overlay = screen.getByTestId('card-flight-animation');
    expect(overlay.className).toContain('absolute');
    expect(overlay.className).toContain('inset-0');
  });

  it('renders exactly one flying card element (data-testid="card-flight-card")', () => {
    renderFlight();
    expect(screen.getAllByTestId('card-flight-card')).toHaveLength(1);
  });
});

// ── Face-up card visual ──────────────────────────────────────────────────────

describe('CardFlightAnimation — face-up card style', () => {
  it('the flying card has animate-card-flight class', () => {
    renderFlight();
    const card = screen.getByTestId('card-flight-card');
    expect(card.className).toContain('animate-card-flight');
  });

  it('renders the transferred card face-up instead of a face-down card back', () => {
    renderFlight({ cardId: '5_s' });
    expect(screen.getByLabelText('5 of Spades')).toBeTruthy();
    expect(screen.queryByLabelText('Card (face down)')).toBeNull();
  });

  it('the flying card wrapper has absolute positioning class', () => {
    renderFlight();
    const card = screen.getByTestId('card-flight-card');
    expect(card.className).toContain('absolute');
  });
});

// ── CSS custom properties ────────────────────────────────────────────────────

describe('CardFlightAnimation — CSS custom properties', () => {
  it('sets --flight-dx on the card element', () => {
    renderFlight({ fromX: 100, toX: 400 });
    const card = screen.getByTestId('card-flight-card');
    const style = card.getAttribute('style') ?? '';
    expect(style).toContain('--flight-dx');
  });

  it('sets --flight-dy on the card element', () => {
    renderFlight({ fromY: 200, toY: 150 });
    const card = screen.getByTestId('card-flight-card');
    const style = card.getAttribute('style') ?? '';
    expect(style).toContain('--flight-dy');
  });

  it('--flight-dx value equals toX - fromX', () => {
    renderFlight({ fromX: 100, toX: 400 });
    const card = screen.getByTestId('card-flight-card');
    const style = card.getAttribute('style') ?? '';
    const match = style.match(/--flight-dx:\s*([-\d.]+)px/);
    expect(match).not.toBeNull();
    expect(parseFloat(match![1])).toBeCloseTo(300, 0);
  });

  it('--flight-dy value equals toY - fromY', () => {
    renderFlight({ fromY: 200, toY: 150 });
    const card = screen.getByTestId('card-flight-card');
    const style = card.getAttribute('style') ?? '';
    const match = style.match(/--flight-dy:\s*([-\d.]+)px/);
    expect(match).not.toBeNull();
    expect(parseFloat(match![1])).toBeCloseTo(-50, 0);
  });

  it('supports negative delta when toX < fromX', () => {
    renderFlight({ fromX: 500, toX: 100 });
    const card = screen.getByTestId('card-flight-card');
    const style = card.getAttribute('style') ?? '';
    const match = style.match(/--flight-dx:\s*([-\d.]+)px/);
    expect(match).not.toBeNull();
    expect(parseFloat(match![1])).toBeCloseTo(-400, 0);
  });

  it('sets animationDuration inline style matching FLIGHT_DURATION_MS', () => {
    renderFlight();
    const card = screen.getByTestId('card-flight-card');
    const style = card.getAttribute('style') ?? '';
    expect(style).toContain(`${FLIGHT_DURATION_MS}ms`);
  });
});

// ── Card positioning ─────────────────────────────────────────────────────────

describe('CardFlightAnimation — card positioning', () => {
  it('centers the card box on the giving seat', () => {
    renderFlight({ fromX: 200, fromY: 300 });
    const { style } = screen.getByTestId('card-flight-card');
    expect(parseFloat(style.left) + parseFloat(style.width) / 2).toBe(200);
    expect(parseFloat(style.top) + parseFloat(style.height) / 2).toBe(300);
  });

  it.each([[100, 400, 8], [400, 100, -8], [100, 100, 0]])(
    'banks in the transfer direction from x=%s to x=%s',
    (fromX, toX, lean) => {
      renderFlight({ fromX, toX, fromY: 200, toY: 200 });
      const { style } = screen.getByTestId('card-flight-card');
      expect(style.getPropertyValue('--flight-lean')).toBe(`${lean}deg`);
    },
  );

  it('keeps the original flat flight on Android', () => {
    const env = jest.replaceProperty(process, 'env', { ...process.env, NEXT_PUBLIC_BUILD_TARGET: 'android' });
    try {
      renderFlight();
      const card = screen.getByTestId('card-flight-card');
      expect(card.classList.contains('animate-card-flight')).toBe(true);
      expect(card.classList.contains('animate-card-flight-table')).toBe(false);
      expect(card.style.width).toBe('40px');
      expect(card.style.height).toBe('64px');
    } finally {
      env.restore();
    }
  });
});

// ── Completion ───────────────────────────────────────────────────────────────

describe('CardFlightAnimation — completion', () => {
  it('does NOT call onComplete before FLIGHT_DURATION_MS elapses', () => {
    const onComplete = jest.fn();
    renderFlight({ onComplete });
    act(() => { jest.advanceTimersByTime(FLIGHT_DURATION_MS - 1); });
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('calls onComplete after FLIGHT_DURATION_MS', () => {
    const onComplete = jest.fn();
    renderFlight({ onComplete });
    act(() => { jest.advanceTimersByTime(FLIGHT_DURATION_MS + 1); });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('calls onComplete exactly once, not multiple times', () => {
    const onComplete = jest.fn();
    renderFlight({ onComplete });
    act(() => { jest.advanceTimersByTime(FLIGHT_DURATION_MS * 3); });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('restarts the animation and timer if another card arrives mid-flight', () => {
    const onComplete = jest.fn();
    const { rerender } = renderFlight({ onComplete });
    const first = screen.getByTestId('card-flight-card');
    act(() => { jest.advanceTimersByTime(1000); });
    rerender(
      <CardFlightAnimation cardId="7_h" fromX={100} fromY={200} toX={400} toY={150} onComplete={onComplete} />,
    );
    expect(screen.getByTestId('card-flight-card')).not.toBe(first);
    act(() => { jest.advanceTimersByTime(FLIGHT_DURATION_MS - 1); });
    expect(onComplete).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(1); });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

// ── Cleanup on early unmount ─────────────────────────────────────────────────

describe('CardFlightAnimation — cleanup on early unmount', () => {
  it('cancels the timer and does NOT call onComplete when unmounted early', () => {
    const onComplete = jest.fn();
    const { unmount } = renderFlight({ onComplete });
    act(() => { jest.advanceTimersByTime(FLIGHT_DURATION_MS / 2); });
    unmount();
    act(() => { jest.advanceTimersByTime(FLIGHT_DURATION_MS * 2); });
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does not throw when unmounted immediately (zero timers)', () => {
    const { unmount } = renderFlight({ onComplete: jest.fn() });
    expect(() => unmount()).not.toThrow();
  });
});

// ── onComplete reference stability ───────────────────────────────────────────

describe('CardFlightAnimation — onComplete ref stability', () => {
  it('calls the latest onComplete if the prop changes before the timer fires', () => {
    const first  = jest.fn();
    const second = jest.fn();
    const { rerender } = renderFlight({ onComplete: first });

    act(() => { jest.advanceTimersByTime(FLIGHT_DURATION_MS / 2); });

    rerender(
      <CardFlightAnimation
        cardId="5_s"
        fromX={100} fromY={200} toX={400} toY={150}
        onComplete={second}
      />
    );

    act(() => { jest.advanceTimersByTime(FLIGHT_DURATION_MS / 2); });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

// ── z-index layer ────────────────────────────────────────────────────────────

describe('CardFlightAnimation — z-index', () => {
  it('renders above the seats and below speech bubbles', () => {
    renderFlight();
    const overlay = screen.getByTestId('card-flight-animation');
    expect(overlay.className).toContain('z-40');
  });
});
