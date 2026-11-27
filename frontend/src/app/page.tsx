'use client';

import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useGuestSession } from '@/hooks/useGuestSession';
import { useGuest } from '@/contexts/GuestContext';
import { recentPlayerRoomCodes } from '@/lib/roomMembership';
import { isKickedFromRoom } from '@/lib/kickedRooms';
import { API_URL, getReturningRoom, type ReturningRoom } from '@/lib/api';
import { gamePath, isAndroidBuild, roomPath, tutorialPath } from '@/lib/appPaths';
import { parseRoomJoinInput } from '@/lib/roomJoinInput';
import ShortTutorial from '@/components/ShortTutorial';
import CreateRoomModal from '@/components/CreateRoomModal';

const emptySubscribe = () => () => {};

// A healthy backend answers well under this; a Render cold start takes 30s+.
const WAKE_NOTICE_DELAY_MS = 2000;

export default function Home() {
  const router = useRouter();
  const { guestSession, hasName, ensureGuestName } = useGuestSession();
  const { clearGuest } = useGuest();

  const [isCreateRoomOpen, setIsCreateRoomOpen] = useState(false);
  const [isWakingServer, setIsWakingServer] = useState(false);
  const [roomInput, setRoomInput] = useState('');
  const [invalidRoomInput, setInvalidRoomInput] = useState(false);
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);

  const [check, setCheck] = useState<{ identity: string; room: ReturningRoom | null; hosting: boolean; hostedLobby?: string; failed?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [createAfterCheck, setCreateAfterCheck] = useState(false);
  const identity = guestSession?.sessionId;
  const displayName = guestSession?.displayName;
  const current = check?.identity === identity ? check : null;
  const returning = current?.room;
  const checking = Boolean(identity && !current);
  const hostedLobby = current?.hostedLobby;

  useEffect(() => {
    if (!identity || !displayName) return;
    let latest = 0;
    let hasResult = false;
    let timer: ReturnType<typeof setTimeout>;

    const session = { identity, displayName };

    async function refresh() {
      const request = ++latest;
      clearTimeout(timer);
      try {
        const codes = recentPlayerRoomCodes().filter(code => !isKickedFromRoom(code));
        const { room, hosting, hostedLobby } = await getReturningRoom(session.displayName, session.identity, codes);
        if (request !== latest) return;
        hasResult = true;
        setCheck({ identity: session.identity, room, hosting, hostedLobby });
        if (room || hosting) timer = setTimeout(refreshWhenVisible, 15000);
      } catch {
        if (request !== latest) return;
        if (hasResult) timer = setTimeout(refreshWhenVisible, 15000);
        else setCheck({ identity: session.identity, room: null, hosting: false, failed: true });
      }
    }

    function refreshWhenVisible() {
      if (document.visibilityState === 'visible') void refresh();
    }

    void refresh();
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      latest++;
      clearTimeout(timer);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [identity, displayName, attempt]);

  useEffect(() => {
    if (!createAfterCheck || !current) return;
    setCreateAfterCheck(false);
    if (!current.failed && !current.hosting && !current.room) setIsCreateRoomOpen(true);
  }, [createAfterCheck, current]);

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

  async function _createPrivateRoom() {
    const session = await ensureGuestName();
    if (!session) return; // user dismissed the guest name modal
    if (!current || current.identity !== session.sessionId) {
      setCreateAfterCheck(true);
      return;
    }
    if (!returning || window.confirm('Create another room and leave your current seat?')) setIsCreateRoomOpen(true);
  }

  function _joinPrivateRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const origin = isAndroidBuild() ? undefined : window.location.origin;
    const code = parseRoomJoinInput(roomInput, origin);
    if (!code) {
      setInvalidRoomInput(true);
      return;
    }
    if (returning && returning.code !== code && !window.confirm('Join another room and leave your current seat?')) return;
    router.push(returning?.code === code && returning.destination === 'game' ? gamePath(code) : roomPath(code));
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
              onClick={() => {
                if (!returning || window.confirm('Changing your name starts a new guest session. Leave your current seat?')) clearGuest();
              }}
              disabled={checking || current?.failed}
              className="ml-1 text-emerald-400 hover:text-white text-xs underline focus:outline-none focus:ring-1 focus:ring-emerald-400 rounded"
              aria-label="Change display name"
            >
              change
            </button>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-col gap-3 w-full">
          {returning && (
            <button
              onClick={() => router.push(returning.destination === 'game' ? gamePath(returning.code) : roomPath(returning.code))}
              className="rounded-xl bg-emerald-600 px-6 py-4 text-lg font-bold text-white hover:bg-emerald-500"
            >
              Return to {returning.destination} · {returning.code}
            </button>
          )}
          {hostedLobby && (
            <button
              onClick={() => {
                if (window.confirm('Return to your hosted lobby and leave your current seat?')) router.push(roomPath(hostedLobby));
              }}
              className="rounded-xl border border-emerald-700 px-6 py-3 font-semibold text-emerald-100 hover:bg-emerald-900"
            >
              Return to hosted lobby · {hostedLobby}
            </button>
          )}
          {current?.failed && (
            <button onClick={() => { setCheck(null); setAttempt(value => value + 1); }} className="rounded-xl border border-amber-600 p-3 text-amber-200">
              Couldn’t check your room. Retry
            </button>
          )}
          {current?.hosting && !returning && <p role="status" className="text-amber-200">You already host an active room.</p>}
          {!current?.hosting && <button
            disabled={checking || current?.failed}
            onClick={_createPrivateRoom}
            className="
              flex-1 py-4 px-6 rounded-xl font-bold text-lg
              bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700
              text-white shadow-lg shadow-emerald-900/50
              transition-all duration-150 active:scale-[0.97]
              focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-950
            "
          >
            <span className="flex flex-col items-center leading-tight">
              <span><span aria-hidden="true">🔒 </span>{checking ? 'Checking your room…' : 'Create Private Room'}</span>
              <span className="text-xs font-medium text-emerald-100/90 mt-1">
                Play with friends in your own room
              </span>
            </span>
          </button>}
          <form
            onSubmit={_joinPrivateRoom}
            className="rounded-xl border border-emerald-800/70 bg-emerald-950/40 p-3 text-left sm:p-4"
          >
            <label htmlFor="room-join-input" className="mb-2 block text-sm font-semibold text-emerald-100">
              Join by code
            </label>
            <div className="flex gap-2">
              <input
                id="room-join-input"
                value={roomInput}
                onChange={(event) => {
                  setRoomInput(event.target.value);
                  setInvalidRoomInput(false);
                }}
                placeholder="Room code or invite link"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalidRoomInput}
                aria-describedby={invalidRoomInput ? 'room-join-error' : undefined}
                className="min-w-0 flex-1 rounded-lg border border-slate-600 bg-slate-950 px-3 py-2.5 text-white placeholder:text-slate-400 focus-visible:outline-2 focus-visible:outline-emerald-300"
              />
              <button
                disabled={checking || current?.failed}
                type="submit"
                className="shrink-0 rounded-lg border border-emerald-600 bg-emerald-900 px-3 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-emerald-300"
              >
                Join room
              </button>
            </div>
            {invalidRoomInput && (
              <p id="room-join-error" role="alert" className="mt-2 text-sm text-rose-200">
                Enter a 6-character room code or invite link for players.
              </p>
            )}
          </form>
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
        <nav aria-label="Explore Literati" className="flex flex-wrap items-center justify-center gap-x-3 text-sm text-emerald-200">
          <a href={tutorialPath()} className="rounded px-3 py-2 underline underline-offset-4 hover:text-white focus-visible:outline-2">
            Play the full interactive tutorial
          </a>
          <a href={isAndroidBuild() ? '/avatar-preview.html' : '/avatar-preview'}
            className="rounded px-3 py-2 underline underline-offset-4 hover:text-white focus-visible:outline-2">
            Preview avatar animations
          </a>
        </nav>
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
