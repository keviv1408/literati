'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import AccountControls from '@/components/AccountControls';
import { isAndroidBuild } from '@/lib/appPaths';
import styles from './Guide.module.css';

export default function ProfilePanel({ guestName, changeDisabled, onChangeName }: {
  guestName?: string;
  changeDisabled: boolean;
  onChangeName: () => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const showSignInError = useCallback(() => {
    setOpen(true);
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    function _dismissOutside(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', _dismissOutside);
    return () => document.removeEventListener('pointerdown', _dismissOutside);
  }, [open]);

  if (isAndroidBuild() && !guestName) return null;

  return (
    <div ref={container} className={styles.profile}
      onBlur={event => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={event => {
        if (open && event.key === 'Escape') {
          setOpen(false);
          trigger.current?.focus();
        }
      }}>
      <button type="button" ref={trigger} className={styles.profileButton}
        aria-label="Profile" title="Profile" aria-expanded={open} aria-controls="home-profile"
        onClick={() => setOpen(value => !value)}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <circle cx="12" cy="8" r="3.4" />
          <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
        </svg>
      </button>
      <div id="home-profile" className={styles.profilePanel} hidden={!open}>
        {guestName && (
          <div className={styles.guest}>
            <span>Playing as <strong>{guestName}</strong></span>
            <button type="button" aria-label="Change display name" disabled={changeDisabled}
              onClick={onChangeName}>Change</button>
          </div>
        )}
        {!isAndroidBuild() && <AccountControls onSignInFailure={showSignInError} />}
      </div>
    </div>
  );
}
