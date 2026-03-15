/**
 * Literati Socket.io client — singleton.
 *
 * Provides a managed Socket.io connection to the Literati backend.
 * The connection is authenticated by passing the backend bearer token in the
 * Socket.io handshake auth payload: { auth: { token } }.
 *
 * This file is client-only (browser environment). Do NOT import it from
 * Next.js Server Components, API routes, or middleware.
 *
 * Usage:
 *   import { connectSocket, getSocket, disconnectSocket } from '@/lib/socket';
 *
 *   // Connect (idempotent — returns existing socket if already connected)
 *   const socket = connectSocket(bearerToken);
 *
 *   // Listen for the room-created event (fired after POST /api/rooms)
 *   socket.on('room-created', (payload: RoomCreatedPayload) => {
 *     console.log(payload.inviteCode, payload.spectatorLink);
 *   });
 *
 *   // Disconnect when the component unmounts
 *   return () => disconnectSocket();
 *
 * Token sourcing:
 *   - Guests:            pass the token returned by getGuestBearerToken()  (api.ts)
 *   - Registered users:  pass the Supabase access token from useAuth()
 *
 * The socket module itself does not import api.ts / AuthContext to stay
 * dependency-free. The caller is responsible for obtaining a valid token.
 */

import { io, Socket } from 'socket.io-client';
import { API_URL } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Payload delivered by the 'room-created' event.
 * Emitted by the server immediately after POST /api/rooms succeeds.
 */
export interface RoomCreatedPayload {
  /** The full room record returned by the DB insert. */
  room: {
    id: string;
    code: string;
    invite_code: string;
    host_user_id: string;
    player_count: number;
    card_removal_variant: string;
    status: string;
    created_at: string;
    updated_at: string;
  };
  /** The invite_code token from the DB (the long hex token, NOT the 6-char code). */
  inviteCode: string;
  /** Full URL players use to join: `${origin}/room/${code}` */
  inviteLink: string;
  /** Full URL spectators use: `${origin}/room/${code}?spectate=1` */
  spectatorLink: string;
}

// ── Singleton state ───────────────────────────────────────────────────────────

/** The active Socket.io connection, or null when disconnected. */
let _socket: Socket | null = null;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Connect to the Socket.io server (idempotent).
 *
 * If a socket is already connected with the same token it is returned
 * immediately without creating a second connection.
 *
 * If a socket exists but is disconnected it is reconnected in-place.
 *
 * @param token  Bearer token for authentication (guest token or Supabase JWT).
 * @returns      The Socket.io socket instance.
 */
export function connectSocket(token: string): Socket {
  if (_socket) {
    // Update the auth token in case it changed (e.g. after a token refresh).
    _socket.auth = { token };

    if (_socket.disconnected) {
      _socket.connect();
    }
    return _socket;
  }

  _socket = io(API_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
  });

  return _socket;
}

/**
 * Return the current socket instance without creating one.
 * Returns null if no connection has been initiated.
 */
export function getSocket(): Socket | null {
  return _socket;
}

/**
 * Disconnect the socket and clear the singleton.
 * Safe to call even when no socket is active.
 */
export function disconnectSocket(): void {
  if (_socket) {
    _socket.disconnect();
    _socket = null;
  }
}

/**
 * Replace the singleton (for use in tests only).
 * @internal
 */
export function _setSocket(socket: Socket | null): void {
  _socket = socket;
}
