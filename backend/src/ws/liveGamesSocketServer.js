'use strict';

/**
 * Live Games WebSocket server — /ws/live-games
 *
 * Exposes a real-time feed of all active matchmaking games.
 * No authentication required — this is a public, read-only channel
 * intended for the Live Games browsing page and spectators.
 *
 * Connection URL:
 *   ws(s)://host/ws/live-games
 *
 * Protocol (Server → Client only; clients do not send messages):
 *
 *   { type: 'live_games_init', games: LiveGame[] }
 *     Sent immediately after a client connects.
 *     Contains the current snapshot of all active games with computed elapsedMs.
 *
 *   { type: 'live_game_added', game: LiveGame }
 *     A new matchmaking game has been registered (room created).
 *
 *   { type: 'live_game_updated', game: LiveGame }
 *     An existing game's metadata changed (player count, scores, status, etc.).
 *
 *   { type: 'live_game_removed', roomCode: string }
 *     A game has ended (completed or cancelled) and is no longer listed.
 *
 * LiveGame shape (same as liveGamesStore, plus computed elapsedMs):
 * {
 *   roomCode:       string,
 *   playerCount:    number,
 *   currentPlayers: number,
 *   cardVariant:    string,
 *   scores:         { team1: number, team2: number },
 *   status:         'waiting' | 'in_progress',
 *   createdAt:      number,
 *   startedAt:      number | null,
 *   elapsedMs:      number,   — computed at send time
 * }
 */

const { WebSocketServer, WebSocket } = require('ws');
const url = require('url');
const liveGamesStore = require('../liveGames/liveGamesStore');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send a JSON-serialised payload to a single WebSocket, suppressing any
 * errors that arise if the socket has since closed.
 *
 * @param {WebSocket} ws
 * @param {Object} data
 */
function sendJson(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      // Socket closed between the readyState check and send — ignore.
    }
  }
}

/**
 * Augment a raw LiveGame object with the computed `elapsedMs` field.
 * @param {Object} game
 * @returns {Object}
 */
function withElapsed(game) {
  const now = Date.now();
  return {
    ...game,
    elapsedMs: now - (game.startedAt ?? game.createdAt),
  };
}

// ---------------------------------------------------------------------------
// WebSocket server factory
// ---------------------------------------------------------------------------

/**
 * Attach the live-games WebSocket server to an existing HTTP server.
 *
 * Path: `/ws/live-games`
 * Uses the HTTP `upgrade` event for path-based routing — matching connections
 * are handled here; everything else is passed to the next registered handler.
 *
 * @param {import('http').Server} httpServer
 * @returns {WebSocketServer}
 */
function attachLiveGamesSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  // ── Route upgrade requests to this server ─────────────────────────────────
  httpServer.on('upgrade', (req, socket, head) => {
    const parsed = url.parse(req.url || '', true);

    // Only claim connections to /ws/live-games
    if (parsed.pathname !== '/ws/live-games') {
      return; // Let the next upgrade handler deal with it.
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  // ── Handle each client connection ──────────────────────────────────────────
  wss.on('connection', (ws) => {
    // Immediately send the current snapshot.
    sendJson(ws, {
      type:  'live_games_init',
      games: liveGamesStore.getAll(),
    });

    // The client is read-only — we don't process incoming messages, but we
    // install a minimal message handler to absorb any ping/keepalive bytes
    // that some browser WebSocket implementations send automatically.
    ws.on('message', () => {
      // Intentionally no-op: this endpoint is server-push only.
    });

    ws.on('error', (err) => {
      console.error('[live-games-ws] socket error:', err.message);
    });
  });

  // ── Forward liveGamesStore events to all connected clients ─────────────────

  liveGamesStore.on('game_added', (game) => {
    const payload = JSON.stringify({ type: 'live_game_added', game: withElapsed(game) });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(payload); } catch (_) { /* ignore closed sockets */ }
      }
    }
  });

  liveGamesStore.on('game_updated', (game) => {
    const payload = JSON.stringify({ type: 'live_game_updated', game: withElapsed(game) });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(payload); } catch (_) { /* ignore closed sockets */ }
      }
    }
  });

  liveGamesStore.on('game_removed', ({ roomCode }) => {
    const payload = JSON.stringify({ type: 'live_game_removed', roomCode });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(payload); } catch (_) { /* ignore closed sockets */ }
      }
    }
  });

  return wss;
}

module.exports = { attachLiveGamesSocketServer };
