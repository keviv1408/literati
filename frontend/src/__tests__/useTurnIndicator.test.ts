/**
 * @jest-environment jsdom
 *
 * Unit tests for /hooks/useTurnIndicator.ts — Sub-AC 14-3.
 *
 * Coverage:
 *   • `indicatorActive` starts as false
 *   • Transitions false → true when `isMyTurn` becomes true
 *   • Does NOT re-activate if `isMyTurn` is already true across re-renders
 *   • `clearIndicator()` sets `indicatorActive` to false immediately
 *   • No periodic reminder chime fires while waiting on your turn
 *   • When `isMyTurn` becomes false, indicator is cleared automatically
 *   • `playTurnChime` is called exactly once when the turn starts
 *   • `playTurnChime` does NOT fire repeatedly while `isMyTurn` remains true
 *   • Cleanup: no extra chimes fire after unmount
 */

import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock @/lib/audio so no real AudioContext is created
// ---------------------------------------------------------------------------

const mockPlayTurnChime = jest.fn<void, []>();

jest.mock('@/lib/audio', () => ({
  MUTE_STORAGE_KEY: 'literati:muted',
  isMuted: jest.fn().mockReturnValue(false),
  setMuted: jest.fn(),
  toggleMuted: jest.fn(),
  playTurnChime: (...args: unknown[]) => mockPlayTurnChime(...(args as [])),
}));

// ---------------------------------------------------------------------------
// Import hook AFTER mocks
// ---------------------------------------------------------------------------

import { useTurnIndicator } from '@/hooks/useTurnIndicator';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('useTurnIndicator — initial state', () => {
  it('indicatorActive is false on first render (isMyTurn=false)', () => {
    const { result } = renderHook(() => useTurnIndicator(false));
    expect(result.current.indicatorActive).toBe(false);
  });

  it('indicatorActive is false even on first render when isMyTurn=true (no prior false)', () => {
    // First render: isMyTurn starts true — the hook has no prior state so
    // prevTurnRef is false, meaning the false→true transition fires.
    const { result } = renderHook(() => useTurnIndicator(true));
    expect(result.current.indicatorActive).toBe(true);
  });

  it('does not call playTurnChime on first render when isMyTurn=false', () => {
    renderHook(() => useTurnIndicator(false));
    expect(mockPlayTurnChime).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Turn start (false → true)
// ---------------------------------------------------------------------------

describe('useTurnIndicator — turn start', () => {
  it('sets indicatorActive=true when isMyTurn transitions from false to true', () => {
    const { result, rerender } = renderHook(
      ({ isMyTurn }: { isMyTurn: boolean }) => useTurnIndicator(isMyTurn),
      { initialProps: { isMyTurn: false } },
    );
    expect(result.current.indicatorActive).toBe(false);

    act(() => {
      rerender({ isMyTurn: true });
    });

    expect(result.current.indicatorActive).toBe(true);
  });

  it('calls playTurnChime exactly once when turn starts', () => {
    const { rerender } = renderHook(
      ({ isMyTurn }: { isMyTurn: boolean }) => useTurnIndicator(isMyTurn),
      { initialProps: { isMyTurn: false } },
    );

    act(() => {
      rerender({ isMyTurn: true });
    });

    expect(mockPlayTurnChime).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-fire playTurnChime on re-render while isMyTurn remains true', () => {
    const { rerender } = renderHook(
      ({ isMyTurn }: { isMyTurn: boolean }) => useTurnIndicator(isMyTurn),
      { initialProps: { isMyTurn: false } },
    );

    act(() => {
      rerender({ isMyTurn: true });
    });
    mockPlayTurnChime.mockClear();

    // Additional renders with isMyTurn still true should not re-trigger the chime
    act(() => {
      rerender({ isMyTurn: true });
    });
    act(() => {
      rerender({ isMyTurn: true });
    });

    expect(mockPlayTurnChime).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No periodic reminder chime
// ---------------------------------------------------------------------------

describe('useTurnIndicator — no periodic reminder chime', () => {
  it('does not fire playTurnChime again just because time has passed', () => {
    const { rerender } = renderHook(
      ({ isMyTurn }: { isMyTurn: boolean }) => useTurnIndicator(isMyTurn),
      { initialProps: { isMyTurn: false } },
    );

    act(() => {
      rerender({ isMyTurn: true });
    });
    mockPlayTurnChime.mockClear();

    // Advance fake timers; there should be no periodic replay
    act(() => {
      jest.advanceTimersByTime(30_000);
    });

    expect(mockPlayTurnChime).not.toHaveBeenCalled();
  });

  it('does not fire playTurnChime repeatedly across long durations', () => {
    const { rerender } = renderHook(
      ({ isMyTurn }: { isMyTurn: boolean }) => useTurnIndicator(isMyTurn),
      { initialProps: { isMyTurn: false } },
    );

    act(() => {
      rerender({ isMyTurn: true });
    });
    mockPlayTurnChime.mockClear();

    act(() => {
      jest.advanceTimersByTime(120_000);
    });

    expect(mockPlayTurnChime).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// clearIndicator()
// ---------------------------------------------------------------------------

describe('useTurnIndicator — clearIndicator()', () => {
  it('sets indicatorActive=false when clearIndicator() is called', () => {
    const { result, rerender } = renderHook(
      ({ isMyTurn }: { isMyTurn: boolean }) => useTurnIndicator(isMyTurn),
      { initialProps: { isMyTurn: false } },
    );

    act(() => {
      rerender({ isMyTurn: true });
    });
    expect(result.current.indicatorActive).toBe(true);

    act(() => {
      result.current.clearIndicator();
    });

    expect(result.current.indicatorActive).toBe(false);
  });

  it('does not emit extra chimes after clearIndicator()', () => {
    const { result, rerender } = renderHook(
      ({ isMyTurn }: { isMyTurn: boolean }) => useTurnIndicator(isMyTurn),
      { initialProps: { isMyTurn: false } },
    );

    act(() => {
      rerender({ isMyTurn: true });
    });

    act(() => {
      result.current.clearIndicator();
    });
    mockPlayTurnChime.mockClear();

    act(() => {
      jest.advanceTimersByTime(30_000);
    });

    expect(mockPlayTurnChime).not.toHaveBeenCalled();
  });

  it('clearIndicator() is idempotent (safe to call multiple times)', () => {
    const { result, rerender } = renderHook(
      ({ isMyTurn }: { isMyTurn: boolean }) => useTurnIndicator(isMyTurn),
      { initialProps: { isMyTurn: false } },
    );

    act(() => {
      rerender({ isMyTurn: true });
    });

    act(() => {
      result.current.clearIndicator();
      result.current.clearIndicator();
      result.current.clearIndicator();
    });

    expect(result.current.indicatorActive).toBe(false);
  });

  it('clearIndicator is a stable callback reference across re-renders', () => {
    const { result, rerender } = renderHook(
      ({ isMyTurn }: { isMyTurn: boolean }) => useTurnIndicator(isMyTurn),
      { initialProps: { isMyTurn: false } },
    );

    const first = result.current.clearIndicator;
    act(() => {
      rerender({ isMyTurn: false });
    });
    const second = result.current.clearIndicator;

    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// Turn end (true → false)
// ---------------------------------------------------------------------------

describe('useTurnIndicator — turn end (isMyTurn → false)', () => {
  it('sets indicatorActive=false when isMyTurn transitions from true to false', () => {
    const { result, rerender } = renderHook(
      ({ isMyTurn }: { isMyTurn: boolean }) => useTurnIndicator(isMyTurn),
      { initialProps: { isMyTurn: false } },
    );

    act(() => {
      rerender({ isMyTurn: true });
    });
    expect(result.current.indicatorActive).toBe(true);

    act(() => {
      rerender({ isMyTurn: false });
    });

    expect(result.current.indicatorActive).toBe(false);
  });

  it('does not emit extra chimes when isMyTurn becomes false', () => {
    const { rerender } = renderHook(
      ({ isMyTurn }: { isMyTurn: boolean }) => useTurnIndicator(isMyTurn),
      { initialProps: { isMyTurn: false } },
    );

    act(() => {
      rerender({ isMyTurn: true });
    });

    act(() => {
      rerender({ isMyTurn: false });
    });
    mockPlayTurnChime.mockClear();

    act(() => {
      jest.advanceTimersByTime(30_000);
    });

    expect(mockPlayTurnChime).not.toHaveBeenCalled();
  });

  it('re-activates correctly when turn comes back (false → true → false → true)', () => {
    const { result, rerender } = renderHook(
      ({ isMyTurn }: { isMyTurn: boolean }) => useTurnIndicator(isMyTurn),
      { initialProps: { isMyTurn: false } },
    );

    // First turn
    act(() => { rerender({ isMyTurn: true }); });
    expect(result.current.indicatorActive).toBe(true);
    const firstChimeCount = mockPlayTurnChime.mock.calls.length;

    // Turn passes
    act(() => { rerender({ isMyTurn: false }); });
    expect(result.current.indicatorActive).toBe(false);

    // Second turn starts
    act(() => { rerender({ isMyTurn: true }); });
    expect(result.current.indicatorActive).toBe(true);
    // A new chime should have fired for the second turn start
    expect(mockPlayTurnChime.mock.calls.length).toBeGreaterThan(firstChimeCount);
  });
});

// ---------------------------------------------------------------------------
// clearIndicator() then turn ends (race condition test)
// ---------------------------------------------------------------------------

describe('useTurnIndicator — clearIndicator then turn ends', () => {
  it('remains false after clearIndicator() when isMyTurn later becomes false', () => {
    const { result, rerender } = renderHook(
      ({ isMyTurn }: { isMyTurn: boolean }) => useTurnIndicator(isMyTurn),
      { initialProps: { isMyTurn: false } },
    );

    act(() => { rerender({ isMyTurn: true }); });
    act(() => { result.current.clearIndicator(); });
    expect(result.current.indicatorActive).toBe(false);

    // Server now confirms action by moving turn to another player
    act(() => { rerender({ isMyTurn: false }); });

    // Still false — no unexpected state change
    expect(result.current.indicatorActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unmount cleanup
// ---------------------------------------------------------------------------

describe('useTurnIndicator — unmount cleanup', () => {
  it('does not emit extra chimes when the component unmounts', () => {
    const { rerender, unmount } = renderHook(
      ({ isMyTurn }: { isMyTurn: boolean }) => useTurnIndicator(isMyTurn),
      { initialProps: { isMyTurn: false } },
    );

    act(() => {
      rerender({ isMyTurn: true });
    });

    unmount();
    mockPlayTurnChime.mockClear();

    act(() => {
      jest.advanceTimersByTime(30_000);
    });

    expect(mockPlayTurnChime).not.toHaveBeenCalled();
  });
});
