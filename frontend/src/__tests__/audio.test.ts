/**
 * @jest-environment jsdom
 *
 * Unit tests for /lib/audio.ts — the Browser Audio API utility.
 *
 * Coverage:
 *   • isMuted() — returns false by default, true when localStorage is set
 *   • setMuted() — writes to localStorage
 *   • toggleMuted() — flips the value and returns the new state
 *   • playTurnChime() — no-op when muted; calls AudioContext when unmuted
 *   • playTurnChime() — no-op when AudioContext is unavailable
 *   • playTurnChime() — fail-silently on AudioContext errors
 */

import {
  isMuted,
  setMuted,
  toggleMuted,
  playTurnChime,
  MUTE_STORAGE_KEY,
} from '@/lib/audio';

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

/** Simple in-memory localStorage substitute. */
const makeLocalStorageMock = () => {
  const store: Record<string, string> = {};
  return {
    getItem: jest.fn((key: string) => store[key] ?? null),
    setItem: jest.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: jest.fn((key: string) => { delete store[key]; }),
    clear: jest.fn(() => { Object.keys(store).forEach((k) => delete store[k]); }),
  };
};

let localStorageMock: ReturnType<typeof makeLocalStorageMock>;

// Shorthand for window cast used in several tests
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const win = () => window as any;

beforeEach(() => {
  localStorageMock = makeLocalStorageMock();
  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
    writable: true,
    configurable: true,
  });
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AudioContext mock helpers
// ---------------------------------------------------------------------------

type MockOscillator = {
  type: OscillatorType;
  frequency: { value: number };
  connect: jest.Mock;
  start: jest.Mock;
  stop: jest.Mock;
};

type MockGainNode = {
  gain: {
    setValueAtTime: jest.Mock;
    linearRampToValueAtTime: jest.Mock;
    exponentialRampToValueAtTime: jest.Mock;
  };
  connect: jest.Mock;
};

type MockAudioCtx = {
  currentTime: number;
  destination: Record<string, never>;
  createOscillator: jest.Mock<MockOscillator>;
  createGain: jest.Mock<MockGainNode>;
  close: jest.Mock<Promise<void>>;
};

function buildMockAudioContext(): MockAudioCtx {
  const makeOscillator = (): MockOscillator => ({
    type: 'sine',
    frequency: { value: 0 },
    connect: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
  });

  const makeGain = (): MockGainNode => ({
    gain: {
      setValueAtTime: jest.fn(),
      linearRampToValueAtTime: jest.fn(),
      exponentialRampToValueAtTime: jest.fn(),
    },
    connect: jest.fn(),
  });

  return {
    currentTime: 0,
    destination: {},
    createOscillator: jest.fn(() => makeOscillator()),
    createGain: jest.fn(() => makeGain()),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

function installAudioContext(ctx: MockAudioCtx) {
  win().AudioContext = jest.fn(() => ctx);
  delete win().webkitAudioContext;
}

function removeAudioContext() {
  delete win().AudioContext;
  delete win().webkitAudioContext;
}

// ---------------------------------------------------------------------------
// isMuted()
// ---------------------------------------------------------------------------

describe('isMuted()', () => {
  it('returns false when localStorage has no entry', () => {
    expect(isMuted()).toBe(false);
  });

  it('returns true when localStorage is set to "true"', () => {
    localStorageMock.getItem.mockReturnValueOnce('true');
    expect(isMuted()).toBe(true);
  });

  it('returns false when localStorage is set to "false"', () => {
    localStorageMock.getItem.mockReturnValueOnce('false');
    expect(isMuted()).toBe(false);
  });

  it('uses the correct storage key', () => {
    isMuted();
    expect(localStorageMock.getItem).toHaveBeenCalledWith(MUTE_STORAGE_KEY);
  });
});

// ---------------------------------------------------------------------------
// setMuted()
// ---------------------------------------------------------------------------

describe('setMuted()', () => {
  it('writes "true" to localStorage when called with true', () => {
    setMuted(true);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(MUTE_STORAGE_KEY, 'true');
  });

  it('writes "false" to localStorage when called with false', () => {
    setMuted(false);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(MUTE_STORAGE_KEY, 'false');
  });
});

// ---------------------------------------------------------------------------
// toggleMuted()
// ---------------------------------------------------------------------------

describe('toggleMuted()', () => {
  it('returns true and sets muted when previously unmuted', () => {
    localStorageMock.getItem.mockReturnValueOnce(null as unknown as string);
    const result = toggleMuted();
    expect(result).toBe(true);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(MUTE_STORAGE_KEY, 'true');
  });

  it('returns false and sets unmuted when previously muted', () => {
    localStorageMock.getItem.mockReturnValueOnce('true');
    const result = toggleMuted();
    expect(result).toBe(false);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(MUTE_STORAGE_KEY, 'false');
  });
});

// ---------------------------------------------------------------------------
// playTurnChime()
// ---------------------------------------------------------------------------

describe('playTurnChime()', () => {
  it('creates AudioContext and plays two tones when unmuted', () => {
    const ctx = buildMockAudioContext();
    installAudioContext(ctx);

    localStorageMock.getItem.mockReturnValue(null as unknown as string);

    playTurnChime();

    expect(win().AudioContext).toHaveBeenCalledTimes(1);
    // Two oscillator + gain pairs for the two tones
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
    expect(ctx.createGain).toHaveBeenCalledTimes(2);
  });

  it('does NOT create AudioContext when muted', () => {
    const ctx = buildMockAudioContext();
    installAudioContext(ctx);

    localStorageMock.getItem.mockReturnValue('true');

    playTurnChime();

    expect(win().AudioContext).not.toHaveBeenCalled();
  });

  it('is a no-op when AudioContext is unavailable', () => {
    removeAudioContext();
    localStorageMock.getItem.mockReturnValue(null as unknown as string);

    // Should not throw even with no AudioContext
    expect(() => playTurnChime()).not.toThrow();
  });

  it('falls back to webkitAudioContext when AudioContext is absent', () => {
    const ctx = buildMockAudioContext();
    delete win().AudioContext;
    win().webkitAudioContext = jest.fn(() => ctx);

    localStorageMock.getItem.mockReturnValue(null as unknown as string);

    playTurnChime();

    expect(win().webkitAudioContext).toHaveBeenCalledTimes(1);
  });

  it('fails silently if AudioContext constructor throws', () => {
    win().AudioContext = jest.fn(() => {
      throw new Error('AudioContext not allowed');
    });
    localStorageMock.getItem.mockReturnValue(null as unknown as string);

    expect(() => playTurnChime()).not.toThrow();
  });

  it('connects oscillators to the gain node and gain to destination', () => {
    const ctx = buildMockAudioContext();
    installAudioContext(ctx);

    localStorageMock.getItem.mockReturnValue(null as unknown as string);

    playTurnChime();

    // Each oscillator should have been connected (to its gain node)
    const calls = ctx.createOscillator.mock.results;
    calls.forEach((r) => {
      expect((r.value as MockOscillator).connect).toHaveBeenCalledTimes(1);
    });

    // Each gain node should have been connected (to the destination)
    const gainCalls = ctx.createGain.mock.results;
    gainCalls.forEach((r) => {
      expect((r.value as MockGainNode).connect).toHaveBeenCalledWith(ctx.destination);
    });
  });

  it('schedules oscillator start and stop for each tone', () => {
    const ctx = buildMockAudioContext();
    installAudioContext(ctx);

    localStorageMock.getItem.mockReturnValue(null as unknown as string);

    playTurnChime();

    ctx.createOscillator.mock.results.forEach((r) => {
      const osc = r.value as MockOscillator;
      expect(osc.start).toHaveBeenCalledTimes(1);
      expect(osc.stop).toHaveBeenCalledTimes(1);
    });
  });
});
