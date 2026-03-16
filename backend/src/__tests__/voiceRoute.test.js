'use strict';

const express = require('express');
const request = require('supertest');

let mockUser = null;
const mockGetGame = jest.fn();
const mockJoinRoom = jest.fn();

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    if (!mockUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = mockUser;
    return next();
  },
}));

jest.mock('../game/gameStore', () => ({
  getGame: (...args) => mockGetGame(...args),
}));

jest.mock('../lib/daily', () => ({
  joinRoom: (...args) => mockJoinRoom(...args),
}));

const voiceRouter = require('../routes/voice');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rooms', voiceRouter);
  return app;
}

function buildGame(players) {
  return {
    roomCode: 'ABC123',
    status: 'active',
    players,
  };
}

describe('voice route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = {
      id: 'player-1',
      displayName: 'Alice',
      isGuest: false,
    };
  });

  it('returns 400 for an invalid room code', async () => {
    const app = buildApp();

    const response = await request(app)
      .post('/api/rooms/not-a-code/voice/join')
      .set('Authorization', 'Bearer test-token');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/invalid room code/i);
    expect(mockGetGame).not.toHaveBeenCalled();
  });

  it('returns 409 when there is no active game for the room', async () => {
    mockGetGame.mockReturnValue(undefined);
    const app = buildApp();

    const response = await request(app)
      .post('/api/rooms/abc123/voice/join')
      .set('Authorization', 'Bearer test-token');

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('Voice unavailable');
    expect(mockGetGame).toHaveBeenCalledWith('ABC123');
    expect(mockJoinRoom).not.toHaveBeenCalled();
  });

  it('returns 403 when the requester is not a player in the game', async () => {
    mockGetGame.mockReturnValue(
      buildGame([
        { playerId: 'player-2', displayName: 'Bob', isBot: false },
      ]),
    );

    const app = buildApp();
    const response = await request(app)
      .post('/api/rooms/ABC123/voice/join')
      .set('Authorization', 'Bearer test-token');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
    expect(mockJoinRoom).not.toHaveBeenCalled();
  });

  it('mints a Daily join session for a matching player', async () => {
    mockGetGame.mockReturnValue(
      buildGame([
        { playerId: 'player-1', displayName: 'Alice', isBot: false },
        { playerId: 'player-2', displayName: 'Bob', isBot: false },
      ]),
    );
    mockJoinRoom.mockResolvedValue({
      roomName: 'literati-voice-ABC123',
      roomUrl: 'https://literati.daily.co/literati-voice-ABC123',
      meetingToken: 'token-123',
      expiresAt: '2026-03-16T10:00:00.000Z',
    });

    const app = buildApp();
    const response = await request(app)
      .post('/api/rooms/abc123/voice/join')
      .set('Authorization', 'Bearer test-token');

    expect(response.status).toBe(200);
    expect(response.body.meetingToken).toBe('token-123');
    expect(mockJoinRoom).toHaveBeenCalledWith({
      roomCode: 'ABC123',
      userId: 'player-1',
      userName: 'Alice',
    });
  });

  it('uses the guest session id for guest players', async () => {
    mockUser = {
      sessionId: 'guest-player-1',
      displayName: 'Guest Alice',
      isGuest: true,
    };
    mockGetGame.mockReturnValue(
      buildGame([
        { playerId: 'guest-player-1', displayName: 'Guest Alice', isBot: false },
      ]),
    );
    mockJoinRoom.mockResolvedValue({
      roomName: 'literati-voice-ABC123',
      roomUrl: 'https://literati.daily.co/literati-voice-ABC123',
      meetingToken: 'token-123',
      expiresAt: '2026-03-16T10:00:00.000Z',
    });

    const app = buildApp();
    const response = await request(app)
      .post('/api/rooms/ABC123/voice/join')
      .set('Authorization', 'Bearer guest-token');

    expect(response.status).toBe(200);
    expect(mockJoinRoom).toHaveBeenCalledWith({
      roomCode: 'ABC123',
      userId: 'guest-player-1',
      userName: 'Guest Alice',
    });
  });

  it('surfaces Daily configuration failures as 503', async () => {
    mockGetGame.mockReturnValue(
      buildGame([
        { playerId: 'player-1', displayName: 'Alice', isBot: false },
      ]),
    );
    mockJoinRoom.mockRejectedValue(
      Object.assign(new Error('Daily is not configured'), { statusCode: 503 }),
    );

    const app = buildApp();
    const response = await request(app)
      .post('/api/rooms/ABC123/voice/join')
      .set('Authorization', 'Bearer test-token');

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('Voice unavailable');
    expect(response.body.message).toMatch(/configured/i);
  });
});
