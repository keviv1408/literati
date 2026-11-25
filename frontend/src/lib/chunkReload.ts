const _KEY = 'literati:chunk-reload-at';
// Covers the reload and the lobby's redirect into the game; a second failure inside it means the deploy itself is broken.
const _WINDOW_MS = 60_000;

// A tab left open across a deploy asks for chunks the new build no longer serves; one reload picks up the new build.
export function claimChunkReload(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'ChunkLoadError') return false;
  try {
    const last = Number(window.sessionStorage.getItem(_KEY));
    if (Date.now() - last < _WINDOW_MS) return false;
    window.sessionStorage.setItem(_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}
