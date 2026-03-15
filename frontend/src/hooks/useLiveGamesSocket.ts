/**
 * useLiveGamesSocket
 *
 * Subscribes to the /ws/live-games WebSocket feed and returns a real-time
 * list of active games.  Falls back to REST polling when the WebSocket
 * connection fails or is unavailable.
 *
 * WebSocket message types (server → client):
 *
 *   { type: 'live_games_init',    games: LiveGame[] }
 *     Full snapshot sent immediately on connection.
 *
 *   { type: 'live_game_added',    game: LiveGame }
 *     A new game became active — insert it into the local list.
 *
 *   { type: 'live_game_updated',  game: LiveGame }
 *     An existing game has new data (scores, status, etc.) — merge by roomCode.
 *
 *   { type: 'live_game_removed',  roomCode: string }
 *     A game completed or was cancelled — remove it from the local list.
 */

'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { getLiveGames, type LiveGame, API_URL } from '@/lib/api';

/** How long to wait before attempting a WebSocket reconnect (ms). */
const RECONNECT_DELAY_MS = 3_000;

/** Polling interval used when WebSocket is unavailable (ms). */
const POLL_INTERVAL_MS = 15_000;

/** Derive a WebSocket base URL from the HTTP API base URL. */
function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws');
}

export interface UseLiveGamesSocketResult {
  /** Current list of active games (real-time). */
  games: LiveGame[];
  /** True when the WebSocket connection is open. */
  isConnected: boolean;
  /** Non-null when the WebSocket is unavailable and the page has fallen back to polling. */
  isFallback: boolean;
  /** Error message if the most recent connection attempt failed. */
  error: string | null;
}

/**
 * Hook that subscribes to the /ws/live-games WebSocket feed.
 * Automatically reconnects on disconnect and falls back to REST polling
 * if WebSocket is unavailable (e.g. in test environments).
 */
export function useLiveGamesSocket(): UseLiveGamesSocketResult {
  const [games, setGames] = useState<LiveGame[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isFallback, setIsFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  const failCountRef = useRef(0);

  // ── REST fallback polling ────────────────────────────────────────────────

  const fetchGames = useCallback(async () => {
    try {
      const res = await getLiveGames();
      if (mountedRef.current) {
        setGames(res.games);
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError('Failed to load live games.');
      }
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return; // already polling
    setIsFallback(true);
    fetchGames();
    pollTimerRef.current = setInterval(fetchGames, POLL_INTERVAL_MS);
  }, [fetchGames]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setIsFallback(false);
  }, []);

  // ── WebSocket connection ─────────────────────────────────────────────────

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    // Close any stale socket before opening a new one
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    const wsUrl = `${toWsUrl(API_URL)}/ws/live-games`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      // WebSocket constructor can throw in test environments
      failCountRef.current++;
      if (failCountRef.current >= 2) startPolling();
      return;
    }

    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      failCountRef.current = 0;
      setIsConnected(true);
      setError(null);
      stopPolling(); // stop REST fallback if it was running
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;
        switch (msg.type) {
          case 'live_games_init': {
            setGames((msg.games as LiveGame[]) ?? []);
            break;
          }
          case 'live_game_added': {
            const incoming = msg.game as LiveGame;
            setGames((prev) => {
              // Deduplicate: don't add if roomCode already in list
              if (prev.some((g) => g.roomCode === incoming.roomCode)) {
                return prev;
              }
              return [...prev, incoming];
            });
            break;
          }
          case 'live_game_updated': {
            const updated = msg.game as LiveGame;
            setGames((prev) =>
              prev.map((g) => (g.roomCode === updated.roomCode ? updated : g))
            );
            break;
          }
          case 'live_game_removed': {
            const removedCode = msg.roomCode as string;
            setGames((prev) => prev.filter((g) => g.roomCode !== removedCode));
            break;
          }
          default:
            break;
        }
      } catch {
        // Malformed JSON — ignore
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setIsConnected(false);
      wsRef.current = null;

      failCountRef.current++;
      if (failCountRef.current >= 3) {
        // After 3 consecutive failures, start REST polling as fallback
        startPolling();
        // Keep retrying WebSocket in background (less aggressively)
        reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS * 5);
      } else {
        reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setError('Live games connection interrupted. Reconnecting…');
      // onclose will fire after onerror and handle reconnect
    };
  }, [startPolling, stopPolling]);

  // ── Mount / unmount ──────────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return { games, isConnected, isFallback, error };
}
