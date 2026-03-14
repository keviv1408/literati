/**
 * @jest-environment jsdom
 *
 * Unit tests for /lib/soundManager.ts
 *
 * Coverage:
 *   SoundManager class:
 *     • Constructor reads volume from localStorage (default 0.7 when absent)
 *     • setVolume() clamps, persists, and updates the volume getter
 *     • preload() creates an AudioContext and resumes if suspended
 *     • preload() is idempotent (second call is a no-op)
 *     • play() dispatches to the correct play method for each SoundEvent
 *     • play() silently ignores unknown event strings
 *     • playCardDeal() — no-op when muted
 *     • playCardDeal() — creates oscillator + noise when unmuted
 *     • playAskSuccess() — no-op when muted
 *     • playAskSuccess() — plays three ascending tones when unmuted
 *     • playAskFail() — no-op when muted
 *     • playAskFail() — plays two descending tones when unmuted
 *     • playDeclarationFanfare() — no-op when muted
 *     • playDeclarationFanfare() — plays five notes when unmuted
 *     • All play methods — no-op when volume === 0
 *     • All play methods — fail silently on AudioContext errors
 *     • All play methods — no-op when AudioContext unavailable
 *     • Lazy AudioContext — created on first play, reused thereafter
 *
 *   soundManager singleton:
 *     • Is an instance of SoundManager
 *     • Has a default volume in [0, 1]
 */

import { SoundManager, soundManager, VOLUME_STORAGE_KEY } from '@/lib/soundManager';

// ---------------------------------------------------------------------------
// LocalStorage mock
// ---------------------------------------------------------------------------

const makeLocalStorageMock = () => {
  const store: Record<string, string> = {};
  return {
    getItem:    jest.fn((k: string) => store[k] ?? null),
    setItem:    jest.fn((k: string, v: string) => { store[k] = v; }),
    removeItem: jest.fn((k: string) => { delete store[k]; }),
    clear:      jest.fn(() => { Object.keys(store).forEach(k => delete store[k]); }),
    _store:     store,
  };
};

let lsMock: ReturnType<typeof makeLocalStorageMock>;

// ---------------------------------------------------------------------------
// AudioContext mock
// ---------------------------------------------------------------------------

type MockBufferSrcNode = {
  buffer: AudioBuffer | null;
  connect: jest.Mock;
  start: jest.Mock;
  stop: jest.Mock;
};

type MockOscillator = {
  type: OscillatorType;
  frequency: { value: number };
  connect: jest.Mock;
  start: jest.Mock;
  stop: jest.Mock;
};

type MockBiquadFilter = {
  type: BiquadFilterType;
  frequency: { value: number; setValueAtTime: jest.Mock; exponentialRampToValueAtTime: jest.Mock };
  Q: { value: number };
  connect: jest.Mock;
};

type MockGainNode = {
  gain: {
    value: number;
    setValueAtTime: jest.Mock;
    linearRampToValueAtTime: jest.Mock;
    exponentialRampToValueAtTime: jest.Mock;
  };
  connect: jest.Mock;
};

type MockAudioBuffer = object;

type MockAudioCtx = {
  state: 'running' | 'suspended' | 'closed';
  currentTime: number;
  sampleRate: number;
  destination: Record<string, never>;
  resume: jest.Mock<Promise<void>>;
  close:  jest.Mock<Promise<void>>;
  createOscillator: jest.Mock<MockOscillator>;
  createGain: jest.Mock<MockGainNode>;
  createBiquadFilter: jest.Mock<MockBiquadFilter>;
  createBuffer: jest.Mock<MockAudioBuffer>;
  createBufferSource: jest.Mock<MockBufferSrcNode>;
};

function buildMockAudioCtx(state: MockAudioCtx['state'] = 'running'): MockAudioCtx {
  const makeOsc = (): MockOscillator => ({
    type: 'sine',
    frequency: { value: 0 },
    connect: jest.fn(),
    start:   jest.fn(),
    stop:    jest.fn(),
  });

  const makeGain = (): MockGainNode => ({
    gain: {
      value: 1,
      setValueAtTime: jest.fn(),
      linearRampToValueAtTime: jest.fn(),
      exponentialRampToValueAtTime: jest.fn(),
    },
    connect: jest.fn(),
  });

  const makeFilter = (): MockBiquadFilter => ({
    type: 'lowpass',
    frequency: {
      value: 0,
      setValueAtTime: jest.fn(),
      exponentialRampToValueAtTime: jest.fn(),
    },
    Q: { value: 1 },
    connect: jest.fn(),
  });

  const makeBufSrc = (): MockBufferSrcNode => ({
    buffer: null,
    connect: jest.fn(),
    start:   jest.fn(),
    stop:    jest.fn(),
  });

  // Simple fake AudioBuffer
  const makeBuffer = (): MockAudioBuffer => ({
    getChannelData: jest.fn(() => new Float32Array(1024)),
  });

  return {
    state,
    currentTime: 0,
    sampleRate: 44100,
    destination: {},
    resume: jest.fn().mockResolvedValue(undefined),
    close:  jest.fn().mockResolvedValue(undefined),
    createOscillator:   jest.fn(makeOsc),
    createGain:         jest.fn(makeGain),
    createBiquadFilter: jest.fn(makeFilter),
    createBuffer:       jest.fn(makeBuffer),
    createBufferSource: jest.fn(makeBufSrc),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const win = () => window as any;

function installAudioContext(ctx: MockAudioCtx) {
  win().AudioContext = jest.fn(() => ctx);
  delete win().webkitAudioContext;
}

function removeAudioContext() {
  delete win().AudioContext;
  delete win().webkitAudioContext;
}

// ---------------------------------------------------------------------------
// isMuted mock (from @/lib/audio)
// ---------------------------------------------------------------------------

const mockIsMuted = jest.fn<boolean, []>().mockReturnValue(false);

jest.mock('@/lib/audio', () => ({
  isMuted: (...args: unknown[]) => mockIsMuted(...(args as [])),
}));

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  lsMock = makeLocalStorageMock();
  Object.defineProperty(window, 'localStorage', {
    value: lsMock,
    writable: true,
    configurable: true,
  });
  jest.clearAllMocks();
  mockIsMuted.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// Helper: fresh SoundManager instance (avoids singleton state leak)
// ---------------------------------------------------------------------------
function freshManager() {
  return new SoundManager();
}

// ===========================================================================
// 1. Constructor & volume
// ===========================================================================

describe('SoundManager — constructor & volume', () => {
  it('uses DEFAULT_VOLUME (0.7) when localStorage has no entry', () => {
    lsMock.getItem.mockReturnValue(null);
    const sm = freshManager();
    expect(sm.volume).toBe(0.7);
  });

  it('reads volume from localStorage on construction', () => {
    lsMock.getItem.mockReturnValueOnce('0.4');
    const sm = freshManager();
    expect(sm.volume).toBeCloseTo(0.4);
  });

  it('falls back to DEFAULT_VOLUME when localStorage value is NaN', () => {
    lsMock.getItem.mockReturnValueOnce('not-a-number');
    const sm = freshManager();
    expect(sm.volume).toBe(0.7);
  });

  it('clamps a stored value > 1 to 1.0', () => {
    lsMock.getItem.mockReturnValueOnce('2.5');
    const sm = freshManager();
    expect(sm.volume).toBe(1.0);
  });

  it('clamps a stored value < 0 to 0.0', () => {
    lsMock.getItem.mockReturnValueOnce('-0.3');
    const sm = freshManager();
    expect(sm.volume).toBe(0.0);
  });
});

describe('SoundManager — setVolume()', () => {
  it('updates the volume getter', () => {
    const sm = freshManager();
    sm.setVolume(0.5);
    expect(sm.volume).toBeCloseTo(0.5);
  });

  it('persists to localStorage using VOLUME_STORAGE_KEY', () => {
    const sm = freshManager();
    sm.setVolume(0.3);
    expect(lsMock.setItem).toHaveBeenCalledWith(VOLUME_STORAGE_KEY, '0.3');
  });

  it('clamps values above 1', () => {
    const sm = freshManager();
    sm.setVolume(5);
    expect(sm.volume).toBe(1.0);
    expect(lsMock.setItem).toHaveBeenCalledWith(VOLUME_STORAGE_KEY, '1');
  });

  it('clamps values below 0', () => {
    const sm = freshManager();
    sm.setVolume(-1);
    expect(sm.volume).toBe(0.0);
    expect(lsMock.setItem).toHaveBeenCalledWith(VOLUME_STORAGE_KEY, '0');
  });

  it('allows setting to 0 (silent)', () => {
    const sm = freshManager();
    sm.setVolume(0);
    expect(sm.volume).toBe(0);
  });

  it('allows setting to 1 (full)', () => {
    const sm = freshManager();
    sm.setVolume(1);
    expect(sm.volume).toBe(1);
  });
});

// ===========================================================================
// 2. preload()
// ===========================================================================

describe('SoundManager — preload()', () => {
  it('creates an AudioContext on first call', () => {
    const ctx = buildMockAudioCtx('running');
    installAudioContext(ctx);
    const sm = freshManager();

    sm.preload();

    expect(win().AudioContext).toHaveBeenCalledTimes(1);
  });

  it('calls resume() when context is suspended', () => {
    const ctx = buildMockAudioCtx('suspended');
    installAudioContext(ctx);
    const sm = freshManager();

    sm.preload();

    expect(ctx.resume).toHaveBeenCalledTimes(1);
  });

  it('does not call resume() when context is already running', () => {
    const ctx = buildMockAudioCtx('running');
    installAudioContext(ctx);
    const sm = freshManager();

    sm.preload();

    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it('is idempotent — second call does not create another AudioContext', () => {
    const ctx = buildMockAudioCtx('running');
    installAudioContext(ctx);
    const sm = freshManager();

    sm.preload();
    sm.preload();

    expect(win().AudioContext).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when AudioContext is unavailable', () => {
    removeAudioContext();
    const sm = freshManager();
    expect(() => sm.preload()).not.toThrow();
  });
});

// ===========================================================================
// 3. play() dispatcher
// ===========================================================================

describe('SoundManager — play() dispatcher', () => {
  it('calls playCardDeal() for "card_deal"', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();
    const spy = jest.spyOn(sm, 'playCardDeal');

    sm.play('card_deal');

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('calls playAskSuccess() for "ask_success"', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();
    const spy = jest.spyOn(sm, 'playAskSuccess');

    sm.play('ask_success');

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('calls playAskFail() for "ask_fail"', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();
    const spy = jest.spyOn(sm, 'playAskFail');

    sm.play('ask_fail');

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('calls playDeclarationFanfare() for "declaration_fanfare"', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();
    const spy = jest.spyOn(sm, 'playDeclarationFanfare');

    sm.play('declaration_fanfare');

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not throw for an unknown event name', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    // Cast to bypass TypeScript so we can test the runtime guard
    expect(() => sm.play('unknown_event' as 'card_deal')).not.toThrow();
  });
});

// ===========================================================================
// 4. playCardDeal()
// ===========================================================================

describe('SoundManager — playCardDeal()', () => {
  it('does not create AudioContext when muted', () => {
    mockIsMuted.mockReturnValue(true);
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playCardDeal();

    expect(win().AudioContext).not.toHaveBeenCalled();
  });

  it('does not create AudioContext when volume is 0', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();
    sm.setVolume(0);
    jest.clearAllMocks();

    sm.playCardDeal();

    expect(win().AudioContext).not.toHaveBeenCalled();
  });

  it('creates nodes and starts playback when unmuted', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playCardDeal();

    // Expects at least one oscillator or buffer source
    const oscillators  = ctx.createOscillator.mock.calls.length;
    const bufferSrcs   = ctx.createBufferSource.mock.calls.length;
    expect(oscillators + bufferSrcs).toBeGreaterThan(0);
  });

  it('starts the oscillator / buffer source', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playCardDeal();

    const allStartCalls = [
      ...ctx.createOscillator.mock.results.map(r => (r.value as MockOscillator).start),
      ...ctx.createBufferSource.mock.results.map(r => (r.value as MockBufferSrcNode).start),
    ];
    expect(allStartCalls.some(fn => fn.mock.calls.length > 0)).toBe(true);
  });

  it('is a no-op when AudioContext is unavailable', () => {
    removeAudioContext();
    const sm = freshManager();
    expect(() => sm.playCardDeal()).not.toThrow();
  });

  it('fails silently when AudioContext constructor throws', () => {
    win().AudioContext = jest.fn(() => { throw new Error('blocked'); });
    const sm = freshManager();
    expect(() => sm.playCardDeal()).not.toThrow();
  });
});

// ===========================================================================
// 5. playAskSuccess()
// ===========================================================================

describe('SoundManager — playAskSuccess()', () => {
  it('does not create AudioContext when muted', () => {
    mockIsMuted.mockReturnValue(true);
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playAskSuccess();

    expect(win().AudioContext).not.toHaveBeenCalled();
  });

  it('does not create AudioContext when volume is 0', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();
    sm.setVolume(0);
    jest.clearAllMocks();

    sm.playAskSuccess();

    expect(win().AudioContext).not.toHaveBeenCalled();
  });

  it('plays three ascending tones (3 oscillators)', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playAskSuccess();

    expect(ctx.createOscillator).toHaveBeenCalledTimes(3);
  });

  it('creates one gain node per tone', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playAskSuccess();

    expect(ctx.createGain).toHaveBeenCalledTimes(3);
  });

  it('connects each oscillator to its gain then to destination', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playAskSuccess();

    ctx.createGain.mock.results.forEach(r => {
      expect((r.value as MockGainNode).connect).toHaveBeenCalledWith(ctx.destination);
    });
  });

  it('starts and stops every oscillator', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playAskSuccess();

    ctx.createOscillator.mock.results.forEach(r => {
      const osc = r.value as MockOscillator;
      expect(osc.start).toHaveBeenCalledTimes(1);
      expect(osc.stop).toHaveBeenCalledTimes(1);
    });
  });

  it('is a no-op when AudioContext is unavailable', () => {
    removeAudioContext();
    const sm = freshManager();
    expect(() => sm.playAskSuccess()).not.toThrow();
  });

  it('fails silently when AudioContext constructor throws', () => {
    win().AudioContext = jest.fn(() => { throw new Error('blocked'); });
    const sm = freshManager();
    expect(() => sm.playAskSuccess()).not.toThrow();
  });
});

// ===========================================================================
// 6. playAskFail()
// ===========================================================================

describe('SoundManager — playAskFail()', () => {
  it('does not create AudioContext when muted', () => {
    mockIsMuted.mockReturnValue(true);
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playAskFail();

    expect(win().AudioContext).not.toHaveBeenCalled();
  });

  it('does not create AudioContext when volume is 0', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();
    sm.setVolume(0);
    jest.clearAllMocks();

    sm.playAskFail();

    expect(win().AudioContext).not.toHaveBeenCalled();
  });

  it('plays two descending tones (2 oscillators)', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playAskFail();

    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
  });

  it('uses a low-pass filter to soften sawtooth harshness', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playAskFail();

    // Two oscillators → two low-pass filters
    expect(ctx.createBiquadFilter).toHaveBeenCalledTimes(2);
    ctx.createBiquadFilter.mock.results.forEach(r => {
      expect((r.value as MockBiquadFilter).type).toBe('lowpass');
    });
  });

  it('uses sawtooth waveform for the "fail" quality', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playAskFail();

    ctx.createOscillator.mock.results.forEach(r => {
      expect((r.value as MockOscillator).type).toBe('sawtooth');
    });
  });

  it('starts and stops every oscillator', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playAskFail();

    ctx.createOscillator.mock.results.forEach(r => {
      const osc = r.value as MockOscillator;
      expect(osc.start).toHaveBeenCalledTimes(1);
      expect(osc.stop).toHaveBeenCalledTimes(1);
    });
  });

  it('is a no-op when AudioContext is unavailable', () => {
    removeAudioContext();
    const sm = freshManager();
    expect(() => sm.playAskFail()).not.toThrow();
  });

  it('fails silently when AudioContext constructor throws', () => {
    win().AudioContext = jest.fn(() => { throw new Error('blocked'); });
    const sm = freshManager();
    expect(() => sm.playAskFail()).not.toThrow();
  });
});

// ===========================================================================
// 7. playDeclarationFanfare()
// ===========================================================================

describe('SoundManager — playDeclarationFanfare()', () => {
  it('does not create AudioContext when muted', () => {
    mockIsMuted.mockReturnValue(true);
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playDeclarationFanfare();

    expect(win().AudioContext).not.toHaveBeenCalled();
  });

  it('does not create AudioContext when volume is 0', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();
    sm.setVolume(0);
    jest.clearAllMocks();

    sm.playDeclarationFanfare();

    expect(win().AudioContext).not.toHaveBeenCalled();
  });

  it('plays 5 primary notes + 5 harmonic overtones (10 oscillators total)', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playDeclarationFanfare();

    // 5 primary + 5 harmonic oscillators
    expect(ctx.createOscillator).toHaveBeenCalledTimes(10);
  });

  it('creates a gain node for each oscillator', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playDeclarationFanfare();

    // 5 masterGain + 5 harmGain
    expect(ctx.createGain).toHaveBeenCalledTimes(10);
  });

  it('starts and stops every oscillator', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playDeclarationFanfare();

    ctx.createOscillator.mock.results.forEach(r => {
      const osc = r.value as MockOscillator;
      expect(osc.start).toHaveBeenCalledTimes(1);
      expect(osc.stop).toHaveBeenCalledTimes(1);
    });
  });

  it('is a no-op when AudioContext is unavailable', () => {
    removeAudioContext();
    const sm = freshManager();
    expect(() => sm.playDeclarationFanfare()).not.toThrow();
  });

  it('fails silently when AudioContext constructor throws', () => {
    win().AudioContext = jest.fn(() => { throw new Error('blocked'); });
    const sm = freshManager();
    expect(() => sm.playDeclarationFanfare()).not.toThrow();
  });
});

// ===========================================================================
// 8. Lazy AudioContext reuse
// ===========================================================================

describe('SoundManager — lazy AudioContext reuse', () => {
  it('creates AudioContext only once across multiple play calls', () => {
    const ctx = buildMockAudioCtx();
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playAskSuccess();
    sm.playAskFail();
    sm.playCardDeal();

    expect(win().AudioContext).toHaveBeenCalledTimes(1);
  });

  it('resumes a suspended context before playing', () => {
    const ctx = buildMockAudioCtx('suspended');
    installAudioContext(ctx);
    const sm = freshManager();

    sm.playAskSuccess();

    expect(ctx.resume).toHaveBeenCalled();
  });
});

// ===========================================================================
// 9. soundManager singleton
// ===========================================================================

describe('soundManager singleton', () => {
  it('is an instance of SoundManager', () => {
    expect(soundManager).toBeInstanceOf(SoundManager);
  });

  it('has a default volume in the range [0, 1]', () => {
    expect(soundManager.volume).toBeGreaterThanOrEqual(0);
    expect(soundManager.volume).toBeLessThanOrEqual(1);
  });

  it('exposes play(), playCardDeal(), playAskSuccess(), playAskFail(), playDeclarationFanfare()', () => {
    expect(typeof soundManager.play).toBe('function');
    expect(typeof soundManager.playCardDeal).toBe('function');
    expect(typeof soundManager.playAskSuccess).toBe('function');
    expect(typeof soundManager.playAskFail).toBe('function');
    expect(typeof soundManager.playDeclarationFanfare).toBe('function');
  });

  it('exposes setVolume() and preload()', () => {
    expect(typeof soundManager.setVolume).toBe('function');
    expect(typeof soundManager.preload).toBe('function');
  });
});

// ===========================================================================
// 10. VOLUME_STORAGE_KEY export
// ===========================================================================

describe('VOLUME_STORAGE_KEY', () => {
  it('is a non-empty string', () => {
    expect(typeof VOLUME_STORAGE_KEY).toBe('string');
    expect(VOLUME_STORAGE_KEY.length).toBeGreaterThan(0);
  });

  it('follows the literati: namespace convention', () => {
    expect(VOLUME_STORAGE_KEY).toMatch(/^literati:/);
  });
});
