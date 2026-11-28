'use client';

import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useGuestSession } from '@/hooks/useGuestSession';
import { useAccount } from '@/contexts/AccountContext';
import ProfilePanel from '@/components/home/ProfilePanel';
import { useGuest } from '@/contexts/GuestContext';
import { recentPlayerRoomCodes } from '@/lib/roomMembership';
import { isKickedFromRoom } from '@/lib/kickedRooms';
import { HTTP_API_URL, ApiError, getReturningRoom, type ReturningRoom } from '@/lib/api';
import { gamePath, isAndroidBuild, roomPath } from '@/lib/appPaths';
import { loadGuestSession } from '@/lib/guestSession';
import { parseRoomJoinInput } from '@/lib/roomJoinInput';
import TableGuide from '@/components/home/TableGuide';
import GuideCard from '@/components/home/GuideCard';
import styles from '@/components/home/Guide.module.css';
import CreateRoomModal, { createPrivateLobby } from '@/components/CreateRoomModal';

const emptySubscribe = () => () => {};

// A healthy backend answers well under this; a Render cold start takes 30s+.
const WAKE_NOTICE_DELAY_MS = 2000;

export default function Home() {
  const router = useRouter();
  const { guestSession, hasName, ensureGuestName } = useGuestSession();
  const { session: account, loading: accountLoading, displayName: accountName } = useAccount();
  const { clearGuest, setGuestName } = useGuest();

  const [isCreateRoomOpen, setIsCreateRoomOpen] = useState(false);
  const [isWakingServer, setIsWakingServer] = useState(false);
  const [startingBots, setStartingBots] = useState(false);
  const [botError, setBotError] = useState('');
  const [roomInput, setRoomInput] = useState('');
  const [invalidRoomInput, setInvalidRoomInput] = useState(false);
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);

  const [check, setCheck] = useState<{ identity: string; room: ReturningRoom | null; hosting: boolean; hostedLobby?: string; failed?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [createAfterCheck, setCreateAfterCheck] = useState(false);
  const identity = accountLoading ? undefined : account?.user.id ?? guestSession?.sessionId;
  const displayName = account ? accountName : guestSession?.displayName;
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
        const { room, hosting, hostedLobby } = await getReturningRoom(session.displayName, session.identity, codes, account?.access_token);
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
  }, [identity, displayName, attempt, account?.access_token]);

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

    fetch(`${HTTP_API_URL}/health`)
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
    const session = account ? { sessionId: account.user.id } : await ensureGuestName();
    if (!session) return; // user dismissed the guest name modal
    if (!current || current.identity !== session.sessionId) {
      setCreateAfterCheck(true);
      return;
    }
    if (!returning || window.confirm('Create another room and leave your current seat?')) setIsCreateRoomOpen(true);
  }

  async function _playWithBots() {
    if (startingBots) return;
    if (current?.hosting) {
      if (hostedLobby) router.push(roomPath(hostedLobby));
      else if (returning) router.push(returning.destination === 'game' ? gamePath(returning.code) : roomPath(returning.code));
      else setBotError('You already host an active room.');
      return;
    }
    if (returning && !window.confirm('Start a bot game and leave your current seat?')) return;
    setStartingBots(true);
    setBotError('');
    try {
      const guest = account ? null : guestSession ?? loadGuestSession() ?? setGuestName('Guest');
      const room = await createPrivateLobby(6, accountName ?? guest!.displayName, {
        bearerToken: account?.access_token,
        recoveryKey: guest?.sessionId ?? null,
        startWithBots: true,
      });
      router.push(roomPath(room.code));
    } catch (error) {
      setBotError(error instanceof ApiError ? error.message : 'Could not start the game. Try again.');
      setStartingBots(false);
      setAttempt(value => value + 1);
    }
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
    <main className={styles.home} id="play">
      <nav className={styles.mast} aria-label="Main navigation">
        <a href="#play" aria-label="Literati home" className={styles.brand}>
          <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><use href="/icons/high-diamond.svg#diamond" /></svg>
          Literati
        </a>
        <ProfilePanel
          guestName={mounted && !accountLoading && !account && hasName ? guestSession?.displayName : undefined}
          changeDisabled={checking || Boolean(current?.failed)}
          onChangeName={() => {
            if (!returning || window.confirm('Changing your name starts a new guest session. Leave your current seat?')) clearGuest();
          }}
        />
      </nav>
      <section className={styles.hero}>
        <div className={styles.intro}>
          <h1>Literature</h1>
          <p className={styles.tagline}>Remember who took the card.<br /><em>Ask for it back.</em></p>
          {/* Action buttons */}
          <div className={styles.actions}>
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
              disabled={accountLoading || checking || current?.failed}
              onClick={_createPrivateRoom}
              className={styles.play}
            >
              <span className="flex flex-col items-start leading-tight">
                <span>{checking ? 'Checking your room…' : 'Play now!'}</span>
                <span className="text-xs font-medium mt-1">
                  Play with friends or bots in a private room.
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
                  disabled={accountLoading || checking || current?.failed}
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
          <a className={styles.read} href="#lesson-1"><span aria-hidden="true">↓</span> Scroll to learn the game</a>
        </div>
        <div className={styles.cover} aria-hidden="true">
          <div className={styles.fan}>
            <div><GuideCard rank={13} suit="s" /></div>
            <div><GuideCard rank={12} suit="h" /></div>
            <div><GuideCard rank={1} /></div>
          </div>
        </div>
      </section>
      <TableGuide
        onPlay={_playWithBots}
        playLabel={startingBots ? 'Starting your game…' : current?.hosting ? 'Return to your room' : 'Play with bots'}
        playDisabled={!mounted || accountLoading || startingBots || checking}
        playError={botError}
      />

      {/* Create Room modal — shown after guest name is confirmed */}
      {mounted && displayName && (
        <CreateRoomModal
          open={isCreateRoomOpen}
          displayName={displayName}
          onClose={() => setIsCreateRoomOpen(false)}
        />
      )}
    </main>
  );
}
