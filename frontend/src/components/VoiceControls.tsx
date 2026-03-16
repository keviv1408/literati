'use client';

import React from 'react';
import { useVoice } from '@/contexts/VoiceContext';

export default function VoiceControls() {
  const {
    canJoin,
    clearError,
    error,
    isJoined,
    isJoining,
    isLeaving,
    isMicOn,
    joinVoice,
    leaveVoice,
    participantCount,
    toggleMic,
  } = useVoice();

  const joinDisabled = !isJoined && (!canJoin || isJoining || isLeaving);
  const leaveDisabled = isLeaving || isJoining;

  return (
    <div className="flex items-center gap-2 flex-wrap justify-end">
      <button
        type="button"
        onClick={isJoined ? leaveVoice : joinVoice}
        disabled={isJoined ? leaveDisabled : joinDisabled}
        className={[
          'px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors',
          'focus:outline-none focus:ring-2 focus:ring-sky-400 disabled:opacity-50',
          isJoined
            ? 'bg-rose-700/80 hover:bg-rose-600 text-white'
            : 'bg-sky-700/80 hover:bg-sky-600 text-white',
        ].join(' ')}
        aria-label={isJoined ? 'Leave voice chat' : 'Join voice chat'}
        title={
          !canJoin && !isJoined
            ? 'Voice becomes available once your player seat is connected.'
            : undefined
        }
      >
        {isJoining ? 'Connecting…' : isLeaving ? 'Leaving…' : isJoined ? 'Leave voice' : 'Join voice'}
      </button>

      {isJoined && (
        <button
          type="button"
          onClick={toggleMic}
          className={[
            'px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors',
            'focus:outline-none focus:ring-2 focus:ring-emerald-400',
            isMicOn
              ? 'bg-emerald-700/80 hover:bg-emerald-600 text-white'
              : 'bg-slate-700/80 hover:bg-slate-600 text-slate-100',
          ].join(' ')}
          aria-pressed={isMicOn}
          aria-label={isMicOn ? 'Mute microphone' : 'Unmute microphone'}
        >
          {isMicOn ? 'Mic on' : 'Mic off'}
        </button>
      )}

      {isJoined && (
        <span className="text-[10px] text-slate-400 whitespace-nowrap">
          {participantCount} in voice
        </span>
      )}

      {error && (
        <button
          type="button"
          onClick={clearError}
          className="text-[10px] text-rose-300 hover:text-rose-200 transition-colors"
          title={error}
          aria-label={error}
        >
          Voice unavailable
        </button>
      )}
    </div>
  );
}
