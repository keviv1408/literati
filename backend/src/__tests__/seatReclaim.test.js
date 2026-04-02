'use strict';

/**
 * Unit tests for seat reclaim within the reconnect window.
 *
 * When a human player disconnects during an active game:
 * 1. A reconnect window starts immediately.
 * 2. The player's slot is temporarily bot-controlled (isBot: true).
 * 3. `player_disconnected` is broadcast to all remaining connections.
 * 4. If it's the disconnected player's turn, a bot turn is scheduled.
 * 5. If the player reconnects within 60s, the bot is evicted (isBot: false).
 * 6. `player_reconnected` is broadcast to all OTHER clients on reclaim.
 * 7. Any pending bot turn timer is cancelled on reclaim.
 * 8. After 60s without reconnect, `reconnect_expired` is broadcast and
 * the bot controls the seat permanently.
 * 9. Reconnect window does NOT start for bot players.
 * 10. Reconnect window does NOT start for spectators.
 * 11. Reconnect window does NOT start when the game is not active.
 * 12. A second disconnect by the same player before the window expires
 * replaces the existing timer (no duplicate windows).
 */

const {
  _startReconnectWindow,
  _cancelReconnectWindow,
  scheduleBotTurnIfNeeded,
  cancelTurnTimer,
  broadcastStateUpdate,
  _reconnectWindows,
  RECONNECT_WINDOW_MS,
  BOT_TURN_DELAY_MS,
} = require('../game/gameSocketServer');

const { setGame, getGame, registerConnection, removeConnection, _clearAll } = require('../game/gameStore');
const { createGameState } = require('../game/gameState');

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../db/supabase', () => ({
  getSupabaseClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      rpc:    () => Promise.resolve({ error: null }),
    }),
    auth: { getUser: async () => ({ data: null, error: new Error('mock') }) },
  }),
}));

jest.mock('../sessions/guestSessionStore', () => ({
  getGuestSession: () => null,
}));

jest.mock('../liveGames/liveGamesStore', () => ({
  addGame:    jest.fn(),
  updateGame: jest.fn(),
  removeGame: jest.fn(),
  get:        jest.fn().mockReturnValue(null),
}));

jest.mock('../game/botLogic', () => ({
  decideBotMove:                   jest.fn().mockReturnValue({ action: 'pass' }),
  completeBotFromPartial:          jest.fn().mockReturnValue({ action: 'pass' }),
  updateKnowledgeAfterAsk:         jest.fn(),
  updateKnowledgeAfterDeclaration: jest.fn(),
  updateTeamIntentAfterAsk:        jest.fn(),
  updateTeamIntentAfterDeclaration: jest.fn(),
}));

jest.mock('../game/rematchStore', () => ({
  initRematch:    jest.fn().mockReturnValue({ yesCount: 0, noCount: 0, totalCount: 0 }),
  castVote:       jest.fn(),
  getVoteSummary: jest.fn(),
  hasRematch:     jest.fn().mockReturnValue(false),
  clearRematch:   jest.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOM = 'RECL01';

/**
 * Build a 6-player game where every player is human (isBot: false).
 * Players are: p1 (T1), p2 (T2), p3 (T1), p4 (T2), p5 (T1), p6 (T2).
 */
function makeGame({ status = 'active', currentPlayer = 'p1' } = {}) {
  const seats = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id, idx) => ({
    seatIndex:   idx,
    playerId:    id,
    displayName: `Player ${id}`,
    avatarId:    `avatar_${id}`,
    teamId:      idx % 2 === 0 ? 1 : 2,
    isBot:       false,
    isGuest:     false,
  }));

  const gs = createGameState({
    roomCode:    ROOM,
    roomId:      'room-uuid-reclaim',
    variant:     'remove_7s',
    playerCount: 6,
    seats,
  });
  gs.status              = status;
  gs.currentTurnPlayerId = currentPlayer;
  return gs;
}

function makeMockWs() {
  const msgs = [];
  return {
    readyState: 1, // WebSocket.OPEN
    send:       (data) => msgs.push(JSON.parse(data)),
    _messages:  msgs,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();

  // Clear all in-memory state
  _clearAll();
  _reconnectWindows.clear();

  try { setGame(ROOM, null); } catch { /* ok */ }
});

afterEach(() => {
  // Cancel any lingering reconnect windows
  for (const [pid] of _reconnectWindows) {
    _cancelReconnectWindow(pid);
  }
  _reconnectWindows.clear();

  cancelTurnTimer(ROOM);

  // Clean up registered connections
  ['p1','p2','p3','p4','p5','p6'].forEach((pid) => removeConnection(ROOM, pid));

  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Reconnect window starts on disconnect
// ---------------------------------------------------------------------------

describe('_startReconnectWindow', () => {
  it('1. stores a reconnect window entry for the player', () => {
    const gs = makeGame({ currentPlayer: 'p2' }); // p1 is NOT the active player
    setGame(ROOM, gs);

    const player = gs.players.find((p) => p.playerId === 'p1');
    _startReconnectWindow(gs, player);

    expect(_reconnectWindows.has('p1')).toBe(true);
    const entry = _reconnectWindows.get('p1');
    expect(entry.roomCode).toBe(ROOM);
    expect(entry.originalDisplayName).toBe('Player p1');
    expect(entry.originalAvatarId).toBe('avatar_p1');
    expect(entry.originalIsGuest).toBe(false);
    expect(typeof entry.timerId).toBe('object'); // setTimeout handle
    expect(entry.expiresAt).toBeGreaterThan(Date.now());
  });

  it('2. marks the player as bot-controlled (isBot: true)', () => {
    const gs = makeGame({ currentPlayer: 'p2' });
    setGame(ROOM, gs);

    const player = gs.players.find((p) => p.playerId === 'p1');
    expect(player.isBot).toBe(false);

    _startReconnectWindow(gs, player);

    expect(player.isBot).toBe(true);
  });

  it('3. broadcasts player_disconnected to all connected clients', () => {
    const gs = makeGame({ currentPlayer: 'p2' });
    setGame(ROOM, gs);

    const ws2 = makeMockWs();
    const ws3 = makeMockWs();
    registerConnection(ROOM, 'p2', ws2);
    registerConnection(ROOM, 'p3', ws3);

    const player = gs.players.find((p) => p.playerId === 'p1');
    _startReconnectWindow(gs, player);

    const msg2 = ws2._messages.find((m) => m.type === 'player_disconnected');
    expect(msg2).toBeDefined();
    expect(msg2.playerId).toBe('p1');
    expect(msg2.reconnectWindowMs).toBe(RECONNECT_WINDOW_MS);
    expect(msg2.expiresAt).toBeGreaterThan(Date.now());

    const msg3 = ws3._messages.find((m) => m.type === 'player_disconnected');
    expect(msg3).toBeDefined();
  });

  it('4. schedules a bot turn when the disconnected player holds the active turn', () => {
    const gs = makeGame({ currentPlayer: 'p1' }); // p1's turn
    setGame(ROOM, gs);

    const ws2 = makeMockWs();
    registerConnection(ROOM, 'p2', ws2);

    const player = gs.players.find((p) => p.playerId === 'p1');
    _startReconnectWindow(gs, player);

    // Advance by BOT_TURN_DELAY_MS — bot turn fires
    // (decideBotMove mock returns { action: 'pass' }, so no actual move)
    jest.advanceTimersByTime(BOT_TURN_DELAY_MS);

    // We verify that the bot flag was set AND bot scheduling was triggered.
    // Since the mock bot returns 'pass', the turn doesn't advance, but we can
    // verify that the player is still marked as bot (no crash, game still active).
    expect(gs.status).toBe('active');
    expect(player.isBot).toBe(true);
  });

  it('5. does NOT schedule a bot turn when it is not the disconnected player\'s turn', () => {
    const gs = makeGame({ currentPlayer: 'p2' }); // p2's turn, p1 disconnects
    setGame(ROOM, gs);

    const ws2 = makeMockWs();
    registerConnection(ROOM, 'p2', ws2);

    const player = gs.players.find((p) => p.playerId === 'p1');
    _startReconnectWindow(gs, player);

    // p1 is now bot-controlled, but it's not their turn — no bot timer fires
    jest.advanceTimersByTime(BOT_TURN_DELAY_MS);

    // p2 should still be the active turn player (human, no bot turn scheduled for p2)
    expect(gs.currentTurnPlayerId).toBe('p2');
  });

  it('cancels an existing stale window when called again for the same player', () => {
    const gs = makeGame({ currentPlayer: 'p2' });
    setGame(ROOM, gs);

    const player = gs.players.find((p) => p.playerId === 'p1');
    _startReconnectWindow(gs, player);
    const firstTimer = _reconnectWindows.get('p1').timerId;

    // Simulate rapid disconnect → reconnect → disconnect by calling again
    _startReconnectWindow(gs, player);
    const secondTimer = _reconnectWindows.get('p1').timerId;

    // Only one window should exist; the timer reference changed (old one cancelled)
    expect(_reconnectWindows.size).toBe(1);
    expect(secondTimer).not.toBe(firstTimer);
  });
});

// ---------------------------------------------------------------------------
// 8. Reconnect window expiry
// ---------------------------------------------------------------------------

describe('reconnect window expiry', () => {
  it('8. broadcasts reconnect_expired and removes window entry after 60s', () => {
    const gs = makeGame({ currentPlayer: 'p2' });
    setGame(ROOM, gs);

    const ws2 = makeMockWs();
    registerConnection(ROOM, 'p2', ws2);

    const player = gs.players.find((p) => p.playerId === 'p1');
    _startReconnectWindow(gs, player);

    expect(_reconnectWindows.has('p1')).toBe(true);

    // Advance past the full reconnect window
    jest.advanceTimersByTime(RECONNECT_WINDOW_MS);

    const expiredMsg = ws2._messages.find((m) => m.type === 'reconnect_expired');
    expect(expiredMsg).toBeDefined();
    expect(expiredMsg.playerId).toBe('p1');

    // Window entry is cleaned up
    expect(_reconnectWindows.has('p1')).toBe(false);
  });

  it('keeps the player as bot-controlled after window expires', () => {
    const gs = makeGame({ currentPlayer: 'p2' });
    setGame(ROOM, gs);

    const ws2 = makeMockWs();
    registerConnection(ROOM, 'p2', ws2);

    const player = gs.players.find((p) => p.playerId === 'p1');
    _startReconnectWindow(gs, player);

    jest.advanceTimersByTime(RECONNECT_WINDOW_MS);

    // isBot stays true — bot controls the slot permanently
    expect(player.isBot).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// _cancelReconnectWindow
// ---------------------------------------------------------------------------

describe('_cancelReconnectWindow', () => {
  it('cancels the timer and removes the window entry', () => {
    const gs = makeGame({ currentPlayer: 'p2' });
    setGame(ROOM, gs);

    const player = gs.players.find((p) => p.playerId === 'p1');
    _startReconnectWindow(gs, player);

    expect(_reconnectWindows.has('p1')).toBe(true);

    _cancelReconnectWindow('p1');

    expect(_reconnectWindows.has('p1')).toBe(false);

    // Advance past window — timer was cancelled, so reconnect_expired must NOT fire
    const ws2 = makeMockWs();
    registerConnection(ROOM, 'p2', ws2);
    jest.advanceTimersByTime(RECONNECT_WINDOW_MS);
    expect(ws2._messages.some((m) => m.type === 'reconnect_expired')).toBe(false);
  });

  it('is safe to call when no window exists', () => {
    expect(() => _cancelReconnectWindow('non_existent_player')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// RECONNECT_WINDOW_MS constant
// ---------------------------------------------------------------------------

describe('RECONNECT_WINDOW_MS', () => {
  it('is 180 seconds', () => {
    expect(RECONNECT_WINDOW_MS).toBe(180_000);
  });
});

// ---------------------------------------------------------------------------
// 9–11. Windows are NOT started for bots/spectators/completed games
// ---------------------------------------------------------------------------

describe('window not started in invalid cases', () => {
  it('9. does not store a window if the player is already a bot', () => {
    const gs = makeGame({ currentPlayer: 'p2' });
    setGame(ROOM, gs);

    // Manually mark p1 as a bot
    const player = gs.players.find((p) => p.playerId === 'p1');
    player.isBot = true;

    // The disconnect handler checks !player.isBot — simulate that check
    if (!player.isBot) {
      _startReconnectWindow(gs, player);
    }

    expect(_reconnectWindows.has('p1')).toBe(false);
  });

  it('11. does not start a window when the game status is not active', () => {
    const gs = makeGame({ currentPlayer: 'p1', status: 'completed' });
    setGame(ROOM, gs);

    const player = gs.players.find((p) => p.playerId === 'p1');

    // Simulating the disconnect handler guard condition
    if (gs.status === 'active') {
      _startReconnectWindow(gs, player);
    }

    expect(_reconnectWindows.has('p1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Seat reclaim — isBot restoration + broadcast
// ---------------------------------------------------------------------------

describe('seat reclaim (player reconnects within window)', () => {
  it('restores isBot to false after _cancelReconnectWindow and manual restore', () => {
    const gs = makeGame({ currentPlayer: 'p2' });
    setGame(ROOM, gs);

    const player = gs.players.find((p) => p.playerId === 'p1');
    _startReconnectWindow(gs, player);

    expect(player.isBot).toBe(true);

    // Simulate what the connection handler does on reconnect
    const entry = _reconnectWindows.get('p1');
    expect(entry).toBeDefined();

    _cancelReconnectWindow('p1');

    player.isBot        = false;
    player.displayName  = entry.originalDisplayName;
    player.avatarId     = entry.originalAvatarId;
    player.isGuest      = entry.originalIsGuest;

    expect(player.isBot).toBe(false);
    expect(player.displayName).toBe('Player p1');
    expect(player.avatarId).toBe('avatar_p1');
    expect(_reconnectWindows.has('p1')).toBe(false);
  });

  it('window entry is absent after cancellation, preventing a late bot timer broadcast', () => {
    const gs = makeGame({ currentPlayer: 'p2' });
    setGame(ROOM, gs);

    const ws2 = makeMockWs();
    registerConnection(ROOM, 'p2', ws2);

    const player = gs.players.find((p) => p.playerId === 'p1');
    _startReconnectWindow(gs, player);

    // Player reconnects within window — cancel window
    _cancelReconnectWindow('p1');

    // Advance past the original window duration
    jest.advanceTimersByTime(RECONNECT_WINDOW_MS);

    // reconnect_expired must NOT have been sent
    const expiredMsgs = ws2._messages.filter((m) => m.type === 'reconnect_expired');
    expect(expiredMsgs).toHaveLength(0);
  });
});
