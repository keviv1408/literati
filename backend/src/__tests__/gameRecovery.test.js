'use strict';

jest.useFakeTimers();

jest.mock('../db/supabase', () => ({
  getSupabaseClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: { getUser: async () => ({ data: null, error: new Error('mock') }) },
  }),
}));

jest.mock('../sessions/guestSessionStore', () => ({ getGuestSession: () => null }));

const mockLiveGamesStore = {
  addGame:    jest.fn(),
  updateGame: jest.fn(),
  removeGame: jest.fn(),
  get:        jest.fn().mockReturnValue(undefined),
};
jest.mock('../liveGames/liveGamesStore', () => mockLiveGamesStore);

const { recoverGame, cancelBotTimer } = require('../game/gameSocketServer');

describe('recoverGame', () => {
  afterEach(() => {
    cancelBotTimer('RECOVR');
    jest.clearAllTimers();
    jest.clearAllMocks();
    mockLiveGamesStore.get.mockReturnValue(undefined);
  });

  it('rehydrates the live-games store and resumes bot timers for recovered active games', () => {
    const snapshot = {
      variant: 'remove_7s',
      playerCount: 6,
      status: 'active',
      currentTurnPlayerId: 'bot-1',
      players: [
        { playerId: 'bot-1', displayName: 'Bot 1', teamId: 1, seatIndex: 0, isBot: true, isGuest: false },
        { playerId: 'p2', displayName: 'P2', teamId: 1, seatIndex: 2, isBot: false, isGuest: false },
        { playerId: 'p3', displayName: 'P3', teamId: 1, seatIndex: 4, isBot: false, isGuest: false },
        { playerId: 'p4', displayName: 'P4', teamId: 2, seatIndex: 1, isBot: false, isGuest: false },
        { playerId: 'p5', displayName: 'P5', teamId: 2, seatIndex: 3, isBot: false, isGuest: false },
        { playerId: 'p6', displayName: 'P6', teamId: 2, seatIndex: 5, isBot: false, isGuest: false },
      ],
      hands: {
        'bot-1': ['1_s'],
        p2: ['2_s'],
        p3: ['3_s'],
        p4: ['4_s'],
        p5: ['5_s'],
        p6: ['6_s'],
      },
      declaredSuits: {},
      scores: { team1: 1, team2: 0 },
      lastMove: 'Recovered game',
      winner: null,
      tiebreakerWinner: null,
      moveHistory: [],
      eliminatedPlayerIds: [],
      turnRecipients: {},
    };

    recoverGame('RECOVR', 'room-id', snapshot);

    expect(mockLiveGamesStore.addGame).toHaveBeenCalledWith(
      expect.objectContaining({
        roomCode: 'RECOVR',
        playerCount: 6,
        currentPlayers: 5,
        cardVariant: 'remove_7s',
        scores: { team1: 1, team2: 0 },
        status: 'in_progress',
      })
    );
    expect(jest.getTimerCount()).toBeGreaterThan(0);
  });
});
