'use client';

import { useEffect, useState } from 'react';
import { invalidateGuestToken } from '@/lib/api';
import { clearRoomMembership } from '@/lib/roomMembership';
import type { WsStatus } from '@/hooks/useRoomSocket';

// The server forgot the session (e.g. it restarted), so the token is useless.
const _UNKNOWN_SESSION = 4001;

type _Phase = 'armed' | 'recovering' | 'spent';

interface UseLobbyRecoveryOptions {
  roomCode: string | null;
  wsStatus: WsStatus;
  stopCode: number | null;
  retry: () => void;
}

/**
 * Registers the guest again and rejoins once when the lobby socket is refused
 * with 4001. Armed again only after the socket reaches 'connected'.
 */
export function useLobbyRecovery({
  roomCode,
  wsStatus,
  stopCode,
  retry,
}: UseLobbyRecoveryOptions): { recovering: boolean } {
  const [phase, setPhase] = useState<_Phase>('armed');

  const refused = roomCode !== null && wsStatus === 'error' && stopCode === _UNKNOWN_SESSION;

  // Derived during render so the very render that sees the 4001 already reports recovering.
  let next = phase;
  if (phase === 'armed' && refused) next = 'recovering';
  else if (phase === 'recovering' && wsStatus !== 'error') next = 'spent';
  else if (phase === 'spent' && wsStatus === 'connected') next = 'armed';
  if (next !== phase) setPhase(next);

  useEffect(() => {
    if (phase !== 'recovering' || !roomCode) return;
    clearRoomMembership(roomCode);
    invalidateGuestToken();
    retry();
    // Runs once per entry into 'recovering'; roomCode and retry are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  return { recovering: next === 'recovering' };
}
