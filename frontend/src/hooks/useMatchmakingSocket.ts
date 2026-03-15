'use client';

/**
 * useMatchmakingSocket — React hook for joining and monitoring the matchmaking queue.
 *
 * Connects to the backend WebSocket server at `/ws?token=<bearer>` and handles
 * the matchmaking protocol:
 *
 *   Server → Client messages handled:
 *   ──────────────────────────────────
 *   { type: 'connected',    playerId, displayName }
 *     → Auth confirmed.  If `autoJoinFilter` is set, immediately sends 'join-queue'.
 *
 *   { type: 'queue-joined', filterKey, playerCount, cardRemovalVariant, position, queueSize }
 *     → Confirmed in queue.  Updates status to 'in-queue'.
 *
 *   { type: 'queue-update', filterKey, queueSize }
 *     → Live queue size update (another player joined or left the same group).
 *
 *   { type: 'match-found',  roomCode, playerCount, cardRemovalVariant }
 *     → Match assembled.  Fires `onMatchFound(roomCode)` and closes the socket.
 *
 *   { type: 'queue-left',   filterKey }
 *     → Confirmed departure from queue.  Resets to 'ready' status.
 *
 *   Client → Server messages (via joinQueue / leaveQueue):
 *   ───────────────────────────────────────────────────────
 *   { type: 'join-queue',  playerCount: 6|8, cardRemovalVariant: string }
 *   { type: 'leave-queue' }
 *
 * @param options.sessionId       Backend session ID (null = defer connection).
 * @param options.bearerToken     Auth token for WS handshake (null = defer).
 * @param options.autoJoinFilter  If set, sends 'join-queue' automatically once
 *                                the server sends 'connected'.  Pass null to
 *                                call joinQueue() manually instead.
 * @param options.onMatchFound    Called with the room code when a match is found.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { API_URL } from '@/lib/api';
import type { CardRemovalVariant } from '@/types/room';

// ── Types ─────────────────────────────────────────────────────────────────────

export type MatchmakingStatus =
  | 'idle'          // not connected
  | 'connecting'    // socket connecting or authenticating (waiting for 'connected')
  | 'ready'         // authenticated but not yet in a queue
  | 'in-queue'      // in the matchmaking queue
  | 'match-found'   // match assembled — room code available
  | 'error'         // connection or server error
  | 'disconnected'; // socket closed unexpectedly

export interface MatchmakingFilter {
  playerCount: 6 | 8;
  cardRemovalVariant: CardRemovalVariant;
  inferenceMode: boolean;
}

export interface UseMatchmakingSocketOptions {
  /**
   * Backend session identifier (guest sessionId or Supabase user ID).
   * Pass null to defer the WebSocket connection.
   */
  sessionId: string | null;
  /**
   * Bearer token used as the `?token=` WS query parameter.
   * Pass null to defer the WebSocket connection.
   */
  bearerToken: string | null;
  /**
   * When set, the hook automatically sends `join-queue` once the server
   * confirms authentication (receives the `connected` event).
   * Pass null to call `joinQueue()` manually instead.
   */
  autoJoinFilter?: MatchmakingFilter | null;
  /** Fired once when the server sends `match-found`. */
  onMatchFound?: (roomCode: string) => void;
}

export interface UseMatchmakingSocketResult {
  /** Current matchmaking lifecycle state. */
  status: MatchmakingStatus;
  /** Number of players waiting in the same filter group. Updated live. */
  queueSize: number;
  /** This player's 1-based position in the queue. */
  position: number;
  /** The filter key this player is queued under (null if not in queue). */
  filterKey: string | null;
  /** The room code once a match is found (null otherwise). */
  matchRoomCode: string | null;
  /**
   * Send a `join-queue` message to the server.
   * No-ops if the socket is not OPEN.
   */
  joinQueue: (playerCount: 6 | 8, cardRemovalVariant: CardRemovalVariant, inferenceMode?: boolean) => void;
  /**
   * Send a `leave-queue` message to the server.
   * No-ops if the socket is not OPEN.
   */
  leaveQueue: () => void;
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

export function useMatchmakingSocket({
  sessionId,
  bearerToken,
  autoJoinFilter = null,
  onMatchFound,
}: UseMatchmakingSocketOptions): UseMatchmakingSocketResult {
  const [status, setStatus] = useState<MatchmakingStatus>('idle');
  const [queueSize, setQueueSize] = useState(0);
  const [position, setPosition] = useState(0);
  const [filterKey, setFilterKey] = useState<string | null>(null);
  const [matchRoomCode, setMatchRoomCode] = useState<string | null>(null);

  // Stable ref to live socket so callbacks don't recreate
  const wsRef = useRef<WebSocket | null>(null);

  // Track current status in a ref for use inside cleanup closures
  const statusRef = useRef<MatchmakingStatus>('idle');
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Keep callbacks in refs so they don't trigger the connection effect
  const autoJoinFilterRef = useRef<MatchmakingFilter | null>(autoJoinFilter ?? null);
  useEffect(() => {
    autoJoinFilterRef.current = autoJoinFilter ?? null;
  });

  const onMatchFoundRef = useRef<((roomCode: string) => void) | undefined>(onMatchFound);
  useEffect(() => {
    onMatchFoundRef.current = onMatchFound;
  });

  // ── WebSocket lifecycle ───────────────────────────────────────────────────

  useEffect(() => {
    // Don't connect until we have both identity and token
    if (!sessionId || !bearerToken) {
      setStatus('idle');
      return;
    }

    const wsBase = toWsBase(API_URL);
    const wsUrl = `${wsBase}/ws?token=${encodeURIComponent(bearerToken)}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      setStatus('error');
      return;
    }

    wsRef.current = ws;
    setStatus('connecting');

    // Reset queue state on new connection
    setQueueSize(0);
    setPosition(0);
    setFilterKey(null);
    setMatchRoomCode(null);

    ws.onopen = () => {
      // Wait for the server 'connected' event before acting
      setStatus('connecting');
    };

    ws.onclose = () => {
      wsRef.current = null;
      setStatus((prev) => {
        // Don't overwrite terminal states
        if (prev === 'match-found' || prev === 'idle') return prev;
        return 'disconnected';
      });
    };

    ws.onerror = () => {
      setStatus('error');
    };

    ws.onmessage = (event: MessageEvent) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return; // Non-JSON frame — ignore
      }

      switch (msg.type) {
        // ── Authentication confirmed ─────────────────────────────────────────
        case 'connected': {
          setStatus('ready');
          // Auto-join if a filter was supplied
          const filter = autoJoinFilterRef.current;
          if (filter && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'join-queue',
                playerCount: filter.playerCount,
                cardRemovalVariant: filter.cardRemovalVariant,
                inferenceMode: filter.inferenceMode,
              })
            );
          }
          break;
        }

        // ── Confirmed entry into queue ───────────────────────────────────────
        case 'queue-joined': {
          setStatus('in-queue');
          setFilterKey(msg.filterKey as string);
          setQueueSize(msg.queueSize as number);
          setPosition(msg.position as number);
          break;
        }

        // ── Live queue size update ───────────────────────────────────────────
        case 'queue-update': {
          setQueueSize(msg.queueSize as number);
          break;
        }

        // ── Match assembled — redirect player to the new room ────────────────
        case 'match-found': {
          const code = msg.roomCode as string;
          setMatchRoomCode(code);
          setStatus('match-found');
          // Close socket gracefully — we'll reconnect as part of the room lobby
          ws.close(1000, 'match-found');
          onMatchFoundRef.current?.(code);
          break;
        }

        // ── Confirmed departure from queue ───────────────────────────────────
        case 'queue-left': {
          setStatus('ready');
          setFilterKey(null);
          setQueueSize(0);
          setPosition(0);
          break;
        }

        // ── Ignore all other messages (lobby, room, error, etc.) ─────────────
        default:
          break;
      }
    };

    // Cleanup: gracefully leave queue before unmounting (if still in queue)
    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        if (statusRef.current === 'in-queue') {
          // Tell server to remove us so other players see the updated count
          ws.send(JSON.stringify({ type: 'leave-queue' }));
        }
        ws.close(1000, 'unmount');
      }
      wsRef.current = null;
    };
    // Reconnect only when identity/token changes — intentionally not including
    // autoJoinFilter (handled via ref so it doesn't re-trigger the effect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, bearerToken]);

  // ── Stable action callbacks ───────────────────────────────────────────────

  /**
   * Manually join the matchmaking queue with specific filters.
   * Call after the socket is 'ready' (authenticated).
   */
  const joinQueue = useCallback(
    (playerCount: 6 | 8, cardRemovalVariant: CardRemovalVariant, inferenceMode = true): void => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ type: 'join-queue', playerCount, cardRemovalVariant, inferenceMode })
        );
      }
    },
    []
  );

  /**
   * Leave the matchmaking queue.
   * Call from the "Leave Queue" button.
   */
  const leaveQueue = useCallback((): void => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'leave-queue' }));
    }
  }, []);

  return {
    status,
    queueSize,
    position,
    filterKey,
    matchRoomCode,
    joinQueue,
    leaveQueue,
  };
}
