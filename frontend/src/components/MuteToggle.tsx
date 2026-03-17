'use client';

import React from 'react';
import { useAudio } from '@/hooks/useAudio';

export interface MuteToggleProps {
  className?: string;
  muted?: boolean;
  onToggle?: () => void;
}

const MuteToggle: React.FC<MuteToggleProps> = ({
  className = '',
  muted: controlledMuted,
  onToggle,
}) => {
  const { muted: hookMuted, toggleMute } = useAudio();
  const muted = controlledMuted ?? hookMuted;
  const handleToggle = onToggle ?? toggleMute;

  return (
    <button
      type="button"
      onClick={handleToggle}
      aria-label={muted ? 'Unmute game sounds' : 'Mute game sounds'}
      aria-pressed={muted}
      title={muted ? 'Unmute sounds' : 'Mute sounds'}
      className={[
        'text-slate-400 hover:text-white transition-colors',
        'p-1 rounded-lg',
        'focus:outline-none focus:ring-2 focus:ring-emerald-400',
        'text-base leading-none',
        muted ? 'text-rose-400 hover:text-rose-300' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="mute-toggle"
    >
      <span aria-hidden="true">{muted ? '🔇' : '🔔'}</span>
    </button>
  );
};

export default MuteToggle;
