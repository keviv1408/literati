'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useGuestSession } from '@/hooks/useGuestSession';
import { useGuest } from '@/contexts/GuestContext';
import { API_URL } from '@/lib/api';
import { tutorialPath } from '@/lib/appPaths';
import ShortTutorial from '@/components/ShortTutorial';
import CreateRoomModal from '@/components/CreateRoomModal';

const emptySubscribe = () => () => {};

// A healthy backend answers well under this; a Render cold start takes 30s+.
const WAKE_NOTICE_DELAY_MS = 2000;

export default function Home() {
  const { guestSession, hasName, ensureGuestName } = useGuestSession();
  const { clearGuest } = useGuest();

  const [isCreateRoomOpen, setIsCreateRoomOpen] = useState(false);
  const [isWakingServer, setIsWakingServer] = useState(false);
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);

  // Ping the backend on landing so a spun-down Render instance starts waking
  // before the first real request, and tell the player if it is slow.
  useEffect(() => {
    let cancelled = false;
    const slowTimer = setTimeout(() => {
      if (!cancelled) setIsWakingServer(true);
    }, WAKE_NOTICE_DELAY_MS);

    fetch(`${API_URL}/health`)
      .catch(() => {})
      .finally(() => {
        clearTimeout(slowTimer);
        if (!cancelled) setIsWakingServer(false);
      });

    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
    };
  }, []);

  async function handlePrivateRoom() {
    const session = await ensureGuestName();
    if (!session) return; // user dismissed the guest name modal
    setIsCreateRoomOpen(true);
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4">
      {/* Background decorative suits */}
      <div
        className="pointer-events-none fixed inset-0 overflow-hidden opacity-5 select-none"
        aria-hidden="true"
      >
        <span className="absolute text-[30rem] -top-24 -left-24 text-white">
          ♠
        </span>
        <span className="absolute text-[20rem] bottom-0 right-0 text-white">
          ♦
        </span>
      </div>

      {/* Hero */}
      <main className="relative z-10 flex flex-col items-center text-center max-w-lg w-full gap-6 py-10 sm:gap-8">
        <div className="space-y-2">
          <h1 className="flex items-center justify-center gap-3 text-[clamp(2.8rem,9vw,4.2rem)] leading-none font-bold tracking-[-0.045em] text-white" style={{ fontFamily: 'Georgia, serif' }}>
            <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" className="size-[.9em] shrink-0">
              <use href="/icons/high-diamond.svg#diamond" />
            </svg>
            Literature
          </h1>
          <p className="mt-4 text-emerald-200 text-base sm:text-lg">
            Remember who took the card. Ask for it back.
          </p>
        </div>

        {/* Guest session indicator */}
        {mounted && hasName && guestSession && (
          <div className="flex items-center gap-2 bg-emerald-900/50 border border-emerald-700/50 rounded-full px-4 py-2 text-sm text-emerald-200">
            <span className="text-base" aria-hidden="true">
              👤
            </span>
            Playing as{' '}
            <span className="font-semibold">{guestSession.displayName}</span>
            <button
              onClick={clearGuest}
              className="ml-1 text-emerald-400 hover:text-white text-xs underline focus:outline-none focus:ring-1 focus:ring-emerald-400 rounded"
              aria-label="Change display name"
            >
              change
            </button>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-col gap-3 w-full">
          <button
            onClick={handlePrivateRoom}
            className="
              flex-1 py-4 px-6 rounded-xl font-bold text-lg
              bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700
              text-white shadow-lg shadow-emerald-900/50
              transition-all duration-150 active:scale-[0.97]
              focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-950
            "
          >
            <span className="flex flex-col items-center leading-tight">
              <span>🔒 Private Room</span>
              <span className="text-xs font-medium text-emerald-100/90 mt-1">
                Play with friends in your own room
              </span>
            </span>
          </button>
          <ShortTutorial returnTo="home" />
        </div>

        {isWakingServer && (
          <p
            role="status"
            className="flex items-center gap-2 rounded-full border border-amber-700/50 bg-amber-900/30 px-4 py-2 text-sm text-amber-200 animate-pulse"
          >
            <span aria-hidden="true">☕</span>
            Waking up the table… this can take up to a minute.
          </p>
        )}

        {/* Feature pills */}
        <div className="flex flex-wrap justify-center gap-2 text-xs text-slate-400">
          {[
            '6 or 8 Players',
            'Smart Bots',
            'No Account Required',
          ].map((f) => (
            <span
              key={f}
              className="bg-slate-800/60 border border-slate-700/50 rounded-full px-3 py-1"
            >
              {f}
            </span>
          ))}
        </div>
        <a href={tutorialPath()} className="rounded px-3 py-2 text-sm text-emerald-200 underline underline-offset-4 hover:text-white focus-visible:outline-2">
          Play the full interactive tutorial
        </a>
      </main>

      {/* Create Room modal — shown after guest name is confirmed */}
      {mounted && guestSession && (
        <CreateRoomModal
          open={isCreateRoomOpen}
          displayName={guestSession.displayName}
          onClose={() => setIsCreateRoomOpen(false)}
        />
      )}
    </div>
  );
}
