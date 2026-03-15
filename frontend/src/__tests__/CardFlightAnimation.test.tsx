/**
 * @jest-environment jsdom
 *
 * Tests for CardFlightAnimation (AC 33 Sub-AC 1) — card back-face flight
 * animation triggered after a successful ask_card result.
 *
 * Covers:
 *  • Component mounts with correct data-testid
 *  • aria-hidden="true" so the overlay is excluded from accessibility tree
 *  • pointer-events-none class so game controls are not blocked
 *  • fixed + inset-0 classes for full-viewport overlay
 *  • The flying card element is present on mount
 *  • Card carries the card-back visual style (blue-900 background)
 *  • CSS custom properties --flight-dx and --flight-dy are set from props
 *  • animate-card-flight class is applied to the flying card element
 *  • onComplete fires after FLIGHT_DURATION_MS
 *  • onComplete does NOT fire before FLIGHT_DURATION_MS elapses
 *  • Component is driven by timer not DOM events — cleanup cancels timer on unmount
 *  • animationDuration inline style is set from FLIGHT_DURATION_MS
 *  • Card is positioned at (fromX - halfW, fromY - halfH) i.e. centred on source
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

  it('has fixed + inset-0 classes for full-viewport overlay', () => {
    renderFlight();
    const overlay = screen.getByTestId('card-flight-animation');
    expect(overlay.className).toContain('fixed');
    expect(overlay.className).toContain('inset-0');
  });

  it('renders exactly one flying card element (data-testid="card-flight-card")', () => {
    renderFlight();
    expect(screen.getAllByTestId('card-flight-card')).toHaveLength(1);
  });
});

// ── Card back visual ─────────────────────────────────────────────────────────

describe('CardFlightAnimation — card back style', () => {
  it('the flying card has animate-card-flight class', () => {
    renderFlight();
    const card = screen.getByTestId('card-flight-card');
    expect(card.className).toContain('animate-card-flight');
  });

  it('the flying card contains a child with bg-blue-900 (card back colour)', () => {
    renderFlight();
    const card = screen.getByTestId('card-flight-card');
    // The blue card back is a direct child of the positioned card element
    const backFace = card.firstElementChild as HTMLElement;
    expect(backFace).toBeTruthy();
    expect(backFace.className).toContain('bg-blue-900');
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
  it('positions the card so its left edge = fromX - 20 (half of CARD_W=40)', () => {
    renderFlight({ fromX: 200 });
    const card = screen.getByTestId('card-flight-card');
    const style = card.getAttribute('style') ?? '';
    // left: 200 - 20 = 180
    expect(style).toContain('left: 180');
  });

  it('positions the card so its top edge = fromY - 32 (half of CARD_H=64)', () => {
    renderFlight({ fromY: 300 });
    const card = screen.getByTestId('card-flight-card');
    const style = card.getAttribute('style') ?? '';
    // top: 300 - 32 = 268
    expect(style).toContain('top: 268');
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

    // Update the prop mid-flight — the ref update should ensure second() is called
    rerender(
      <CardFlightAnimation
        fromX={100} fromY={200} toX={400} toY={150}
        onComplete={second}
      />
    );

    act(() => { jest.advanceTimersByTime(FLIGHT_DURATION_MS); });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

// ── z-index layer ────────────────────────────────────────────────────────────

describe('CardFlightAnimation — z-index', () => {
  it('has z-50 class to render above all other game UI', () => {
    renderFlight();
    const overlay = screen.getByTestId('card-flight-animation');
    expect(overlay.className).toContain('z-50');
  });
});
