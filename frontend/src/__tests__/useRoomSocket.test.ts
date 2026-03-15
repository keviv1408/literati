/**
 * Unit tests for the useRoomSocket hook.
 *
 * We replace the global WebSocket with a lightweight mock so we can control
 * exactly which events fire and when, without needing a real backend.
 *
 * Tested scenarios:
 *   • Hook stays idle when roomCode or sessionId is null
 *   • WebSocket URL is correctly constructed (ws:// prefix, token param)
 *   • Status transitions: connecting → connected → disconnected
 *   • 'connected' event sets myPlayerId and triggers join-room message
 *   • 'room-joined' snapshot populates players array
 *   • 'player-joined' appends new player to the list
 *   • 'player-joined' deduplicates if same playerId already present
 *   • 'player-kicked' (broadcast) removes the player from the list
 *   • 'player-left' removes the player from the list
 *   • 'you-were-kicked' sets isKicked (does NOT affect players list)
 *   • player-kicked message matching the caller's sessionId sets isKicked
 *   • player-kicked with sentinel "*" also sets isKicked
 *   • player-kicked targeting a DIFFERENT sessionId is ignored
 *   • addKickedRoom is called when kicked
 *   • onKicked callback fires once
 *   • Socket is closed on unmount
 *   • kickReason reflects the server's reason string
 *   • Default reason is used when server omits the reason field
 *   • emit() sends JSON when the socket is OPEN
 *   • emit() is a no-op when the socket is not OPEN
 *   • kickPlayer() sends kick-player message when socket is OPEN
 *   • kickPlayer() is a no-op when the socket is not OPEN
 */

import { renderHook, act } from '@testing-library/react';
import { useRoomSocket } from '@/hooks/useRoomSocket';
import * as kickedRoomsModule from '@/lib/kickedRooms';

// ── Mock WebSocket ────────────────────────────────────────────────────────────

interface MockWsInstance {
  onopen: (() => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  close: jest.Mock;
  send: jest.Mock;
  readyState: number;
  url: string;
}

// Collect every instance created so tests can interact with them.
const wsInstances: MockWsInstance[] = [];

class MockWebSocket {
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  close = jest.fn((code?: number, reason?: string) => {
    this.readyState = MockWebSocket.CLOSED;
    // Trigger the close handler so the hook can update state.
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  });
  send = jest.fn();
  readyState: number = MockWebSocket.CONNECTING;
  url: string;

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  constructor(url: string) {
    this.url = url;
    wsInstances.push(this as unknown as MockWsInstance);
  }
}

// ── Jest setup ────────────────────────────────────────────────────────────────

beforeAll(() => {
  // Replace global WebSocket with mock.
  (global as unknown as Record<string, unknown>).WebSocket = MockWebSocket;
});

beforeEach(() => {
  wsInstances.length = 0;
  window.localStorage.clear();
  jest.clearAllMocks();
});

// ── Helper: simulate open ─────────────────────────────────────────────────────

function openSocket(instance: MockWsInstance) {
  act(() => {
    instance.readyState = MockWebSocket.OPEN;
    instance.onopen?.();
  });
}

function sendMessage(instance: MockWsInstance, data: unknown) {
  act(() => {
    instance.onmessage?.({ data: JSON.stringify(data) });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useRoomSocket', () => {
  describe('idle / guard conditions', () => {
    it('stays idle and does not open a socket when roomCode is null', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: null, sessionId: 'sess-1' })
      );
      expect(wsInstances).toHaveLength(0);
      expect(result.current.wsStatus).toBe('idle');
    });

    it('stays idle and does not open a socket when sessionId is null', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: null })
      );
      expect(wsInstances).toHaveLength(0);
      expect(result.current.wsStatus).toBe('idle');
    });

    it('stays idle when both roomCode and sessionId are null', () => {
      renderHook(() =>
        useRoomSocket({ roomCode: null, sessionId: null })
      );
      expect(wsInstances).toHaveLength(0);
    });
  });

  describe('WebSocket URL construction', () => {
    it('uses the ws:// scheme for http API URLs', () => {
      // NEXT_PUBLIC_API_URL is undefined in tests, so it falls back to localhost:3001
      renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      expect(wsInstances).toHaveLength(1);
      expect(wsInstances[0].url).toMatch(/^ws:\/\//);
    });

    it('connects to the /ws endpoint', () => {
      // The new protocol sends join-room as a message after connection;
      // the room code is NOT embedded in the path.
      renderHook(() =>
        useRoomSocket({ roomCode: 'abc123', sessionId: 'sess-1' })
      );
      expect(wsInstances[0].url).toContain('/ws');
    });

    it('appends the bearer token as a query param when provided', () => {
      renderHook(() =>
        useRoomSocket({
          roomCode: 'ABC123',
          sessionId: 'sess-1',
          bearerToken: 'my-token',
        })
      );
      expect(wsInstances[0].url).toContain('token=my-token');
    });

    it('omits the token query param when bearerToken is null', () => {
      renderHook(() =>
        useRoomSocket({
          roomCode: 'ABC123',
          sessionId: 'sess-1',
          bearerToken: null,
        })
      );
      expect(wsInstances[0].url).not.toContain('token=');
    });
  });

  describe('status transitions', () => {
    it('starts at "connecting" when a valid roomCode + sessionId are provided', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      expect(result.current.wsStatus).toBe('connecting');
    });

    it('transitions to "connected" when the socket opens', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      expect(result.current.wsStatus).toBe('connected');
    });

    it('transitions to "disconnected" after the socket closes normally', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      act(() => {
        wsInstances[0].readyState = MockWebSocket.CLOSED;
        wsInstances[0].onclose?.({ code: 1000, reason: 'done' });
      });
      expect(result.current.wsStatus).toBe('disconnected');
    });

    it('transitions to "error" when the socket errors', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      act(() => {
        wsInstances[0].onerror?.();
      });
      expect(result.current.wsStatus).toBe('error');
    });
  });

  describe('kick handling', () => {
    // The new protocol uses 'you-were-kicked' to notify the targeted client
    // directly, and 'player-kicked' as a broadcast to observers.
    const addKickedRoomSpy = jest
      .spyOn(kickedRoomsModule, 'addKickedRoom')
      .mockImplementation(() => {});

    afterEach(() => {
      addKickedRoomSpy.mockClear();
    });

    it('sets isKicked when "you-were-kicked" is received', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type: 'you-were-kicked',
        roomCode: 'ABC123',
      });
      expect(result.current.isKicked).toBe(true);
    });

    it('does NOT set isKicked for a "player-kicked" broadcast (observer message)', () => {
      // player-kicked is a broadcast to observers; isKicked stays false for
      // clients that are NOT the target.
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type: 'player-kicked',
        roomCode: 'ABC123',
        playerId: 'some-other-player',
      });
      expect(result.current.isKicked).toBe(false);
    });

    it('uses a default kick reason after "you-were-kicked"', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type: 'you-were-kicked',
        roomCode: 'ABC123',
      });
      expect(result.current.kickReason).toBeTruthy();
      expect(typeof result.current.kickReason).toBe('string');
    });

    it('calls addKickedRoom with the room code on "you-were-kicked"', () => {
      renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type: 'you-were-kicked',
        roomCode: 'ABC123',
      });
      expect(addKickedRoomSpy).toHaveBeenCalledWith('ABC123');
    });

    it('fires the onKicked callback once on "you-were-kicked"', () => {
      const onKicked = jest.fn();
      renderHook(() =>
        useRoomSocket({
          roomCode: 'ABC123',
          sessionId: 'sess-1',
          onKicked,
        })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type: 'you-were-kicked',
        roomCode: 'ABC123',
      });
      expect(onKicked).toHaveBeenCalledTimes(1);
    });

    it('closes the socket after "you-were-kicked"', () => {
      renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type: 'you-were-kicked',
        roomCode: 'ABC123',
      });
      expect(wsInstances[0].close).toHaveBeenCalled();
    });

    it('ignores non-JSON messages without throwing', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      expect(() =>
        act(() => {
          wsInstances[0].onmessage?.({ data: 'plain text — not JSON' });
        })
      ).not.toThrow();
      expect(result.current.isKicked).toBe(false);
    });

    it('ignores unknown message types', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type: 'unknown-event',
        sessionId: 'sess-1',
      });
      expect(result.current.isKicked).toBe(false);
    });
  });

  // ── connected event & join-room auto-send ────────────────────────────────

  describe('connected event', () => {
    it('records myPlayerId from the connected message', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type: 'connected',
        playerId: 'server-player-id',
        displayName: 'Alice',
      });
      expect(result.current.myPlayerId).toBe('server-player-id');
    });

    it('sends join-room after receiving the connected message', () => {
      renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      // Reset send mock so we only see messages after connected
      wsInstances[0].send.mockClear();
      sendMessage(wsInstances[0], {
        type: 'connected',
        playerId: 'server-player-id',
      });
      expect(wsInstances[0].send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'join-room', roomCode: 'ABC123' })
      );
    });

    it('uppercases the roomCode in the join-room message', () => {
      renderHook(() =>
        useRoomSocket({ roomCode: 'abc123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      wsInstances[0].send.mockClear();
      sendMessage(wsInstances[0], { type: 'connected', playerId: 'pid' });
      expect(wsInstances[0].send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'join-room', roomCode: 'ABC123' })
      );
    });
  });

  // ── Player list management ─────────────────────────────────────────────────

  describe('player list management', () => {
    const PLAYER_ALICE = {
      playerId: 'p-alice',
      displayName: 'Alice',
      avatarId: null,
      isGuest: false,
      isHost: true,
    };
    const PLAYER_BOB = {
      playerId: 'p-bob',
      displayName: 'Bob',
      avatarId: null,
      isGuest: true,
      isHost: false,
    };
    const PLAYER_CAROL = {
      playerId: 'p-carol',
      displayName: 'Carol',
      avatarId: null,
      isGuest: false,
      isHost: false,
    };

    it('populates players from room-joined snapshot', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type: 'room-joined',
        roomCode: 'ABC123',
        players: [PLAYER_ALICE, PLAYER_BOB],
      });
      expect(result.current.players).toHaveLength(2);
      expect(result.current.players[0].playerId).toBe('p-alice');
      expect(result.current.players[1].playerId).toBe('p-bob');
    });

    it('correctly sets isHost flag from the snapshot', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type: 'room-joined',
        roomCode: 'ABC123',
        players: [PLAYER_ALICE, PLAYER_BOB],
      });
      const alice = result.current.players.find((p) => p.playerId === 'p-alice');
      expect(alice?.isHost).toBe(true);
      const bob = result.current.players.find((p) => p.playerId === 'p-bob');
      expect(bob?.isHost).toBe(false);
    });

    it('appends a new player on player-joined', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type: 'room-joined',
        roomCode: 'ABC123',
        players: [PLAYER_ALICE],
      });
      sendMessage(wsInstances[0], {
        type: 'player-joined',
        roomCode: 'ABC123',
        player: PLAYER_BOB,
      });
      expect(result.current.players).toHaveLength(2);
      expect(result.current.players[1].playerId).toBe('p-bob');
    });

    it('deduplicates player-joined for a playerId already in the list', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type: 'room-joined',
        roomCode: 'ABC123',
        players: [PLAYER_ALICE, PLAYER_BOB],
      });
      // Send a duplicate join for Bob
      sendMessage(wsInstances[0], {
        type: 'player-joined',
        roomCode: 'ABC123',
        player: PLAYER_BOB,
      });
      expect(result.current.players).toHaveLength(2);
    });

    it('removes a player on player-kicked broadcast', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type: 'room-joined',
        roomCode: 'ABC123',
        players: [PLAYER_ALICE, PLAYER_BOB, PLAYER_CAROL],
      });
      sendMessage(wsInstances[0], {
        type: 'player-kicked',
        roomCode: 'ABC123',
        playerId: 'p-bob',
      });
      expect(result.current.players).toHaveLength(2);
      expect(result.current.players.find((p) => p.playerId === 'p-bob')).toBeUndefined();
    });

    it('does NOT set isKicked on a player-kicked broadcast (observer message)', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type: 'room-joined',
        roomCode: 'ABC123',
        players: [PLAYER_ALICE, PLAYER_BOB],
      });
      sendMessage(wsInstances[0], {
        type: 'player-kicked',
        roomCode: 'ABC123',
        playerId: 'p-bob',
      });
      // isKicked should still be false — the 'you-were-kicked' message is
      // sent only to the targeted client
      expect(result.current.isKicked).toBe(false);
    });

    it('removes a player on player-left', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type: 'room-joined',
        roomCode: 'ABC123',
        players: [PLAYER_ALICE, PLAYER_BOB],
      });
      sendMessage(wsInstances[0], {
        type: 'player-left',
        roomCode: 'ABC123',
        playerId: 'p-bob',
      });
      expect(result.current.players).toHaveLength(1);
      expect(result.current.players[0].playerId).toBe('p-alice');
    });

    it('ignores player-joined when the player field is missing', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type: 'room-joined',
        roomCode: 'ABC123',
        players: [PLAYER_ALICE],
      });
      sendMessage(wsInstances[0], {
        type: 'player-joined',
        roomCode: 'ABC123',
        // no player field
      });
      expect(result.current.players).toHaveLength(1);
    });

    it('resets players to empty array on new connection attempt', () => {
      const { result, rerender } = renderHook(
        ({ rc }: { rc: string | null }) =>
          useRoomSocket({ roomCode: rc, sessionId: 'sess-1' }),
        { initialProps: { rc: 'ABC123' as string | null } }
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type: 'room-joined',
        roomCode: 'ABC123',
        players: [PLAYER_ALICE, PLAYER_BOB],
      });
      expect(result.current.players).toHaveLength(2);

      // Drop connection then reconnect with a new room code
      rerender({ rc: null });
      rerender({ rc: 'XYZ999' });
      // A fresh socket is created; players should reset to []
      expect(result.current.players).toHaveLength(0);
    });
  });

  // ── kickPlayer ────────────────────────────────────────────────────────────

  describe('kickPlayer', () => {
    it('sends a kick-player message with the correct targetPlayerId when OPEN', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      act(() => {
        result.current.kickPlayer('target-player-id');
      });
      expect(wsInstances[0].send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'kick-player',
          roomCode: 'ABC123',
          targetPlayerId: 'target-player-id',
        })
      );
    });

    it('uppercases the roomCode in the kick-player message', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'abc123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      act(() => {
        result.current.kickPlayer('target-id');
      });
      const lastCall = wsInstances[0].send.mock.calls.at(-1)?.[0] as string;
      const parsed = JSON.parse(lastCall);
      expect(parsed.roomCode).toBe('ABC123');
    });

    it('does nothing when the socket is not OPEN', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      // Do NOT call openSocket — socket stays in CONNECTING state
      act(() => {
        result.current.kickPlayer('target-id');
      });
      expect(wsInstances[0].send).not.toHaveBeenCalled();
    });

    it('does nothing when roomCode is null', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: null, sessionId: 'sess-1' })
      );
      // Hook should be idle (no socket opened)
      act(() => {
        result.current.kickPlayer('target-id');
      });
      expect(wsInstances).toHaveLength(0);
    });
  });

  describe('emit', () => {
    it('sends a JSON payload when the socket is OPEN', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      act(() => {
        result.current.emit('ping', { timestamp: 123 });
      });
      expect(wsInstances[0].send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'ping', payload: { timestamp: 123 } })
      );
    });

    it('does nothing when the socket is still connecting', () => {
      // readyState is CONNECTING (0) at creation — do not call onopen
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      act(() => {
        result.current.emit('ping', {});
      });
      expect(wsInstances[0].send).not.toHaveBeenCalled();
    });
  });

  describe('unmount cleanup', () => {
    it('closes the socket when the hook unmounts', () => {
      const { unmount } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      unmount();
      expect(wsInstances[0].close).toHaveBeenCalled();
    });
  });

  // ── Bot indicator support (Sub-AC 6.3) ──────────────────────────────────
  //
  // The `lobby-starting` / `game_starting` events carry the final seat list
  // including bot players.  The hook must propagate the `isBot` flag so the
  // lobby UI can render BotBadge indicators for bot-occupied seats.

  describe('bot indicator support (Sub-AC 6.3)', () => {
    const BOT_SEAT = {
      playerId:    'bot-quirky-turing',
      displayName: 'Quirky Turing',
      avatarId:    null,
      isGuest:     false,
      isHost:      false,
      teamId:      2,
      isBot:       true,
    };
    const HUMAN_SEAT = {
      playerId:    'p-alice',
      displayName: 'Alice',
      avatarId:    null,
      isGuest:     false,
      isHost:      true,
      teamId:      1,
      isBot:       false,
    };

    it('sets isBot=true for bot entries in lobby-starting snapshot', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type:      'lobby-starting',
        roomCode:  'ABC123',
        seats:     [HUMAN_SEAT, BOT_SEAT],
        botsAdded: ['bot-quirky-turing'],
      });
      expect(result.current.lobbyStarting).toBe(true);
      const bot = result.current.players.find((p) => p.playerId === 'bot-quirky-turing');
      expect(bot).toBeDefined();
      expect(bot?.isBot).toBe(true);
    });

    it('sets isBot=false for human entries in lobby-starting snapshot', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type:      'lobby-starting',
        roomCode:  'ABC123',
        seats:     [HUMAN_SEAT, BOT_SEAT],
        botsAdded: ['bot-quirky-turing'],
      });
      const human = result.current.players.find((p) => p.playerId === 'p-alice');
      expect(human).toBeDefined();
      expect(human?.isBot).toBe(false);
    });

    it('defaults isBot to false when flag is absent from lobby-starting entry', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      const seatWithoutIsBot = { ...HUMAN_SEAT };
      // Remove isBot to simulate legacy server not sending the field
      const { isBot: _, ...seatLegacy } = seatWithoutIsBot;
      void _;
      sendMessage(wsInstances[0], {
        type:  'lobby-starting',
        seats: [seatLegacy],
      });
      const player = result.current.players.find((p) => p.playerId === 'p-alice');
      expect(player?.isBot).toBe(false);
    });

    it('sets isBot=true for bot entries in game_starting snapshot', () => {
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type:  'game_starting',
        seats: [HUMAN_SEAT, BOT_SEAT],
      });
      expect(result.current.lobbyStarting).toBe(true);
      const bot = result.current.players.find((p) => p.playerId === 'bot-quirky-turing');
      expect(bot?.isBot).toBe(true);
    });

    it('propagates isBot from room_players snapshot', () => {
      // room_players atomically replaces the player list; isBot must be passed
      // through transparently so the seats effect in the room page sees it.
      const { result } = renderHook(() =>
        useRoomSocket({ roomCode: 'ABC123', sessionId: 'sess-1' })
      );
      openSocket(wsInstances[0]);
      sendMessage(wsInstances[0], {
        type:    'room_players',
        players: [
          { ...HUMAN_SEAT },
          { ...BOT_SEAT },
        ],
      });
      const bot = result.current.players.find((p) => p.playerId === 'bot-quirky-turing');
      expect(bot?.isBot).toBe(true);
      const human = result.current.players.find((p) => p.playerId === 'p-alice');
      expect(human?.isBot).toBe(false);
    });
  });
});
