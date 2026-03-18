/**
 * @jest-environment jsdom
 *
 * Tests for DealAnimation — client-side shuffle + full-deck deal animation.
 *
 * Covers:
 * • Component renders with correct data-testid and aria-hidden attribute
 * • Overlay is pointer-events-none (does not block game controls)
 * • In the shuffle phase (0–700 ms) no flying cards are visible
 * • After ~700 ms the deal phase begins and the full 48-card deck appears in flight
 * • 6-player game → 8 cards dealt to each seat
 * • 8-player game → 6 cards dealt to each seat
 * • onComplete fires after the full animation (~3.1 s)
 * • Component unmounts (renders null) once onComplete is called
 * • Each flying card carries the deal-animation-card testid
 * • Cleanup: pending timers are cancelled when the component unmounts early
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react';
import DealAnimation from '@/components/DealAnimation';

// Use fake timers so we can advance time without real delays
beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderDealAnimation(
  playerCount: 6 | 8 = 6,
  onComplete: () => void = jest.fn()
) {
  return render(<DealAnimation playerCount={playerCount} onComplete={onComplete} />);
}

// ---------------------------------------------------------------------------
// Rendering basics
// ---------------------------------------------------------------------------

describe('DealAnimation — rendering', () => {
  it('renders with data-testid="deal-animation" on mount', () => {
    renderDealAnimation();
    expect(screen.getByTestId('deal-animation')).toBeTruthy();
  });

  it('has aria-hidden="true" so it is excluded from the accessibility tree', () => {
    renderDealAnimation();
    expect(screen.getByTestId('deal-animation').getAttribute('aria-hidden')).toBe('true');
  });

  it('has pointer-events-none class so it does not block game controls', () => {
    renderDealAnimation();
    expect(screen.getByTestId('deal-animation').className).toContain('pointer-events-none');
  });

  it('has fixed positioning so it overlays the full viewport', () => {
    renderDealAnimation();
    expect(screen.getByTestId('deal-animation').className).toContain('fixed');
    expect(screen.getByTestId('deal-animation').className).toContain('inset-0');
  });
});

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

describe('DealAnimation — shuffle phase (0–700 ms)', () => {
  it('shows NO flying cards during the shuffle phase', () => {
    renderDealAnimation();
    // Immediately after mount: still shuffling
    expect(screen.queryAllByTestId('deal-animation-card')).toHaveLength(0);
  });

  it('deck element has animate-deck-shuffle class during shuffle phase', () => {
    renderDealAnimation();
    expect(screen.getByTestId('deal-animation-deck').className).toContain('animate-deck-shuffle');
  });
});

describe('DealAnimation — deal phase (700 ms onward)', () => {
  it('transitions to deal phase after ~700 ms', () => {
    renderDealAnimation(6);
    expect(screen.queryAllByTestId('deal-animation-card')).toHaveLength(0);

    act(() => { jest.advanceTimersByTime(701); });

    expect(screen.getAllByTestId('deal-animation-card')).toHaveLength(48);
  });

  it('renders one seat target per player', () => {
    renderDealAnimation(6);
    expect(screen.getAllByTestId('deal-seat-target')).toHaveLength(6);
  });

  it('renders 8 seat targets for an 8-player game', () => {
    renderDealAnimation(8);
    expect(screen.getAllByTestId('deal-seat-target')).toHaveLength(8);
  });

  it('deals 8 cards to each seat in a 6-player game', () => {
    renderDealAnimation(6);
    act(() => { jest.advanceTimersByTime(701); });

    const cards = screen.getAllByTestId('deal-animation-card');
    const seatCounts = new Map<string, number>();
    cards.forEach((card) => {
      const seat = card.getAttribute('data-seat-index') ?? 'missing';
      seatCounts.set(seat, (seatCounts.get(seat) ?? 0) + 1);
    });

    expect(cards).toHaveLength(48);
    expect(Array.from(seatCounts.values())).toEqual([8, 8, 8, 8, 8, 8]);
  });

  it('deals 6 cards to each seat in an 8-player game', () => {
    renderDealAnimation(8);
    act(() => { jest.advanceTimersByTime(701); });

    const cards = screen.getAllByTestId('deal-animation-card');
    const seatCounts = new Map<string, number>();
    cards.forEach((card) => {
      const seat = card.getAttribute('data-seat-index') ?? 'missing';
      seatCounts.set(seat, (seatCounts.get(seat) ?? 0) + 1);
    });

    expect(cards).toHaveLength(48);
    expect(Array.from(seatCounts.values())).toEqual([6, 6, 6, 6, 6, 6, 6, 6]);
  });

  it('each flying card has the animate-card-deal class', () => {
    renderDealAnimation(6);
    act(() => { jest.advanceTimersByTime(701); });
    const cards = screen.getAllByTestId('deal-animation-card');
    cards.forEach((card) => {
      expect(card.className).toContain('animate-card-deal');
    });
  });

  it('deck shuffle class is absent during deal phase', () => {
    renderDealAnimation(6);
    act(() => { jest.advanceTimersByTime(701); });
    // animate-deck-shuffle should be gone once phase changes to 'dealing'
    expect(screen.getByTestId('deal-animation-deck').className).not.toContain('animate-deck-shuffle');
  });
});

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

describe('DealAnimation — completion', () => {
  it('calls onComplete after the full animation (~3.1 s)', () => {
    const onComplete = jest.fn();
    renderDealAnimation(6, onComplete);

    expect(onComplete).not.toHaveBeenCalled();

    act(() => { jest.advanceTimersByTime(3201); });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onComplete prematurely at 1600 ms (mid-deal)', () => {
    const onComplete = jest.fn();
    renderDealAnimation(6, onComplete);

    act(() => { jest.advanceTimersByTime(1600); });

    expect(onComplete).not.toHaveBeenCalled();
  });

  it('renders null (no deal-animation element) after onComplete', () => {
    renderDealAnimation(6);

    act(() => { jest.advanceTimersByTime(3201); });

    expect(screen.queryByTestId('deal-animation')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cleanup on early unmount
// ---------------------------------------------------------------------------

describe('DealAnimation — cleanup on early unmount', () => {
  it('cancels pending timers when unmounted before animation completes', () => {
    const onComplete = jest.fn();
    const { unmount } = renderDealAnimation(6, onComplete);

    // Unmount in the middle of the shuffle phase
    act(() => { jest.advanceTimersByTime(200); });
    unmount();

    // Advance past total animation time — onComplete must NOT fire
    act(() => { jest.advanceTimersByTime(3500); });

    expect(onComplete).not.toHaveBeenCalled();
  });

  it('cancels pending timers when unmounted during deal phase', () => {
    const onComplete = jest.fn();
    const { unmount } = renderDealAnimation(6, onComplete);

    act(() => { jest.advanceTimersByTime(1200); }); // mid-deal
    unmount();

    act(() => { jest.advanceTimersByTime(2500); });
    expect(onComplete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Flying card structure
// ---------------------------------------------------------------------------

describe('DealAnimation — flying card structure', () => {
  it('each flying card has CSS custom property --deal-dx set', () => {
    renderDealAnimation(6);
    act(() => { jest.advanceTimersByTime(701); });

    const cards = screen.getAllByTestId('deal-animation-card');
    cards.forEach((card) => {
      const style = card.getAttribute('style') ?? '';
      expect(style).toContain('--deal-dx');
    });
  });

  it('each flying card has CSS custom property --deal-dy set', () => {
    renderDealAnimation(6);
    act(() => { jest.advanceTimersByTime(701); });

    const cards = screen.getAllByTestId('deal-animation-card');
    cards.forEach((card) => {
      const style = card.getAttribute('style') ?? '';
      expect(style).toContain('--deal-dy');
    });
  });

  it('flying cards spread in different directions (non-zero dx/dy values)', () => {
    renderDealAnimation(6);
    act(() => { jest.advanceTimersByTime(701); });

    const cards = screen.getAllByTestId('deal-animation-card');
    const dxValues = cards.map((card) => {
      const m = (card.getAttribute('style') ?? '').match(/--deal-dx:\s*([-\d.]+)px/);
      return m ? parseFloat(m[1]) : 0;
    });

    // Not all cards should have the same dx — they spread in different directions
    const uniqueDx = new Set(dxValues.map((v) => Math.round(v)));
    expect(uniqueDx.size).toBeGreaterThan(1);
  });

  it('each flying card carries a deal round index', () => {
    renderDealAnimation(6);
    act(() => { jest.advanceTimersByTime(701); });

    const rounds = new Set(
      screen
        .getAllByTestId('deal-animation-card')
        .map((card) => card.getAttribute('data-deal-round'))
        .filter(Boolean)
    );

    expect(rounds.size).toBe(8);
  });
});
