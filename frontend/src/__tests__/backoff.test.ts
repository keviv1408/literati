import { backoffDelayMs, retryWithBackoff } from '@/lib/backoff';

type Outcome = boolean | Error | 'throw' | 'hang' | 'rejectOnAbort';

const ATTEMPT_TIMEOUT_MS = 15_000;

let cancels: Array<() => void> = [];

beforeEach(() => {
  jest.useFakeTimers();
  cancels = [];
});

afterEach(() => {
  cancels.forEach((cancel) => cancel());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// Unlisted outcomes fail, so a test sees every extra call in its times.
function _recordingRun(outcomes: Outcome[]) {
  const t0 = Date.now();
  const times: number[] = [];
  const signals: AbortSignal[] = [];
  const run = (signal: AbortSignal): Promise<boolean> => {
    times.push(Date.now() - t0);
    signals.push(signal);
    const outcome = outcomes[times.length - 1] ?? false;
    if (outcome === 'throw') throw new Error('sync failure');
    if (outcome === 'hang') return new Promise<boolean>(() => {});
    if (outcome === 'rejectOnAbort') {
      return new Promise<boolean>((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve(outcome);
  };
  return { run, times, signals };
}

function _start(run: (signal: AbortSignal) => Promise<boolean>) {
  const cancel = retryWithBackoff(run, { attemptTimeoutMs: ATTEMPT_TIMEOUT_MS });
  cancels.push(cancel);
  return cancel;
}

function _fireVisibility(state: DocumentVisibilityState) {
  jest.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  document.dispatchEvent(new Event('visibilitychange'));
}

function _fireOnline() {
  window.dispatchEvent(new Event('online'));
}

function _listenerSpies() {
  return [
    {
      type: 'visibilitychange',
      add: jest.spyOn(document, 'addEventListener'),
      remove: jest.spyOn(document, 'removeEventListener'),
    },
    {
      type: 'online',
      add: jest.spyOn(window, 'addEventListener'),
      remove: jest.spyOn(window, 'removeEventListener'),
    },
  ];
}

function _expectListenersRemoved(spies: ReturnType<typeof _listenerSpies>) {
  for (const { type, add, remove } of spies) {
    const handler = add.mock.calls.find(([added]) => added === type)?.[1];
    expect(handler).toBeDefined();
    expect(remove).toHaveBeenCalledWith(type, handler);
  }
}

describe('backoffDelayMs', () => {
  it('doubles from 1 s and caps at 10 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(backoffDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 10000, 10000, 10000,
    ]);
  });
});

describe('retryWithBackoff', () => {
  it('retries a false result on the schedule and stops for good on true', async () => {
    const { run, times } = _recordingRun([false, false, true]);
    _start(run);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(times).toEqual([0, 1000, 3000]);
  });

  it('retries a synchronous throw and a rejection the same way', async () => {
    const { run, times } = _recordingRun(['throw', new Error('async failure'), true]);
    _start(run);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(times).toEqual([0, 1000, 3000]);
  });

  it('runs the next attempt at once when the page becomes visible during a wait', async () => {
    const { run, times } = _recordingRun([false, true]);
    _start(run);
    await jest.advanceTimersByTimeAsync(400);

    _fireVisibility('hidden');
    await jest.advanceTimersByTimeAsync(0);
    expect(times).toEqual([0]);

    _fireVisibility('visible');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(times).toEqual([0, 400]);
  });

  it('runs the next attempt at once on online during a wait, and the schedule moves on', async () => {
    const { run, times } = _recordingRun([false, false, true]);
    _start(run);
    await jest.advanceTimersByTimeAsync(500);

    _fireOnline();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(times).toEqual([0, 500, 2500]);
  });

  it('ignores visible and online while an attempt is in flight', async () => {
    const { run, times } = _recordingRun(['hang']);
    _start(run);

    _fireOnline();
    _fireVisibility('visible');
    await jest.advanceTimersByTimeAsync(0);
    expect(times).toEqual([0]);
  });

  it('aborts a run that never settles at the deadline and schedules the next attempt', async () => {
    const { run, times, signals } = _recordingRun(['hang', true]);
    _start(run);

    await jest.advanceTimersByTimeAsync(ATTEMPT_TIMEOUT_MS - 1);
    expect(signals[0].aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(signals[0].aborted).toBe(true);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(times).toEqual([0, ATTEMPT_TIMEOUT_MS + 1000]);
  });

  it('ignores the rejection of an attempt it already timed out', async () => {
    const { run, times } = _recordingRun(['rejectOnAbort', true]);
    _start(run);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(times).toEqual([0, ATTEMPT_TIMEOUT_MS + 1000]);
  });

  it('cancel aborts the attempt in flight, stops the loop and removes its listeners', async () => {
    const spies = _listenerSpies();
    const { run, times, signals } = _recordingRun(['hang']);
    const cancel = _start(run);

    cancel();
    expect(signals[0].aborted).toBe(true);
    _expectListenersRemoved(spies);

    _fireOnline();
    _fireVisibility('visible');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(times).toEqual([0]);
  });

  it('cancel during a wait stops the loop', async () => {
    const { run, times } = _recordingRun([false]);
    const cancel = _start(run);
    await jest.advanceTimersByTimeAsync(500);

    cancel();
    _fireOnline();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(times).toEqual([0]);
  });

  it('removes its listeners on success, and cancel after that is safe to call twice', async () => {
    const spies = _listenerSpies();
    const { run, times, signals } = _recordingRun([true]);
    const cancel = _start(run);
    await jest.advanceTimersByTimeAsync(0);
    _expectListenersRemoved(spies);

    cancel();
    cancel();
    expect(signals[0].aborted).toBe(false);
    _fireOnline();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(times).toEqual([0]);
  });
});
