'use client';

import React, { useEffect, useRef } from 'react';
import { useVoice } from '@/contexts/VoiceContext';
import type { VoiceParticipantState } from '@/hooks/useDailyVoice';

function RemoteAudio({ participant }: { participant: VoiceParticipantState }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audioEl = audioRef.current;

    if (!audioEl) return;

    if (!participant.audioTrack || typeof MediaStream === 'undefined') {
      audioEl.srcObject = null;
      return;
    }

    const mediaStream = new MediaStream([participant.audioTrack]);
    audioEl.srcObject = mediaStream;
    void audioEl.play().catch(() => {});

    return () => {
      audioEl.srcObject = null;
    };
  }, [participant.audioTrack]);

  return (
    <audio
      ref={audioRef}
      autoPlay
      playsInline
      data-testid="voice-remote-audio"
      data-player-id={participant.playerId}
    />
  );
}

export default function VoiceAudioLayer() {
  const { isJoined, remoteAudioParticipants } = useVoice();

  if (!isJoined) return null;

  return (
    <div className="hidden" aria-hidden="true" data-testid="voice-audio-layer">
      {remoteAudioParticipants.map((participant) => (
        <RemoteAudio
          key={participant.sessionId}
          participant={participant}
        />
      ))}
    </div>
  );
}
