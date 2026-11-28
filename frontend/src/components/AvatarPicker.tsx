'use client';

import { useState } from 'react';
import { AVATAR_IDS, getAvatarCreature } from '@/utils/avatar';
import Avatar from './Avatar';
import styles from './AvatarPlatform.module.css';
import { CREATURE_NAMES } from './creatures/kind';

interface AvatarPickerProps {
  value: string | null;
  onChange: (avatarId: string) => void;
}

export default function AvatarPicker({ value, onChange }: AvatarPickerProps) {
  const [shaking, setShaking] = useState<string | null>(null);

  function _stop(id: string) {
    setShaking(active => active === id ? null : active);
  }

  return (
    <div role="group" aria-label="Your avatar" className={styles.grid} data-testid="avatar-picker">
      {AVATAR_IDS.map(id => {
        const name = CREATURE_NAMES[getAvatarCreature(id, '')];
        return (
          <button key={id} type="button" aria-label={name} title={name}
            aria-pressed={value === id} className={styles.option}
            data-shaking={shaking === id ? '' : undefined}
            onPointerEnter={() => setShaking(id)}
            onPointerLeave={event => { if (event.pointerType !== 'touch') _stop(id); }}
            onFocus={event => { if (event.currentTarget.matches(':focus-visible')) setShaking(id); }}
            onBlur={() => _stop(id)}
            onAnimationEnd={() => _stop(id)}
            onClick={() => onChange(id)}>
            <Avatar displayName="" avatarId={id} variant="picker" />
          </button>
        );
      })}
    </div>
  );
}
