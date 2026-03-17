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
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => {
            if (mockDbConfig.lookupError) {
              return Promise.resolve({ data: null, error: mockDbConfig.lookupError });
            }
            return Promise.resolve({
              data: {
                host_user_id:   mockDbConfig.hostUserId,
                is_matchmaking: mockDbConfig.isMatchmaking,
              },
              error: null,
            });
          },
        }),
      }),
      update: () => ({
        // Simulate Supabase network/write failures by rejecting the promise.
        // handleRematchInitiate uses try/catch, so rejections are caught.
        eq: () => {
          if (mockDbConfig.updateError) {
            return Promise.reject(mockDbConfig.updateError);
          }
          return Promise.resolve({ error: null });
        },
      }),
    }),
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

const { handleRematchInitiate } = require('../game/gameSocketServer');
const { _clearAll, registerConnection } = require('../game/gameStore');
const { _clearAll: clearRematch, initRematch, hasRematch } = require('../game/rematchStore');

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
  // Reset DB config to happy-path defaults
  mockDbConfig.hostUserId    = HOST_ID;
  mockDbConfig.isMatchmaking = false;
  mockDbConfig.lookupError   = null;
  mockDbConfig.updateError   = null;

  _clearAll();
  clearRematch();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleRematchInitiate ', () => {
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

  it('5. Supabase update failure → rejects with REMATCH_RESET_FAILED, no broadcast', async () => {
    // The mock returns Promise.reject when updateError is set, which triggers
    // the try/catch handler in handleRematchInitiate.
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
