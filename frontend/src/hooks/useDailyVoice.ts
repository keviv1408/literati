'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DailyCall,
  DailyEventObject,
  DailyParticipant,
  DailyParticipantsObject,
} from '@daily-co/daily-js';
import { ApiError, joinRoomVoice } from '@/lib/api';

export interface VoiceParticipantState {
  playerId: string;
  sessionId: string;
  displayName: string;
  local: boolean;
  connected: boolean;
  muted: boolean;
  audioTrack: MediaStreamTrack | null;
}

export interface VoiceSeatState {
  connected: boolean;
  muted: boolean;
  speaking: boolean;
  local: boolean;
}

interface UseDailyVoiceOptions {
  roomCode: string | null;
  bearerToken: string | null;
  canJoin?: boolean;
}

export interface UseDailyVoiceReturn {
  joinVoice: () => Promise<void>;
  leaveVoice: () => Promise<void>;
  toggleMic: () => void;
  clearError: () => void;
  isJoined: boolean;
  isJoining: boolean;
  isLeaving: boolean;
  isMicOn: boolean;
  canJoin: boolean;
  participantCount: number;
  participants: Record<string, VoiceParticipantState>;
  remoteAudioParticipants: VoiceParticipantState[];
  activeSpeakerId: string | null;
  error: string | null;
  getSeatState: (playerId: string | null | undefined) => VoiceSeatState | null;
}

function getPlayerId(participant: DailyParticipant): string {
  return String(participant.user_id || participant.session_id || '').trim();
}

function getAudioTrack(participant: DailyParticipant): MediaStreamTrack | null {
  return (
    participant.tracks?.audio?.persistentTrack ||
    participant.tracks?.audio?.track ||
    participant.audioTrack ||
    null
  );
}

function isParticipantMuted(participant: DailyParticipant): boolean {
  return participant.tracks?.audio?.state !== 'playable';
}

function normalizeParticipants(
  participantsObject: DailyParticipantsObject | undefined | null
): Record<string, VoiceParticipantState> {
  const next: Record<string, VoiceParticipantState> = {};

  if (!participantsObject) return next;

  for (const participant of Object.values(participantsObject)) {
    if (!participant) continue;

    const playerId = getPlayerId(participant);
    if (!playerId) continue;

    next[playerId] = {
      playerId,
      sessionId: participant.session_id,
      displayName: participant.user_name || 'Player',
      local: Boolean(participant.local),
      connected: true,
      muted: isParticipantMuted(participant),
      audioTrack: getAudioTrack(participant),
    };
  }

  return next;
}

export function useDailyVoice({
  roomCode,
  bearerToken,
  canJoin = true,
}: UseDailyVoiceOptions): UseDailyVoiceReturn {
  const callObjectRef = useRef<DailyCall | null>(null);
  const [participants, setParticipants] = useState<Record<string, VoiceParticipantState>>({});
  const [activeSpeakerSessionId, setActiveSpeakerSessionId] = useState<string | null>(null);
  const [isJoined, setIsJoined] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearVoiceState = useCallback(() => {
    setParticipants({});
    setActiveSpeakerSessionId(null);
    setIsJoined(false);
    setIsJoining(false);
    setIsLeaving(false);
    setIsMicOn(false);
  }, []);

  const syncParticipants = useCallback((participantsObject?: DailyParticipantsObject | null) => {
    const source = participantsObject || callObjectRef.current?.participants();
    const next = normalizeParticipants(source);
    const localParticipant = Object.values(next).find((participant) => participant.local);

    setParticipants(next);
    setIsMicOn(Boolean(localParticipant && !localParticipant.muted));
  }, []);

  const ensureCallObject = useCallback(async () => {
    if (callObjectRef.current) return callObjectRef.current;

    const DailyIframe = (await import('@daily-co/daily-js')).default;
    const callObject = DailyIframe.createCallObject({
      activeSpeakerMode: true,
      subscribeToTracksAutomatically: true,
      startAudioOff: true,
      startVideoOff: true,
      audioSource: true,
      videoSource: false,
    });

    callObject.on('joined-meeting', (event: DailyEventObject<'joined-meeting'>) => {
      setError(null);
      setIsJoined(true);
      setIsJoining(false);
      setIsLeaving(false);
      syncParticipants(event.participants);
    });

    callObject.on('left-meeting', () => {
      clearVoiceState();
    });

    callObject.on('participant-joined', () => {
      syncParticipants();
    });

    callObject.on('participant-updated', () => {
      syncParticipants();
    });

    callObject.on('participant-left', () => {
      syncParticipants();
    });

    callObject.on('active-speaker-change', (event: DailyEventObject<'active-speaker-change'>) => {
      setActiveSpeakerSessionId(event.activeSpeaker?.peerId ?? null);
    });

    callObject.on('error', (event: DailyEventObject<'error'>) => {
      setError(event.errorMsg || 'Voice unavailable');
      clearVoiceState();
    });

    callObject.on('nonfatal-error', (event: DailyEventObject<'nonfatal-error'>) => {
      setError(event.errorMsg || 'Voice unavailable');
    });

    callObjectRef.current = callObject;
    return callObject;
  }, [clearVoiceState, syncParticipants]);

  const joinVoice = useCallback(async () => {
    if (isJoining || isJoined) return;

    if (!roomCode || !bearerToken) {
      setError('Voice is unavailable because this session is missing room credentials.');
      return;
    }

    if (!canJoin) {
      setError('Voice will be available once your player seat is connected.');
      return;
    }

    setError(null);
    setIsJoining(true);

    try {
      const callObject = await ensureCallObject();
      const voiceSession = await joinRoomVoice(roomCode, bearerToken);

      await callObject.join({
        url: voiceSession.roomUrl,
        token: voiceSession.meetingToken,
        activeSpeakerMode: true,
        subscribeToTracksAutomatically: true,
        startAudioOff: true,
        startVideoOff: true,
        audioSource: true,
        videoSource: false,
      });

      callObject.setLocalAudio(false);
      syncParticipants();
    } catch (joinError) {
      clearVoiceState();

      if (joinError instanceof ApiError) {
        const message =
          (joinError.body as { message?: string } | undefined)?.message ||
          joinError.message ||
          'Voice unavailable';
        setError(message);
        return;
      }

      if (joinError instanceof Error) {
        setError(joinError.message || 'Voice unavailable');
        return;
      }

      setError('Voice unavailable');
    }
  }, [
    bearerToken,
    canJoin,
    clearVoiceState,
    ensureCallObject,
    isJoined,
    isJoining,
    roomCode,
    syncParticipants,
  ]);

  const leaveVoice = useCallback(async () => {
    const callObject = callObjectRef.current;

    if (!callObject) {
      clearVoiceState();
      return;
    }

    setError(null);
    setIsLeaving(true);

    try {
      await callObject.leave();
    } catch {
      // Ignore leave failures; gameplay should continue either way.
    } finally {
      clearVoiceState();
    }
  }, [clearVoiceState]);

  const toggleMic = useCallback(() => {
    const callObject = callObjectRef.current;
    if (!callObject || !isJoined) return;

    setError(null);

    const nextMicState = !callObject.localAudio();
    callObject.setLocalAudio(nextMicState);
    setIsMicOn(nextMicState);

    setParticipants((currentParticipants) => {
      const localParticipant = Object.values(currentParticipants).find(
        (participant) => participant.local,
      );

      if (!localParticipant) return currentParticipants;

      return {
        ...currentParticipants,
        [localParticipant.playerId]: {
          ...localParticipant,
          muted: !nextMicState,
        },
      };
    });
  }, [isJoined]);

  useEffect(() => {
    return () => {
      const callObject = callObjectRef.current;
      callObjectRef.current = null;

      if (!callObject) return;

      clearVoiceState();

      Promise.resolve().then(async () => {
        try {
          if (!callObject.isDestroyed()) {
            try {
              await callObject.leave();
            } catch {
              // Best-effort cleanup only.
            }
            await callObject.destroy();
          }
        } catch {
          // Ignore cleanup failures during navigation.
        }
      });
    };
  }, [clearVoiceState]);

  const activeSpeakerId = useMemo(
    () =>
      Object.values(participants).find(
        (participant) => participant.sessionId === activeSpeakerSessionId,
      )?.playerId ?? null,
    [activeSpeakerSessionId, participants],
  );

  const participantCount = useMemo(
    () => Object.keys(participants).length,
    [participants],
  );

  const remoteAudioParticipants = useMemo(
    () =>
      Object.values(participants).filter(
        (participant) => !participant.local && Boolean(participant.audioTrack),
      ),
    [participants],
  );

  const getSeatState = useCallback(
    (playerId: string | null | undefined): VoiceSeatState | null => {
      if (!playerId) return null;

      const participant = participants[playerId];
      if (!participant) return null;

      return {
        connected: participant.connected,
        muted: participant.muted,
        speaking: activeSpeakerId === playerId,
        local: participant.local,
      };
    },
    [activeSpeakerId, participants],
  );

  return {
    joinVoice,
    leaveVoice,
    toggleMic,
    clearError: () => setError(null),
    isJoined,
    isJoining,
    isLeaving,
    isMicOn,
    canJoin: Boolean(roomCode && bearerToken && canJoin),
    participantCount,
    participants,
    remoteAudioParticipants,
    activeSpeakerId,
    error,
    getSeatState,
  };
}
