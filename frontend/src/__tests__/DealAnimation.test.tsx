/**
 * @jest-environment jsdom
 *
 * Tests for DealAnimation — cinematic card deal animation.
 *
 * Covers:
 * • Component renders with correct data-testid and aria-hidden attribute
 * • Overlay is pointer-events-none (does not block game controls)
 * • In the gather phase (0–400 ms) no flying cards are visible
 * • In the riffle phase (400–1000 ms) no flying cards yet
 * • After ~1000 ms the deal phase begins and the full 48-card deck appears in flight
 * • 6-player game → 8 cards dealt to each seat
 * • 8-player game → 6 cards dealt to each seat
 * • onComplete fires after the full animation
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

// Gather (400ms) + Riffle (600ms) = 1000ms before dealing starts
const DEAL_START_MS = 1001;

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

describe('DealAnimation — gather phase (0–400 ms)', () => {
  it('shows NO flying cards during the gather phase', () => {
    renderDealAnimation();
    expect(screen.queryAllByTestId('deal-animation-card')).toHaveLength(0);
  });

  it('deck element has animate-deck-gather class during gather phase', () => {
    renderDealAnimation();
    expect(screen.getByTestId('deal-animation-deck').className).toContain('animate-deck-gather');
  });
});

describe('DealAnimation — riffle phase (400–1000 ms)', () => {
  it('shows NO flying cards during the riffle phase', () => {
    renderDealAnimation();
    act(() => { jest.advanceTimersByTime(500); });
    expect(screen.queryAllByTestId('deal-animation-card')).toHaveLength(0);
  });

  it('deck gather class is absent during riffle phase', () => {
    renderDealAnimation(6);
    act(() => { jest.advanceTimersByTime(500); });
    expect(screen.getByTestId('deal-animation-deck').className).not.toContain('animate-deck-gather');
  });
});

describe('DealAnimation — deal phase (1000 ms onward)', () => {
  it('transitions to deal phase after gather + riffle (~1000 ms)', () => {
    renderDealAnimation(6);
    expect(screen.queryAllByTestId('deal-animation-card')).toHaveLength(0);

    act(() => { jest.advanceTimersByTime(DEAL_START_MS); });

    expect(screen.getAllByTestId('deal-animation-card')).toHaveLength(48);
  });

  it('deals 8 cards to each seat in a 6-player game', () => {
    renderDealAnimation(6);
    act(() => { jest.advanceTimersByTime(DEAL_START_MS); });

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
    act(() => { jest.advanceTimersByTime(DEAL_START_MS); });

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
    act(() => { jest.advanceTimersByTime(DEAL_START_MS); });
    const cards = screen.getAllByTestId('deal-animation-card');
    cards.forEach((card) => {
      expect(card.className).toContain('animate-card-deal');
    });
  });
});

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

describe('DealAnimation — completion', () => {
  it('calls onComplete after the full animation', () => {
    const onComplete = jest.fn();
    renderDealAnimation(6, onComplete);

    expect(onComplete).not.toHaveBeenCalled();

    // Total: 400 + 600 + (47 * 50) + 720 + 300 = 4370ms
    act(() => { jest.advanceTimersByTime(4500); });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onComplete prematurely at 2000 ms (mid-deal)', () => {
    const onComplete = jest.fn();
    renderDealAnimation(6, onComplete);

    act(() => { jest.advanceTimersByTime(2000); });

    expect(onComplete).not.toHaveBeenCalled();
  });

  it('renders null (no deal-animation element) after onComplete', () => {
    renderDealAnimation(6);

    act(() => { jest.advanceTimersByTime(4500); });

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

    act(() => { jest.advanceTimersByTime(200); });
    unmount();

    act(() => { jest.advanceTimersByTime(5000); });

    expect(onComplete).not.toHaveBeenCalled();
  });

  it('cancels pending timers when unmounted during deal phase', () => {
    const onComplete = jest.fn();
    const { unmount } = renderDealAnimation(6, onComplete);

    act(() => { jest.advanceTimersByTime(1500); }); // mid-deal
    unmount();

    act(() => { jest.advanceTimersByTime(4000); });
    expect(onComplete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Flying card structure
// ---------------------------------------------------------------------------

describe('DealAnimation — flying card structure', () => {
  it('each flying card has CSS custom property --deal-dx set', () => {
    renderDealAnimation(6);
    act(() => { jest.advanceTimersByTime(DEAL_START_MS); });

    const cards = screen.getAllByTestId('deal-animation-card');
    cards.forEach((card) => {
      const style = card.getAttribute('style') ?? '';
      expect(style).toContain('--deal-dx');
    });
  });

  it('each flying card has CSS custom property --deal-dy set', () => {
    renderDealAnimation(6);
    act(() => { jest.advanceTimersByTime(DEAL_START_MS); });

    const cards = screen.getAllByTestId('deal-animation-card');
    cards.forEach((card) => {
      const style = card.getAttribute('style') ?? '';
      expect(style).toContain('--deal-dy');
    });
  });

  it('flying cards spread in different directions (non-zero dx/dy values)', () => {
    renderDealAnimation(6);
    act(() => { jest.advanceTimersByTime(DEAL_START_MS); });

    const cards = screen.getAllByTestId('deal-animation-card');
    const dxValues = cards.map((card) => {
      const m = (card.getAttribute('style') ?? '').match(/--deal-dx:\s*([-\d.]+)px/);
      return m ? parseFloat(m[1]) : 0;
    });

    const uniqueDx = new Set(dxValues.map((v) => Math.round(v)));
    expect(uniqueDx.size).toBeGreaterThan(1);
  });

  it('each flying card carries a deal round index', () => {
    renderDealAnimation(6);
    act(() => { jest.advanceTimersByTime(DEAL_START_MS); });

    const rounds = new Set(
      screen
        .getAllByTestId('deal-animation-card')
        .map((card) => card.getAttribute('data-deal-round'))
        .filter(Boolean)
    );

    expect(rounds.size).toBe(8);
  });

  it('each flying card has 3D rotation custom properties (--deal-rx-mid, --deal-ry-mid)', () => {
    renderDealAnimation(6);
    act(() => { jest.advanceTimersByTime(DEAL_START_MS); });

    const cards = screen.getAllByTestId('deal-animation-card');
    cards.forEach((card) => {
      const style = card.getAttribute('style') ?? '';
      expect(style).toContain('--deal-rx-mid');
      expect(style).toContain('--deal-ry-mid');
    });
  });
});
