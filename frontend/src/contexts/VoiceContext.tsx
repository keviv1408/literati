'use client';

import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useDailyVoice, type UseDailyVoiceReturn } from '@/hooks/useDailyVoice';

interface VoiceProviderProps {
  roomCode: string | null;
  bearerToken: string | null;
  canJoin?: boolean;
  children: ReactNode;
}

const VoiceContext = createContext<UseDailyVoiceReturn | null>(null);
VoiceContext.displayName = 'VoiceContext';

export function VoiceProvider({
  roomCode,
  bearerToken,
  canJoin = true,
  children,
}: VoiceProviderProps) {
  const voice = useDailyVoice({ roomCode, bearerToken, canJoin });
  const value = useMemo(() => voice, [voice]);

  return (
    <VoiceContext.Provider value={value}>
      {children}
    </VoiceContext.Provider>
  );
}

export function useVoice(): UseDailyVoiceReturn {
  const context = useContext(VoiceContext);

  if (!context) {
    throw new Error('useVoice must be used within a VoiceProvider');
  }

  return context;
}
