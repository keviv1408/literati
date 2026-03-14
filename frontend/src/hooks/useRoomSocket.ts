'use client';

/**
 * useRoomSocket — WebSocket hook for a single room lobby.
 *
 * Protocol (all messages are JSON):
 *
 *   On connect:   client automatically sends { type: 'join-room', roomCode }
 *
 *   Server → client messages handled:
 *   ─────────────────────────────────
 *   { type: 'connected',     playerId, displayName }
 *     → Server confirms auth. Hook sends 'join-room' immediately after.
 *
 *   { type: 'room-joined',   roomCode, playerId, players: LobbyPlayer[] }
 *     → Populates the full initial player list (including the current user).
 *       Each player has { playerId, displayName, avatarId, isGuest, isHost }.
 *
 *   { type: 'player-joined', roomCode, player: LobbyPlayer }
 *     → Appends the new arrival to the player list.
 *
 *   { type: 'player-kicked', roomCode, playerId, displayName }
 *     → Removes the kicked player from the list (broadcast to observers).
 *
 *   { type: 'you-were-kicked', roomCode }
 *     → Sent only to the kicked client. Sets isKicked=true and fires onKicked.
 *
 *   { type: 'player-left',   roomCode, playerId, displayName }
 *     → Removes the disconnected player from the list.
 *
 *   { type: 'kick-confirmed', roomCode, playerId }
 *     → Sent only to the host after a successful kick (player already removed
 *       from the list by the preceding 'player-kicked' broadcast).
 *
 *   Client → server messages:
 *   ──────────────────────────
 *   { type: 'join-room',   roomCode }          — sent automatically on connect
 *   { type: 'kick-player', roomCode, targetPlayerId }  — via kickPlayer()
 *   (other types via the generic emit() escape-hatch)
 *
 * @param options.roomCode     6-char room code to join.
 * @param options.sessionId    Caller's backend identity (guest sessionId or
 *                             Supabase user id). Pass null to skip connecting.
 * @param options.bearerToken  Auth token passed as ?token= query param.
 *                             Pass null to skip connecting (server will reject).
 * @param options.onKicked     Optional callback fired once when the server
 *                             sends 'you-were-kicked' to this client.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { addKickedRoom } from '@/lib/kickedRooms';
import { API_URL } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single player as broadcast by the server in lobby state messages.
 *
 * `teamId` is present in `room_players` snapshots sent by the room WS server
 * (/ws/room/<CODE>).  It is optional so existing callers that still receive
 * the older `room-joined` / `player-joined` incremental events (from the
 * legacy /ws server) continue to compile without changes.
 *
 * `isBot` is populated in `lobby-starting` / `game_starting` snapshots (where
 * bots appear for the first time) and in `room_players` broadcasts from the
 * room WS server when bot seats are included (e.g. after a timer fill).
 */
export interface LobbyPlayer {
  playerId: string;
  displayName: string;
  avatarId: string | null;
  isGuest: boolean;
  /** True for the room creator (host_user_id in Supabase). */
  isHost: boolean;
  /** Team assignment: 1 or 2.  Present in room_players snapshots. */
  teamId?: 1 | 2;
  /** True when this player is an AI bot (present in lobby-starting seats). */
  isBot?: boolean;
}

export type WsStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

/**
 * Lobby countdown timer state broadcast by the server when the first player
 * joins a room.  The timer fires after 2 minutes; if all seats fill before
 * then, the timer is cancelled and the game starts immediately.
 */
export interface LobbyTimerState {
  /** Unix epoch ms when the 2-minute fill timer will fire. */
  expiresAt: number;
}

export interface UseRoomSocketOptions {
  /** 6-character room code. */
  roomCode: string | null;
  /**
   * Caller's backend session identifier:
   *   - guest:      the sessionId returned by POST /api/auth/guest
   *   - registered: the Supabase user UUID from session.user.id
   *
   * Pass null while the session is still loading; the hook will not connect
   * until a non-null value is provided.
   */
  sessionId: string | null;
  /**
   * Bearer token to authenticate the WebSocket connection (passed as ?token=).
   *   - guest:      opaque token from getGuestBearerToken()
   *   - registered: session.access_token from Supabase
   *
   * Pass null to defer connection.
   */
  bearerToken?: string | null;
  /** Fired once if/when the server sends 'you-were-kicked' to this client. */
  onKicked?: (reason: string) => void;
}

/**
 * Payload emitted when host authority transfers to a new player.
 * Broadcast by the server as `{ type: 'host_changed', newHostId, newHostName }`.
 */
export interface HostChangedEvent {
  /** userId of the player who became the new host. */
  newHostId: string;
  /** Display name of the new host (for showing a notification). */
  newHostName: string;
}

export interface UseRoomSocketResult {
  /** Current WebSocket lifecycle state. */
  wsStatus: WsStatus;
  /**
   * Live player list as maintained by the server.
   * Populated from the 'room-joined' snapshot, then updated via 'player-joined',
   * 'player-kicked', and 'player-left' events.
   */
  players: LobbyPlayer[];
  /**
   * This client's server-assigned playerId (from the 'connected' event).
   * Null until the WebSocket handshake completes. Use this to identify the
   * current user's entry in `players` and determine whether they are the host:
   *
   *   const myPlayer = players.find(p => p.playerId === myPlayerId);
   *   const amIHost  = myPlayer?.isHost ?? false;
   */
  myPlayerId: string | null;
  /** True once 'you-were-kicked' is received for this client. */
  isKicked: boolean;
  /** Reason string from the 'you-were-kicked' message, if any. */
  kickReason: string | null;
  /**
   * Most recent host-authority-transfer notification, or null if no transfer
   * has occurred this session.  Populated when the server broadcasts
   * `{ type: 'host_changed' }` after the original host's grace window expires.
   * The `room_players` snapshot that follows this message will carry the updated
   * `isHost` flags, so callers may also derive host status directly from `players`.
   */
  hostChangedEvent: HostChangedEvent | null;
  /**
   * Emit a 'kick-player' event for the given targetPlayerId.
   * Server enforces that only the host may kick; non-hosts receive an error.
   * No-ops silently when the socket is not OPEN.
   *
   * @param targetPlayerId  The playerId of the player to kick.
   */
  kickPlayer: (targetPlayerId: string) => void;
  /**
   * Request a team switch for the current player.
   * Sends `{ type: 'change_team', teamId }` to the room WS server.
   * The server enforces capacity limits and broadcasts the updated
   * `room_players` snapshot to ALL connected clients on success.
   * No-ops silently when the socket is not OPEN.
   *
   * @param teamId  1 or 2 — the team to switch to.
   */
  changeTeam: (teamId: 1 | 2) => void;
  /**
   * Generic escape-hatch: send any JSON event to the server.
   * No-ops silently when the socket is not OPEN.
   */
  emit: (type: string, payload?: unknown) => void;
  /**
   * Request the server to start the game immediately.
   * Only accepted by the server when the caller is the room host.
   * The server fills any empty seats with bots, updates the room status to
   * 'in_progress', and broadcasts 'lobby-starting' to all connected clients.
   * No-ops silently when the socket is not OPEN.
   */
  startGame: () => void;
  /**
   * Countdown timer state set when the server broadcasts 'lobby-timer-started'.
   * Null until the first player joins; cleared when the game starts.
   * Use `expiresAt` to drive a countdown UI (e.g. 2:00 → 0:00).
   */
  lobbyTimer: LobbyTimerState | null;
  /**
   * True once the server broadcasts 'lobby-starting', indicating the game
   * is transitioning from the lobby to the in-progress state.
   * Callers can navigate to the game board when this becomes true.
   */
  lobbyStarting: boolean;
  /**
   * Last error message received from the server (non-fatal { type: 'error' }
   * messages).  Useful for surfacing validation errors from host commands.
   * Cleared when a new WebSocket connection is opened.
   */
  lastError: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert an HTTP(S) base URL to a WS(S) base URL.
 *   "http://localhost:3001"  → "ws://localhost:3001"
 *   "https://api.example.com" → "wss://api.example.com"
 */
function toWsBase(httpUrl: string): string {
  return httpUrl.replace(/^https?/, (proto) =>
    proto === 'https' ? 'wss' : 'ws'
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useRoomSocket({
  roomCode,
  sessionId,
  bearerToken = null,
  onKicked,
}: UseRoomSocketOptions): UseRoomSocketResult {
  const [wsStatus, setWsStatus] = useState<WsStatus>('idle');
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);
  const [isKicked, setIsKicked] = useState(false);
  const [kickReason, setKickReason] = useState<string | null>(null);
  const [lobbyTimer, setLobbyTimer] = useState<LobbyTimerState | null>(null);
  const [lobbyStarting, setLobbyStarting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [hostChangedEvent, setHostChangedEvent] = useState<HostChangedEvent | null>(null);

  // Stable ref to the live WebSocket so emit/kickPlayer don't need re-creation.
  const wsRef = useRef<WebSocket | null>(null);

  // Stable ref to roomCode used inside the 'connected' handler to send join-room.
  const roomCodeRef = useRef<string | null>(roomCode);
  useEffect(() => {
    roomCodeRef.current = roomCode;
  });

  // Stable ref for onKicked so we don't re-open the socket on every re-render.
  const onKickedRef = useRef<((reason: string) => void) | undefined>(onKicked);
  useEffect(() => {
    onKickedRef.current = onKicked;
  });

  useEffect(() => {
    // Don't connect until we have both a room code and a session ID.
    if (!roomCode || !sessionId) {
      setWsStatus('idle');
      return;
    }

    // Build WebSocket URL.
    // The room WS server listens at /ws/room/<ROOMCODE>; the room code is
    // embedded in the path so the server can route without a join message.
    // Authentication is passed as a ?token= query parameter (browser WS API
    // does not support custom headers).
    const wsBase = toWsBase(API_URL);
    const tokenParam = bearerToken ? `?token=${encodeURIComponent(bearerToken)}` : '';
    const wsUrl = `${wsBase}/ws/room/${roomCode.toUpperCase()}${tokenParam}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      // WebSocket constructor can throw synchronously in some environments.
      setWsStatus('error');
      return;
    }

    wsRef.current = ws;
    setWsStatus('connecting');

    // Reset lobby state on new connection attempt.
    setPlayers([]);
    setMyPlayerId(null);
    setIsKicked(false);
    setKickReason(null);
    setLobbyTimer(null);
    setLobbyStarting(false);
    setLastError(null);
    setHostChangedEvent(null);

    ws.onopen = () => {
      setWsStatus('connected');
      // Server sends 'connected' first; we send 'join-room' in response (see onmessage).
    };

    ws.onclose = () => {
      wsRef.current = null;
      setWsStatus((prev) => (prev === 'error' ? 'error' : 'disconnected'));
    };

    ws.onerror = () => {
      setWsStatus('error');
    };

    ws.onmessage = (event: MessageEvent) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return; // Non-JSON frame — ignore.
      }

      switch (msg.type) {
        // ── Auth confirmed — record our server identity ──────────────────────
        // The room WS server (/ws/room/<CODE>) sends `{ type: 'connected', userId }`
        // while the legacy lobby server sends `{ type: 'connected', playerId }`.
        // Accept either field so the hook works with both servers.
        case 'connected': {
          const serverPlayerId =
            (msg.userId as string | undefined) ??
            (msg.playerId as string | undefined);
          if (serverPlayerId) {
            setMyPlayerId(serverPlayerId);
          }
          // The room WS server joins the player automatically on connection;
          // still send join-room so the legacy /ws server path also works.
          const code = roomCodeRef.current;
          if (code && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'join-room', roomCode: code.toUpperCase() }));
          }
          break;
        }

        // ── Full lobby snapshot on successful join ───────────────────────────
        case 'room-joined': {
          const rawPlayers = msg.players;
          if (Array.isArray(rawPlayers)) {
            setPlayers(rawPlayers as LobbyPlayer[]);
          }
          break;
        }

        // ── Incremental: new player arrived ─────────────────────────────────
        case 'player-joined': {
          const newPlayer = msg.player as LobbyPlayer | undefined;
          if (newPlayer) {
            setPlayers((prev) => {
              // Guard against duplicate entries (e.g. reconnect race).
              if (prev.some((p) => p.playerId === newPlayer.playerId)) {
                return prev;
              }
              return [...prev, newPlayer];
            });
          }
          break;
        }

        // ── Incremental: player was kicked (broadcast to observers) ──────────
        case 'player-kicked': {
          const kickedId = msg.playerId as string | undefined;
          if (kickedId) {
            setPlayers((prev) => prev.filter((p) => p.playerId !== kickedId));
          }
          break;
        }

        // ── You personally were kicked ───────────────────────────────────────
        case 'you-were-kicked': {
          const reason =
            'You have been removed from this room by the host.';
          if (roomCode) addKickedRoom(roomCode);
          setIsKicked(true);
          setKickReason(reason);
          ws.close(1000, 'kicked');
          onKickedRef.current?.(reason);
          break;
        }

        // ── Incremental: player disconnected voluntarily ─────────────────────
        case 'player-left': {
          const leftId = msg.playerId as string | undefined;
          if (leftId) {
            setPlayers((prev) => prev.filter((p) => p.playerId !== leftId));
          }
          break;
        }

        // ── Full roster snapshot (room WS server, /ws/room/<CODE>) ──────────
        // Sent by the server after every state change: join, leave, kick, or
        // team reassignment.  Replaces the entire player list atomically so
        // all clients converge to the same state without incremental merging.
        case 'room_players': {
          const rawPlayers = msg.players;
          if (Array.isArray(rawPlayers)) {
            setPlayers(rawPlayers as LobbyPlayer[]);
          }
          break;
        }

        // ── Lobby fill timer started ──────────────────────────────────────
        // Broadcast when the first human player joins a room lobby.
        // `expiresAt` is epoch-ms; use (expiresAt - Date.now()) for countdown.
        case 'lobby-timer-started': {
          const expiresAt = msg.expiresAt as number | undefined;
          if (typeof expiresAt === 'number' && expiresAt > 0) {
            setLobbyTimer({ expiresAt });
          }
          break;
        }

        // ── Lobby / game transitioning to active gameplay ─────────────────
        // Both event types signal that the room has transitioned from "waiting"
        // to "starting" and all clients should navigate to the game board.
        //
        //   'lobby-starting' — sent by:
        //     • roomSocketServer.js (/ws/room/<CODE>) when the host fires
        //       start_game (Sub-AC 5.4).
        //     • wsServer.js (/ws) when the lobby fill timer fires or the
        //       room reaches capacity.
        //
        //   'game_starting' — forward-compatible alias (same semantics).
        //
        // Payload: { seats: LobbySeat[], botsAdded: string[], roomCode: string }
        case 'lobby-starting':
        // eslint-disable-next-line no-fallthrough
        case 'game_starting': {
          setLobbyStarting(true);
          setLobbyTimer(null); // timer no longer relevant
          // Update player list with final seats (includes bots).
          // `isBot` must be mapped here so bot seats render BotBadge indicators
          // in the brief pre-navigation lobby snapshot (Sub-AC 6.3).
          const seats = msg.seats;
          if (Array.isArray(seats)) {
            setPlayers(
              seats.map((s: Record<string, unknown>) => ({
                playerId:    s.playerId    as string,
                displayName: s.displayName as string,
                avatarId:    (s.avatarId   as string | null) ?? null,
                isGuest:     (s.isGuest    as boolean) ?? false,
                isHost:      (s.isHost     as boolean) ?? false,
                teamId:      s.teamId      as 1 | 2 | undefined,
                isBot:       (s.isBot      as boolean) ?? false,
              }))
            );
          }
          break;
        }

        // ── Server-sent non-fatal error ───────────────────────────────────────
        // e.g. "Only the host can start the game", "Team X is full", etc.
        case 'error': {
          const errMessage = msg.message as string | undefined;
          if (typeof errMessage === 'string') {
            setLastError(errMessage);
          }
          break;
        }

        // ── Host authority transferred ────────────────────────────────────────
        // Sent by the server when the original host's 30-second grace window
        // expires without a reconnect and a new player has been promoted.
        // The server immediately follows this message with a `room_players`
        // snapshot carrying the updated `isHost` flags — callers relying on
        // the live player list don't need to do anything beyond re-deriving
        // `amIHost` from the updated `players` array.
        // `hostChangedEvent` is exposed so callers can show a toast/banner.
        case 'host_changed': {
          const newHostId   = msg.newHostId   as string | undefined;
          const newHostName = msg.newHostName as string | undefined;
          if (newHostId && newHostName) {
            setHostChangedEvent({ newHostId, newHostName });
          }
          break;
        }

        // ── kick-confirmed, team-reassigned, etc. — ignored here ─────────────
        default:
          break;
      }
    };

    // Teardown: close the socket when the hook unmounts or deps change.
    return () => {
      ws.close(1000, 'unmount');
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, sessionId, bearerToken]);

  // ── Stable callbacks ────────────────────────────────────────────────────────

  /**
   * Emit a 'kick-player' event to the server.
   * Only works when the socket is open; server enforces host-only authorization.
   */
  const kickPlayer = useCallback(
    (targetPlayerId: string): void => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && roomCode) {
        ws.send(
          JSON.stringify({
            type: 'kick-player',
            roomCode: roomCode.toUpperCase(),
            targetPlayerId,
          })
        );
      }
    },
    [roomCode]
  );

  /**
   * Generic escape-hatch for sending any JSON event to the server.
   * Silently no-ops when the socket is not OPEN.
   */
  const emit = useCallback((type: string, payload?: unknown): void => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, ...(payload !== undefined ? { payload } : {}) }));
    }
  }, []);

  /**
   * Request a team switch for the current player.
   * Sends `{ type: 'change_team', teamId }` directly (no payload wrapper) so
   * the room WS server can read `message.teamId` without unwrapping.
   * The server enforces capacity limits and broadcasts room_players on success.
   */
  const changeTeam = useCallback((teamId: 1 | 2): void => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'change_team', teamId }));
    }
  }, []);

  /**
   * Ask the server to start the game immediately.
   * The server validates host authority, fills empty seats with bots,
   * transitions room status to 'in_progress', and broadcasts 'lobby-starting'
   * with the final seat list to all connected clients.
   * No-ops silently when the socket is not OPEN.
   */
  const startGame = useCallback((): void => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'start_game' }));
    }
  }, []);

  return {
    wsStatus,
    players,
    myPlayerId,
    isKicked,
    kickReason,
    kickPlayer,
    changeTeam,
    emit,
    startGame,
    lobbyTimer,
    lobbyStarting,
    lastError,
    hostChangedEvent,
  };
}
