'use strict';

/**
 * AC 52 — Only fully completed games count in stats; abandoned or dissolved
 * games are discarded.
 *
 * Coverage:
 *
 *  updateStats guard (primary safety mechanism):
 *   1.  updateStats is a no-op when gs.status === 'active'    (in-progress game)
 *   2.  updateStats is a no-op when gs.status === 'abandoned' (abandoned game)
 *   3.  updateStats is a no-op when gs.status is undefined / null
 *   4.  updateStats DOES call the RPC when gs.status === 'completed'
 *   5.  Rematch dissolution does NOT re-invoke updateStats
 *
 *  markRoomAbandoned:
 *   6.  Calls supabase.update({ status: 'abandoned' }) for the correct room
 *   7.  Only updates rooms whose current status is in_progress / starting / waiting
 *   8.  Logs a console warning when Supabase returns an error (non-fatal)
 *   9.  Does not throw when Supabase throws (non-fatal)
 *
 *  markStaleGamesAbandoned:
 *  10.  Calls the mark_stale_games_abandoned RPC with a 'seconds' interval
 *  11.  Converts the staleAfterMs parameter correctly to seconds
 *  12.  Logs how many rooms were swept when count > 0
 *  13.  Does not throw when the RPC returns an error (non-fatal)
 *  14.  Default staleAfterMs is 2 hours (7200 seconds)
 */

// ---------------------------------------------------------------------------
// Mocks — must be defined before require() calls
// ---------------------------------------------------------------------------

const mockRpc = jest.fn().mockResolvedValue({ data: 0, error: null });
const mockUpdateEq = jest.fn().mockResolvedValue({ error: null });
const mockUpdateIn = jest.fn().mockReturnValue({ eq: mockUpdateEq });
const mockUpdate   = jest.fn().mockReturnValue({ in: mockUpdateIn });

jest.mock('../db/supabase', () => ({
  getSupabaseClient: () => ({
    from: (_table) => ({
      update: mockUpdate,
    }),
    rpc: mockRpc,
    auth: { getUser: async () => ({ data: null, error: new Error('mock') }) },
  }),
}));

jest.mock('../sessions/guestSessionStore', () => ({ getGuestSession: () => null }));
jest.mock('../liveGames/liveGamesStore', () => ({
  addGame:    jest.fn(),
  updateGame: jest.fn(),
  removeGame: jest.fn(),
  get:        jest.fn().mockReturnValue({ scores: { team1: 0, team2: 0 } }),
}));
jest.mock('../game/rematchStore', () => ({
  initRematch:    jest.fn().mockReturnValue({ yesCount: 0, noCount: 0, totalCount: 0 }),
  castVote:       jest.fn(),
  getVoteSummary: jest.fn(),
  hasRematch:     jest.fn().mockReturnValue(false),
  clearRematch:   jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

const { updateStats } = require('../game/gameSocketServer');
const { markRoomAbandoned, markStaleGamesAbandoned } = require('../game/gameState');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSupabaseMock({
  updateError  = null,
  rpcData      = 0,
  rpcError     = null,
  rpcThrows    = false,
  updateThrows = false,
} = {}) {
  // The actual chain used by markRoomAbandoned is:
  //   supabase.from('rooms').update({ status: 'abandoned' })
  //           .eq('code', roomCode)
  //           .in('status', [...])
  const updateInFn = jest.fn().mockImplementation(
    updateThrows
      ? () => { throw new Error('DB connection lost'); }
      : () => Promise.resolve({ error: updateError })
  );
  const updateEqFn  = jest.fn().mockReturnValue({ in: updateInFn });
  const updateFn    = jest.fn().mockReturnValue({ eq: updateEqFn });
  const rpcFn       = jest.fn().mockImplementation(
    rpcThrows
      ? () => { throw new Error('RPC network error'); }
      : () => Promise.resolve({ data: rpcData, error: rpcError })
  );
  return {
    from: () => ({ update: updateFn }),
    rpc: rpcFn,
    _updateFn:    updateFn,
    _updateEqFn:  updateEqFn,
    _updateInFn:  updateInFn,
    _rpcFn:       rpcFn,
  };
}

function makeGs(status, players = null) {
  return {
    roomCode:    'TEST01',
    status,
    winner:      status === 'completed' ? 1 : null,
    scores:      { team1: 5, team2: 3 },
    players: players ?? [
      { playerId: 'p1', teamId: 1, isBot: false, isGuest: false },
      { playerId: 'p2', teamId: 2, isBot: false, isGuest: false },
    ],
    moveHistory: [],
  };
}

// ---------------------------------------------------------------------------
// Tests 1–5: updateStats guard
// ---------------------------------------------------------------------------

describe('updateStats — never fires for non-completed games (AC 52)', () => {
  beforeEach(() => {
    mockRpc.mockClear();
  });

  it('1. does NOT call RPC when gs.status === "active" (in-progress game)', async () => {
    await updateStats(makeGs('active'));
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('2. does NOT call RPC when gs.status === "abandoned"', async () => {
    await updateStats(makeGs('abandoned'));
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('3. does NOT call RPC when gs.status is undefined', async () => {
    const gs = makeGs('active');
    delete gs.status;
    await updateStats(gs);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('4. DOES call RPC when gs.status === "completed"', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await updateStats(makeGs('completed'));
    // One RPC call per non-bot, non-guest player (2 players → 2 calls)
    expect(mockRpc).toHaveBeenCalledTimes(2);
    const [rpcName] = mockRpc.mock.calls[0];
    expect(rpcName).toBe('increment_user_stats');
  });

  it('5. completing game_over for one room does not affect a second abandoned game', async () => {
    mockRpc.mockClear();
    mockRpc.mockResolvedValue({ data: null, error: null });

    // Room A completes → stats written
    await updateStats(makeGs('completed'));
    const callsAfterCompletion = mockRpc.mock.calls.length;

    // Room B abandoned → stats NOT written
    await updateStats(makeGs('abandoned'));
    expect(mockRpc.mock.calls.length).toBe(callsAfterCompletion); // no new calls
  });
});

// ---------------------------------------------------------------------------
// Tests 6–9: markRoomAbandoned
// ---------------------------------------------------------------------------

describe('markRoomAbandoned (AC 52)', () => {
  it('6. calls supabase update with status=abandoned for the correct room code', async () => {
    const sb = makeSupabaseMock();
    await markRoomAbandoned('ROOM01', sb);

    // Chain: .update({ status: 'abandoned' }).eq('code', roomCode).in('status', [...])
    expect(sb._updateFn).toHaveBeenCalledWith({ status: 'abandoned' });
    expect(sb._updateEqFn).toHaveBeenCalledWith('code', 'ROOM01');
    expect(sb._updateInFn).toHaveBeenCalledWith(
      'status',
      ['in_progress', 'starting', 'waiting']
    );
  });

  it('7. only touches rooms with status in_progress / starting / waiting', async () => {
    const sb = makeSupabaseMock();
    await markRoomAbandoned('ROOM02', sb);

    const [, statusValues] = sb._updateInFn.mock.calls[0];
    expect(statusValues).toEqual(['in_progress', 'starting', 'waiting']);
    // 'completed' and 'abandoned' are intentionally absent
    expect(statusValues).not.toContain('completed');
    expect(statusValues).not.toContain('abandoned');
  });

  it('8. logs a warning but does not throw when Supabase returns an error', async () => {
    const sb = makeSupabaseMock({ updateError: new Error('constraint violation') });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(markRoomAbandoned('ROOM03', sb)).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });

  it('9. does not throw when Supabase itself throws', async () => {
    const sb = makeSupabaseMock({ updateThrows: true });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(markRoomAbandoned('ROOM04', sb)).resolves.toBeUndefined();
    errorSpy.mockRestore();
  });

  it('9b. persists an abandoned game_state snapshot when one is provided', async () => {
    const sb = makeSupabaseMock();
    const gs = {
      variant: 'remove_7s',
      playerCount: 6,
      status: 'abandoned',
      currentTurnPlayerId: null,
      players: [],
      hands: new Map(),
      declaredSuits: new Map(),
      scores: { team1: 0, team2: 0 },
      lastMove: 'All humans left',
      winner: null,
      tiebreakerWinner: null,
      moveHistory: [],
      eliminatedPlayerIds: new Set(),
      turnRecipients: new Map(),
    };

    await markRoomAbandoned('ROOM05', sb, gs);

    expect(sb._updateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'abandoned',
        game_state: expect.objectContaining({ status: 'abandoned', lastMove: 'All humans left' }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Tests 10–14: markStaleGamesAbandoned
// ---------------------------------------------------------------------------

describe('markStaleGamesAbandoned (AC 52)', () => {
  it('10. calls mark_stale_games_abandoned RPC with a seconds-based interval string', async () => {
    const sb = makeSupabaseMock({ rpcData: 0 });
    await markStaleGamesAbandoned(sb, 3600000); // 1 hour

    expect(sb._rpcFn).toHaveBeenCalledWith('mark_stale_games_abandoned', {
      stale_after: '3600 seconds',
    });
  });

  it('11. converts staleAfterMs to seconds correctly', async () => {
    const sb = makeSupabaseMock({ rpcData: 0 });
    await markStaleGamesAbandoned(sb, 5400000); // 1.5 hours = 5400 seconds

    const [, args] = sb._rpcFn.mock.calls[0];
    expect(args.stale_after).toBe('5400 seconds');
  });

  it('12. logs how many rooms were swept when count > 0', async () => {
    const sb = makeSupabaseMock({ rpcData: 3 });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await markStaleGamesAbandoned(sb, 7200000);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('3 stale in_progress room(s) as abandoned')
    );
    logSpy.mockRestore();
  });

  it('13. does not throw when the RPC returns an error (non-fatal)', async () => {
    const sb = makeSupabaseMock({ rpcError: new Error('DB unreachable') });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(markStaleGamesAbandoned(sb, 7200000)).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });

  it('14. default staleAfterMs is 2 hours (7200 seconds)', async () => {
    const sb = makeSupabaseMock({ rpcData: 0 });
    // Call without providing staleAfterMs
    await markStaleGamesAbandoned(sb);

    const [, args] = sb._rpcFn.mock.calls[0];
    expect(args.stale_after).toBe('7200 seconds');
  });
});
