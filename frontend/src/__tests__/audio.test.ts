/**
 * @jest-environment jsdom
 */

type AudioModule = typeof import('@/lib/audio');

const makeLocalStorageMock = () => {
  const store: Record<string, string> = {};
  return {
    getItem: jest.fn((key: string) => store[key] ?? null),
    setItem: jest.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: jest.fn((key: string) => {
      delete store[key];
    }),
    clear: jest.fn(() => {
      Object.keys(store).forEach((key) => delete store[key]);
    }),
  };
};

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

type MockBufferSource = {
  buffer: AudioBuffer | null;
  connect: jest.Mock;
  start: jest.Mock;
  stop: jest.Mock;
};

type MockAudioBuffer = {
  getChannelData: jest.Mock<Float32Array, [number]>;
};

type MockAudioCtx = {
  state: 'running' | 'suspended' | 'closed';
  currentTime: number;
  sampleRate: number;
  destination: Record<string, never>;
  resume: jest.Mock<Promise<void>>;
  decodeAudioData: jest.Mock<Promise<AudioBuffer>, [ArrayBuffer]>;
  createOscillator: jest.Mock<MockOscillator>;
  createGain: jest.Mock<MockGainNode>;
  createBuffer: jest.Mock<MockAudioBuffer, [number, number, number]>;
  createBufferSource: jest.Mock<MockBufferSource>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const win = () => window as any;

function buildMockAudioContext(state: MockAudioCtx['state'] = 'running'): MockAudioCtx {
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

  const makeBufferSource = (): MockBufferSource => ({
    buffer: null,
    connect: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
  });

  const makeAudioBuffer = (): MockAudioBuffer => ({
    getChannelData: jest.fn(() => new Float32Array(1)),
  });

  return {
    state,
    currentTime: 0,
    sampleRate: 44100,
    destination: {},
    resume: jest.fn().mockResolvedValue(undefined),
    decodeAudioData: jest.fn(async () => ({ decoded: true } as unknown as AudioBuffer)),
    createOscillator: jest.fn(makeOscillator),
    createGain: jest.fn(makeGain),
    createBuffer: jest.fn(makeAudioBuffer),
    createBufferSource: jest.fn(makeBufferSource),
  };
}

function installAudioContext(ctx: MockAudioCtx) {
  win().AudioContext = jest.fn(() => ctx);
  delete win().webkitAudioContext;
}

function installWebkitAudioContext(ctx: MockAudioCtx) {
  delete win().AudioContext;
  win().webkitAudioContext = jest.fn(() => ctx);
}

function removeAudioContext() {
  delete win().AudioContext;
  delete win().webkitAudioContext;
}

function loadAudioModule(): AudioModule {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/lib/audio') as AudioModule;
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let localStorageMock: ReturnType<typeof makeLocalStorageMock>;

beforeEach(() => {
  localStorageMock = makeLocalStorageMock();
  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, 'navigator', {
    value: {
      ...window.navigator,
      userActivation: { hasBeenActive: true, isActive: true },
    },
    writable: true,
    configurable: true,
  });

  global.fetch = jest.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
  })) as unknown as typeof fetch;

  jest.clearAllMocks();
});

afterEach(() => {
  removeAudioContext();
});

describe('audio.ts — mute helpers', () => {
  it('reads and writes the persisted mute preference', () => {
    const audio = loadAudioModule();

    expect(audio.isMuted()).toBe(false);

    audio.setMuted(true);
    expect(audio.isMuted()).toBe(true);

    expect(audio.toggleMuted()).toBe(false);
    expect(audio.isMuted()).toBe(false);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(audio.MUTE_STORAGE_KEY, 'true');
    expect(localStorageMock.setItem).toHaveBeenCalledWith(audio.MUTE_STORAGE_KEY, 'false');
  });
});

describe('audio.ts — user activation and shared context', () => {
  it('does not create an AudioContext before the page is user-activated', () => {
    const ctx = buildMockAudioContext();
    installAudioContext(ctx);
    Object.defineProperty(window, 'navigator', {
      value: {
        ...window.navigator,
        userActivation: { hasBeenActive: false, isActive: false },
      },
      writable: true,
      configurable: true,
    });

    const audio = loadAudioModule();
    audio.playTurnChime();

    expect(win().AudioContext).not.toHaveBeenCalled();
  });

  it('warms the shared context once and preloads the game sound files', async () => {
    const ctx = buildMockAudioContext('suspended');
    installAudioContext(ctx);
    const audio = loadAudioModule();

    audio.unlockGameAudio();
    await flushAsyncWork();

    expect(win().AudioContext).toHaveBeenCalledTimes(1);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.createBuffer).toHaveBeenCalledWith(1, 1, ctx.sampleRate);
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(4);
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(4);
  });

  it('reuses the unlocked shared context for synthesized sounds', async () => {
    const ctx = buildMockAudioContext();
    installAudioContext(ctx);
    const audio = loadAudioModule();

    audio.unlockGameAudio();
    await flushAsyncWork();
    expect(win().AudioContext).toHaveBeenCalledTimes(1);

    ctx.createOscillator.mockClear();
    ctx.createGain.mockClear();

    audio.playTurnChime();

    expect(win().AudioContext).toHaveBeenCalledTimes(1);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
    expect(ctx.createGain).toHaveBeenCalledTimes(2);
  });

  it('falls back to webkitAudioContext when needed', async () => {
    const ctx = buildMockAudioContext();
    installWebkitAudioContext(ctx);
    const audio = loadAudioModule();

    audio.unlockGameAudio();
    await flushAsyncWork();
    audio.playTurnChime();

    expect(win().webkitAudioContext).toHaveBeenCalledTimes(1);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
  });
});

describe('audio.ts — synthesized gameplay sounds', () => {
  it('plays the deal cue through the shared context after unlock', async () => {
    const ctx = buildMockAudioContext();
    installAudioContext(ctx);
    const audio = loadAudioModule();

    audio.unlockGameAudio();
    await flushAsyncWork();
    ctx.createOscillator.mockClear();
    ctx.createGain.mockClear();

    audio.playDealSound();

    expect(ctx.createOscillator).toHaveBeenCalledTimes(10);
    expect(ctx.createGain).toHaveBeenCalledTimes(10);
  });

  it('is a no-op for synthesized sounds when muted', () => {
    const ctx = buildMockAudioContext();
    installAudioContext(ctx);
    localStorageMock.getItem.mockReturnValue('true');
    const audio = loadAudioModule();

    audio.playDealSound();
    audio.playTurnChime();

    expect(win().AudioContext).not.toHaveBeenCalled();
  });
});

describe('audio.ts — file-backed gameplay sounds', () => {
  it('plays from the preloaded buffer cache once unlocked', async () => {
    const ctx = buildMockAudioContext();
    installAudioContext(ctx);
    const audio = loadAudioModule();

    audio.unlockGameAudio();
    await flushAsyncWork();
    ctx.createBufferSource.mockClear();

    audio.playAskSuccess();

    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
    const source = ctx.createBufferSource.mock.results[0].value as MockBufferSource;
    expect(source.connect).toHaveBeenCalledWith(ctx.destination);
    expect(source.start).toHaveBeenCalledWith(0);
  });

  it('lazy-loads a file sound and plays it once decoding completes', async () => {
    const ctx = buildMockAudioContext();
    installAudioContext(ctx);
    const audio = loadAudioModule();

    audio.playAskSuccess();
    await flushAsyncWork();

    expect(win().AudioContext).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith('/sounds/askSuccess.mp3');
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
  });

  it('does not attempt file playback when muted', () => {
    const ctx = buildMockAudioContext();
    installAudioContext(ctx);
    localStorageMock.getItem.mockReturnValue('true');
    const audio = loadAudioModule();

    audio.playAskFail();
    audio.playDeclarationSuccess();
    audio.playDeclarationFail();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(win().AudioContext).not.toHaveBeenCalled();
  });

  it('fails silently when fetch is unavailable during unlock', () => {
    const ctx = buildMockAudioContext();
    installAudioContext(ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = undefined;
    const audio = loadAudioModule();

    expect(() => audio.unlockGameAudio()).not.toThrow();
  });

  it('fails silently when the AudioContext constructor throws', () => {
    win().AudioContext = jest.fn(() => {
      throw new Error('blocked');
    });
    const audio = loadAudioModule();

    expect(() => audio.unlockGameAudio()).not.toThrow();
    expect(() => audio.playAskSuccess()).not.toThrow();
    expect(() => audio.playTurnChime()).not.toThrow();
  });
});
