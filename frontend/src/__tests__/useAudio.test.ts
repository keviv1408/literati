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
 *   • All sound callbacks delegate to the audio utility (respect mute)
 *   • Stable callback references across re-renders
 */

import { renderHook, act } from '@testing-library/react';
import { MUTE_STORAGE_KEY } from '@/lib/audio';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the entire audio lib so we can verify calls without synthesising audio.
const mockIsMuted              = jest.fn<boolean, []>();
const mockSetMuted             = jest.fn<void, [boolean]>();
const mockUnlockGameAudio      = jest.fn<void, []>();
const mockPlayChime            = jest.fn<void, []>();
const mockPlayDealSound        = jest.fn<void, []>();
const mockPlayAskSuccess       = jest.fn<void, []>();
const mockPlayAskFail          = jest.fn<void, []>();
const mockPlayDeclarationSuccess = jest.fn<void, []>();
const mockPlayDeclarationFail  = jest.fn<void, []>();

jest.mock('@/lib/audio', () => ({
  MUTE_STORAGE_KEY: 'literati:muted',
  isMuted:               (...args: unknown[]) => mockIsMuted(...(args as [])),
  setMuted:              (...args: unknown[]) => mockSetMuted(...(args as [boolean])),
  unlockGameAudio:       (...args: unknown[]) => mockUnlockGameAudio(...(args as [])),
  toggleMuted:           jest.fn(),   // not used by the hook directly
  playTurnChime:         (...args: unknown[]) => mockPlayChime(...(args as [])),
  playDealSound:         (...args: unknown[]) => mockPlayDealSound(...(args as [])),
  playAskSuccess:        (...args: unknown[]) => mockPlayAskSuccess(...(args as [])),
  playAskFail:           (...args: unknown[]) => mockPlayAskFail(...(args as [])),
  playDeclarationSuccess:(...args: unknown[]) => mockPlayDeclarationSuccess(...(args as [])),
  playDeclarationFail:   (...args: unknown[]) => mockPlayDeclarationFail(...(args as [])),
}));

// Mock soundManager so we can spy on its methods without touching a real
// AudioContext.  Volume is kept in a mutable variable so the getter updates.
const mockSmSetVolume      = jest.fn<void, [number]>();
const mockSmPreload        = jest.fn<void, []>();
const mockSmPlayCardDeal   = jest.fn<void, []>();
const mockSmPlayDecFanfare = jest.fn<void, []>();
let   mockSmVolume         = 0.7;

jest.mock('@/lib/soundManager', () => ({
  soundManager: {
    get volume() { return mockSmVolume; },
    setVolume: (...args: unknown[]) => {
      mockSmSetVolume(...(args as [number]));
      // Mirror clamping the real SoundManager applies
      mockSmVolume = Math.max(0, Math.min(1, args[0] as number));
    },
    preload:                (...args: unknown[]) => mockSmPreload(...(args as [])),
    playCardDeal:           (...args: unknown[]) => mockSmPlayCardDeal(...(args as [])),
    playDeclarationFanfare: (...args: unknown[]) => mockSmPlayDecFanfare(...(args as [])),
  },
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
  // Reset soundManager mock volume to default
  mockSmVolume = 0.7;
});

// ---------------------------------------------------------------------------
// Initial state
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

// ---------------------------------------------------------------------------
// toggleMute()
// ---------------------------------------------------------------------------

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
    mockIsMuted.mockReturnValue(false);
    const { result } = renderHook(() => useAudio());

    act(() => result.current.toggleMute());

    expect(mockSetMuted).toHaveBeenCalledTimes(1);
    expect(MUTE_STORAGE_KEY).toBe('literati:muted');
  });
});

// ---------------------------------------------------------------------------
// playTurnChime()
// ---------------------------------------------------------------------------

describe('useAudio — playTurnChime()', () => {
  it('calls the underlying playTurnChime utility', () => {
    mockIsMuted.mockReturnValue(false);
    const { result } = renderHook(() => useAudio());

    act(() => result.current.playTurnChime());

    expect(mockPlayChime).toHaveBeenCalledTimes(1);
  });

  it('still calls the utility when muted (mute is enforced inside the utility)', () => {
    // The hook itself does not gate on muted; the audio.ts utility does.
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

// ---------------------------------------------------------------------------
// Game-event sound callbacks
// ---------------------------------------------------------------------------

describe('useAudio — playDealSound()', () => {
  it('calls the underlying playDealSound utility', () => {
    const { result } = renderHook(() => useAudio());
    act(() => result.current.playDealSound());
    expect(mockPlayDealSound).toHaveBeenCalledTimes(1);
  });

  it('is a stable callback reference across re-renders', () => {
    const { result, rerender } = renderHook(() => useAudio());
    const first = result.current.playDealSound;
    rerender();
    expect(result.current.playDealSound).toBe(first);
  });
});

describe('useAudio — playAskSuccess()', () => {
  it('calls the underlying playAskSuccess utility', () => {
    const { result } = renderHook(() => useAudio());
    act(() => result.current.playAskSuccess());
    expect(mockPlayAskSuccess).toHaveBeenCalledTimes(1);
  });

  it('is a stable callback reference across re-renders', () => {
    const { result, rerender } = renderHook(() => useAudio());
    const first = result.current.playAskSuccess;
    rerender();
    expect(result.current.playAskSuccess).toBe(first);
  });
});

describe('useAudio — playAskFail()', () => {
  it('calls the underlying playAskFail utility', () => {
    const { result } = renderHook(() => useAudio());
    act(() => result.current.playAskFail());
    expect(mockPlayAskFail).toHaveBeenCalledTimes(1);
  });

  it('is a stable callback reference across re-renders', () => {
    const { result, rerender } = renderHook(() => useAudio());
    const first = result.current.playAskFail;
    rerender();
    expect(result.current.playAskFail).toBe(first);
  });
});

describe('useAudio — playDeclarationSuccess()', () => {
  it('calls the underlying playDeclarationSuccess utility', () => {
    const { result } = renderHook(() => useAudio());
    act(() => result.current.playDeclarationSuccess());
    expect(mockPlayDeclarationSuccess).toHaveBeenCalledTimes(1);
  });

  it('is a stable callback reference across re-renders', () => {
    const { result, rerender } = renderHook(() => useAudio());
    const first = result.current.playDeclarationSuccess;
    rerender();
    expect(result.current.playDeclarationSuccess).toBe(first);
  });
});

describe('useAudio — playDeclarationFail()', () => {
  it('calls the underlying playDeclarationFail utility', () => {
    const { result } = renderHook(() => useAudio());
    act(() => result.current.playDeclarationFail());
    expect(mockPlayDeclarationFail).toHaveBeenCalledTimes(1);
  });

  it('is a stable callback reference across re-renders', () => {
    const { result, rerender } = renderHook(() => useAudio());
    const first = result.current.playDeclarationFail;
    rerender();
    expect(result.current.playDeclarationFail).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// SoundManager-backed features: volume, setVolume, preload
// ---------------------------------------------------------------------------

describe('useAudio — volume (SoundManager)', () => {
  beforeEach(() => {
    mockSmVolume = 0.7;
  });

  it('initialises volume from soundManager.volume', () => {
    mockSmVolume = 0.4;
    const { result } = renderHook(() => useAudio());
    expect(result.current.volume).toBeCloseTo(0.4);
  });

  it('defaults to 0.7 when soundManager returns 0.7', () => {
    mockSmVolume = 0.7;
    const { result } = renderHook(() => useAudio());
    expect(result.current.volume).toBeCloseTo(0.7);
  });
});

describe('useAudio — setVolume()', () => {
  beforeEach(() => {
    mockSmVolume = 0.7;
  });

  it('calls soundManager.setVolume with the given level', () => {
    const { result } = renderHook(() => useAudio());
    act(() => result.current.setVolume(0.5));
    expect(mockSmSetVolume).toHaveBeenCalledWith(0.5);
  });

  it('reflects the clamped volume back in the hook state', () => {
    const { result } = renderHook(() => useAudio());
    act(() => result.current.setVolume(0.5));
    // mockSmVolume is updated by the mock's setVolume side-effect
    expect(result.current.volume).toBeCloseTo(0.5);
  });

  it('clamps values above 1 via soundManager', () => {
    const { result } = renderHook(() => useAudio());
    act(() => result.current.setVolume(5));
    expect(result.current.volume).toBe(1);
  });

  it('clamps values below 0 via soundManager', () => {
    const { result } = renderHook(() => useAudio());
    act(() => result.current.setVolume(-1));
    expect(result.current.volume).toBe(0);
  });

  it('is a stable callback reference across re-renders', () => {
    const { result, rerender } = renderHook(() => useAudio());
    const first = result.current.setVolume;
    rerender();
    expect(result.current.setVolume).toBe(first);
  });
});

describe('useAudio — preload()', () => {
  it('unlocks legacy audio and preloads soundManager', () => {
    const { result } = renderHook(() => useAudio());
    act(() => result.current.preload());
    expect(mockUnlockGameAudio).toHaveBeenCalledTimes(1);
    expect(mockSmPreload).toHaveBeenCalledTimes(1);
  });

  it('is a stable callback reference across re-renders', () => {
    const { result, rerender } = renderHook(() => useAudio());
    const first = result.current.preload;
    rerender();
    expect(result.current.preload).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// SoundManager-backed sound callbacks: playCardDeal, playDeclarationFanfare
// ---------------------------------------------------------------------------

describe('useAudio — playCardDeal() [SoundManager]', () => {
  it('delegates to soundManager.playCardDeal()', () => {
    const { result } = renderHook(() => useAudio());
    act(() => result.current.playCardDeal());
    expect(mockSmPlayCardDeal).toHaveBeenCalledTimes(1);
  });

  it('is a stable callback reference across re-renders', () => {
    const { result, rerender } = renderHook(() => useAudio());
    const first = result.current.playCardDeal;
    rerender();
    expect(result.current.playCardDeal).toBe(first);
  });
});

describe('useAudio — playDeclarationFanfare() [SoundManager]', () => {
  it('delegates to soundManager.playDeclarationFanfare()', () => {
    const { result } = renderHook(() => useAudio());
    act(() => result.current.playDeclarationFanfare());
    expect(mockSmPlayDecFanfare).toHaveBeenCalledTimes(1);
  });

  it('is a stable callback reference across re-renders', () => {
    const { result, rerender } = renderHook(() => useAudio());
    const first = result.current.playDeclarationFanfare;
    rerender();
    expect(result.current.playDeclarationFanfare).toBe(first);
  });
});
