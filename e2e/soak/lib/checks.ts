import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from '@playwright/test';
import { findFrame, type Frame, type GameSocket, type Msg } from '../../tests/helpers/gameWire';
import type { GameResult, KillRecord } from './driver';
import { failure } from './fail';
import { AFTER_MOVE_POLL_MS, BACKEND_URL, FINAL_SAVE_MS, FINAL_SCREEN_POLL_MS } from './limits';
import type { Team } from './model';
import type { Kill } from './plan';
import { liveSocket, nameOf, type Seat, type Table } from './seats';
import type { Stack } from './stack';

export const ERROR_VIEWS = [
  'ws-error-banner',
  'generic-error-view',
  'server-unreachable-view',
  'not-found-view',
  'abandoned-view',
  'cancelled-view',
  'invalid-format-view',
];

declare global {
  interface Window {
    __e2e?: number;
    __errorViews?: string[];
  }
}

type _ScanSeat = Pick<Seat, 'index' | 'name' | 'wire' | 'read'>;

interface _PageRead {
  marker: number | undefined;
  views: string[];
  hand: string[] | null;
  books: { team1: string[]; team2: string[] };
  activeTurn: string[];
  gameOver: { team1: string; team2: string } | null;
  reconnecting: boolean;
}

interface _Where {
  seat: Seat;
  kill?: Kill;
  move?: number;
}

// Each means a bot or a server clock acted for a human, which a six-human game with no lost clock never needs.
const _FORBIDDEN = ['bot_takeover', 'player_disconnected', 'reconnect_expired'];
const _SERVER_ERROR_CODE = 4500;
const _HALF_SUITS = 8;
const _POLL_MS = 100;

export async function installPageObserver(page: Page): Promise<void> {
  await page.evaluate((ids) => {
    const views: string[] = (window.__errorViews = []);
    const selector = ids.map((id) => `[data-testid="${id}"]`).join(',');
    const note = (id: string | null) => {
      if (id !== null && ids.includes(id)) views.push(id);
    };
    const noteTree = (node: Node) => {
      if (!(node instanceof Element)) return;
      if (node.matches(selector)) note(node.getAttribute('data-testid'));
      node.querySelectorAll(selector).forEach((found) => note(found.getAttribute('data-testid')));
    };
    noteTree(document.body);
    // React swaps data-testid on reused nodes and a view can vanish before the callback, so read the records.
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          note(record.oldValue);
          note((record.target as Element).getAttribute('data-testid'));
        } else {
          record.addedNodes.forEach(noteTree);
        }
      }
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-testid'],
      attributeOldValue: true,
    });
  }, ERROR_VIEWS);
}

export async function pageProblems(seat: Seat, gameUrl: string): Promise<string[]> {
  const seen = await _readPage(seat.page);
  return typeof seen === 'string' ? [seen] : _pageLines(seat, gameUrl, seen);
}

export function scanFrames(table: { seats: _ScanSeat[] }, where: { move?: number } = {}): void {
  for (const seat of table.seats) {
    for (const socket of seat.wire.sockets) {
      const end = socket.frames.length;
      const initAt = socket.frames.findIndex(({ msg }) => msg.type === 'game_init');
      for (let i = seat.read.get(socket) ?? 0; i < end; i++) {
        const problem = _frameProblem(socket.frames[i].msg, initAt !== -1 && initAt < i);
        if (problem) throw failure(`socket #${socket.index} got ${problem}`, { seat, ...where });
      }
      seat.read.set(socket, end);
      if (!socket.cut && socket.closed && _isStopCode(socket.closed.code)) {
        const { code, by, reason } = socket.closed;
        throw failure(`socket #${socket.index} closed by the ${by} with ${code} ${reason}`, { seat, ...where });
      }
    }
  }
}

// A socket closed without a cut is a dropped player unless a kill or a restart covers it.
export function scanDrops(seat: Pick<Seat, 'index' | 'name' | 'wire'>, coveredTo: number, where: { move?: number } = {}): void {
  const dropped = seat.wire.sockets.find((socket) => socket.index > coveredTo && socket.closed !== null && !socket.cut);
  if (!dropped) return;
  const { by, code, reason } = dropped.closed!;
  throw failure(`dropped without a kill: socket #${dropped.index} closed by the ${by} with ${code}${reason ? ` ${reason}` : ''}`, { seat, ...where });
}

export async function afterMove(table: Table, move?: number): Promise<void> {
  await Promise.all(
    table.seats.filter((seat) => liveSocket(seat)).map((seat) => _poll({ seat, move }, () => _afterMoveProblems(table, seat))),
  );
}

export async function afterRecovery(table: Table, seat: Seat, record: KillRecord, move?: number): Promise<void> {
  const where = { seat, kill: record.kill, move };
  const socket = liveSocket(seat);
  if (!socket) throw failure('went down again before its recovery check', where);
  const init = findFrame(socket, 'game_init')!;
  const me = init.msg.players.find((p: Msg) => p.playerId === init.msg.myPlayerId);
  if (init.msg.myPlayerId !== seat.playerId || me?.seatIndex !== seat.seatIndex) {
    throw failure(`came back as ${init.msg.myPlayerId} in seat ${me?.seatIndex}, expected ${seat.playerId} in seat ${seat.seatIndex}`, where);
  }
  const problem = _initProblem(table, seat, socket, init);
  if (problem) throw failure(problem, where);
  await _poll(where, () => _afterMoveProblems(table, seat));
}

export async function atEnd(table: Table, stack: Stack, result: GameResult, plan: Kill[]): Promise<void> {
  const { model } = table;
  const where = { move: result.moves };
  scanFrames(table, where);
  if (model.declared.size !== _HALF_SUITS) {
    throw failure(`end: ${model.declared.size} half-suits declared, expected ${_HALF_SUITS}`, where);
  }
  const { team1, team2 } = result.scores;
  if (team1 + team2 !== _HALF_SUITS || team1 !== model.scores.team1 || team2 !== model.scores.team2) {
    throw failure(`end: result scores ${team1}-${team2}, model ${_score(model.scores)}`, where);
  }
  await Promise.all(table.seats.map((seat) =>
    _poll({ seat, move: result.moves }, () => _endProblems(table, seat), FINAL_SCREEN_POLL_MS),
  ));
  await _savedSummary(table, where);

  const ran = new Set(result.kills.map((record) => record.kill.id));
  const missing = plan.filter((kill) => !ran.has(kill.id));
  if (missing.length > 0) {
    throw failure(`end: ${missing.map((kill) => `${kill.kind} #${kill.id}`).join(', ')} never ran`, where);
  }
  for (const record of result.kills) {
    const { kill } = record;
    if (kill.kind !== 'freeze' && kill.kind !== 'refuse') continue;
    if (record.movesMadeWhileDown === 0 && !record.heldTurnThroughout) {
      throw failure('no move settled while the seat was down', { seat: table.seats[kill.seat as number], kill, move: record.ranAtMove });
    }
  }
  const report = await stack.standinReport();
  if (report.unknown.length > 0 || report.refused.length > 0) {
    throw failure(`end: the stand-in saw unknown ${JSON.stringify(report.unknown)} and refused ${JSON.stringify(report.refused)}`, where);
  }
  scanFrames(table, where);
}

function _frameProblem(msg: Msg, afterInit: boolean): string | null {
  if (_FORBIDDEN.includes(msg.type)) return `${msg.type}${msg.playerId ? ` for ${msg.playerId}` : ''}`;
  if (Array.isArray(msg.players) && msg.players.some((p: Msg) => p?.isBot === true)) return `${msg.type} with a bot seated`;
  if (msg.type === 'post_declaration_turn_selected' && msg.reason === 'timeout') return `${msg.type} with reason timeout`;
  // Before game_init an error is the server's own retryable refusal, followed by a 4500 close.
  if (msg.type === 'error' && afterInit) return `error ${msg.code}: ${msg.message}`;
  if (msg.type === 'closing' && _isStopCode(msg.code)) return `closing ${msg.code} ${msg.reason ?? ''}`.trimEnd();
  return null;
}

// The client's own rule: these codes stop it from reconnecting.
function _isStopCode(code: number): boolean {
  return code >= 4000 && code <= 4999 && code !== _SERVER_ERROR_CODE;
}

async function _poll(where: _Where, read: () => Promise<string[]>, timeoutMs = AFTER_MOVE_POLL_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const problems = await read();
    if (problems.length === 0) return;
    if (Date.now() >= deadline) throw failure(`${problems.join('; ')} (still after ${timeoutMs / 1000} s)`, where);
    await sleep(_POLL_MS);
  }
}

async function _afterMoveProblems(table: Table, seat: Seat): Promise<string[]> {
  const { model } = table;
  const socket = liveSocket(seat);
  if (!socket) return ['its socket went down'];
  const name = (playerId: string) => nameOf(table, playerId);
  const hand = [...(model.hands.get(seat.playerId) ?? [])].sort();
  const declared = _declaredByTeam(model.declared);
  const problems: string[] = [];

  const handFrame = _lastHand(socket);
  if (!_same(handFrame, hand)) problems.push(`hand frame ${_list(handFrame)}, model ${_list(hand)}`);
  const state = _lastState(socket);
  if (state.currentTurnPlayerId !== model.turn) {
    problems.push(`game_state turn on ${name(state.currentTurnPlayerId)}, model ${name(model.turn)}`);
  }
  if (_score(state.scores) !== _score(model.scores)) problems.push(`game_state score ${_score(state.scores)}, model ${_score(model.scores)}`);
  const stateDeclared = _declaredByTeam(new Map(state.declaredSuits.map((d: Msg) => [d.halfSuitId, d.teamId])));
  if (!_sameBooks(stateDeclared, declared)) {
    problems.push(`game_state declared ${_books(stateDeclared)}, model ${_books(declared)}`);
  }

  const seen = await _readPage(seat.page);
  if (typeof seen === 'string') return [...problems, seen];
  problems.push(..._pageLines(seat, table.gameUrl, seen));
  if (seen.hand === null) problems.push('the page shows no hand');
  else if (!_same(seen.hand, hand)) problems.push(`page hand ${_list(seen.hand)}, model ${_list(hand)}`);
  if (!_sameBooks(seen.books, declared)) problems.push(`page books ${_books(seen.books)}, model ${_books(declared)}`);
  // A wire move never calls the page's clearIndicator, so its own seat's marker follows the turn like the others.
  if (!_same(seen.activeTurn, [model.turn])) {
    problems.push(`page marks the turn on [${seen.activeTurn.map(name).join(', ')}], model ${name(model.turn)}`);
  }
  if (seen.reconnecting) problems.push('the page shows ws-reconnecting-banner');
  return problems;
}

// A game_init sent while a move was in flight shows the table before it; that move's result then follows on the same socket.
function _initProblem(table: Table, seat: Seat, socket: GameSocket, init: Frame): string | null {
  const { history } = table.model;
  const tip = history[history.length - 1];
  const asks: number = init.msg.askHistory.length;
  const declarations: number = init.msg.gameState.declaredSuits.length;
  const behind = tip.asks + tip.declarations - asks - declarations;
  const resultAfter = socket.frames
    .slice(socket.frames.indexOf(init) + 1)
    .some(({ msg }) => msg.type === 'ask_result' || msg.type === 'declaration_result');
  const checkpoint = history.findLast((cp) => cp.asks === asks && cp.declarations === declarations);
  if (!checkpoint || !(behind === 0 || (behind === 1 && resultAfter))) {
    return `game_init shows ${asks} asks and ${declarations} declarations, the model ${tip.asks} and ${tip.declarations}`;
  }
  const hand = [...init.msg.myHand].sort();
  const want = checkpoint.hands[seat.playerId] ?? [];
  return _same(hand, want) ? null : `game_init hand ${_list(hand)}, model ${_list(want)}`;
}

async function _endProblems(table: Table, seat: Seat): Promise<string[]> {
  const { scores } = table.model;
  const socket = liveSocket(seat);
  if (!socket) return ['its socket went down before the end'];
  const problems: string[] = [];
  const over = socket.frames.find(({ msg }) => msg.type === 'game_over')?.msg;
  if (!over) problems.push('no game_over');
  else if (_score(over.scores) !== _score(scores)) problems.push(`game_over score ${_score(over.scores)}, model ${_score(scores)}`);

  const seen = await _readPage(seat.page);
  if (typeof seen === 'string') return [...problems, seen];
  problems.push(..._pageLines(seat, table.gameUrl, seen));
  if (!seen.gameOver) problems.push('no game-over-screen');
  else if (seen.gameOver.team1 !== String(scores.team1) || seen.gameOver.team2 !== String(scores.team2)) {
    problems.push(`game-over-screen score ${seen.gameOver.team1}-${seen.gameOver.team2}, model ${_score(scores)}`);
  }
  return problems;
}

async function _savedSummary(table: Table, where: { move: number }): Promise<void> {
  const want = _score(table.model.scores);
  const deadline = Date.now() + FINAL_SAVE_MS;
  let last = 'no answer';
  for (;;) {
    try {
      // A hung backend then fails here with the summary message, not at the test's timeout.
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      const res = await fetch(`${BACKEND_URL}/api/stats/game-summary/${table.roomCode}`, { signal });
      const body = await res.json();
      if (res.ok && _score(body.scores) === want && Date.now() <= deadline) return;
      last = res.ok ? `score ${_score(body.scores)}` : `status ${res.status}`;
    } catch (err) {
      last = String(err instanceof Error ? err.message : err);
    }
    if (Date.now() >= deadline) {
      throw failure(`end: the game summary did not show ${want} within ${FINAL_SAVE_MS / 1000} s (last: ${last})`, where);
    }
    await sleep(_POLL_MS);
  }
}

async function _readPage(page: Page): Promise<_PageRead | string> {
  try {
    return await page.evaluate(() => {
      const ids = (root: Element | null, prefix: string) =>
        root
          ? Array.from(root.querySelectorAll(`[data-testid^="${prefix}"]`), (el) => el.getAttribute('data-testid')!.slice(prefix.length)).sort()
          : [];
      const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
      const hand = byId('desktop-card-hand');
      const over = byId('game-over-screen');
      const score = (team: number) => over?.querySelector(`[data-testid="score-team${team}"]`)?.textContent?.trim() ?? '';
      return {
        marker: window.__e2e,
        views: window.__errorViews ?? [],
        hand: hand ? ids(hand, 'card-wrapper-') : byId('card-hand-empty') ? [] : null,
        books: { team1: ids(byId('table-books-team1'), 'table-book-'), team2: ids(byId('table-books-team2'), 'table-book-') },
        activeTurn: Array.from(
          document.querySelectorAll('[data-testid="game-player-seat"][data-active-turn="true"]'),
          (el) => el.getAttribute('data-player-id') ?? '',
        ).sort(),
        gameOver: over ? { team1: score(1), team2: score(2) } : null,
        reconnecting: byId('ws-reconnecting-banner') !== null,
      };
    });
  } catch (err) {
    return `the page did not answer: ${_firstLine(err)}`;
  }
}

function _pageLines(seat: Seat, gameUrl: string, seen: _PageRead): string[] {
  const problems: string[] = [];
  if (seen.marker !== 1) problems.push('window.__e2e is gone: the page reloaded');
  if (seat.loads > 0) problems.push(`the page loaded ${seat.loads} time(s) after the game started`);
  const url = seat.page.url();
  // The query string and fragment are cut, so nothing a URL might carry reaches the message.
  if (url !== gameUrl) problems.push(`the page left the game for ${url.split(/[?#]/)[0]}`);
  if (seen.views.length > 0) problems.push(`the page showed ${[...new Set(seen.views)].join(', ')}`);
  if (seat.authCalls.length > 0) {
    problems.push(`the page called ${[...new Set(seat.authCalls)].join(', ')} after its first game_init`);
  }
  return problems;
}

function _lastHand(socket: GameSocket): string[] {
  const frame = socket.frames.findLast(({ msg }) => msg.type === 'hand_update' || msg.type === 'game_init')!;
  return [...(frame.msg.type === 'hand_update' ? frame.msg.hand : frame.msg.myHand)].sort();
}

function _lastState(socket: GameSocket): Msg {
  const frame = socket.frames.findLast(({ msg }) => msg.type === 'game_state' || msg.type === 'game_init')!;
  return frame.msg.type === 'game_state' ? frame.msg.state : frame.msg.gameState;
}

function _declaredByTeam(declared: Map<string, Team>): { team1: string[]; team2: string[] } {
  const of = (team: Team) => [...declared].filter(([, t]) => t === team).map(([id]) => id).sort();
  return { team1: of(1), team2: of(2) };
}

function _same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function _sameBooks(a: { team1: string[]; team2: string[] }, b: { team1: string[]; team2: string[] }): boolean {
  return _same(a.team1, b.team1) && _same(a.team2, b.team2);
}

function _books(books: { team1: string[]; team2: string[] }): string {
  return `team1 ${_list(books.team1)} team2 ${_list(books.team2)}`;
}

function _list(items: string[]): string {
  return `[${items.join(' ')}]`;
}

function _score(scores: { team1: number; team2: number }): string {
  return `${scores.team1}-${scores.team2}`;
}

function _firstLine(err: unknown): string {
  return String(err instanceof Error ? err.message : err).split('\n')[0];
}
