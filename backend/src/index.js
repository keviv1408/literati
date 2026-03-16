require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const roomsRouter = require('./routes/rooms');
const voiceRouter = require('./routes/voice');
const authRouter = require('./routes/auth');
const matchmakingRouter = require('./routes/matchmaking');
const liveGamesRouter = require('./routes/liveGames');
const { startCleanupTimer, stopCleanupTimer } = require('./sessions/guestSessionStore');
const {
  startQueueCleanupTimer,
  stopQueueCleanupTimer,
} = require('./matchmaking/matchmakingQueue');
const { createWsServer } = require('./ws/wsServer');
const { attachRoomSocketServer } = require('./ws/roomSocketServer');
const { attachGameSocketServer } = require('./game/gameSocketServer');
const { attachLiveGamesSocketServer } = require('./ws/liveGamesSocketServer');
const { initSocket } = require('./socket/server');
const { markStaleGamesAbandoned } = require('./game/gameState');
const { getSupabaseClient } = require('./db/supabase');

const app = express();
const PORT = process.env.PORT || 3012;

// ── CORS (must be before helmet so preflight OPTIONS get headers) ─────────────
app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:3011',
      'http://localhost:3011',
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

// ── Security middleware ────────────────────────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// ── General rate limiting ──────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  skip: () => process.env.NODE_ENV === 'development',
});
app.use(generalLimiter);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/rooms', roomsRouter);
app.use('/api/rooms', voiceRouter);
app.use('/api/matchmaking', matchmakingRouter);
app.use('/api/live-games', liveGamesRouter);

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start server ───────────────────────────────────────────────────────────────
if (require.main === module) {
  // Start the guest-session cleanup timer before accepting connections.
  startCleanupTimer();

  // Start the matchmaking queue cleanup timer.
  startQueueCleanupTimer();

  // Create a plain Node.js HTTP server so the WebSocket server can share
  // the same port via the 'upgrade' event.
  const httpServer = http.createServer(app);

  // Attach the game WebSocket server FIRST (path-based: /ws/game/<CODE>).
  // Handles all active gameplay messages.
  attachGameSocketServer(httpServer);

  // Attach the room WebSocket server (path-based: /ws/room/<CODE>).
  // It handles the upgrade event for matching paths and lets non-matching
  // paths fall through to the next handler.
  attachRoomSocketServer(httpServer);

  // Attach the live games WebSocket server (path: /ws/live-games).
  // Public, read-only feed of all active matchmaking games.
  attachLiveGamesSocketServer(httpServer);

  // Attach the legacy lobby WebSocket server (catch-all: /ws).
  // Registered AFTER roomSocketServer so it only sees connections that the
  // path-based handler did not claim.
  createWsServer(httpServer);

  // Attach the Socket.io server (room-created, future real-time room events).
  initSocket(httpServer);

  httpServer.listen(PORT, () => {
    console.log(`Literati backend listening on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log('WebSocket (ws) and Socket.io servers active on the same port');

    // AC 52: On startup, sweep any rooms left in 'in_progress' from a previous
    // server instance (crash / restart) and mark them 'abandoned' in Supabase.
    // Only rooms idle for ≥ 2 hours are touched — fresher rooms may have
    // players who are still in their 60-second reconnect window.
    markStaleGamesAbandoned(getSupabaseClient()).catch((err) => {
      console.error('[startup] markStaleGamesAbandoned failed:', err.message);
    });
  });

  // Graceful shutdown: stop the cleanup timer and close the HTTP server.
  const shutdown = () => {
    console.log('Shutting down...');
    stopCleanupTimer();
    stopQueueCleanupTimer();
    httpServer.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;
