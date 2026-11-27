'use strict';

/**
 * Unit tests for handleRematchInitiate.
 *
 * handleRematchInitiate is the server handler for `rematch_initiate` — a
 * host-only WebSocket message that immediately triggers a rematch in a
 * private room without requiring a majority vote.
 *
 * Coverage:
 * 1. Host of a private room triggers rematch → rematch_start broadcast to all
 * 2. Matchmaking room → rejects with NOT_PRIVATE_ROOM error
 * 3. Non-host player → rejects with HOST_ONLY error
 * 4. DB lookup failure → rejects with ROOM_NOT_FOUND error
 * 5. Supabase update failure → rejects with REMATCH_RESET_FAILED error
 * 6. Clears any active rematch vote before triggering rematch_start
 * 7. rematch_start payload contains the correct roomCode
 * 8. No error sent to caller on success
 */

// ---------------------------------------------------------------------------
// Mutable mock config — referenced inside jest.mock factory via the `mock`
// prefix convention so Jest permits the closure access.
// ---------------------------------------------------------------------------

// Prefixed with "mock" so Jest allows access from the factory closure.
const mockDbConfig = {
  hostUserId:   'host-user-uuid',
  isMatchmaking: false,
  lookupError:  null,
  updateError:  null,
};

jest.mock('../db/supabase', () => ({
  getSupabaseClient: () => ({
    from: () => {
      const filters = {};
      let update;
      const _row = () => ({
        id: mockDbConfig.roomId,
        code: 'REMA01',
        status: mockDbConfig.status,
        host_user_id: mockDbConfig.hostUserId,
        is_matchmaking: mockDbConfig.isMatchmaking,
      });
      return {
        eq(column, value) { filters[column] = value; return this; },
        select() { return this; },
        update(values) { update = values; return this; },
        single: async () => ({ data: _row(), error: mockDbConfig.lookupError }),
        maybeSingle: async () => {
          const row = _row();
          const matches = mockDbConfig.matches && Object.entries(filters).every(([key, value]) => row[key] === value);
          if (!update) return { data: matches ? row : null, error: mockDbConfig.readbackError };
          if (matches && (!mockDbConfig.updateError || mockDbConfig.commitOnError)) {
            mockDbConfig.status = update.status;
          }
          mockDbConfig.afterWrite?.();
          return { data: matches ? row : null, error: mockDbConfig.updateError };
        },
      };
    },
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

const { handleRematchInitiate, _openRematchVote } = require('../game/gameSocketServer');
const { _clearAll, registerConnection, getGame, setGame } = require('../game/gameStore');
const { _clearAll: clearRematch, initRematch, hasRematch, REMATCH_VOTE_TIMEOUT_MS } = require('../game/rematchStore');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOM_CODE = 'REMA01';
const HOST_ID   = 'host-user-uuid';
const OTHER_ID  = 'other-player-uuid';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeWs() {
  const sent = [];
  const ws = {
    readyState: 1, // OPEN
    send: jest.fn((data) => sent.push(JSON.parse(data))),
    _sent: sent,
  };
  return ws;
}

function registerFakeWs(roomCode, playerId) {
  const ws = makeFakeWs();
  registerConnection(roomCode, playerId, ws);
  return ws;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers();
  // Reset DB config to happy-path defaults
  mockDbConfig.hostUserId    = HOST_ID;
  mockDbConfig.isMatchmaking = false;
  mockDbConfig.lookupError   = null;
  mockDbConfig.updateError   = null;
  mockDbConfig.matches = true;
  mockDbConfig.roomId = 'room-uuid';
  mockDbConfig.status = 'completed';
  mockDbConfig.commitOnError = false;
  mockDbConfig.readbackError = null;
  mockDbConfig.afterWrite = null;

  _clearAll();
  clearRematch();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('handleRematchInitiate ', () => {
  const finished = {
    roomId: 'room-uuid', roomCode: ROOM_CODE, status: 'completed', variant: 'remove_2s', playerCount: 6,
    players: [{ playerId: HOST_ID, isBot: false, teamId: 1, seatIndex: 0 }],
  };

  it('finishes a committed reset after a lost reply, even across the old vote deadline', async () => {
    setGame(ROOM_CODE, finished);
    const observer = registerFakeWs(ROOM_CODE, 'observer');
    _openRematchVote(finished);
    mockDbConfig.commitOnError = true;
    mockDbConfig.updateError = new Error('lost reply');
    mockDbConfig.afterWrite = () => {
      _openRematchVote(finished);
      jest.advanceTimersByTime(REMATCH_VOTE_TIMEOUT_MS + 3000);
    };
    await handleRematchInitiate(ROOM_CODE, HOST_ID, makeFakeWs());
    expect(observer._sent.map(message => message.type)).toContain('rematch_start');
    expect(observer._sent.map(message => message.type)).not.toContain('room_dissolved');
    expect(observer._sent.find(message => message.type === 'rematch_start').previousTeams).toHaveLength(1);
    expect(hasRematch(ROOM_CODE)).toBe(false);
    expect(getGame(ROOM_CODE)).toBeUndefined();
  });

  it('lets the host finish an uncertain reset on retry without reopening the old vote', async () => {
    setGame(ROOM_CODE, finished);
    const observer = registerFakeWs(ROOM_CODE, 'observer');
    _openRematchVote(finished);
    mockDbConfig.commitOnError = true;
    mockDbConfig.updateError = new Error('lost reply');
    mockDbConfig.readbackError = new Error('database unreachable');
    await handleRematchInitiate(ROOM_CODE, HOST_ID, makeFakeWs());
    expect(hasRematch(ROOM_CODE)).toBe(false);
    expect(observer._sent.at(-1)).toMatchObject({ type: 'rematch_declined' });
    mockDbConfig.updateError = null;
    mockDbConfig.readbackError = null;
    await handleRematchInitiate(ROOM_CODE, HOST_ID, makeFakeWs());
    expect(observer._sent.filter(message => message.type === 'rematch_start')).toHaveLength(1);
  });

  it('refuses to reset an unrelated waiting room', async () => {
    setGame(ROOM_CODE, { ...finished });
    mockDbConfig.status = 'waiting';
    const ws = registerFakeWs(ROOM_CODE, HOST_ID);
    await handleRematchInitiate(ROOM_CODE, HOST_ID, ws);
    expect(ws._sent).toEqual([expect.objectContaining({ code: 'REMATCH_RESET_FAILED' })]);
  });

  it.each([['roomId', 'replacement'], ['hostUserId', OTHER_ID], ['status', 'cancelled']])(
    'does not finish an ambiguous reset after the room changes %s',
    async (field, value) => {
      setGame(ROOM_CODE, { ...finished });
      const observer = registerFakeWs(ROOM_CODE, 'observer');
      mockDbConfig.commitOnError = true;
      mockDbConfig.updateError = new Error('lost reply');
      mockDbConfig.afterWrite = () => { mockDbConfig[field] = value; };
      await handleRematchInitiate(ROOM_CODE, HOST_ID, makeFakeWs());
      expect(observer._sent).toEqual([{ type: 'rematch_declined', reason: 'room_unavailable' }]);
      expect(hasRematch(ROOM_CODE)).toBe(false);
    }
  );

  it('reopens voting when the database confirms the reset did not commit', async () => {
    setGame(ROOM_CODE, { ...finished });
    const observer = registerFakeWs(ROOM_CODE, 'observer');
    mockDbConfig.updateError = new Error('write failed');
    await handleRematchInitiate(ROOM_CODE, HOST_ID, makeFakeWs());
    expect(observer._sent.at(-1)).toMatchObject({ type: 'rematch_vote_update', yesCount: 0 });
    expect(hasRematch(ROOM_CODE)).toBe(true);
  });

  it('1. host of a private room → broadcasts rematch_start to all connected clients', async () => {
    const observerWs = registerFakeWs(ROOM_CODE, 'observer');
    const callerWs   = makeFakeWs();

    await handleRematchInitiate(ROOM_CODE, HOST_ID, callerWs);

    const rematchMsg = observerWs._sent.find((m) => m.type === 'rematch_start');
    expect(rematchMsg).toBeDefined();
    expect(rematchMsg.roomCode).toBe(ROOM_CODE);
  });

  it('2. matchmaking room → rejects with NOT_PRIVATE_ROOM, no broadcast', async () => {
    mockDbConfig.isMatchmaking = true;
    const observerWs = registerFakeWs(ROOM_CODE, 'observer');
    const callerWs   = makeFakeWs();

    await handleRematchInitiate(ROOM_CODE, HOST_ID, callerWs);

    const err = callerWs._sent.find((m) => m.type === 'error');
    expect(err).toBeDefined();
    expect(err.code).toBe('NOT_PRIVATE_ROOM');
    expect(observerWs._sent.find((m) => m.type === 'rematch_start')).toBeUndefined();
  });

  it('3. non-host player → rejects with HOST_ONLY, no broadcast', async () => {
    const observerWs = registerFakeWs(ROOM_CODE, 'observer');
    const callerWs   = makeFakeWs();

    await handleRematchInitiate(ROOM_CODE, OTHER_ID, callerWs);

    const err = callerWs._sent.find((m) => m.type === 'error');
    expect(err).toBeDefined();
    expect(err.code).toBe('HOST_ONLY');
    expect(observerWs._sent.find((m) => m.type === 'rematch_start')).toBeUndefined();
  });

  it('4. DB lookup failure → rejects with ROOM_NOT_FOUND, no broadcast', async () => {
    mockDbConfig.lookupError = new Error('connection refused');
    const observerWs = registerFakeWs(ROOM_CODE, 'observer');
    const callerWs   = makeFakeWs();

    await handleRematchInitiate(ROOM_CODE, HOST_ID, callerWs);

    const err = callerWs._sent.find((m) => m.type === 'error');
    expect(err).toBeDefined();
    expect(err.code).toBe('ROOM_NOT_FOUND');
    expect(observerWs._sent.find((m) => m.type === 'rematch_start')).toBeUndefined();
  });

  it('refuses a stale rematch request after the private lobby closes', async () => {
    mockDbConfig.matches = false;
    const ws = { readyState: 1, send: jest.fn() };
    await handleRematchInitiate(ROOM_CODE, HOST_ID, ws);
    expect(JSON.parse(ws.send.mock.calls[0][0]).code).toBe('REMATCH_RESET_FAILED');
  });

  it('5. Supabase update failure → rejects with REMATCH_RESET_FAILED, no broadcast', async () => {
    mockDbConfig.updateError = new Error('write timeout');
    const observerWs = registerFakeWs(ROOM_CODE, 'observer');
    const callerWs   = makeFakeWs();

    await handleRematchInitiate(ROOM_CODE, HOST_ID, callerWs);

    const err = callerWs._sent.find((m) => m.type === 'error');
    expect(err).toBeDefined();
    expect(err.code).toBe('REMATCH_RESET_FAILED');
    expect(observerWs._sent.find((m) => m.type === 'rematch_start')).toBeUndefined();
  });

  it('6. clears any active rematch vote before triggering rematch_start', async () => {
    initRematch(ROOM_CODE, [
      { playerId: HOST_ID, isBot: false },
      { playerId: 'p2',    isBot: false },
    ], () => {});
    expect(hasRematch(ROOM_CODE)).toBe(true);

    registerFakeWs(ROOM_CODE, 'observer');
    const callerWs = makeFakeWs();

    await handleRematchInitiate(ROOM_CODE, HOST_ID, callerWs);

    expect(hasRematch(ROOM_CODE)).toBe(false);
  });

  it('7. rematch_start payload contains the correct roomCode', async () => {
    const observerWs = registerFakeWs(ROOM_CODE, 'observer');
    const callerWs   = makeFakeWs();

    await handleRematchInitiate(ROOM_CODE, HOST_ID, callerWs);

    const rematchMsg = observerWs._sent.find((m) => m.type === 'rematch_start');
    expect(rematchMsg).toBeDefined();
    expect(rematchMsg.roomCode).toBe(ROOM_CODE);
  });

  it('8. no error message sent to caller on success', async () => {
    registerFakeWs(ROOM_CODE, 'observer');
    const callerWs = makeFakeWs();

    await handleRematchInitiate(ROOM_CODE, HOST_ID, callerWs);

    const err = callerWs._sent.find((m) => m.type === 'error');
    expect(err).toBeUndefined();
  });
});
