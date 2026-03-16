'use client';

import { useEffect, useRef, useState } from 'react';
import {
  cancelMoveAnnouncement,
  speakMoveAnnouncement,
  supportsMoveAnnouncements,
} from '@/lib/moveAnnouncements';

interface UseMoveAnnouncementsOptions {
  message: string | null | undefined;
  enabled: boolean;
}

export interface UseMoveAnnouncementsReturn {
  supported: boolean;
  stopAnnouncement: () => void;
}

export function useMoveAnnouncements({
  message,
  enabled,
}: UseMoveAnnouncementsOptions): UseMoveAnnouncementsReturn {
  const lastAnnouncedMessageRef = useRef<string | null>(null);
  const [hasUserGesture, setHasUserGesture] = useState<boolean>(() => {
    if (typeof navigator === 'undefined') return false;

    const nav = navigator as Navigator & {
      userActivation?: { hasBeenActive?: boolean; isActive?: boolean };
    };

    return Boolean(nav.userActivation?.hasBeenActive || nav.userActivation?.isActive);
  });

  useEffect(() => {
    if (hasUserGesture || typeof window === 'undefined') return;

    const handleGesture = () => {
      setHasUserGesture(true);
    };

    const options: AddEventListenerOptions = { once: true, passive: true };
    window.addEventListener('pointerdown', handleGesture, options);
    window.addEventListener('keydown', handleGesture, { once: true });
    window.addEventListener('touchstart', handleGesture, options);

    return () => {
      window.removeEventListener('pointerdown', handleGesture);
      window.removeEventListener('keydown', handleGesture);
      window.removeEventListener('touchstart', handleGesture);
    };
  }, [hasUserGesture]);

  useEffect(() => {
    if (!enabled) return;
    if (!message) return;
    if (!supportsMoveAnnouncements()) return;
    if (!hasUserGesture) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (lastAnnouncedMessageRef.current === message) return;

    lastAnnouncedMessageRef.current = message;
    speakMoveAnnouncement(message);
  }, [enabled, hasUserGesture, message]);

  useEffect(() => {
    if (!enabled) {
      cancelMoveAnnouncement();
    }
  }, [enabled]);

  useEffect(() => {
    if (message) return;
    lastAnnouncedMessageRef.current = null;
  }, [message]);

  useEffect(() => {
    return () => {
      cancelMoveAnnouncement();
    };
  }, []);

  return {
    supported: supportsMoveAnnouncements(),
    stopAnnouncement: cancelMoveAnnouncement,
  };
}
