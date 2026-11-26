import { expect, test } from '@playwright/test';
import type { Closed, GameSocket, Msg } from '../../tests/helpers/gameWire';
import { scanDrops, scanFrames } from '../lib/checks';
import { SoakFailure } from '../lib/fail';

const _INIT: Msg = { type: 'game_init', myPlayerId: 'p0', players: [{ playerId: 'p0', isBot: false }] };

function _socket(msgs: Msg[], extra: { cut?: boolean; closed?: Closed } = {}): GameSocket {
  return {
    index: 0,
    openedAt: 0,
    page: null as never,
    server: null,
    cut: extra.cut ?? false,
    closed: extra.closed ?? null,
    frames: msgs.map((msg, at) => ({ at, msg })),
  };
}

function _closed(code: number): Closed {
  return { by: 'server', code, reason: 'test', at: 0 };
}

function _table(socket: GameSocket) {
  return { seats: [{ index: 3, name: 'Soak 4', wire: { sockets: [socket], refusing: false }, read: new Map<GameSocket, number>() }] };
}

function _scan(socket: GameSocket) {
  return () => scanFrames(_table(socket));
}

function _seat(sockets: GameSocket[]) {
  sockets.forEach((socket, index) => (socket.index = index));
  return { index: 3, name: 'Soak 4', wire: { sockets, refusing: false } };
}

function _gone(reason: string): Closed {
  return { by: 'server', code: 1006, reason, at: 0 };
}

test('a forbidden frame before a result is still caught', () => {
  const socket = _socket([_INIT, { type: 'bot_takeover', playerId: 'p0' }, { type: 'ask_result', askerId: 'p0' }]);
  expect(_scan(socket)).toThrow(SoakFailure);
  expect(_scan(socket)).toThrow(/^seat 3 \(Soak 4\) .*bot_takeover/);
});

test('a bot in a player list fails', () => {
  expect(_scan(_socket([_INIT, { type: 'game_players', players: [{ playerId: 'p0', isBot: true }] }]))).toThrow(SoakFailure);
});

test('a choice made by the timeout fails', () => {
  const selected = { type: 'post_declaration_turn_selected', selectedPlayerId: 'p2', reason: 'timeout' };
  expect(_scan(_socket([_INIT, selected]))).toThrow(/timeout/);
  expect(_scan(_socket([_INIT, { ...selected, reason: 'player_choice' }]))).not.toThrow();
});

test('an error before game_init is allowed', () => {
  const socket = _socket([{ type: 'error', code: 'SERVER_ERROR', message: 'x' }], { closed: _closed(4500) });
  expect(_scan(socket)).not.toThrow();
});

test('an error after game_init fails', () => {
  expect(_scan(_socket([_INIT, { type: 'error', code: 'NOT_YOUR_TURN', message: 'x' }]))).toThrow(/NOT_YOUR_TURN/);
});

test('a closing 4006 on an uncut socket fails', () => {
  expect(_scan(_socket([_INIT, { type: 'closing', code: 4006, reason: 'x' }]))).toThrow(/4006/);
  expect(_scan(_socket([_INIT], { closed: _closed(4006) }))).toThrow(/4006/);
});

test('a closing 4500 does not', () => {
  expect(_scan(_socket([_INIT, { type: 'closing', code: 4500, reason: 'x' }], { closed: _closed(4500) }))).not.toThrow();
});

test("a cut socket's close is ignored", () => {
  expect(_scan(_socket([_INIT], { cut: true, closed: _closed(4006) }))).not.toThrow();
});

test('scanning twice reads nothing twice', () => {
  const socket = _socket([_INIT, { type: 'ask_result', askerId: 'p0' }]);
  const table = _table(socket);
  scanFrames(table);
  expect(table.seats[0].read.get(socket)).toBe(2);
  // A frame already passed is not read again, so changing it behind the mark goes unseen.
  socket.frames[1].msg = { type: 'bot_takeover', playerId: 'p0' };
  expect(() => scanFrames(table)).not.toThrow();
  socket.frames.push({ at: 2, msg: { type: 'reconnect_expired', playerId: 'p0' } });
  expect(() => scanFrames(table)).toThrow(/reconnect_expired/);
});

test('a socket that closes without a cut is a drop', () => {
  const seat = _seat([_socket([_INIT]), _socket([_INIT], { closed: _gone('') })]);
  expect(() => scanDrops(seat, -1, { move: 5 })).toThrow(
    new SoakFailure('seat 3 (Soak 4) dropped without a kill: socket #1 closed by the server with 1006 (move 5)'),
  );
});

test('a kill covers its cut socket, the refused ones and the retries before the seat came back', () => {
  const kill = _socket([_INIT], { cut: true });
  const refused = _socket([], { closed: _gone('refused') });
  const retry = _socket([{ type: 'error', code: 'SERVER_ERROR', message: 'x' }], { closed: _closed(4500) });
  const back = _socket([_INIT]);
  const seat = _seat([kill, refused, retry, back]);
  expect(() => scanDrops(seat, back.index - 1)).not.toThrow();
  // Without the kill's cover, the refused socket is the first drop.
  expect(() => scanDrops(seat, kill.index)).toThrow(/socket #1 closed by the server with 1006 refused/);
});

test("a freeze's cut socket and a live one are not drops", () => {
  expect(() => scanDrops(_seat([_socket([_INIT], { cut: true }), _socket([_INIT])]), -1)).not.toThrow();
});

test('a socket the seat came back on that drops again is a drop', () => {
  const seat = _seat([_socket([_INIT], { cut: true }), _socket([_INIT], { closed: _gone('') })]);
  expect(() => scanDrops(seat, 0)).toThrow(/socket #1/);
});
