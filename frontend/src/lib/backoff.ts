const _BASE_DELAY_MS = 1000;
const _MAX_DELAY_MS = 10_000;

export function backoffDelayMs(attempt: number): number {
  return Math.min(_BASE_DELAY_MS * 2 ** attempt, _MAX_DELAY_MS);
}

export function retryWithBackoff(
  run: (signal: AbortSignal) => Promise<boolean>,
  options: { attemptTimeoutMs: number },
): () => void {
  let failures = 0;
  let current: AbortController | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let wait: ReturnType<typeof setTimeout> | undefined;

  async function attempt() {
    wait = undefined;
    const controller = new AbortController();
    current = controller;
    deadline = setTimeout(() => {
      controller.abort();
      settle(controller, false);
    }, options.attemptTimeoutMs);
    let done: boolean;
    try {
      done = await run(controller.signal);
    } catch {
      done = false;
    }
    settle(controller, done);
  }

  function settle(controller: AbortController, done: boolean) {
    // A timed-out or cancelled attempt may still settle later; only the current one counts.
    if (controller !== current) return;
    if (done) {
      stop();
      return;
    }
    clearTimeout(deadline);
    current = null;
    wait = setTimeout(attempt, backoffDelayMs(failures++));
  }

  function retryNow() {
    if (wait === undefined) return;
    clearTimeout(wait);
    void attempt();
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') retryNow();
  }

  function stop() {
    clearTimeout(deadline);
    clearTimeout(wait);
    wait = undefined;
    current = null;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('online', retryNow);
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('online', retryNow);
  void attempt();

  return () => {
    current?.abort();
    stop();
  };
}
