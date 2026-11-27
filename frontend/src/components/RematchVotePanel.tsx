'use client';

/**
 * RematchVotePanel — displayed on the post-game screen after `game_over`.
 *
 * Shows:
 *   • Yes / No vote buttons for the local player (disabled after voting)
 *   • Per-player vote status (✔ yes / ✘ no / … waiting)
 *   • Live tally: "X / Y players voted yes (need Z)"
 *   • Countdown timer showing seconds remaining in the vote window
 *   • Bot players shown with 🤖 and pre-cast yes vote
 *
 * Props:
 *   rematchVote      — latest RematchVoteUpdatePayload from the server (null = no active vote)
 *   rematchDeclined  — non-null once the vote window closed without a majority
 *   myPlayerId       — local player's id (to lock out their button after voting)
 *   onVote           — callback invoked with true (yes) or false (no)
 *   voteTimeoutMs    — total vote window in ms (default 60 000), used to show countdown
 *   voteStartedAt    — epoch ms when the vote window opened (optional; estimated from mount)
 *   disabled         — true while the vote cannot be sent
 */

import { useEffect, useState } from 'react';
import type { RematchVoteUpdatePayload, RematchDeclinedPayload } from '@/types/game';

const DEFAULT_TIMEOUT_MS = 60_000;

interface RematchVotePanelProps {
  rematchVote:     RematchVoteUpdatePayload | null;
  rematchDeclined: RematchDeclinedPayload   | null;
  myPlayerId:      string | null;
  onVote:          (vote: boolean) => void;
  voteTimeoutMs?:  number;
  voteStartedAt?:  number; // epoch ms; defaults to component mount time
  disabled?:       boolean;
}

export default function RematchVotePanel(props: RematchVotePanelProps) {
  return <VoteRound key={props.rematchVote?.roundId} {...props} />;
}

function VoteRound({
  rematchVote,
  rematchDeclined,
  myPlayerId,
  onVote,
  voteTimeoutMs = DEFAULT_TIMEOUT_MS,
  voteStartedAt,
  disabled = false,
}: RematchVotePanelProps) {
  const [mountedAt] = useState(Date.now);
  const startTime      = voteStartedAt ?? mountedAt;
  const expiresAt      = rematchVote?.expiresAt ?? startTime + voteTimeoutMs;

  const [secondsLeft, setSecondsLeft] = useState<number>(
    () => Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
  );
  const [localVote, setLocalVote] = useState<boolean | null>(null);

  // Countdown ticker
  useEffect(() => {
    if (rematchDeclined || !rematchVote) return;

    const tick = () => {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setSecondsLeft(remaining);
    };

    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [expiresAt, rematchDeclined, rematchVote]);

  // ── Declined state ──────────────────────────────────────────────────────
  if (rematchDeclined) {
    const reason = {
      timeout: 'Vote timed out',
      majority_no: 'Majority voted no',
      room_unavailable: 'This room is unavailable for a rematch.',
    }[rematchDeclined.reason];
    return (
      <div
        className="flex flex-col items-center gap-3 px-4 py-4 rounded-2xl border border-slate-700/60 bg-slate-800/70 backdrop-blur-sm w-full max-w-sm"
        data-testid="rematch-declined-panel"
        role="status"
        aria-label="Rematch declined"
      >
        <span className="text-2xl" aria-hidden="true">🚫</span>
        <p className="text-sm font-semibold text-slate-300">Rematch declined</p>
        <p className="text-xs text-slate-500">{reason}</p>
      </div>
    );
  }

  // ── No active vote yet ──────────────────────────────────────────────────
  if (!rematchVote) {
    return (
      <div
        className="flex flex-col items-center gap-2 px-4 py-4 rounded-2xl border border-slate-700/60 bg-slate-800/70 backdrop-blur-sm w-full max-w-sm"
        data-testid="rematch-loading-panel"
        role="status"
      >
        <span className="text-xs text-slate-400">Waiting for rematch vote…</span>
      </div>
    );
  }

  const { yesCount, totalCount, majority, playerVotes } = rematchVote;
  const myVoteRecord = myPlayerId ? playerVotes.find((pv) => pv.playerId === myPlayerId) : null;
  const serverVote = myPlayerId ? rematchVote.votes[myPlayerId] : undefined;
  const myCurrentVote = localVote ?? serverVote ?? myVoteRecord?.vote ?? null;
  const locked = myCurrentVote !== null || disabled;

  function handleVote(vote: boolean) {
    if (locked) return;
    setLocalVote(vote);
    onVote(vote);
  }

  return (
    <div
      className="flex flex-col items-center gap-4 px-4 py-4 rounded-2xl border border-slate-700/60 bg-slate-800/70 backdrop-blur-sm w-full max-w-sm"
      data-testid="rematch-vote-panel"
      aria-label="Rematch vote"
    >
      {/* Header */}
      <div className="text-center">
        <p className="text-sm font-semibold text-white">Play again?</p>
        <p className="text-xs text-slate-400 mt-0.5" data-testid="rematch-tally">
          {yesCount} / {totalCount} voted yes · need {majority}
        </p>
      </div>

      {/* Vote buttons — only for human local player who hasn't voted */}
      {myPlayerId && myVoteRecord && !myVoteRecord.isBot && (
        <div className="flex gap-3 w-full" data-testid="rematch-vote-buttons">
          <button
            onClick={() => handleVote(true)}
            disabled={locked}
            aria-pressed={myCurrentVote === true}
            data-testid="rematch-yes-btn"
            className={[
              'flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400',
              myCurrentVote === true
                ? 'bg-emerald-600 text-white ring-2 ring-emerald-400'
                : locked
                ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                : 'bg-emerald-700 hover:bg-emerald-600 text-white',
            ].join(' ')}
          >
            👍 Yes
          </button>
          <button
            onClick={() => handleVote(false)}
            disabled={locked}
            aria-pressed={myCurrentVote === false}
            data-testid="rematch-no-btn"
            className={[
              'flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-red-400',
              myCurrentVote === false
                ? 'bg-red-700 text-white ring-2 ring-red-400'
                : locked
                ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                : 'bg-slate-700 hover:bg-slate-600 text-slate-200',
            ].join(' ')}
          >
            👎 No
          </button>
        </div>
      )}

      <details className="w-full text-sm text-slate-300">
        <summary className="cursor-pointer rounded py-1 focus-visible:outline-2">Player votes</summary>
        <ul className="w-full space-y-1" aria-label="Player votes" data-testid="rematch-player-votes">
          {playerVotes.map((pv) => (
            <li
              key={pv.playerId}
              className="flex items-center justify-between text-xs"
              data-testid={`rematch-player-vote-${pv.playerId}`}
            >
              <span className={['flex items-center gap-1', pv.playerId === myPlayerId ? 'text-emerald-300 font-semibold' : 'text-slate-300'].join(' ')}>
                {pv.isBot && <span aria-label="bot">🤖</span>}
                <span className="max-w-[8rem] truncate">{pv.displayName}</span>
                {pv.playerId === myPlayerId && <span className="text-slate-500">(you)</span>}
              </span>
              <span
                aria-label={pv.vote === true ? 'voted yes' : pv.vote === false ? 'voted no' : 'waiting'}
                className={[
                  'font-semibold',
                  pv.vote === true  ? 'text-emerald-400' :
                  pv.vote === false ? 'text-red-400'     : 'text-slate-600',
                ].join(' ')}
              >
                {pv.vote === true ? '✔ Yes' : pv.vote === false ? '✘ No' : '…'}
              </span>
            </li>
          ))}
        </ul>
      </details>

      {/* Progress bar */}
      <div className="w-full h-1 rounded-full bg-slate-700 overflow-hidden" aria-hidden="true">
        <div
          className="h-full bg-emerald-500 transition-all duration-300"
          style={{ width: `${Math.min(100, (yesCount / Math.max(1, majority)) * 100)}%` }}
        />
      </div>

      {/* Countdown */}
      <p
        className={['text-xs tabular-nums', secondsLeft <= 10 ? 'text-red-400 font-semibold' : 'text-slate-500'].join(' ')}
        aria-live="polite"
        data-testid="rematch-countdown"
      >
        {secondsLeft}s remaining
      </p>

    </div>
  );
}
