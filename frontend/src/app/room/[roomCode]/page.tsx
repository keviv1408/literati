'use client';

/**
 * Room Lobby Page — /room/[roomCode]
 *
 * The host lands here immediately after creating a private room.
 * Other players will join by entering the 6-character room code or following
 * a share link. Spectators append ?spectate=1 to the URL.
 *
 * Fetch + display room details (code, settings, share link).
 * Fast-path for the host — CreateRoomModal caches the room in
 * sessionStorage; the page consumes it immediately so there is no
 * loading spinner and both the invite link and spectator link are
 * visible the instant the host lands here.
 * Two labelled team columns with player cards for each seat.
 * Seats alternate T1-T2-T1-T2; empty seats show "Waiting…".
 * Real-time WebSocket seat updates arrive in
 * Kicked-player handling —
 * • On mount checks localStorage to see if this browser was
 * previously kicked from this room; if so, shows the dismissal
 * notice immediately without even fetching room details.
 * • Connects to the backend WebSocket and listens for
 * "player-kicked" events targeting the current session.
 * • When kicked, persists the room code to localStorage and
 * renders the dismissal notice, blocking re-entry.
 * Auto-reconnect on page refresh —
 * • useReconnect validates the stored session (guest token or
 * Supabase JWT) against the backend before the WebSocket opens.
 * • Shows "Reconnecting…" spinner while session is being validated.
 * • Shows "Session Expired" notice for registered users whose
 * tokens are fully expired (sign-in redirect provided).
 * • Guest stale-token recovery is transparent: the hook creates a
 * fresh guest session silently when the old one is no longer
 * in the server's in-memory store.
 * • Shows a retryable "Connection Error" screen when the backend
 * is unreachable.
 *
 * The page is a Client Component so it can access window.location for the
 * share link and react to room state changes when WebSocket support is added.
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { getRoomByCode, ApiError } from '@/lib/api';
import { isKickedFromRoom } from '@/lib/kickedRooms';
import {
  loadRoomMembership,
  saveRoomMembership,
  clearRoomMembership,
  type RoomRole,
} from '@/lib/roomMembership';
import { consumeCreatedRoom } from '@/components/CreateRoomModal';
import { useRoomSocket } from '@/hooks/useRoomSocket';
import { useReconnect } from '@/hooks/useReconnect';
import { useGuestSession } from '@/hooks/useGuestSession';
import { connectSocket, disconnectSocket } from '@/lib/socket';
import type { RoomCreatedPayload } from '@/lib/socket';
import type { Room, Team } from '@/types/room';
import DraggableLobbyTeamColumns from '@/components/DraggableLobbyTeamColumns';
import { buildEmptySeats } from '@/types/lobby';
import type { LobbyPlayer } from '@/types/lobby';

// ── Variant display helpers ──────────────────────────────────────────────────

const VARIANT_LABELS: Record<string, string> = {
  remove_2s: 'Remove 2s',
  remove_7s: 'Remove 7s (Classic)',
  remove_8s: 'Remove 8s',
};

// ── Page component ───────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ roomCode: string }>;
}

export default function RoomLobbyPage({ params }: PageProps) {
  const router = useRouter();

  // ── Session validation / auto-reconnect ────────────────────────
  // useReconnect validates the stored session (guest bearer token or Supabase
  // JWT) against the backend before the WebSocket can connect. This prevents
  // the socket hook from attempting a connection with a stale or expired token.
  const {
    status: reconnectStatus,
    sessionId: reconnectSessionId,
    bearerToken: baseToken,
    errorMessage: reconnectError,
    retry: retryReconnect,
  } = useReconnect();

  const { ensureGuestName } = useGuestSession();

  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  /** True when viewer arrives via ?spectate=1 URL param. */
  const [isSpectator, setIsSpectator] = useState(false);

  /** Copy states for invite and spectator links. */
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [copiedSpectator, setCopiedSpectator] = useState(false);

  /**
   * Lobby seats derived from the live WebSocket player list.
   *
   * The room WS server (/ws/room/<CODE>) broadcasts a full `room_players`
   * snapshot after every state change (join, leave, kick, team switch).
   * Each player has a `teamId` (1 or 2). We map T1 players to even seat
   * indices and T2 players to odd seat indices, preserving server-side order
   * within each team so the layout is deterministic for all clients.
   */
  const [seats, setSeats] = useState<Array<LobbyPlayer | null>>([]);

  /**
   * True when the current browser session created this room. Used to decide whether to render draggable
   * team columns so only the host can reassign players between teams.
   */
  const [isHostUser, setIsHostUser] = useState(false);

  // Resolve async params (Next.js 15+ params are Promises)
  const [roomCode, setRoomCode] = useState<string | null>(null);

  // ── Kicked-player state ────────────────────────────────────────
  /**
   * True when localStorage already marks this browser as kicked from this
   * room — checked synchronously on mount so the notice shows before any
   * network fetch.
   */
  const [kickedOnEntry, setKickedOnEntry] = useState(false);

  /**
   * Bearer token used for WebSocket authentication.
   *
   * Derived from two sources (first available wins):
   * 1. loadRoomMembership(roomCode).bearerToken — the exact token that was
   * accepted by the WS server on a previous visit to this room URL.
   * Re-using it ensures the server recognises the same player identity.
   * 2. useReconnect().bearerToken — the validated base session token
   * (guest bearer or Supabase JWT) when no room membership is stored.
   *
   * Only populated once reconnectStatus === 'ready' so the WebSocket hook
   * never attempts to connect with an unvalidated or expired token.
   */
  const [bearerToken, setBearerToken] = useState<string | null>(null);

  /**
   * Server-authoritative links delivered by the 'room-created' Socket.io event.
   *
   * When the host's socket is connected at the moment the room is created the
   * backend emits these links (using the server-side FRONTEND_URL env var).
   * If the socket was not connected during creation these stay null and the
   * page falls back to computing links from window.location.origin.
   */
  const [socketRoomLinks, setSocketRoomLinks] =
    useState<Pick<RoomCreatedPayload, 'inviteLink' | 'spectatorLink'> | null>(null);

  useEffect(() => {
    params.then(({ roomCode: code }) => {
      setRoomCode(code.toUpperCase());
    });
  }, [params]);

  // ── Detect spectator mode from URL query params ────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    setIsSpectator(params.get('spectate') === '1');
  }, []);

  // ── Check whether already kicked (persisted from a previous session) ──────
  useEffect(() => {
    if (!roomCode) return;
    if (isKickedFromRoom(roomCode)) {
      setKickedOnEntry(true);
      setLoading(false);
    }
  }, [roomCode]);

  // ── Derive WebSocket bearer token from validated session ────────
  //
  // Only runs once the session has been validated by useReconnect (status ===
  // 'ready'). Prefers the room-specific membership token (same identity that
  // was used on the last visit) over the generic base session token.
  //
  // Setting bearerToken to null when the session is not yet ready prevents
  // useRoomSocket from opening a WebSocket connection prematurely.
  useEffect(() => {
    if (reconnectStatus !== 'ready' || !roomCode || kickedOnEntry) {
      setBearerToken(null);
      return;
    }

    // Priority 1: room-specific membership token from a previous visit.
    // This re-uses the exact backend session that the WS server already
    // accepted for this room, preserving seat and host status.
    const membership = loadRoomMembership(roomCode);
    if (membership) {
      setBearerToken(membership.bearerToken);
      return;
    }

    // Priority 2: validated base session token from useReconnect.
    setBearerToken(baseToken);
  }, [reconnectStatus, roomCode, baseToken, kickedOnEntry]);

  // ── Socket.io connection for room-created event ───────────────────────────
  // Connects once a bearer token is available so the host can receive the
  // 'room-created' event if they happened to be connected when the room was
  // created (e.g. they opened the socket before submitting the create-room
  // form). The server emits this event with server-authoritative links
  // (using the FRONTEND_URL env var) which may differ from window.location.origin
  // in production.
  useEffect(() => {
    if (!bearerToken || kickedOnEntry) return;

    const socket = connectSocket(bearerToken);

    const onRoomCreated = (payload: RoomCreatedPayload) => {
      // Only update if the event is for the room we are currently viewing.
      if (!roomCode) return;
      if (payload.room?.code?.toUpperCase() !== roomCode) return;
      setSocketRoomLinks({
        inviteLink: payload.inviteLink,
        spectatorLink: payload.spectatorLink,
      });
    };

    socket.on('room-created', onRoomCreated);

    return () => {
      socket.off('room-created', onRoomCreated);
      disconnectSocket();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bearerToken, kickedOnEntry]);

  // ── Live kick listener ────────────────────────────────────────────────────
  //
  // sessionId is the server-assigned identity returned by useReconnect once
  // the session is validated. Passing null while reconnecting prevents
  // useRoomSocket from opening a WebSocket before auth is confirmed.
  const sessionId = reconnectStatus === 'ready' ? reconnectSessionId : null;

  const handleKickedLive = useCallback(() => {
    // useRoomSocket already called addKickedRoom; we just stop the spinner.
    // Also clear the room membership binding so the stored token cannot be
    // used to sneak back into the room after being kicked.
    if (roomCode) clearRoomMembership(roomCode);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode]);

  const {
    isKicked,
    kickReason,
    emit: socketEmit,
    players: wsPlayers,
    myPlayerId,
    kickPlayer,
    changeTeam,
    startGame,
    lobbyStarting,
    lastError: wsError,
    hostChangedEvent,
  } = useRoomSocket({
    // Pass null when already kicked so no socket is opened unnecessarily.
    roomCode: kickedOnEntry ? null : roomCode,
    sessionId,
    bearerToken,
    onKicked: handleKickedLive,
  });

  // Derive whether the current user is the host by finding their entry in the
  // live WebSocket player list returned by the server. The `isHost` flag is
  // set server-side based on the Supabase rooms.host_user_id field, so no
  // client-side spoofing is possible.
  const myWsPlayer = wsPlayers.find((p) => p.playerId === myPlayerId);
  const amIHostLive = myWsPlayer?.isHost ?? false;

  // ── Host-transfer notification ─────────────────────────────────────────────
  // When the server broadcasts `host_changed`, display a dismissable banner
  // so all lobby participants know who the new host is.
  const [hostChangedBanner, setHostChangedBanner] = useState<string | null>(null);

  useEffect(() => {
    if (!hostChangedEvent) return;
    const isMe = hostChangedEvent.newHostId === myPlayerId;
    const msg = isMe
      ? 'You are now the host.'
      : `${hostChangedEvent.newHostName} is now the host.`;
    setHostChangedBanner(msg);
    // Auto-dismiss after 5 seconds.
    const t = setTimeout(() => setHostChangedBanner(null), 5000);
    return () => clearTimeout(t);
  }, [hostChangedEvent, myPlayerId]);

  /**
   * True from the moment the host clicks "Start Game" until the server
   * broadcasts 'lobby-starting' (or an error arrives). Used to show a
   * spinner on the button and prevent double-submission.
   */
  const [isStarting, setIsStarting] = useState(false);

  // Reset isStarting if the server reports an error (e.g. start_game rejected).
  // wsError changes whenever a new { type: 'error' } message arrives.
  const prevWsError = useRef<string | null>(null);
  useEffect(() => {
    if (wsError && wsError !== prevWsError.current) {
      prevWsError.current = wsError;
      setIsStarting(false);
    }
  }, [wsError]);

  // ── Navigate to game board when the server triggers lobby-starting ──────────
  // Fires for ALL connected clients (host + players + spectators) when the
  // host starts the game. The redirect goes to /game/<CODE> which is the
  // main game board page.
  useEffect(() => {
    if (!lobbyStarting || !roomCode) return;
    router.push(`/game/${roomCode}`);
  }, [lobbyStarting, roomCode, router]);

  /**
   * The current player's team assignment as reported by the server.
   * Used to determine which "Switch Team" button to display.
   */
  const myTeamId = (myWsPlayer?.teamId ?? null) as 1 | 2 | null;

  // ── Persist room membership binding ───────────────────────────────────────
  // Once the WS server confirms authentication (myPlayerId is set) and the
  // room is not in a kicked state, save the session-to-room binding in
  // localStorage. This allows the page to restore the WebSocket connection
  // on a page reload using the same backend session — see the bearer-token
  // resolution effect above.
  //
  // The role is updated whenever amIHostLive changes (e.g. original host
  // leaves and another player is promoted) so the stored record stays accurate.
  useEffect(() => {
    if (!roomCode || !bearerToken || !myPlayerId) return;
    if (isKicked || kickedOnEntry) return;  // Don't save after being kicked.

    const role: RoomRole = amIHostLive ? 'host' : 'player';
    saveRoomMembership(roomCode, bearerToken, myPlayerId, role);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, bearerToken, myPlayerId, amIHostLive, isKicked, kickedOnEntry]);

  // ── Convert live wsPlayers to the seats array used by the team UI ─────────
  // Runs whenever the server broadcasts a room_players snapshot, keeping the
  // displayed seat columns in sync with the authoritative server state.
  useEffect(() => {
    if (!room) return;

    if (wsPlayers.length === 0) {
      // No live data yet — show empty seats so the UI renders "Waiting…"
      setSeats(buildEmptySeats(room.player_count));
      return;
    }

    // Split players by their server-assigned teamId
    const t1 = wsPlayers.filter((p) => p.teamId === 1);
    const t2 = wsPlayers.filter((p) => p.teamId === 2);

    const newSeats = buildEmptySeats(room.player_count);

    // T1 players occupy even seats (0, 2, 4, 6 …)
    t1.forEach((p, i) => {
      const idx = i * 2;
      if (idx < room.player_count) {
        newSeats[idx] = {
          seatIndex: idx,
          playerId: p.playerId,
          displayName: p.displayName,
          // read isBot from the server snapshot so bot seats
          // correctly render BotBadge indicators (e.g. after lobby-starting).
          isBot: p.isBot ?? false,
          isHost: p.isHost,
          isCurrentUser: p.playerId === myPlayerId,
          avatarUrl: p.avatarId ?? null,
        };
      }
    });

    // T2 players occupy odd seats (1, 3, 5, 7 …)
    t2.forEach((p, i) => {
      const idx = i * 2 + 1;
      if (idx < room.player_count) {
        newSeats[idx] = {
          seatIndex: idx,
          playerId: p.playerId,
          displayName: p.displayName,
          // read isBot from the server snapshot so bot seats
          // correctly render BotBadge indicators (e.g. after lobby-starting).
          isBot: p.isBot ?? false,
          isHost: p.isHost,
          isCurrentUser: p.playerId === myPlayerId,
          avatarUrl: p.avatarId ?? null,
        };
      }
    });

    setSeats(newSeats);
  }, [wsPlayers, room, myPlayerId]);

  // ── Fetch room data (with sessionStorage fast-path) ────────────
  useEffect(() => {
    if (!roomCode) return;
    // Skip the network fetch if we already know the player is kicked.
    if (kickedOnEntry || isKicked) return;

    // Basic format validation — room codes are exactly 6 alphanumeric chars
    const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;
    if (!ROOM_CODE_RE.test(roomCode)) {
      setNotFound(true);
      setLoading(false);
      return;
    }

    // consume the room data cached by CreateRoomModal so the host
    // sees the lobby instantly without an additional API round-trip.
    // When a cached room is found the current browser session CREATED this
    // room — mark it as the host view so drag-and-drop is enabled.
    const cached = consumeCreatedRoom(roomCode);
    if (cached) {
      setRoom(cached);
      setSeats(buildEmptySeats(cached.player_count));
      setIsHostUser(true);
      setLoading(false);
      return;
    }

    let cancelled = false;

    getRoomByCode(roomCode)
      .then(({ room: fetched }) => {
        if (!cancelled) {
          // ── Spectator redirect: if the game is already in progress, send
          // the spectator directly to the game view so they don't have to sit
          // in an empty lobby watching for the lobby-starting event.
          // Read from window.location.search directly to avoid a state
          // timing race with the isSpectator effect.
          const spectateParam =
            typeof window !== 'undefined'
              ? new URLSearchParams(window.location.search).get('spectate')
              : null;
          if (spectateParam === '1' && fetched.status === 'in_progress') {
            router.replace(`/game/${fetched.code}`);
            return;
          }
          setRoom(fetched);
          // Initialise empty seat array sized to the room's player count.
          // will fill these via WebSocket join events.
          setSeats(buildEmptySeats(fetched.player_count));
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          if (err instanceof ApiError && err.status === 404) {
            setNotFound(true);
          }
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [roomCode, kickedOnEntry, isKicked]);

  // ── Seat reassignment ─────────────────────
  /**
   * Called by DraggableLobbyTeamColumns when the host drops a player card
   * onto the opposite team column.
   *
   * Resolves the player's server identity (playerId) from the seats array and
   * emits a `reassign_team` WebSocket message to the room WS server
   * (/ws/room/<CODE>). The server validates host authority, enforces team
   * capacity limits, and broadcasts an updated `room_players` snapshot to all
   * connected clients.
   *
   * @param seatIndex 0-based index of the seat being reassigned.
   * @param toTeam The team the seat was dropped onto (1 or 2).
   */
  const handleReassign = useCallback(
    (seatIndex: number, toTeam: Team) => {
      const seat = seats[seatIndex];
      // Empty seats or seats without a resolved playerId cannot be reassigned.
      if (!seat?.playerId) return;
      socketEmit('reassign_team', {
        targetId: seat.playerId,
        teamId:   toTeam,
      });
    },
    [socketEmit, seats],
  );

  // ── Copy helpers ─────────────────────────────────────────────────────────
  const handleCopyInvite = useCallback(() => {
    if (typeof window === 'undefined' || !roomCode) return;
    const url = `${window.location.origin}/room/${roomCode}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedInvite(true);
      setTimeout(() => setCopiedInvite(false), 2000);
    });
  }, [roomCode]);

  const handleCopySpectator = useCallback(() => {
    if (typeof window === 'undefined' || !roomCode) return;
    const url = `${window.location.origin}/room/${roomCode}?spectate=1`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedSpectator(true);
      setTimeout(() => setCopiedSpectator(false), 2000);
    });
  }, [roomCode]);

  // ── Session-validation render gates ──────────────────────────
  // These are evaluated AFTER the kicked check (handled below) to avoid
  // delaying the kicked notice with a session-validation spinner.

  // ── Reconnecting / session-validating spinner ───────────────────────────
  if (
    !kickedOnEntry && !isKicked &&
    (reconnectStatus === 'loading' || reconnectStatus === 'reconnecting')
  ) {
    return (
      <div
        className="animate-delayed-reveal flex min-h-screen items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950"
        data-testid="reconnecting-screen"
        role="status"
        aria-label="Reconnecting…"
      >
        <div className="flex flex-col items-center gap-5 text-slate-400">
          <div className="flex gap-2" aria-hidden="true">
            <span
              className="animate-loading-dot h-2.5 w-2.5 rounded-full bg-emerald-500"
              style={{ animationDelay: '0ms' }}
            />
            <span
              className="animate-loading-dot h-2.5 w-2.5 rounded-full bg-emerald-500"
              style={{ animationDelay: '180ms' }}
            />
            <span
              className="animate-loading-dot h-2.5 w-2.5 rounded-full bg-emerald-500"
              style={{ animationDelay: '360ms' }}
            />
          </div>
          <span className="text-sm tracking-wide">Reconnecting…</span>
        </div>
      </div>
    );
  }

  // ── Session expired (registered user — both tokens fully expired) ────────
  if (!kickedOnEntry && !isKicked && reconnectStatus === 'session_expired') {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4 gap-6"
        role="alert"
        data-testid="session-expired-screen"
      >
        <div className="text-center max-w-sm">
          <div className="text-5xl mb-4" aria-hidden="true">🔐</div>
          <h1 className="text-2xl font-bold text-white mb-3">Session Expired</h1>
          <p className="text-slate-300 text-sm mb-4">
            {reconnectError ?? 'Your session has expired. Please sign in again to continue.'}
          </p>
        </div>
        <div className="flex flex-col gap-3 w-full max-w-xs">
          <button
            onClick={() => router.push('/auth/login')}
            className="
              py-3 px-6 rounded-xl font-semibold
              bg-emerald-600 hover:bg-emerald-500 text-white
              transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400
            "
            data-testid="session-expired-signin-btn"
          >
            Sign In Again
          </button>
          <button
            onClick={() => router.push('/')}
            className="
              py-3 px-6 rounded-xl font-medium text-sm text-slate-400
              hover:text-white hover:bg-slate-800/50
              border border-transparent hover:border-slate-700
              transition-all duration-150
              focus:outline-none focus:ring-2 focus:ring-emerald-400
            "
            data-testid="session-expired-home-btn"
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  // ── Connection error (backend unreachable) ───────────────────────────────
  if (!kickedOnEntry && !isKicked && reconnectStatus === 'error') {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4 gap-6"
        role="alert"
        data-testid="connection-error-screen"
      >
        <div className="text-center max-w-sm">
          <div className="text-5xl mb-4" aria-hidden="true">📡</div>
          <h1 className="text-2xl font-bold text-white mb-3">Connection Error</h1>
          <p className="text-slate-300 text-sm mb-4">
            {reconnectError ?? 'Could not reach the server. Please check your connection.'}
          </p>
        </div>
        <div className="flex flex-col gap-3 w-full max-w-xs">
          <button
            onClick={retryReconnect}
            className="
              py-3 px-6 rounded-xl font-semibold
              bg-emerald-600 hover:bg-emerald-500 text-white
              transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400
            "
            data-testid="connection-error-retry-btn"
          >
            Try Again
          </button>
          <button
            onClick={() => router.push('/')}
            className="
              py-3 px-6 rounded-xl font-medium text-sm text-slate-400
              hover:text-white hover:bg-slate-800/50
              border border-transparent hover:border-slate-700
              transition-all duration-150
              focus:outline-none focus:ring-2 focus:ring-emerald-400
            "
            data-testid="connection-error-home-btn"
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  // ── No session — guest without a display name / not logged in ────────────
  if (!kickedOnEntry && !isKicked && reconnectStatus === 'no_session') {
    // Prompt the guest to enter a display name, then retry session validation.
    const handleSetName = async () => {
      const session = await ensureGuestName();
      if (session) {
        retryReconnect();
      }
    };

    return (
      <div
        className="flex min-h-screen items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950"
        data-testid="no-session-screen"
      >
        <div className="flex flex-col items-center gap-4">
          <p className="text-slate-300 text-sm">Enter a display name to join this room</p>
          <button
            onClick={handleSetName}
            className="
              py-2 px-4 rounded-xl text-sm font-medium
              bg-emerald-700 hover:bg-emerald-600 text-white
              transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400
            "
          >
            Set Display Name
          </button>
          <button
            onClick={() => router.push('/')}
            className="
              py-1.5 px-3 rounded-xl text-xs font-medium
              text-slate-400 hover:text-slate-200
              transition-colors focus:outline-none
            "
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  // ── Kicked dismissal notice ──────────────────────────────────────────────
  // Shown when the player was kicked either before entering (persisted) or
  // during this live session via WebSocket event.
  if (kickedOnEntry || isKicked) {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4 gap-6"
        role="alert"
        aria-live="assertive"
        data-testid="kicked-notice"
      >
        <div className="text-center max-w-sm">
          <div className="text-5xl mb-4" aria-hidden="true">🚫</div>
          <h1 className="text-2xl font-bold text-white mb-3">
            Removed from Room
          </h1>
          <p className="text-slate-300 text-sm mb-2">
            {kickReason ?? 'You have been removed from this room by the host.'}
          </p>
          <p className="text-slate-500 text-xs">
            Room code:{' '}
            <span className="font-mono font-bold text-slate-400">{roomCode}</span>
          </p>
        </div>

        <button
          onClick={() => router.push('/')}
          className="
            py-3 px-6 rounded-xl font-semibold
            bg-emerald-600 hover:bg-emerald-500 text-white
            transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400
          "
          data-testid="kicked-go-home"
        >
          Back to Home
        </button>
      </div>
    );
  }

  // ── Loading skeleton ─────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950">
        <div className="flex flex-col items-center gap-4 text-slate-400">
          <svg
            className="animate-spin h-8 w-8 text-emerald-500"
            viewBox="0 0 24 24"
            fill="none"
            aria-label="Loading room…"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v8z"
            />
          </svg>
          <span className="text-sm">Loading room…</span>
        </div>
      </div>
    );
  }

  // ── 404 state ────────────────────────────────────────────────────────────
  if (notFound || !room) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4 gap-6">
        <div className="text-center">
          <div className="text-5xl mb-4" aria-hidden="true">🃏</div>
          <h1 className="text-2xl font-bold text-white mb-2">Room Not Found</h1>
          <p className="text-slate-400 text-sm">
            The room code <span className="font-mono font-bold text-emerald-400">{roomCode}</span> doesn&apos;t exist or has expired.
          </p>
        </div>
        <button
          onClick={() => router.push('/')}
          className="
            py-3 px-6 rounded-xl font-semibold
            bg-emerald-600 hover:bg-emerald-500 text-white
            transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400
          "
        >
          Back to Home
        </button>
      </div>
    );
  }

  // ── Room lobby ───────────────────────────────────────────────────────────
  const origin =
    typeof window !== 'undefined' ? window.location.origin : '';
  // Prefer server-authoritative links from 'room-created' socket event
  // (they use the server-side FRONTEND_URL env var). Fall back to computing
  // from window.location.origin when the socket event was not received.
  const inviteUrl =
    socketRoomLinks?.inviteLink ?? `${origin}/room/${room.code}`;
  const spectatorUrl =
    socketRoomLinks?.spectatorLink ?? `${origin}/room/${room.code}?spectate=1`;

  const isCancelled =
    room.status === 'cancelled' || room.status === 'completed';

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 px-4">
      {/* Background decoration — subtle floating drift */}
      <div
        className="pointer-events-none fixed inset-0 overflow-hidden opacity-5 select-none"
        aria-hidden="true"
      >
        <span className="absolute text-[20rem] -top-16 -right-16 text-white animate-suit-drift-1">♦</span>
        <span className="absolute text-[14rem] bottom-0 -left-8 text-white animate-suit-drift-2">♣</span>
      </div>

      <main className="relative z-10 w-full max-w-md flex flex-col gap-6">

        {/* ── Spectator banner ────────────────────────────────────────────── */}
        {isSpectator && (
          <div
            className="
              flex items-center gap-2 px-4 py-2.5 rounded-xl
              bg-amber-900/30 border border-amber-700/50
              text-amber-300 text-sm font-medium
            "
            role="status"
            data-testid="spectator-banner"
          >
            <span aria-hidden="true">👁</span>
            You are watching as a spectator
          </div>
        )}

        {/* ── Matchmaking banner ───────────────────────────────────────────── */}
        {room.is_matchmaking && (
          <div
            className="
              flex items-center gap-2 px-4 py-2.5 rounded-xl
              bg-blue-900/30 border border-blue-700/50
              text-blue-300 text-sm font-medium
            "
            role="status"
            data-testid="matchmaking-banner"
          >
            <span aria-hidden="true">🎮</span>
            Matchmaking Game — teams are auto-assigned
          </div>
        )}

        {/* ── Host-change notification banner ──────────────────────────────── */}
        {hostChangedBanner && (
          <div
            className="
              flex items-center justify-between gap-2 px-4 py-2.5 rounded-xl
              bg-emerald-900/30 border border-emerald-700/50
              text-emerald-300 text-sm font-medium
            "
            role="status"
            aria-live="polite"
            data-testid="host-changed-banner"
          >
            <span className="flex items-center gap-2">
              <span aria-hidden="true">👑</span>
              {hostChangedBanner}
            </span>
            <button
              onClick={() => setHostChangedBanner(null)}
              className="text-emerald-400/60 hover:text-emerald-300 transition-colors"
              aria-label="Dismiss host change notification"
            >
              ✕
            </button>
          </div>
        )}

        {/* ── Room code card ──────────────────────────────────────────────── */}
        <div className="
          bg-gradient-to-b from-slate-800/80 to-slate-900/80
          border border-emerald-700/40
          rounded-2xl p-6 text-center shadow-xl shadow-black/40
          animate-lobby-section-in
        " style={{ animationDelay: '0ms' }}>
          <p className="text-sm text-emerald-300/80 font-medium mb-1 uppercase tracking-widest">
            Room Code
          </p>
          <div
            className="text-5xl font-black font-mono tracking-[0.2em] text-white my-3 select-all"
            aria-label={`Room code: ${room.code}`}
            data-testid="lobby-room-code"
          >
            {room.code}
          </div>
          <p className="text-xs text-slate-500">
            {room.is_matchmaking
              ? 'Waiting for matched players to join…'
              : 'Share this code or the links below so friends can join'}
          </p>

          {/* Invite / spectator links — hidden for matchmaking rooms */}
          {!room.is_matchmaking && (
            <>
              {/* Invite link + copy */}
              <div className="mt-4 text-left">
                <p className="text-xs text-emerald-300/60 font-medium mb-1.5 uppercase tracking-widest">
                  Invite Link
                </p>
                <div className="flex items-center gap-2">
                  <div
                    className="
                      flex-1 bg-slate-800 border border-slate-700 rounded-xl
                      px-3 py-2 text-xs font-mono text-slate-300 truncate
                    "
                    data-testid="lobby-invite-url"
                  >
                    {inviteUrl}
                  </div>
                  <button
                    onClick={handleCopyInvite}
                    aria-label="Copy invite link"
                    data-testid="lobby-copy-invite-btn"
                    className={`
                      px-3 py-2 rounded-xl text-xs font-semibold shrink-0
                      text-white transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400
                      ${copiedInvite
                        ? 'bg-emerald-500 animate-copy-confirm'
                        : 'bg-emerald-700 hover:bg-emerald-600'}
                    `}
                  >
                    {copiedInvite ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              {/* Spectator link + copy */}
              <div className="mt-3 text-left">
                <p className="text-xs text-slate-400/60 font-medium mb-1.5 uppercase tracking-widest">
                  Spectator Link
                </p>
                <div className="flex items-center gap-2">
                  <div
                    className="
                      flex-1 bg-slate-800 border border-slate-600/60 rounded-xl
                      px-3 py-2 text-xs font-mono text-slate-400 truncate
                    "
                    data-testid="lobby-spectator-url"
                  >
                    {spectatorUrl}
                  </div>
                  <button
                    onClick={handleCopySpectator}
                    aria-label="Copy spectator link"
                    data-testid="lobby-copy-spectator-btn"
                    className={`
                      px-3 py-2 rounded-xl text-xs font-semibold shrink-0
                      text-white transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400
                      ${copiedSpectator
                        ? 'bg-emerald-500 animate-copy-confirm'
                        : 'bg-slate-600 hover:bg-slate-500'}
                    `}
                  >
                    {copiedSpectator ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── Room settings ────────────────────────────────────────────────── */}
        <div className="
          bg-slate-800/50 border border-slate-700/50
          rounded-2xl p-5 flex flex-col gap-4
          animate-lobby-section-in
        " style={{ animationDelay: '80ms' }}>
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-widest">
            Room Settings
          </h2>

          <div className="grid grid-cols-2 gap-4">
            {/* Player count */}
            <div className="flex flex-col gap-1">
              <span className="text-xs text-slate-500 uppercase tracking-wider">
                Players
              </span>
              <div className="flex items-center gap-2">
                <span className="text-2xl font-black text-white">
                  {room.player_count}
                </span>
                <span className="text-xs text-slate-400">
                  ({room.player_count === 6 ? '3v3' : '4v4'})
                </span>
              </div>
            </div>

            {/* Variant */}
            <div className="flex flex-col gap-1">
              <span className="text-xs text-slate-500 uppercase tracking-wider">
                Variant
              </span>
              <span className="text-sm font-semibold text-emerald-300">
                {VARIANT_LABELS[room.card_removal_variant] ?? room.card_removal_variant}
              </span>
            </div>
          </div>
        </div>

        {/* ── Team columns / waiting area ───────────────────────────────────── */}
        <div className="
          bg-slate-800/50 border border-slate-700/50
          rounded-2xl p-5
          animate-lobby-section-in
        " style={{ animationDelay: '160ms' }}>
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-widest mb-4">
            Players
          </h2>

          {isCancelled ? (
            <p className="text-sm text-red-400 text-center py-2">
              This room has been {room.status}.
              <button
                onClick={() => router.push('/')}
                className="ml-1 underline hover:text-red-300 transition-colors"
              >
                Go home
              </button>
            </p>
          ) : (
            <>
              {/*
               * Two labelled team columns — seats alternate T1-T2-T1-T2.
               * All seats start empty (null). fills them via
               * WebSocket join events by calling setSeats(updatedSeats).
               *
               * DnD-enabled version — the host (isHostUser) can
               * drag player cards between team columns; each successful drop
               * calls handleReassign which emits a `reassign_team` socket event.
               * Non-host clients (isHostUser=false) see static columns only.
               */}
              <DraggableLobbyTeamColumns
                playerCount={room.player_count}
                seats={seats}
                isHost={isHostUser && !isSpectator}
                onReassign={handleReassign}
              />

              {/* ── Switch Team button ────────────────────────
                  Visible ONLY to the current connected player (not spectators)
                  and NOT in matchmaking rooms (teams are auto-assigned there).
                  Sends change_team to the room WS server; the server enforces
                  capacity limits and broadcasts room_players to everyone.
                  ────────────────────────────────────────────────────── */}
              {myTeamId && !isSpectator && !room.is_matchmaking && (
                <div className="mt-4 flex justify-center">
                  <button
                    type="button"
                    onClick={() => changeTeam(myTeamId === 1 ? 2 : 1)}
                    className="
                      px-4 py-2 rounded-xl text-xs font-semibold
                      bg-slate-700 hover:bg-slate-600 text-slate-200
                      border border-slate-600
                      transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400
                      active:scale-95
                    "
                    aria-label={`Switch to Team ${myTeamId === 1 ? 2 : 1}`}
                    data-testid="switch-team-btn"
                  >
                    Switch to Team {myTeamId === 1 ? 2 : 1}
                  </button>
                </div>
              )}

              {/* ── Host Kick Controls ────────────────────────
                  Visible ONLY when the current user is the room host AND
                  at least one player is connected via WebSocket.
                  Kick button is rendered next to every non-host player.
                  Spectators never see this panel.
                  ────────────────────────────────────────────────────── */}
              {!isSpectator && amIHostLive && wsPlayers.length > 0 && (
                <div
                  className="mt-4 pt-4 border-t border-slate-700/50"
                  data-testid="host-kick-panel"
                >
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2">
                    Connected Players
                  </h3>
                  <ul
                    className="flex flex-col gap-1.5"
                    aria-label="Connected players — host controls"
                  >
                    {wsPlayers.map((player) => {
                      const isMe = player.playerId === myPlayerId;
                      const canKick = !player.isHost && !isMe;

                      return (
                        <li
                          key={player.playerId}
                          className="flex items-center justify-between px-3 py-2 rounded-xl bg-slate-800/60 border border-slate-700/40"
                          data-testid={`player-row-${player.playerId}`}
                        >
                          <span className="flex items-center gap-2 text-sm text-slate-200 min-w-0">
                            <span aria-hidden="true" className="shrink-0">
                              {player.isHost ? '👑' : '👤'}
                            </span>
                            <span className="truncate">{player.displayName}</span>
                            {isMe && (
                              <span className="text-xs text-slate-500 shrink-0">(you)</span>
                            )}
                            {player.isHost && (
                              <span className="text-xs text-emerald-400 shrink-0">Host</span>
                            )}
                          </span>

                          {canKick && (
                            <button
                              type="button"
                              onClick={() => kickPlayer(player.playerId)}
                              aria-label={`Kick ${player.displayName}`}
                              data-testid={`kick-btn-${player.playerId}`}
                              className="
                                ml-3 shrink-0 px-2 py-1 rounded-lg
                                text-xs font-semibold
                                bg-red-900/60 hover:bg-red-700/80
                                text-red-300 hover:text-white
                                border border-red-700/50 hover:border-red-500
                                transition-all duration-150
                                focus:outline-none focus:ring-2 focus:ring-red-500
                                active:scale-95
                              "
                            >
                              Kick
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Host: Start Game controls ───────────────────────
            Visible ONLY when the current user is the room host AND is not a
            spectator.  Empty seats will be filled with bots server-side when
            the host starts the game.
            ─────────────────────────────────────────────────────────────── */}
        {!isSpectator && !isCancelled && (
          <div
            className="
              bg-slate-800/50 border border-slate-700/50
              rounded-2xl p-5 flex flex-col gap-4
              animate-lobby-section-in
            "
            style={{ animationDelay: '240ms' }}
            data-testid="start-game-panel"
          >
            {/* ── Lobby readiness summary ────────────────────────────────── */}
            {(() => {
              const connected = wsPlayers.length;
              const required  = room.player_count;
              const empty     = required - connected;
              const t1Count   = wsPlayers.filter((p) => p.teamId === 1).length;
              const t2Count   = wsPlayers.filter((p) => p.teamId === 2).length;
              const balanced  = t1Count === t2Count;

              return (
                <>
                  {/* Player count + bot-fill info */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
                      Lobby Status
                    </span>
                    <span
                      className={`
                        text-xs font-semibold px-2.5 py-1 rounded-lg
                        ${connected >= required
                          ? 'bg-emerald-900/60 text-emerald-300 border border-emerald-700/40'
                          : 'bg-slate-700/60 text-slate-300 border border-slate-600/40'}
                      `}
                      aria-label={`${connected} of ${required} players connected`}
                      data-testid="lobby-player-count"
                    >
                      {connected}/{required} players
                    </span>
                  </div>

                  {/* Bot fill notice */}
                  {empty > 0 && (
                    <p
                      className="text-xs text-slate-400 -mt-1"
                      data-testid="lobby-bot-fill-notice"
                      role="note"
                    >
                      <span aria-hidden="true">🤖</span>{' '}
                      {empty} empty seat{empty !== 1 ? 's' : ''} will be filled
                      with bot{empty !== 1 ? 's' : ''} when the game starts.
                    </p>
                  )}

                  {/* Team-balance warning */}
                  {connected > 1 && !balanced && (
                    <p
                      className="text-xs text-amber-400 -mt-1 flex items-center gap-1.5"
                      data-testid="lobby-team-imbalance-warning"
                      role="note"
                    >
                      <span aria-hidden="true">⚠️</span>
                      Teams are uneven right now — bots will balance them on
                      start.
                    </p>
                  )}

                  {/* All seats filled confirmation */}
                  {empty === 0 && balanced && (
                    <p
                      className="text-xs text-emerald-400 -mt-1 flex items-center gap-1.5"
                      data-testid="lobby-all-filled-notice"
                      role="note"
                    >
                      <span aria-hidden="true">✅</span>
                      All {required} seats filled — ready to start!
                    </p>
                  )}
                </>
              );
            })()}

            {/* ── Server-side error feedback ─────────────────────────────── */}
            {wsError && !lobbyStarting && (
              <div
                className="
                  px-3 py-2 rounded-xl
                  bg-red-900/40 border border-red-700/50
                  text-red-300 text-xs
                "
                role="alert"
                data-testid="start-game-error"
              >
                <span aria-hidden="true">❌</span>{' '}
                {wsError}
              </div>
            )}

            {/* ── Start Game button ─────────────────────────────────────── */}
            <button
              type="button"
              onClick={() => {
                const sent = startGame();
                if (sent) setIsStarting(true);
              }}
              disabled={isStarting || lobbyStarting}
              aria-label="Start Game"
              aria-busy={isStarting || lobbyStarting}
              data-testid="start-game-btn"
              className={`
                w-full py-3.5 rounded-xl font-bold text-base
                bg-emerald-600 hover:bg-emerald-500
                disabled:bg-emerald-900/50 disabled:cursor-not-allowed
                text-white disabled:text-emerald-400/60
                transition-all duration-150
                focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2
                focus:ring-offset-slate-800
                active:scale-[0.98]
                shadow-lg shadow-emerald-900/30
                ${wsPlayers.length >= room.player_count && !isStarting && !lobbyStarting ? 'animate-start-ready-pulse' : ''}
              `}
            >
              {isStarting || lobbyStarting ? (
                <span className="flex items-center justify-center gap-2">
                  <svg
                    className="animate-spin h-4 w-4 text-emerald-300"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v8z"
                    />
                  </svg>
                  Starting…
                </span>
              ) : (
                'Start Game'
              )}
            </button>
          </div>
        )}

        {/* ── Matchmaking waiting panel ─────────────────────────────────────
            For matchmaking rooms (no host), show player count progress and
            the auto-start timer notice until the game starts.
            ─────────────────────────────────────────────────────────────── */}
        {room.is_matchmaking && !isSpectator && !lobbyStarting && (
          <div
            className="
              bg-slate-800/50 border border-slate-700/50
              rounded-2xl p-5 flex flex-col gap-3
            "
            data-testid="matchmaking-waiting-panel"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
                Waiting for Players
              </span>
              <span
                className={`
                  text-xs font-semibold px-2.5 py-1 rounded-lg
                  ${wsPlayers.length >= room.player_count
                    ? 'bg-emerald-900/60 text-emerald-300 border border-emerald-700/40'
                    : 'bg-slate-700/60 text-slate-300 border border-slate-600/40'}
                `}
                aria-label={`${wsPlayers.length} of ${room.player_count} players joined`}
                data-testid="matchmaking-player-count"
              >
                {wsPlayers.length}/{room.player_count} joined
              </span>
            </div>

            {wsPlayers.length < room.player_count && (
              <p
                className="text-xs text-slate-400 flex items-center gap-1.5"
                role="note"
                data-testid="matchmaking-auto-start-notice"
              >
                <span aria-hidden="true">⏳</span>
                Game will start automatically when all players arrive or after 30 seconds.
              </p>
            )}

            {wsPlayers.length >= room.player_count && (
              <p
                className="text-xs text-emerald-400 flex items-center gap-1.5"
                role="note"
                data-testid="matchmaking-all-joined-notice"
              >
                <span aria-hidden="true">✅</span>
                All {room.player_count} players have joined — starting now!
              </p>
            )}
          </div>
        )}

        {/* ── "Game is starting" overlay for non-host players ──────────────
            Once the host starts, non-host connected players also see a
            transitioning message before the redirect fires.
            ─────────────────────────────────────────────────────────────── */}
        {lobbyStarting && !amIHostLive && (
          <div
            className="
              bg-emerald-900/30 border border-emerald-700/40
              rounded-2xl p-5 text-center
              flex flex-col items-center gap-3
            "
            role="status"
            data-testid="game-starting-notice"
          >
            <svg
              className="animate-spin h-6 w-6 text-emerald-400"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v8z"
              />
            </svg>
            <p className="text-sm font-semibold text-emerald-300">
              Game is starting…
            </p>
            <p className="text-xs text-slate-400">
              {room.is_matchmaking
                ? 'All players matched — redirecting to the game board.'
                : 'The host has started the game. Redirecting to the game board.'}
            </p>
          </div>
        )}

        {/* ── Back button ──────────────────────────────────────────────────── */}
        <button
          onClick={() => router.push('/')}
          className="
            py-3 rounded-xl font-medium text-sm text-slate-400
            hover:text-white hover:bg-slate-800/50
            border border-transparent hover:border-slate-700
            transition-all duration-150
            focus:outline-none focus:ring-2 focus:ring-emerald-400
          "
        >
          ← Back to Home
        </button>
      </main>
    </div>
  );
}
