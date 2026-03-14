/**
 * @jest-environment jsdom
 *
 * Unit tests for /hooks/useAudio.ts
 *
 * Coverage:
 *   • Defaults to unmuted when localStorage has no entry
 *   • Reads initial mute preference from localStorage
 *   • toggleMute() flips muted state and persists to localStorage
 *   • toggleMute() can round-trip mute → unmute
 *   • playTurnChime() delegates to the audio utility (respects mute)
 */

import { renderHook, act } from '@testing-library/react';
import { MUTE_STORAGE_KEY } from '@/lib/audio';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the entire audio lib so we can verify calls without synthesising audio.
const mockIsMuted   = jest.fn<boolean, []>();
const mockSetMuted  = jest.fn<void, [boolean]>();
const mockPlayChime = jest.fn<void, []>();

jest.mock('@/lib/audio', () => ({
  MUTE_STORAGE_KEY: 'literati:muted',
  isMuted:    (...args: unknown[]) => mockIsMuted(...(args as [])),
  setMuted:   (...args: unknown[]) => mockSetMuted(...(args as [boolean])),
  toggleMuted: jest.fn(),          // not used by the hook directly
  playTurnChime: (...args: unknown[]) => mockPlayChime(...(args as [])),
}));

// ---------------------------------------------------------------------------
// Import hook AFTER mocks
// ---------------------------------------------------------------------------

import { useAudio } from '@/hooks/useAudio';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  // Default: not muted
  mockIsMuted.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAudio — initial state', () => {
  it('defaults to muted=false when isMuted() returns false', () => {
    mockIsMuted.mockReturnValue(false);
    const { result } = renderHook(() => useAudio());
    expect(result.current.muted).toBe(false);
  });

  it('reads muted=true from isMuted() on first render', () => {
    mockIsMuted.mockReturnValue(true);
    const { result } = renderHook(() => useAudio());
    expect(result.current.muted).toBe(true);
  });

  it('calls isMuted() exactly once to seed the initial state', () => {
    renderHook(() => useAudio());
    // useState initializer runs once
    expect(mockIsMuted).toHaveBeenCalledTimes(1);
  });
});

describe('useAudio — toggleMute()', () => {
  it('flips muted from false to true', () => {
    mockIsMuted.mockReturnValue(false);
    const { result } = renderHook(() => useAudio());

    act(() => result.current.toggleMute());

    expect(result.current.muted).toBe(true);
  });

  it('calls setMuted(true) when toggling from unmuted', () => {
    mockIsMuted.mockReturnValue(false);
    const { result } = renderHook(() => useAudio());

    act(() => result.current.toggleMute());

    expect(mockSetMuted).toHaveBeenCalledWith(true);
  });

  it('flips muted from true to false on second toggle', () => {
    mockIsMuted.mockReturnValue(false);
    const { result } = renderHook(() => useAudio());

    act(() => result.current.toggleMute()); // → true
    act(() => result.current.toggleMute()); // → false

    expect(result.current.muted).toBe(false);
  });

  it('calls setMuted(false) when toggling from muted', () => {
    mockIsMuted.mockReturnValue(false);
    const { result } = renderHook(() => useAudio());

    act(() => result.current.toggleMute()); // → muted
    mockSetMuted.mockClear();
    act(() => result.current.toggleMute()); // → unmuted

    expect(mockSetMuted).toHaveBeenCalledWith(false);
  });

  it('starts muted=true and toggles to false', () => {
    mockIsMuted.mockReturnValue(true);
    const { result } = renderHook(() => useAudio());

    act(() => result.current.toggleMute());

    expect(result.current.muted).toBe(false);
    expect(mockSetMuted).toHaveBeenCalledWith(false);
  });

  it('persists the correct key via setMuted (integration smoke)', () => {
    // Verify the hook passes through to setMuted which writes MUTE_STORAGE_KEY
    // (Tested more thoroughly in audio.test.ts; here we confirm the hook
    // calls the utility rather than writing localStorage directly.)
    mockIsMuted.mockReturnValue(false);
    const { result } = renderHook(() => useAudio());

    act(() => result.current.toggleMute());

    expect(mockSetMuted).toHaveBeenCalledTimes(1);
    // We don't re-test the key here; that's audio.test.ts responsibility.
    expect(MUTE_STORAGE_KEY).toBe('literati:muted');
  });
});

describe('useAudio — playTurnChime()', () => {
  it('calls the underlying playTurnChime utility', () => {
    mockIsMuted.mockReturnValue(false);
    const { result } = renderHook(() => useAudio());

    act(() => result.current.playTurnChime());

    expect(mockPlayChime).toHaveBeenCalledTimes(1);
  });

  it('still calls the utility when muted (mute is enforced inside the utility)', () => {
    // The hook itself does not gate on muted; the audio.ts utility does.
    // This ensures the hook always delegates rather than duplicating the guard.
    mockIsMuted.mockReturnValue(true);
    const { result } = renderHook(() => useAudio());

    act(() => result.current.playTurnChime());

    expect(mockPlayChime).toHaveBeenCalledTimes(1);
  });

  it('is a stable callback reference across re-renders', () => {
    mockIsMuted.mockReturnValue(false);
    const { result, rerender } = renderHook(() => useAudio());

    const first = result.current.playTurnChime;
    rerender();
    const second = result.current.playTurnChime;

    expect(first).toBe(second);
  });
});
