'use client';

/**
 * LastMoveDisplay
 *
 * A compact banner strip that shows the single most-recent game action.
 * Only one move is ever shown at a time (no running history log).
 *
 * Renders nothing when `message` is null / undefined.
 *
 * Accessibility:
 *   - `aria-live="polite"` so screen readers announce each new move
 *   - `aria-label="Last move"` for region identification
 *
 * Example messages produced by the backend:
 *   - "Alice asked Bob for 9♠ — denied"
 *   - "Alice asked Bob for 9♠ — got it"
 *   - "Charlie declared Low Spades — correct! Team 2 scores"
 *   - "Charlie declared High Hearts — incorrect! Team 1 scores"
 */

interface LastMoveDisplayProps {
  /** The human-readable last-move string from the server, or null when none. */
  message: string | null | undefined;
  /** data-testid for automated tests. Defaults to "last-move-display". */
  testId?: string;
}

export default function LastMoveDisplay({ message, testId = 'last-move-display' }: LastMoveDisplayProps) {
  if (!message) return null;

  return (
    <div
      className="relative z-10 flex items-center justify-center px-4 py-1.5 bg-slate-800/60 border-b border-slate-700/30 text-xs text-slate-300"
      aria-live="polite"
      aria-label="Last move"
      data-testid={testId}
    >
      {message}
    </div>
  );
}
