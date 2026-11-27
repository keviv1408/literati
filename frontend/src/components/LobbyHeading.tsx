import { useEffect, useRef, useState } from 'react';

export default function LobbyHeading({ roomCode }: { roomCode?: string }) {
  const [feedback, setFeedback] = useState('');
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(''), 3000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  async function _copyCode() {
    if (!roomCode) return;
    try {
      await navigator.clipboard.writeText(roomCode);
      setFeedback('Copied');
    } catch {
      codeInput.current?.focus();
      codeInput.current?.select();
      setFeedback('Select and copy the code');
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h1 className="text-2xl font-bold tracking-tight text-white">Room lobby</h1>
      {roomCode && (
        <div className="inline-flex items-center gap-1 rounded-xl border border-emerald-700 bg-emerald-950 pl-3 text-emerald-100">
          <input ref={codeInput} aria-label="Room code" readOnly value={roomCode}
            onFocus={(event) => event.currentTarget.select()}
            className="w-[7ch] select-all bg-transparent font-mono font-semibold tracking-wide text-white focus-visible:outline-2" />
          <button type="button" onClick={_copyCode} aria-label="Copy room code" title="Copy room code"
            className="flex size-11 items-center justify-center rounded-xl hover:bg-emerald-900 focus-visible:outline-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <rect x="8" y="8" width="12" height="13" rx="2" />
              <path d="M15 5V4a1 1 0 0 0-1-1H5a2 2 0 0 0-2 2v10a1 1 0 0 0 1 1h1" />
            </svg>
          </button>
        </div>
      )}
      <span role="status" className="text-xs text-emerald-200">{feedback}</span>
    </div>
  );
}
