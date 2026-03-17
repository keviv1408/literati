'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useGuestSession } from '@/hooks/useGuestSession';
import { useGuest } from '@/contexts/GuestContext';
import CreateRoomModal from '@/components/CreateRoomModal';

export default function Home() {
  const router = useRouter();
  const { guestSession, hasName, ensureGuestName } = useGuestSession();
  const { clearGuest } = useGuest();

  const [isCreateRoomOpen, setIsCreateRoomOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  async function handlePlayNow() {
    const session = await ensureGuestName();
    if (!session) return; // user dismissed the modal
    // Navigate to the matchmaking page — filter selection and queue joining happens there
    router.push('/matchmaking');
  }

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
      <main className="relative z-10 flex flex-col items-center text-center max-w-lg w-full gap-8">
        <div className="space-y-2">
          <h1 className="text-6xl font-black text-white tracking-tight">
            Literati
          </h1>
          <p className="text-emerald-300 text-lg">
            The classic Half-Suit card game — online, real-time, free.
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
        <div className="flex flex-col sm:flex-row gap-3 w-full">
          <button
            onClick={handlePlayNow}
            className="
              flex-1 py-4 px-6 rounded-xl font-bold text-lg
              bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700
              text-white shadow-lg shadow-emerald-900/50
              transition-all duration-150 active:scale-[0.97]
              focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-950
            "
          >
            🎮 Play Now
          </button>
          <button
            onClick={handlePrivateRoom}
            className="
              flex-1 py-4 px-6 rounded-xl font-bold text-lg
              border border-emerald-700 text-emerald-200
              hover:bg-emerald-900/50 hover:border-emerald-500 hover:text-white
              active:scale-[0.97]
              transition-all duration-150
              focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-950
            "
          >
            🔒 Private Room
          </button>
        </div>

        {/* Feature pills */}
        <div className="flex flex-wrap justify-center gap-2 text-xs text-slate-400">
          {[
            '6–8 Players',
            'Two Teams',
            'Smart Bots',
            'Spectators',
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

        {/* Links */}
        <div className="text-sm text-slate-500">
          <a
            href="/live-games"
            className="hover:text-emerald-400 transition-colors focus:outline-none focus:underline"
          >
            Live Games
          </a>
        </div>
      </main>

      {/* How to Play */}
      <section className="relative z-10 w-full max-w-2xl mt-16 mb-12 px-4">
        <h2 className="text-2xl font-bold text-white text-center mb-6">
          How to Play Literature
        </h2>

        <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-4 mb-4">
          <p className="text-sm text-emerald-300 font-semibold mb-3">
            Watch this quick tutorial to learn how to play
          </p>
          <div className="relative overflow-hidden rounded-xl border border-slate-600/70">
            <iframe
              className="w-full h-[280px] sm:h-[360px] lg:h-[420px]"
              src="https://www.youtube.com/embed/LXFpcZytpQc"
              title="How to Play Literature tutorial video"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          </div>
        </div>

        {/* The Basics */}
        <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-5 mb-4">
          <h3 className="text-lg font-semibold text-emerald-300 mb-3">The Basics</h3>
          <ul className="space-y-2 text-sm text-slate-300">
            <li><span className="text-emerald-400 font-medium">Teams:</span> 6 players split into two teams of 3 (or 8 players, 4v4).</li>
            <li><span className="text-emerald-400 font-medium">Cards:</span> A standard deck with 7s removed, leaving 48 cards. Each suit is split into a <span className="text-white font-medium">low half</span> (A-6) and a <span className="text-white font-medium">high half</span> (8-K) &mdash; these are called <span className="text-white font-medium">half-suits</span>.</li>
            <li><span className="text-emerald-400 font-medium">Goal:</span> Collect all 6 cards of a half-suit across your team and <span className="text-white font-medium">declare</span> it to score a point. First team to score 5 (of 8) half-suits wins.</li>
          </ul>
        </div>

        {/* On Your Turn */}
        <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-5 mb-4">
          <h3 className="text-lg font-semibold text-emerald-300 mb-3">On Your Turn</h3>
          <ul className="space-y-2 text-sm text-slate-300">
            <li><span className="text-emerald-400 font-medium">Ask:</span> Pick an opponent and ask for a specific card. You must hold at least one card from that half-suit before asking for another card from it.</li>
            <li><span className="text-emerald-400 font-medium">If they have it:</span> They hand it over and you go again.</li>
            <li><span className="text-emerald-400 font-medium">If they don&apos;t:</span> Your turn ends and the turn passes to them.</li>
            <li><span className="text-emerald-400 font-medium">Declare:</span> You can declare a half-suit by stating which teammate holds each of the six cards. If correct, your team scores; if wrong, the other team scores.</li>
            <li><span className="text-emerald-400 font-medium">Pass the chance:</span> After finishing a set, you can give the next turn to a teammate who is being blocked or who has a better read on the opponents&apos; cards so they can keep collecting and complete another half-suit.</li>
          </ul>
        </div>

      </section>

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
