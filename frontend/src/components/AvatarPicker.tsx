'use client';

import { AVATAR_IDS, getAvatarCreature } from '@/utils/avatar';
import Avatar from './Avatar';
import { CREATURE_NAMES } from './creatures/kind';

interface AvatarPickerProps {
  value: string | null;
  onChange: (avatarId: string) => void;
}

export default function AvatarPicker({ value, onChange }: AvatarPickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Your avatar"
      className="flex flex-wrap justify-center gap-1.5 max-w-xs"
      data-testid="avatar-picker"
    >
      {AVATAR_IDS.map((id) => {
        const selected = id === value;
        const creature = getAvatarCreature(id, '');
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={CREATURE_NAMES[creature]}
            title={CREATURE_NAMES[creature]}
            onClick={() => onChange(id)}
            className={[
              'w-9 h-9 rounded-full text-lg leading-none flex items-center justify-center transition-transform',
              'focus:outline-none focus:ring-2 focus:ring-emerald-400',
              selected
                ? 'bg-emerald-500/30 ring-2 ring-emerald-400 scale-110'
                : 'bg-slate-800/60 ring-1 ring-slate-600 hover:bg-slate-700',
            ].join(' ')}
          >
            <Avatar displayName="" avatarId={id} size="sm" />
          </button>
        );
      })}
    </div>
  );
}
