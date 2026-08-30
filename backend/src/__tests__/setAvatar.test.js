'use strict';

const {
  handleSetAvatar,
  roomClients,
  roomMeta,
  _resetRoomState,
  _setSupabaseClientFactory,
} = require('../ws/roomSocketServer');
const {
  createGuestSession,
  getGuestSession,
  _clearStore,
} = require('../sessions/guestSessionStore');

function createMockWs() {
  return { readyState: 1, send: jest.fn(), close: jest.fn() };
}

function lastSent(ws) {
  const calls = ws.send.mock.calls;
  return calls.length ? JSON.parse(calls[calls.length - 1][0]) : null;
}

const ROOM = 'AVATAR';

beforeEach(() => {
  _resetRoomState();
  _clearStore();
  _setSupabaseClientFactory(null);
});

function seed(entries) {
  roomClients.set(ROOM, new Map(entries.map((e) => [e.userId, { ...e }])));
  roomMeta.set(ROOM, { playerCount: 6 });
  return roomClients.get(ROOM);
}

describe('handleSetAvatar', () => {
  it('updates the entry, persists to the guest session, and broadcasts room_players', () => {
    const { token, session } = createGuestSession('Alice');
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    const clients = seed([
      { ws: ws1, userId: session.sessionId, displayName: 'Alice', avatarId: 'avatar-1', isGuest: true, isHost: true, teamId: 1 },
      { ws: ws2, userId: 'p2', displayName: 'Bob', avatarId: 'avatar-1', isGuest: true, isHost: false, teamId: 2 },
    ]);

    handleSetAvatar(
      { ws: ws1, userId: session.sessionId, roomCode: ROOM, clients },
      { type: 'set_avatar', avatarId: 'avatar-5' },
    );

    expect(clients.get(session.sessionId).avatarId).toBe('avatar-5');
    expect(getGuestSession(token).avatarId).toBe('avatar-5');
    const msg = lastSent(ws2);
    expect(msg.type).toBe('room_players');
    expect(msg.players.find((p) => p.userId === session.sessionId).avatarId).toBe('avatar-5');
  });

  it('rejects an invalid avatarId without broadcasting', () => {
    const ws1 = createMockWs();
    const clients = seed([
      { ws: ws1, userId: 'p1', displayName: 'Alice', avatarId: 'avatar-1', isGuest: true, isHost: true, teamId: 1 },
    ]);

    handleSetAvatar(
      { ws: ws1, userId: 'p1', roomCode: ROOM, clients },
      { type: 'set_avatar', avatarId: 'avatar-42' },
    );

    expect(clients.get('p1').avatarId).toBe('avatar-1');
    expect(lastSent(ws1).type).toBe('error');
  });

  it('is a no-op when the avatar is unchanged', () => {
    const ws1 = createMockWs();
    const clients = seed([
      { ws: ws1, userId: 'p1', displayName: 'Alice', avatarId: 'avatar-3', isGuest: true, isHost: true, teamId: 1 },
    ]);

    handleSetAvatar(
      { ws: ws1, userId: 'p1', roomCode: ROOM, clients },
      { type: 'set_avatar', avatarId: 'avatar-3' },
    );

    expect(ws1.send).not.toHaveBeenCalled();
  });
});
