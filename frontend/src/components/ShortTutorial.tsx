'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import styles from './ShortTutorial.module.css';

const PracticeSession = dynamic(() => import('./PracticeHand'));

export default function ShortTutorial({ returnTo }: { returnTo: 'home' | 'lobby' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={returnTo === 'home' ? styles.homeEntry : styles.entry} onClick={() => setOpen(true)}>
        <strong>Start a short tutorial to learn the basics</strong>
        <span>1–2 min</span>
      </button>
      {open && <PracticeSession returnTo={returnTo} onExit={() => setOpen(false)} />}
    </>
  );
}
