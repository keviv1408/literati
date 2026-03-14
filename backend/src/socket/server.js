'use strict';

/**
 * Socket.io server — singleton.
 *
 * Provides real-time bidirectional communication for:
 *  • Room lifecycle events  (room-created, player-joined, room-status-changed)
 *  • Game state events      (coming in future sub-ACs)
 *
 * Authentication:
 *   Every socket connection MUST present a valid bearer token in the handshake:
 *     { auth: { token: "<bearer>" } }
 *   The same two-stage token resolution used by the HTTP auth middleware is applied:
 *     1. In-memory guest session store (fast, no DB).
 *     2. Supabase JWT verification for registered users.
 *   Connections that fail to authenticate are rejected with an "Unauthorized" error.
 *
 * Connected-users map:
 *   A Map<userId, socketId> is maintained so that REST handlers (e.g. POST /api/rooms)
 *   can push targeted events to specific users without needing a socket reference at
 *   the call site.
 *
 * Usage:
 *   // At startup
 *   const httpServer = http.createServer(app);
 *   initSocket(httpServer);
 *   httpServer.listen(PORT);
 *
 *   // In a REST handler, after room creation:
 *   const { getIO, getConnectedUsers } = require('./socket/server');
 *   const io = getIO();
 *   const socketId = getConnectedUsers().get(hostUserId);
 *   if (io && socketId) io.to(socketId).emit('room-created', payload);
 */

const { Server } = require('socket.io');
const { getGuestSession } = require('../sessions/guestSessionStore');
const { getSupabaseClient } = require('../db/supabase');

// ── Singleton state ───────────────────────────────────────────────────────────

/** @type {import('socket.io').Server|null} */
let _io = null;

/**
 * Map: canonical userId → socket.id
 *
 * For registered users  userId = Supabase user UUID.
 * For guests            userId = guestSession.sessionId  (a UUID).
 *
 * Maintained across connects/disconnects so that HTTP handlers can always
 * resolve the current socket for a given identity.
 */
const _connectedUsers = new Map();

// ── Token resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a raw bearer token to a normalised user identity object.
 *
 * Mirrors the core logic of resolveUser() in middleware/auth.js but accepts
 * a plain token string so it can be used outside the Express request cycle
 * (e.g. Socket.io handshake middleware).
 *
 * Both guest and registered user tokens are supported.
 *
 * @param {string|undefined} token
 * @returns {Promise<{id: string, displayName: string, avatarId: string|null, isGuest: boolean, _noDbWrites: boolean}|null>}
 */
async function resolveTokenDirect(token) {
  if (!token || typeof token !== 'string' || token.length === 0) return null;

  // ── 1. Guest session (in-memory, no DB) ────────────────────────────────────
  const guestSession = getGuestSession(token);
  if (guestSession) {
    return {
      // Use sessionId as the canonical ID for guests (same UUID used everywhere).
      id: guestSession.sessionId,
      sessionId: guestSession.sessionId,
      displayName: guestSession.displayName,
      avatarId: guestSession.avatarId,
      isGuest: true,
      _noDbWrites: true,
    };
  }

  // ── 2. Supabase JWT verification ────────────────────────────────────────────
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) return null;

    const { user } = data;
    return {
      id: user.id,
      email: user.email,
      displayName: user.user_metadata?.display_name || user.email,
      avatarId: user.user_metadata?.avatar_id || null,
      isGuest: false,
      _noDbWrites: false,
    };
  } catch {
    // Supabase not configured (e.g. unit tests without env vars) — reject silently.
    return null;
  }
}

// ── Socket.io initialisation ─────────────────────────────────────────────────

/**
 * Attach a Socket.io server to an existing HTTP server and wire up
 * authentication and connection lifecycle handlers.
 *
 * Call this ONCE at application startup, before httpServer.listen().
 *
 * @param {import('http').Server} httpServer
 * @param {{ corsOrigins?: string[] }} [options]
 * @returns {import('socket.io').Server}
 */
function initSocket(httpServer, options = {}) {
  const corsOrigins = options.corsOrigins ?? [
    process.env.FRONTEND_URL || 'http://localhost:3000',
  ];

  _io = new Server(httpServer, {
    cors: {
      origin: corsOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    // Prefer WebSocket transport; fall back to polling only if needed.
    transports: ['websocket', 'polling'],
  });

  // ── Authentication middleware ────────────────────────────────────────────────
  // Every connection must provide a valid bearer token before being admitted.
  _io.use(async (socket, next) => {
    try {
      // Accept token from either socket.handshake.auth.token (preferred)
      // or Authorization header (for clients that send standard HTTP headers).
      const authToken = socket.handshake.auth?.token;
      const headerAuth = socket.handshake.headers?.authorization;
      const token =
        authToken ||
        (typeof headerAuth === 'string' && headerAuth.startsWith('Bearer ')
          ? headerAuth.slice(7).trim()
          : undefined);

      const user = await resolveTokenDirect(token);
      if (!user) {
        return next(new Error('Unauthorized'));
      }

      // Attach the resolved identity so connection handlers can use it.
      socket.data.user = user;
      next();
    } catch (err) {
      next(new Error('Authentication error'));
    }
  });

  // ── Connection lifecycle ─────────────────────────────────────────────────────
  _io.on('connection', (socket) => {
    const userId = socket.data.user.id;

    // Register this socket as the current live connection for this user.
    _connectedUsers.set(userId, socket.id);

    socket.on('disconnect', () => {
      // Only remove the mapping if this socket is still the registered one
      // (a re-connection from the same user may have already replaced it).
      if (_connectedUsers.get(userId) === socket.id) {
        _connectedUsers.delete(userId);
      }
    });
  });

  return _io;
}

// ── Accessors ─────────────────────────────────────────────────────────────────

/** @returns {import('socket.io').Server|null} */
function getIO() {
  return _io;
}

/**
 * @returns {Map<string, string>}  userId → socket.id
 */
function getConnectedUsers() {
  return _connectedUsers;
}

// ── Test helpers (NOT for production use) ────────────────────────────────────

/**
 * Tear down the singleton completely.
 * Used in tests to restore a clean state between suites.
 */
function _resetSocket() {
  if (_io) {
    _io.close();
  }
  _io = null;
  _connectedUsers.clear();
}

/**
 * Directly inject an IO instance (e.g. a mock).
 * Used in unit tests that do NOT want a real socket server.
 *
 * @param {import('socket.io').Server|null} io
 */
function _setIO(io) {
  _io = io;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  initSocket,
  getIO,
  getConnectedUsers,
  resolveTokenDirect,
  _resetSocket,
  _setIO,
};
