'use strict';

const mockRemoveGame = jest.fn();
const mockUpdateIn = jest.fn().mockResolvedValue({ error: null });
const mockUpdateEq = jest.fn();
const mockUpdate = jest.fn();

jest.mock('../db/supabase', () => ({
  getSupabaseClient: () => ({
    from: () => ({
      update: mockUpdate,
    }),
    auth: { getUser: async () => ({ data: null, error: new Error('mock') }) },
  }),
}));

jest.mock('../sessions/guestSessionStore', () => ({
  getGuestSession: () => null,
}));

jest.mock('../liveGames/liveGamesStore', () => ({
  addGame: jest.fn(),
  updateGame: jest.fn(),
  removeGame: mockRemoveGame,
  get: jest.fn().mockReturnValue(null),
}));

jest.mock('../game/botLogic', () => ({
  decideBotMove: jest.fn().mockReturnValue({ action: 'pass' }),
  completeBotFromPartial: jest.fn().mockReturnValue({ action: 'pass' }),
  updateKnowledgeAfterAsk: jest.fn(),
  updateKnowledgeAfterDeclaration: jest.fn(),
  updateTeamIntentAfterAsk: jest.fn(),
  updateTeamIntentAfterDeclaration: jest.fn(),
}));

jest.mock('../game/rematchStore', () => ({
  initRematch: jest.fn().mockReturnValue({ yesCount: 0, noCount: 0, totalCount: 0 }),
  castVote: jest.fn(),
  getVoteSummary: jest.fn(),
  hasRematch: jest.fn().mockReturnValue(false),
  clearRematch: jest.fn(),
}));

const {
  _startReconnectWindow,
  _clearAllReconnectWindows,
  cancelBotTimer,
  cancelTurnTimer,
  RECONNECT_WINDOW_MS,
} = require('../game/gameSocketServer');
const { setGame, getGame, registerConnection, removeConnection, _clearAll } = require('../game/gameStore');
const { createGameState } = require('../game/gameState');

const ROOM = 'BOTEND';

function makeGame() {
  const seats = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id, idx) => ({
    seatIndex: idx,
    playerId: id,
    displayName: `Player ${id}`,
    avatarId: null,
    teamId: idx % 2 === 0 ? 1 : 2,
    isBot: false,
    isGuest: false,
  }));

  const gs = createGameState({
    roomCode: ROOM,
    roomId: 'room-uuid-bot-end',
    variant: 'remove_7s',
    playerCount: 6,
    seats,
  });

  gs.status = 'active';
  gs.currentTurnPlayerId = 'nobody';
  return gs;
}

function makeMockWs() {
  const msgs = [];
  return {
    readyState: 1,
    send: (data) => msgs.push(JSON.parse(data)),
    _messages: msgs,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();

  let lastUpdatePayload = null;
  mockUpdate.mockImplementation((payload) => {
    lastUpdatePayload = payload;
    mockUpdateEq.mockImplementation(() => (
      lastUpdatePayload?.status === 'abandoned'
        ? { in: mockUpdateIn }
        : Promise.resolve({ error: null })
    ));
    return { eq: mockUpdateEq };
  });

  _clearAll();
  _clearAllReconnectWindows();
});

afterEach(() => {
  _clearAllReconnectWindows();
  cancelBotTimer(ROOM);
  cancelTurnTimer(ROOM);
  removeConnection(ROOM, 'spectator-1');
  jest.useRealTimers();
});

describe('automatic all-bot abandonment', () => {
  it('abandons the game after the last reconnect window closes with no humans left', async () => {
    const gs = makeGame();
    const spectatorWs = makeMockWs();

    setGame(ROOM, gs);
    registerConnection(ROOM, 'spectator-1', spectatorWs);

    for (const player of gs.players) {
      _startReconnectWindow(gs, player);
    }

    jest.advanceTimersByTime(RECONNECT_WINDOW_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(getGame(ROOM)).toBeUndefined();
    expect(mockRemoveGame).toHaveBeenCalledWith(ROOM);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'abandoned',
        game_state: expect.objectContaining({ status: 'abandoned' }),
      })
    );
    expect(mockUpdateIn).toHaveBeenCalledWith(
      'status',
      ['in_progress', 'starting', 'waiting']
    );

    const stateMessages = spectatorWs._messages.filter((msg) => msg.type === 'game_state');
    expect(stateMessages.at(-1)?.state?.status).toBe('abandoned');
    expect(
      spectatorWs._messages.some(
        (msg) => msg.type === 'room_dissolved' && msg.reason === 'all_bots'
      )
    ).toBe(true);
  });

  it('waits for the final reconnect window instead of abandoning on the first expiry', async () => {
    const gs = makeGame();
    const spectatorWs = makeMockWs();

    setGame(ROOM, gs);
    registerConnection(ROOM, 'spectator-1', spectatorWs);

    _startReconnectWindow(gs, gs.players[0]);
    jest.advanceTimersByTime(10_000);

    for (const player of gs.players.slice(1)) {
      _startReconnectWindow(gs, player);
    }

    jest.advanceTimersByTime(RECONNECT_WINDOW_MS - 10_000);
    await Promise.resolve();

    expect(getGame(ROOM)).toBeDefined();
    expect(mockRemoveGame).not.toHaveBeenCalled();
    expect(
      spectatorWs._messages.some(
        (msg) => msg.type === 'room_dissolved' && msg.reason === 'all_bots'
      )
    ).toBe(false);
  });
});
