'use strict';

const express = require('express');
const request = require('supertest');
const rooms = require('../routes/rooms');
const { _setSupabaseClient } = require('../db/supabase');
const { createGuestSession, _clearStore } = require('../sessions/guestSessionStore');
const { roomClients, _resetRoomState } = require('../ws/roomSocketServer');

const code = 'ROOM01';
const app = express().use('/api/rooms', rooms);
let host, guestSocket, db;

beforeEach(() => {
  host = createGuestSession('Host');
  guestSocket = { readyState: 1, send: jest.fn(), close: jest.fn() };
  roomClients.set(code, new Map([['guest', { ws: guestSocket }]]));
  db = {
    from: jest.fn().mockReturnThis(), update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(), in: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(), maybeSingle: jest.fn(),
  };
  _setSupabaseClient(db);
});

afterEach(() => {
  _resetRoomState();
  _clearStore();
  _setSupabaseClient(null);
  jest.useRealTimers();
});

function _abandon() {
  return request(app).post('/api/rooms/ROOM01/abandon').set('Authorization', `Bearer ${host.token}`);
}

test('a committed cancellation closes the guest socket even if the write response is lost', async () => {
  db.maybeSingle.mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce({
    data: { status: 'cancelled', host_guest_id: host.session.sessionId, is_matchmaking: false },
  });
  expect((await _abandon()).status).toBe(200);
  expect(guestSocket.close).toHaveBeenCalledWith(4005, 'Lobby closed');
});

test('a failed write leaves the original waiting lobby connected', async () => {
  db.maybeSingle.mockRejectedValueOnce(new Error('failed write')).mockResolvedValueOnce({
    data: { status: 'waiting', host_guest_id: host.session.sessionId, is_matchmaking: false },
  });
  expect((await _abandon()).status).toBe(503);
  expect(guestSocket.close).not.toHaveBeenCalled();
  expect(db.update).toHaveBeenCalledTimes(1);
});

test('connected guests receive closure once the database recovers without another host request', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  db.maybeSingle.mockRejectedValueOnce(new Error('lost response'))
    .mockResolvedValueOnce({ error: new Error('offline') })
    .mockResolvedValueOnce({ data: { status: 'cancelled', host_guest_id: host.session.sessionId, is_matchmaking: false } });
  expect((await _abandon()).status).toBe(503);
  expect(guestSocket.close).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(15_000);
  expect(guestSocket.close).toHaveBeenCalledWith(4005, 'Lobby closed');
  expect(db.update).toHaveBeenCalledTimes(1);
});
