'use client';

import { useEffect, useState } from 'react';

const _SLOW_AFTER_MS = 10_000;

export default function ReconnectBar({ onRetry }: { onRetry: () => void }) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), _SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className="relative z-10 flex items-center justify-center gap-2 px-4 py-1.5 bg-yellow-900/60 border-b border-yellow-700/40 text-xs text-yellow-200"
      role="status"
      aria-live="polite"
      data-testid="ws-reconnecting-banner"
    >
      <span aria-hidden="true">⟳</span>
      <span>{slow ? 'Reconnecting… the server may be restarting.' : 'Reconnecting…'}</span>
      {slow && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-yellow-600/60 px-2 py-0.5 font-semibold text-yellow-100 hover:bg-yellow-800/60 focus:outline-none focus:ring-2 focus:ring-yellow-400"
          data-testid="ws-retry-now"
        >
          Try now
        </button>
      )}
    </div>
  );
}
