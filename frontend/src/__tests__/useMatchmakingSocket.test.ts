/**
 * Unit tests for useMatchmakingSocket hook.
 *
 * Uses a lightweight mock WebSocket so no real backend is needed.
 *
 * Scenarios:
 *   • Hook stays idle when sessionId or bearerToken is null
 *   • WebSocket URL is correctly constructed (ws:// prefix, token param)
 *   • 'connected' event transitions status to 'ready'
 *   • 'connected' + autoJoinFilter sends join-queue automatically
 *   • 'connected' without autoJoinFilter stays at 'ready' (no auto-join)
 *   • 'queue-joined' event sets status to 'in-queue' with correct metadata
 *   • 'queue-update' event updates queueSize
 *   • 'match-found' event sets status to 'match-found', fires onMatchFound
 *   • 'match-found' closes the socket
 *   • 'queue-left' event resets queue state and sets status to 'ready'
 *   • joinQueue() sends join-queue message when socket is OPEN
 *   • leaveQueue() sends leave-queue message when socket is OPEN
 *   • joinQueue() is a no-op when socket is not OPEN
 *   • leaveQueue() sends leave-queue on unmount if status was in-queue
 *   • Socket closes cleanly on unmount
 *   • Error transitions to 'error' status
 *   • Disconnect transitions to 'disconnected' status (except match-found state)
 */

import { renderHook, act } from '@testing-library/react';
import { useMatchmakingSocket } from '@/hooks/useMatchmakingSocket';

// ── Mock WebSocket ─────────────────────────────────────────────────────────────

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

const wsInstances: MockWsInstance[] = [];

class MockWebSocket {
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  close = jest.fn((code?: number, reason?: string) => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  });
  send = jest.fn();
  readyState = MockWebSocket.CONNECTING;
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

// ── Mock next/navigation ──────────────────────────────────────────────────────

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

// ── Mock API_URL ──────────────────────────────────────────────────────────────

jest.mock('@/lib/api', () => ({
  API_URL: 'http://localhost:3001',
}));

// ── Jest setup ─────────────────────────────────────────────────────────────────

beforeAll(() => {
  Object.defineProperty(globalThis, 'WebSocket', {
    value: MockWebSocket,
    writable: true,
  });
});

beforeEach(() => {
  wsInstances.length = 0;
  jest.clearAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function latestWs(): MockWsInstance {
  return wsInstances[wsInstances.length - 1];
}

function simulateOpen(ws: MockWsInstance) {
  act(() => {
    ws.readyState = MockWebSocket.OPEN;
    ws.onopen?.();
  });
}

function simulateMessage(ws: MockWsInstance, data: object) {
  act(() => {
    ws.onmessage?.({ data: JSON.stringify(data) });
  });
}

function simulateClose(ws: MockWsInstance, code = 1000) {
  act(() => {
    ws.readyState = MockWebSocket.CLOSED;
    ws.onclose?.({ code, reason: '' });
  });
}

function lastSentMsg(ws: MockWsInstance) {
  const calls = ws.send.mock.calls;
  if (calls.length === 0) return null;
  return JSON.parse(calls[calls.length - 1][0]);
}

function allSentMsgs(ws: MockWsInstance) {
  return ws.send.mock.calls.map(([raw]: [string]) => JSON.parse(raw));
}

// =============================================================================
// Tests
// =============================================================================

describe('useMatchmakingSocket — idle when no credentials', () => {
  it('stays idle when sessionId is null', () => {
    const { result } = renderHook(() =>
      useMatchmakingSocket({ sessionId: null, bearerToken: 'token' })
    );
    expect(wsInstances).toHaveLength(0);
    expect(result.current.status).toBe('idle');
  });

  it('stays idle when bearerToken is null', () => {
    const { result } = renderHook(() =>
      useMatchmakingSocket({ sessionId: 'sess-1', bearerToken: null })
    );
    expect(wsInstances).toHaveLength(0);
    expect(result.current.status).toBe('idle');
  });
});

describe('useMatchmakingSocket — WebSocket URL construction', () => {
  it('uses ws:// for http:// API_URL and includes token param', () => {
    renderHook(() =>
      useMatchmakingSocket({ sessionId: 'sess-1', bearerToken: 'my-token' })
    );
    expect(wsInstances).toHaveLength(1);
    expect(wsInstances[0].url).toMatch(/^ws:\/\/localhost:3001\/ws\?token=/);
    expect(wsInstances[0].url).toContain('my-token');
  });
});

describe('useMatchmakingSocket — status transitions', () => {
  it("transitions to 'connecting' on connection attempt", () => {
    const { result } = renderHook(() =>
      useMatchmakingSocket({ sessionId: 'sess-1', bearerToken: 'token' })
    );
    expect(result.current.status).toBe('connecting');
  });

  it("transitions to 'ready' after receiving 'connected' event", () => {
    const { result } = renderHook(() =>
      useMatchmakingSocket({ sessionId: 'sess-1', bearerToken: 'token' })
    );
    const ws = latestWs();
    simulateOpen(ws);
    simulateMessage(ws, { type: 'connected', playerId: 'p1' });
    expect(result.current.status).toBe('ready');
  });

  it("transitions to 'disconnected' on socket close (from 'ready')", () => {
    const { result } = renderHook(() =>
      useMatchmakingSocket({ sessionId: 'sess-1', bearerToken: 'token' })
    );
    const ws = latestWs();
    simulateOpen(ws);
    simulateMessage(ws, { type: 'connected', playerId: 'p1' });
    simulateClose(ws);
    expect(result.current.status).toBe('disconnected');
  });

  it("transitions to 'error' on WebSocket onerror", () => {
    const { result } = renderHook(() =>
      useMatchmakingSocket({ sessionId: 'sess-1', bearerToken: 'token' })
    );
    const ws = latestWs();
    act(() => {
      ws.onerror?.();
    });
    expect(result.current.status).toBe('error');
  });
});

describe('useMatchmakingSocket — auto-join on connect', () => {
  it('sends join-queue automatically when autoJoinFilter is set', () => {
    renderHook(() =>
      useMatchmakingSocket({
        sessionId: 'sess-1',
        bearerToken: 'token',
        autoJoinFilter: { playerCount: 6, cardRemovalVariant: 'remove_7s' },
      })
    );
    const ws = latestWs();
    simulateOpen(ws);
    simulateMessage(ws, { type: 'connected', playerId: 'p1' });

    const msg = lastSentMsg(ws);
    expect(msg).not.toBeNull();
    expect(msg.type).toBe('join-queue');
    expect(msg.playerCount).toBe(6);
    expect(msg.cardRemovalVariant).toBe('remove_7s');
  });

  it('does NOT send join-queue when autoJoinFilter is null', () => {
    renderHook(() =>
      useMatchmakingSocket({
        sessionId: 'sess-1',
        bearerToken: 'token',
        autoJoinFilter: null,
      })
    );
    const ws = latestWs();
    simulateOpen(ws);
    simulateMessage(ws, { type: 'connected', playerId: 'p1' });

    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe('useMatchmakingSocket — queue-joined event', () => {
  it("sets status to 'in-queue' and updates queue metadata", () => {
    const { result } = renderHook(() =>
      useMatchmakingSocket({ sessionId: 'sess-1', bearerToken: 'token' })
    );
    const ws = latestWs();
    simulateOpen(ws);
    simulateMessage(ws, { type: 'connected', playerId: 'p1' });
    simulateMessage(ws, {
      type: 'queue-joined',
      filterKey: '6:remove_7s',
      playerCount: 6,
      cardRemovalVariant: 'remove_7s',
      position: 1,
      queueSize: 1,
    });

    expect(result.current.status).toBe('in-queue');
    expect(result.current.filterKey).toBe('6:remove_7s');
    expect(result.current.queueSize).toBe(1);
    expect(result.current.position).toBe(1);
  });
});

describe('useMatchmakingSocket — queue-update event', () => {
  it('updates queueSize without changing status', () => {
    const { result } = renderHook(() =>
      useMatchmakingSocket({ sessionId: 'sess-1', bearerToken: 'token' })
    );
    const ws = latestWs();
    simulateOpen(ws);
    simulateMessage(ws, { type: 'connected', playerId: 'p1' });
    simulateMessage(ws, {
      type: 'queue-joined',
      filterKey: '6:remove_7s',
      playerCount: 6,
      cardRemovalVariant: 'remove_7s',
      position: 1,
      queueSize: 1,
    });
    simulateMessage(ws, { type: 'queue-update', filterKey: '6:remove_7s', queueSize: 4 });

    expect(result.current.status).toBe('in-queue');
    expect(result.current.queueSize).toBe(4);
  });
});

describe('useMatchmakingSocket — match-found event', () => {
  it("sets status to 'match-found' and stores the room code", () => {
    const { result } = renderHook(() =>
      useMatchmakingSocket({ sessionId: 'sess-1', bearerToken: 'token' })
    );
    const ws = latestWs();
    simulateOpen(ws);
    simulateMessage(ws, { type: 'connected', playerId: 'p1' });
    simulateMessage(ws, {
      type: 'queue-joined',
      filterKey: '6:remove_7s',
      playerCount: 6,
      cardRemovalVariant: 'remove_7s',
      position: 1,
      queueSize: 6,
    });
    simulateMessage(ws, {
      type: 'match-found',
      roomCode: 'ROOM01',
      playerCount: 6,
      cardRemovalVariant: 'remove_7s',
    });

    expect(result.current.status).toBe('match-found');
    expect(result.current.matchRoomCode).toBe('ROOM01');
  });

  it('calls onMatchFound with the room code', () => {
    const onMatchFound = jest.fn();
    renderHook(() =>
      useMatchmakingSocket({
        sessionId: 'sess-1',
        bearerToken: 'token',
        onMatchFound,
      })
    );
    const ws = latestWs();
    simulateOpen(ws);
    simulateMessage(ws, { type: 'connected', playerId: 'p1' });
    simulateMessage(ws, {
      type: 'match-found',
      roomCode: 'ROOM01',
      playerCount: 6,
      cardRemovalVariant: 'remove_7s',
    });

    expect(onMatchFound).toHaveBeenCalledTimes(1);
    expect(onMatchFound).toHaveBeenCalledWith('ROOM01');
  });

  it('closes the socket after match-found', () => {
    renderHook(() =>
      useMatchmakingSocket({ sessionId: 'sess-1', bearerToken: 'token' })
    );
    const ws = latestWs();
    simulateOpen(ws);
    simulateMessage(ws, { type: 'connected', playerId: 'p1' });
    simulateMessage(ws, {
      type: 'match-found',
      roomCode: 'ROOM01',
      playerCount: 6,
      cardRemovalVariant: 'remove_7s',
    });

    expect(ws.close).toHaveBeenCalled();
  });

  it("preserves 'match-found' status even after socket closes", () => {
    const { result } = renderHook(() =>
      useMatchmakingSocket({ sessionId: 'sess-1', bearerToken: 'token' })
    );
    const ws = latestWs();
    simulateOpen(ws);
    simulateMessage(ws, { type: 'connected', playerId: 'p1' });
    simulateMessage(ws, {
      type: 'match-found',
      roomCode: 'ROOM01',
      playerCount: 6,
      cardRemovalVariant: 'remove_7s',
    });
    simulateClose(ws);

    expect(result.current.status).toBe('match-found');
  });
});

describe('useMatchmakingSocket — queue-left event', () => {
  it("resets to 'ready' and clears queue data after leaving", () => {
    const { result } = renderHook(() =>
      useMatchmakingSocket({ sessionId: 'sess-1', bearerToken: 'token' })
    );
    const ws = latestWs();
    simulateOpen(ws);
    simulateMessage(ws, { type: 'connected', playerId: 'p1' });
    simulateMessage(ws, {
      type: 'queue-joined',
      filterKey: '6:remove_7s',
      playerCount: 6,
      cardRemovalVariant: 'remove_7s',
      position: 1,
      queueSize: 3,
    });
    simulateMessage(ws, { type: 'queue-left', filterKey: '6:remove_7s' });

    expect(result.current.status).toBe('ready');
    expect(result.current.filterKey).toBeNull();
    expect(result.current.queueSize).toBe(0);
    expect(result.current.position).toBe(0);
  });
});

describe('useMatchmakingSocket — manual actions', () => {
  it('joinQueue() sends join-queue message when socket is OPEN', () => {
    const { result } = renderHook(() =>
      useMatchmakingSocket({ sessionId: 'sess-1', bearerToken: 'token' })
    );
    const ws = latestWs();
    simulateOpen(ws);
    simulateMessage(ws, { type: 'connected', playerId: 'p1' });

    act(() => {
      result.current.joinQueue(8, 'remove_2s');
    });

    const msg = lastSentMsg(ws);
    expect(msg.type).toBe('join-queue');
    expect(msg.playerCount).toBe(8);
    expect(msg.cardRemovalVariant).toBe('remove_2s');
  });

  it('joinQueue() is a no-op when socket is not OPEN', () => {
    const { result } = renderHook(() =>
      useMatchmakingSocket({ sessionId: 'sess-1', bearerToken: 'token' })
    );
    const ws = latestWs();
    // Socket is CONNECTING — not open yet
    act(() => {
      result.current.joinQueue(6, 'remove_7s');
    });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('leaveQueue() sends leave-queue message when socket is OPEN', () => {
    const { result } = renderHook(() =>
      useMatchmakingSocket({ sessionId: 'sess-1', bearerToken: 'token' })
    );
    const ws = latestWs();
    simulateOpen(ws);
    simulateMessage(ws, { type: 'connected', playerId: 'p1' });

    act(() => {
      result.current.leaveQueue();
    });

    const msg = lastSentMsg(ws);
    expect(msg.type).toBe('leave-queue');
  });
});

describe('useMatchmakingSocket — cleanup on unmount', () => {
  it('closes the socket on unmount', () => {
    const { unmount } = renderHook(() =>
      useMatchmakingSocket({ sessionId: 'sess-1', bearerToken: 'token' })
    );
    const ws = latestWs();
    simulateOpen(ws);
    simulateMessage(ws, { type: 'connected', playerId: 'p1' });

    unmount();

    expect(ws.close).toHaveBeenCalled();
  });

  it('sends leave-queue before closing if status is in-queue', () => {
    const { result, unmount } = renderHook(() =>
      useMatchmakingSocket({ sessionId: 'sess-1', bearerToken: 'token' })
    );
    const ws = latestWs();
    simulateOpen(ws);
    simulateMessage(ws, { type: 'connected', playerId: 'p1' });
    simulateMessage(ws, {
      type: 'queue-joined',
      filterKey: '6:remove_7s',
      playerCount: 6,
      cardRemovalVariant: 'remove_7s',
      position: 1,
      queueSize: 2,
    });

    expect(result.current.status).toBe('in-queue');
    const sendCallsBefore = ws.send.mock.calls.length;

    unmount();

    const msgs = allSentMsgs(ws).slice(sendCallsBefore);
    // At least one leave-queue should have been sent before close
    expect(msgs.some((m) => m.type === 'leave-queue')).toBe(true);
  });
});
