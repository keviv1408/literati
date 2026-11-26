import { setTimeout as sleep } from 'node:timers/promises';
import type { Browser } from '@playwright/test';
import { cut, findFrame, type Frame, type GameSocket, type Msg } from '../../tests/helpers/gameWire';
import { afterMove, afterRecovery, atEnd, scanFrames } from './checks';
import { mayTakeHolderDown, mayWaitForSeats } from './deadline';
import { failure } from './fail';
import {
  AFTER_MOVE_POLL_MS,
  BACK_WITHIN_MS,
  FREEZE_FRESH_MS,
  GAME_CAP_MS,
  MAX_SEATS_DOWN,
  MISS_BUDGET,
  PACE_MS,
  STEP_WAIT_MS,
} from './limits';
import type { Checkpoint } from './model';
import { buildPlan, KILL_KINDS, type Kill, type KillKind, type Size } from './plan';
import { halfSuits, isFinalDeclaration, pickMove, toWire, type Move } from './policy';
import { openRun, type Run } from './report';
import { createRng, type Rng } from './rng';
import { closeTable, isUp, liveSocket, nameOf, openTable, type Seat, type Table } from './seats';
import type { Stack } from './stack';

export interface KillRecord {
  kill: Kill;
  dueAt: number;
  startedAt: number;
  backAt: number;
  ranAtMove: number;
  backMs: number;
  movesMadeWhileDown: number;
  heldTurnThroughout: boolean;
}

export interface GameResult {
  seed: number;
  moves: number;
  kills: KillRecord[];
  lostMoves: number[];
  worstBackMs: Record<KillKind, number>;
  scores: { team1: number; team2: number };
}

interface _Found {
  index: number;
  msg: Msg;
}

interface _Choice {
  declarerId: string;
  eligible: string[];
  expiresAt: number;
}

interface _Settled {
  kind: Checkpoint['kind'];
  result: _Found | null;
  turns: string[];
  choice: _Choice | null;
}

interface _Down {
  record: KillRecord;
  seat: Seat;
  socket: GameSocket;
  // Where the kind's back-within clock starts: the cut, the visibility event, the end of refusals.
  origin: number | null;
  back: boolean;
}

interface _Sent {
  seat: Seat;
  socket: GameSocket;
  from: number;
}

type _Doubtful = Exclude<Move, { type: 'choose_next_turn' }>;

interface _Pending {
  moverId: string;
  move: _Doubtful;
}

const _POLL_MS = 20;

export async function playGame(opts: {
  browser: Browser;
  stack: Stack;
  seed: number;
  size: Size;
  plan?: Kill[];
  outDir: string;
  _afterKillStart?: (seat: Seat) => void;
}): Promise<GameResult> {
  const plan = opts.plan ?? buildPlan(opts.seed, opts.size);
  const run = openRun(opts.outDir, opts.seed, plan);
  let table: Table | null = null;
  try {
    table = await openTable(opts.browser, opts.stack);
    const result = await new _Game(table, opts.stack, opts.seed, opts.size, plan, run, opts._afterKillStart).play();
    run.model(table.model);
    run.close(result);
    return result;
  } catch (err) {
    if (table) run.model(table.model);
    run.close(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    if (table) {
      for (const seat of table.seats) run.frames(seat);
      await closeTable(table);
    }
  }
}

class _Game {
  private readonly rng: Rng;
  private readonly startedAt = Date.now();
  private readonly capMs: number;
  // Per socket, where the one-result check starts; kept apart from seat.read, which only scanFrames moves.
  private readonly marks = new Map<GameSocket, number>();
  private readonly kills: KillRecord[] = [];
  private readonly lostMoves: number[] = [];
  private readonly down: _Down[] = [];
  private readonly dueAt = new Map<number, number>();
  private readonly waitingFor = new Map<number, string>();
  private readonly timers: NodeJS.Timeout[] = [];
  // A failure a kill's own timer found; every wait ends on it.
  private broken: Error | null = null;
  // Sockets opened before the last restart talked to a backend whose clocks died with it.
  private epoch = 0;
  private moves = 0;
  private missesLeft = MISS_BUDGET;
  private choice: _Choice | null = null;
  private over = false;

  constructor(
    private readonly table: Table,
    private readonly stack: Stack,
    private readonly seed: number,
    size: Size,
    private readonly plan: Kill[],
    private readonly run: Run,
    private readonly afterKillStart?: (seat: Seat) => void,
  ) {
    this.rng = createRng(seed);
    this.capMs = GAME_CAP_MS[size];
  }

  async play(): Promise<GameResult> {
    try {
      while (!this.over) {
        this._checkCap();
        await this._recovered();
        await this._startKills();
        // One limit for every wait in the step, so chained waits cannot add up past it; a restart above has its own.
        const deadline = Date.now() + STEP_WAIT_MS;
        await this._waitForSeats(deadline);
        const mover = await this._waitForHolder(deadline);
        const move = pickMove(this.table.model, mover.playerId, {
          openChoice: this.choice?.eligible ?? null,
          missesLeft: this.missesLeft,
          rng: this.rng,
        });
        const final = isFinalDeclaration(this.table.model, move);
        // A restart there may roll the model back or move the turn, so the move is picked again.
        if (final && (await this._readyForFinal(deadline))) continue;
        await this._play(mover, move, final, deadline);
        if (!this.over) await this._pause(this.rng.int(...PACE_MS));
      }
    } finally {
      for (const timer of this.timers) clearTimeout(timer);
    }
    const result = this._result();
    await atEnd(this.table, this.stack, result, this.plan);
    // A stray result after the last move has no next move's check to catch it.
    this._checkStrayResults(null, null);
    return result;
  }

  private async _waitForHolder(deadline: number): Promise<Seat> {
    const seat = this._seat(this.table.model.turn);
    await this._until(`${seat.name}, the turn holder, to be up`, () => (isUp(seat) ? seat : undefined), deadline);
    return seat;
  }

  // Every seat gets game_over on a live socket only if every kill ran first and all six are up.
  private async _readyForFinal(deadline: number): Promise<boolean> {
    for (;;) {
      const kill = this._waiting()[0];
      if (kill && !this.dueAt.has(kill.id)) this.dueAt.set(kill.id, Date.now());
      if (kill) this._finalGate(kill);
      if (!this.table.seats.every(isUp)) {
        if (!this._mayWait()) throw this._endedEarly(`the last declaration cannot wait for ${this._downNames()}: the turn could time out first`);
        await this._until('all six seats up for the last declaration', () => (this.table.seats.every(isUp) ? true : undefined), deadline);
      }
      await this._recovered();
      if (!kill) return false;
      if (kill.kind === 'restart') {
        // _until's watch marks each returned seat back, so _recovered checks them all before the restart.
        const ready = () => (this.table.seats.every(isUp) && this.down.every((d) => d.back) ? true : undefined);
        await this._until(`${kill.kind} #${kill.id} to start before the last declaration`, ready, deadline);
        await this._recovered();
        await this._restart(kill, null);
        return true;
      }
      const seat = this._target(kill)!;
      // With all six up, only a stale last frame can still hold a kill back, and a tick comes every second.
      await this._until(`${kill.kind} #${kill.id} to start before the last declaration`, () => {
        this._finalGate(kill);
        return this._blocker(kill, seat) === null ? true : undefined;
      }, deadline);
      await this._startKill(kill, seat);
    }
  }

  // A kill the last declaration could never see through: the deal ran out of moves before the plan did.
  private _finalGate(kill: Kill): void {
    const seat = this._target(kill);
    let why: string | null = null;
    if (kill.timing === 'midMove') why = 'the last declaration never carries a mid-move kill';
    else if ((kill.kind === 'freeze' || kill.kind === 'refuse') && seat!.playerId !== this.table.model.turn) {
      why = `no move is left to make while ${seat!.name} is down`;
    } else if (!mayTakeHolderDown(kill, this._deadlineAt(), Date.now())) why = 'it could outlast the turn timer';
    if (why) {
      const names = this._waiting().map((k) => `${k.kind} #${k.id}`).join(', ');
      throw this._endedEarly(`${names} had not run (${kill.kind} #${kill.id}: ${why})`);
    }
  }

  private _endedEarly(detail: string): Error {
    return failure(`the game ended before the plan (seed ${this.seed}): ${detail}`, { move: this.moves + 1 });
  }

  // In plan order: a kill that may not start yet holds back the ones after it, so a replay runs them in the same order.
  private async _startKills(): Promise<void> {
    for (const kill of this._waiting()) {
      if (kill.timing === 'midMove' || !this.dueAt.has(kill.id)) return;
      const why = kill.kind === 'restart' ? this._restartBlocker() : this._blocker(kill, this._target(kill)!);
      if (why) {
        this._noteWait(kill, why);
        return;
      }
      if (kill.kind === 'restart') await this._restart(kill, null);
      else await this._startKill(kill, this._target(kill)!);
    }
  }

  // Waiting caps the moves a seat misses, but never for so long that the holder's clock runs out.
  private async _waitForSeats(deadline: number): Promise<void> {
    const used = this.down.filter((d) => !d.back && d.record.movesMadeWhileDown >= d.record.kill.movesWhileDown);
    if (used.length === 0 || !this._mayWait()) return;
    const names = used.map((d) => d.seat.name).join(' and ');
    await this._until(`${names} to come back`, () => (used.every((d) => d.back) ? true : undefined), deadline);
  }

  private _mayWait(): boolean {
    const inProgress = this.down.filter((d) => !d.back).map(({ record }) => ({ kill: record.kill, startedAt: record.startedAt }));
    return mayWaitForSeats(inProgress, this._deadlineAt(), this.choice !== null, Date.now());
  }

  private _blocker(kill: Kill, seat: Seat): string | null {
    const socket = liveSocket(seat);
    if (!socket || this.down.some((d) => d.seat === seat)) return `${seat.name} is down`;
    const downNow = this.table.seats.filter((s) => !isUp(s)).length;
    if (downNow >= MAX_SEATS_DOWN) return `${downNow} seats are down`;
    if (this.choice && (kill.kind === 'freeze' || kill.kind === 'refuse')) return 'a choice is open, and a freeze or a refuse outlasts it';
    if (this.table.model.turn === seat.playerId && !mayTakeHolderDown(kill, this._deadlineAt(), Date.now())) {
      return `${seat.name} holds the turn and its clock is too short`;
    }
    if (kill.kind === 'freeze') {
      if (!findFrame(socket, 'heartbeat')) return 'no heartbeat yet';
      // The page's clocks count from its last frame, so a stale one would end the freeze early.
      const age = Date.now() - socket.frames[socket.frames.length - 1].at;
      if (age >= FREEZE_FRESH_MS) return `the last frame is ${age} ms old`;
    }
    return null;
  }

  // A restart takes every seat down at once, so it waits until no seat is down or still owed its recovery check.
  private _restartBlocker(): string | null {
    const away = this.table.seats.filter((seat) => !isUp(seat) || this.down.some((d) => d.seat === seat));
    return away.length === 0 ? null : `${away.map((seat) => seat.name).join(', ')} not back yet`;
  }

  private async _startKill(kill: Kill, seat: Seat): Promise<void> {
    const socket = liveSocket(seat)!;
    const startedAt = Date.now();
    const record: KillRecord = {
      kill,
      dueAt: this.dueAt.get(kill.id) ?? startedAt,
      startedAt,
      backAt: 0,
      ranAtMove: this.moves + 1,
      backMs: 0,
      movesMadeWhileDown: 0,
      heldTurnThroughout: this.table.model.turn === seat.playerId,
    };
    const down: _Down = { record, seat, socket, origin: null, back: false };
    this.kills.push(record);
    this.down.push(down);
    if (kill.kind === 'freeze') {
      await cut(socket, 'server');
      // Nothing reaches a cut socket, so its last recorded frame is the last the page received.
      const lastAt = socket.frames[socket.frames.length - 1].at;
      this._later(lastAt + kill.downMs - Date.now(), () => this._wake(down));
    } else {
      await cut(socket, 'both');
      if (kill.kind === 'refuse') {
        seat.wire.refusing = true;
        this._later(kill.downMs, () => {
          seat.wire.refusing = false;
          down.origin = Date.now();
          this.run.log(`${kill.kind} #${kill.id}: refusals stopped`);
        });
      } else {
        down.origin = startedAt;
      }
    }
    const waited = _seconds(startedAt - record.dueAt);
    this.run.log(`${kill.kind} #${kill.id}: ${seat.name} down ${kill.timing === 'midMove' ? 'during' : 'before'} move ${record.ranAtMove}, ${waited} s after it came due`);
    this.afterKillStart?.(seat);
  }

  // Nothing else runs meanwhile: no seat is up until the backend is back.
  private async _restart(kill: Kill, pending: _Doubtful | null): Promise<void> {
    const startedAt = Date.now();
    const record: KillRecord = {
      kill,
      dueAt: this.dueAt.get(kill.id) ?? startedAt,
      startedAt,
      backAt: 0,
      ranAtMove: this.moves + 1,
      backMs: 0,
      movesMadeWhileDown: 0,
      heldTurnThroughout: false,
    };
    this.kills.push(record);
    const where = { kill, move: record.ranAtMove };
    const old = this.table.seats.map((seat) => seat.wire.sockets.at(-1)!);
    this.epoch = startedAt;
    await this.stack.killBackend();
    this.run.log(`${kill.kind} #${kill.id}: backend down ${pending ? 'during' : 'before'} move ${record.ranAtMove}, ${_seconds(startedAt - record.dueAt)} s after it came due`);
    for (const seat of this.table.seats) this.afterKillStart?.(seat);
    await sleep(kill.downMs);
    await this.stack.startBackend();
    const origin = Date.now();
    this.run.log(`${kill.kind} #${kill.id}: backend up ${origin - startedAt} ms after the kill`);

    const downs: _Down[] = this.table.seats.map((seat, i) => ({ record, seat, socket: old[i], origin, back: false }));
    this.down.push(...downs);
    // Its own limit, so the 20 s back-within fails first, by seat name.
    const limit = origin + STEP_WAIT_MS;
    await this._until(`all six seats back after ${kill.kind} #${kill.id}`, () => (downs.every((d) => d.back) ? true : undefined), limit);
    const inits = this.table.seats.map((seat) => {
      const live = liveSocket(seat);
      if (!live) throw failure('went down again before its recovery check', { seat, ...where });
      return findFrame(live, 'game_init')!.msg;
    });
    const { model } = this.table;
    const { lostMoves, pendingKept } = model.matchRestart(inits, pending);
    this.lostMoves.push(lostMoves);
    this.choice = null;
    const tip = model.history[model.history.length - 1];
    const kept = pending ? `; pending move ${pendingKept ? 'kept' : 'lost'}` : '';
    this.run.log(`${kill.kind} #${kill.id}: restored at ${tip.asks} asks and ${tip.declarations} declarations, ${lostMoves} move(s) lost${kept}`);
    // The restored game arms a fresh turn timer and sends it to each socket after its game_init.
    await this._until(`a turn_timer for ${this._name(model.turn)} from the restarted backend`, () => this._deadlineAt() ?? undefined, limit);
    await this._recovered();
  }

  // The freeze ends the way a phone wakes: the page sees its document become visible with a stale socket.
  private async _wake(down: _Down): Promise<void> {
    const { seat, record } = down;
    const where = { seat, kill: record.kill, move: this.moves + 1 };
    try {
      if (seat.wire.sockets.at(-1) !== down.socket) throw failure('the page opened a new socket before the visibility event', where);
      const lastAt = down.socket.frames[down.socket.frames.length - 1].at;
      // Set before the event, so a socket the event opens is never taken for one opened before it.
      down.origin = Date.now();
      const state = await seat.page.evaluate(() => {
        const visibility = document.visibilityState;
        if (visibility === 'visible') document.dispatchEvent(new Event('visibilitychange'));
        return visibility;
      });
      if (state !== 'visible') throw failure(`the page was ${state} at the visibility event, so it would ignore it`, where);
      this.run.log(`${record.kill.kind} #${record.kill.id}: visibility event at ${_seconds(down.origin - lastAt)} s since the last frame`);
    } catch (err) {
      this.broken ??= err instanceof Error ? err : new Error(String(err));
    }
  }

  // Runs on every poll of every wait, so a seat that is not back fails when its limit passes, whatever the driver waits for.
  private _watch(): void {
    if (this.broken) throw this.broken;
    for (const down of this.down) {
      if (down.back) continue;
      const { seat, record } = down;
      const where = { seat, kill: record.kill, move: this.moves + 1 };
      if (down.origin === null) {
        if (record.kill.kind === 'freeze' && seat.wire.sockets.at(-1) !== down.socket) {
          throw failure('the page opened a new socket before the visibility event', where);
        }
        continue;
      }
      const limit = BACK_WITHIN_MS[record.kill.kind];
      const live = liveSocket(seat);
      // A restart marks no socket cut, so the old one may look live until its close lands.
      if (live && live !== down.socket) {
        const backAt = findFrame(live, 'game_init')!.at;
        const took = backAt - down.origin;
        if (took > limit) throw failure(`not back ${limit / 1000} s (took ${_seconds(took)} s)`, where);
        down.back = true;
        record.backAt = Math.max(record.backAt, backAt);
        record.backMs = Math.max(record.backMs, took);
        this.run.log(`${seat.name} back ${took} ms after ${record.kill.kind} #${record.kill.id}, ${record.movesMadeWhileDown} move(s) made while down`);
      } else if (Date.now() - down.origin > limit) {
        throw failure(`not back ${limit / 1000} s (took ${_seconds(Date.now() - down.origin)} s so far)`, where);
      }
    }
  }

  // The page checks need a settled table, so a seat that came back is checked between moves.
  private async _recovered(): Promise<void> {
    for (const down of this.down.filter((d) => d.back)) {
      await afterRecovery(this.table, down.seat, down.record, this.moves + 1);
      this.down.splice(this.down.indexOf(down), 1);
    }
  }

  // The holder's open clock: the choice's while one is open, whatever turn_timer a reconnect sends meanwhile.
  private _deadlineAt(): number | null {
    if (this.choice) return this.choice.expiresAt;
    const holder = this.table.model.turn;
    let newest: Frame | undefined;
    for (const seat of this.table.seats) {
      for (const socket of seat.wire.sockets.filter(({ openedAt }) => openedAt >= this.epoch)) {
        const frame = socket.frames.findLast(({ msg }) => msg.type === 'turn_timer' && msg.playerId === holder);
        if (frame && (!newest || frame.at > newest.at)) newest = frame;
      }
    }
    return newest ? newest.msg.expiresAt : null;
  }

  private _waiting(): Kill[] {
    return this.plan.filter((kill) => !this.kills.some((record) => record.kill.id === kill.id));
  }

  private _target(kill: Kill): Seat | undefined {
    return typeof kill.seat === 'number' ? this.table.seats[kill.seat] : undefined;
  }

  // Kills come due once the first move has settled, never before.
  private _markDue(): void {
    for (const kill of this.plan) {
      if (!this.dueAt.has(kill.id) && this.moves >= Math.max(1, kill.dueBeforeMove - 1)) this.dueAt.set(kill.id, Date.now());
    }
  }

  private _noteWait(kill: Kill, why: string): void {
    if (this.waitingFor.get(kill.id) === why) return;
    this.waitingFor.set(kill.id, why);
    this.run.log(`${kill.kind} #${kill.id} waits before move ${this.moves + 1}: ${why}`);
  }

  private _downNames(): string {
    return this.table.seats.filter((seat) => !isUp(seat)).map((seat) => seat.name).join(', ');
  }

  private _later(ms: number, run: () => void): void {
    this.timers.push(setTimeout(run, Math.max(0, ms)));
  }

  // Through _until, so a recovery limit still fails on time during the pause.
  private async _pause(ms: number): Promise<void> {
    const end = Date.now() + ms;
    await this._until('the pause between moves', () => (Date.now() >= end ? true : undefined), end + STEP_WAIT_MS);
  }

  private async _play(mover: Seat, move: Move, final: boolean, deadline: number): Promise<void> {
    const { model } = this.table;
    const number = this.moves + 1;
    const before = model.asks + model.declarations;
    const socket = liveSocket(mover)!;
    const inDoubt = move.type === 'choose_next_turn' || final ? undefined : this._midMoveKill(mover);
    const sent: _Sent[] = this.table.seats.flatMap((seat) => {
      const live = liveSocket(seat);
      return live ? [{ seat, socket: live, from: live.frames.length }] : [];
    });
    socket.server!.send(JSON.stringify(toWire(move)));

    // After a restart the model already holds the restored game, with or without this move, and nothing is sent again.
    let settled: _Settled | null = null;
    if (inDoubt?.kind === 'restart') {
      await this._restart(inDoubt, move as _Doubtful);
    } else if (inDoubt) {
      await this._startKill(inDoubt, mover);
      settled = await this._settleInDoubt(mover, move as _Doubtful, sent, deadline);
    } else {
      settled = await this._settle(mover, move, socket, sent.find((s) => s.socket === socket)!.from, final, deadline);
    }
    if (move.type === 'ask_card' && !move.hit) this.missesLeft -= 1;
    if (settled) {
      if (move.type === 'ask_card') {
        model.applyAsk(mover.playerId, move.targetPlayerId, move.cardId, settled.result!.msg.success);
      } else if (move.type === 'declare_suit') {
        model.applyDeclaration(move.halfSuitId, mover.team);
      }
      model.settle(settled.kind, settled.turns);
      this.choice = settled.choice;
    }
    const sentAs = settled ? '' : ', sent as the backend died';
    this.run.log(`move ${number}: ${this._describe(mover.playerId, move)}${sentAs}; turn ${this._name(model.turn)}`);
    for (const down of this.down) {
      if (down.back) continue;
      down.record.movesMadeWhileDown += 1;
      down.record.heldTurnThroughout = false;
    }

    const pending = inDoubt?.kind === 'restart' ? { moverId: mover.playerId, move: move as _Doubtful } : null;
    await this._checkResultCopies(settled?.result ?? null, before, pending, deadline);
    if (!final) await afterMove(this.table, number);
    this.moves = number;
    this.over = final;
    this._markDue();
  }

  // A handoff's result is only a state frame, so a mid-move kill rides an ask or a declaration, never the last one.
  private _midMoveKill(mover: Seat): Kill | undefined {
    const kill = this._waiting()[0];
    if (!kill || kill.timing !== 'midMove' || !this.dueAt.has(kill.id)) return undefined;
    const why = kill.kind === 'restart' ? this._restartBlocker() : this._blocker(kill, mover);
    if (why) this._noteWait(kill, why);
    return why ? undefined : kill;
  }

  // Silence proves nothing after a mid-move cut, so the mover's next game_init says whether the server kept the move.
  private async _settleInDoubt(
    mover: Seat,
    move: _Doubtful,
    sent: _Sent[],
    deadline: number,
  ): Promise<_Settled> {
    const number = this.moves + 1;
    const where = { seat: mover, move: number };
    const what = this._describe(mover.playerId, move);
    const init = await this._until(`${mover.name}'s game_init after the mid-move cut`, () => {
      const live = liveSocket(mover);
      return live && findFrame(live, 'game_init')!.msg;
    }, deadline);

    const others = sent.filter(({ seat, socket }) => seat !== mover && liveSocket(seat) === socket);
    const heard = others.filter(({ socket, from }) => _find(socket, from, (m) => _isResultOf(m, mover.playerId, move)));
    if (this._kept(init, mover, move)) {
      // The server broadcast the result before it saw the cut, so every other seat up at the send has it by now.
      const deaf = others.filter((other) => !heard.includes(other));
      if (deaf.length > 0) throw failure(`the server kept ${what}, but ${deaf.map(({ seat }) => seat.name).join(', ')} never got its result`, where);
      if (others.length === 0) throw failure(`no other seat is up to settle ${what}`, where);
      this.run.log(`move ${number} in doubt: the server kept ${what}`);
      // Another seat's socket carries the result and the clock.
      return this._settle(mover, move, others[0].socket, others[0].from, false, deadline);
    }

    if (heard.length > 0) {
      throw failure(`the server dropped ${what}, but ${heard.map(({ seat }) => seat.name).join(', ')} got its result`, where);
    }
    this.run.log(`move ${number} in doubt: the server dropped ${what}; sending it again`);
    const socket = liveSocket(mover)!;
    const from = socket.frames.length;
    socket.server!.send(JSON.stringify(toWire(move)));
    return this._settle(mover, move, socket, from, false, deadline);
  }

  private _kept(init: Msg, mover: Seat, move: _Doubtful): boolean {
    const { model } = this.table;
    const asks: Msg[] = init.askHistory;
    const declared: Msg[] = init.gameState.declaredSuits;
    if (move.type === 'ask_card') {
      if (asks.length === model.asks) return false;
      const last = asks[asks.length - 1];
      if (asks.length === model.asks + 1 && _isResultOf({ ...last, type: 'ask_result' }, mover.playerId, move)) return true;
    } else {
      if (declared.length === model.declarations) return false;
      if (declared.length === model.declarations + 1 && declared.some((d) => d.halfSuitId === move.halfSuitId)) return true;
    }
    throw failure(
      `after the mid-move cut, game_init shows ${asks.length} asks and ${declared.length} declarations; ` +
        `the model had ${model.asks} and ${model.declarations} before ${this._describe(mover.playerId, move)}`,
      { seat: mover, move: this.moves + 1 },
    );
  }

  // The next holder comes from the clock after the result: a declaration can still park the turn after its first state.
  private async _settle(mover: Seat, move: Move, socket: GameSocket, from: number, final: boolean, deadline: number): Promise<_Settled> {
    const me = mover.playerId;
    if (move.type === 'ask_card') {
      const result = await this._frame(socket, from, `ask_result for ${this._describe(me, move)}`, deadline, (m) =>
        m.type === 'ask_result' && m.askerId === me && m.targetId === move.targetPlayerId && m.cardId === move.cardId,
      );
      const next: string = result.msg.newTurnPlayerId;
      const expected = result.msg.success ? me : move.targetPlayerId;
      if (next !== expected) {
        throw failure(`the ask gave the turn to ${this._name(next)}, expected ${this._name(expected)}`, { move: this.moves + 1 });
      }
      const clock = await this._frame(socket, result.index + 1, `turn_timer for ${this._name(next)} after the ask`, deadline, (m) =>
        m.type === 'turn_timer' && m.playerId === next,
      );
      return { kind: 'ask', result, turns: [clock.msg.playerId], choice: null };
    }

    if (move.type === 'declare_suit') {
      const result = await this._frame(socket, from, `declaration_result for ${this._describe(me, move)}`, deadline, (m) =>
        m.type === 'declaration_result' && m.declarerId === me && m.halfSuitId === move.halfSuitId,
      );
      if (result.msg.correct !== true) throw failure(`the server judged ${mover.name}'s ${move.halfSuitId} wrong`, { move: this.moves + 1 });
      // The server saves the state it broadcasts first, then may park the turn on the declarer for the choice.
      const saved = await this._frame(socket, result.index + 1, 'game_state after the declaration', deadline, (m) => m.type === 'game_state');
      const savedHolder: string = saved.msg.state.currentTurnPlayerId;
      if (final) {
        await this._frame(socket, result.index + 1, 'game_over', deadline, (m) => m.type === 'game_over');
        return { kind: 'declaration', result, turns: [savedHolder], choice: null };
      }
      const eligible = this._eligibleAfter(me, move.halfSuitId);
      if (eligible.length > 1) {
        const clock = await this._choiceOpened(socket, result.index + 1, `${mover.name}'s ${move.halfSuitId}`, deadline);
        const { declarerId, eligiblePlayers, expiresAt } = clock.msg;
        if (declarerId !== me || !_sameSet(eligiblePlayers, eligible)) {
          throw failure(
            `post_declaration_timer for ${this._name(declarerId)} with [${eligiblePlayers.map((p: string) => this._name(p)).join(', ')}], ` +
              `model expects ${mover.name} with [${eligible.map((p) => this._name(p)).join(', ')}]`,
            { move: this.moves + 1 },
          );
        }
        return { kind: 'declaration', result, turns: [me, savedHolder], choice: { declarerId, eligible: eligiblePlayers, expiresAt } };
      }
      // A turn_timer naming anyone else is a reconnect's, not this declaration's clock.
      const clock = await this._frame(socket, result.index + 1, `turn_timer for ${this._name(savedHolder)} after the declaration`, deadline, (m) =>
        m.type === 'post_declaration_timer' || (m.type === 'turn_timer' && m.playerId === savedHolder),
      );
      if (clock.msg.type !== 'turn_timer') {
        throw failure(`the server opened a choice after ${mover.name}'s ${move.halfSuitId}, but the model has one teammate with cards`, {
          move: this.moves + 1,
        });
      }
      return { kind: 'declaration', result, turns: [savedHolder], choice: null };
    }

    const chosen = move.chosenPlayerId;
    // Searched from the send, because the park before a choice already named the declarer.
    const state = await this._frame(socket, from, `game_state with the turn on ${this._name(chosen)}`, deadline, (m) =>
      m.type === 'game_state' && m.state.currentTurnPlayerId === chosen,
    );
    let after = state.index;
    if (this.choice) {
      const selected = await this._frame(socket, from, 'post_declaration_turn_selected', deadline, (m) => m.type === 'post_declaration_turn_selected');
      if (selected.msg.reason !== 'player_choice' || selected.msg.selectedPlayerId !== chosen) {
        throw failure(
          `post_declaration_turn_selected chose ${this._name(selected.msg.selectedPlayerId)} by ${selected.msg.reason}, the driver chose ${this._name(chosen)}`,
          { move: this.moves + 1 },
        );
      }
      after = Math.max(after, selected.index);
    }
    await this._frame(socket, after + 1, `turn_timer for ${this._name(chosen)} after the handoff`, deadline, (m) =>
      m.type === 'turn_timer' && m.playerId === chosen,
    );
    return { kind: 'handoff', result: null, turns: [chosen], choice: null };
  }

  // A reconnect during the save sends a turn_timer before the park, so a turn_timer means no choice only once no park follows it in time.
  private async _choiceOpened(socket: GameSocket, from: number, declaration: string, deadline: number): Promise<_Found> {
    const where = { move: this.moves + 1 };
    return this._until(`the choice after ${declaration}: the model expects one, the server opened none`, () => {
      const opened = _find(socket, from, (m) => m.type === 'post_declaration_timer');
      if (opened) return opened;
      const timer = _find(socket, from, (m) => m.type === 'turn_timer');
      if (timer && Date.now() - socket.frames[timer.index].at > AFTER_MOVE_POLL_MS) {
        throw failure(
          `the model expects a choice after ${declaration}, but the server sent a turn_timer for ${this._name(timer.msg.playerId)} and opened none`,
          where,
        );
      }
      return undefined;
    }, deadline);
  }

  // The server applies a move and broadcasts its result in one tick, so a socket whose game_init predates the move is owed a copy.
  private async _checkResultCopies(result: _Found | null, before: number, pending: _Pending | null, deadline: number): Promise<void> {
    // Scanned first, so a bot's move fails as the bot_takeover before it fails as a foreign result.
    scanFrames(this.table, { move: this.moves + 1 });
    for (const seat of this.table.seats) {
      const live = liveSocket(seat);
      if (!result || !live || _movesIn(findFrame(live, 'game_init')!.msg) > before) continue;
      const mark = this.marks.get(live) ?? 0;
      await this._until(`${seat.name}'s copy of the ${result.msg.type}`, () => _find(live, mark, (m) => _sameResult(m, result.msg)), deadline);
    }
    this._checkStrayResults(result?.msg ?? null, pending);
  }

  // Every socket, closed ones too, so a stray result on a socket that dies before the next check is still caught.
  private _checkStrayResults(result: Msg | null, pending: _Pending | null): void {
    for (const seat of this.table.seats) {
      for (const socket of seat.wire.sockets) {
        const mark = this.marks.get(socket) ?? 0;
        // A socket from before a mid-move restart may have heard the move the restart then kept or lost.
        const known = (msg: Msg) =>
          (result !== null && _sameResult(msg, result)) ||
          (pending !== null && socket.openedAt < this.epoch && _isResultOf(msg, pending.moverId, pending.move));
        const results = socket.frames.slice(mark).filter(({ msg }) => msg.type === 'ask_result' || msg.type === 'declaration_result');
        const stray = results.find(({ msg }) => !known(msg));
        if (stray || results.length > 1) {
          const what = stray
            ? `a ${stray.msg.type} the driver did not send: ${this._describe(..._resultAsMove(stray.msg))}`
            : `${results.length} copies of its result`;
          throw failure(`socket #${socket.index} got ${what}`, { seat, move: this.moves + 1 });
        }
        this.marks.set(socket, socket.frames.length);
      }
    }
  }

  private _eligibleAfter(declarerId: string, halfSuitId: string): string[] {
    const { model } = this.table;
    const team = model.teams.get(declarerId);
    const cards = new Set(halfSuits().get(halfSuitId));
    return [...model.teams]
      .filter(([playerId, t]) => t === team && [...model.hands.get(playerId)!].some((card) => !cards.has(card)))
      .map(([playerId]) => playerId);
  }

  private async _frame(socket: GameSocket, from: number, what: string, deadline: number, match: (msg: Msg) => boolean): Promise<_Found> {
    return this._until(what, () => _find(socket, from, match), deadline);
  }

  // Scanning on every poll fails a refused move at once, not at the step's deadline.
  private async _until<T>(what: string, probe: () => T | undefined, deadline: number): Promise<T> {
    for (;;) {
      scanFrames(this.table, { move: this.moves + 1 });
      this._watch();
      const found = probe();
      if (found !== undefined) return found;
      this._checkCap();
      if (Date.now() >= deadline) throw failure(`the step passed its ${STEP_WAIT_MS / 1000} s limit waiting for ${what}`, { move: this.moves + 1 });
      await sleep(_POLL_MS);
    }
  }

  private _checkCap(): void {
    const ms = Date.now() - this.startedAt;
    if (ms > this.capMs) throw failure(`the game ran past its ${this.capMs / 1000} s cap`, { move: this.moves + 1 });
  }

  private _result(): GameResult {
    const worst = (kind: KillKind) => Math.max(0, ...this.kills.filter((r) => r.kill.kind === kind).map((r) => r.backMs));
    return {
      seed: this.seed,
      moves: this.moves,
      kills: [...this.kills],
      lostMoves: [...this.lostMoves],
      worstBackMs: Object.fromEntries(KILL_KINDS.map((kind) => [kind, worst(kind)])) as Record<KillKind, number>,
      scores: { ...this.table.model.scores },
    };
  }

  private _describe(moverId: string, move: Move): string {
    const who = this._name(moverId);
    if (move.type === 'ask_card') {
      return `${who} asks ${this._name(move.targetPlayerId)} for ${move.cardId}: ${move.hit ? 'hit' : 'miss'}`;
    }
    if (move.type === 'declare_suit') return `${who} declares ${move.halfSuitId}`;
    return `${who} hands the turn to ${this._name(move.chosenPlayerId)}`;
  }

  private _seat(playerId: string): Seat {
    const seat = this.table.seats.find((s) => s.playerId === playerId);
    if (!seat) throw failure(`no seat for player ${playerId}`, { move: this.moves + 1 });
    return seat;
  }

  private _name(playerId: string): string {
    return nameOf(this.table, playerId);
  }
}

function _find(socket: GameSocket, from: number, match: (msg: Msg) => boolean): _Found | undefined {
  for (let index = from; index < socket.frames.length; index++) {
    if (match(socket.frames[index].msg)) return { index, msg: socket.frames[index].msg };
  }
  return undefined;
}

function _isResultOf(msg: Msg, moverId: string, move: _Doubtful): boolean {
  if (move.type === 'ask_card') {
    return msg.type === 'ask_result' && msg.askerId === moverId && msg.targetId === move.targetPlayerId && msg.cardId === move.cardId;
  }
  return msg.type === 'declaration_result' && msg.declarerId === moverId && msg.halfSuitId === move.halfSuitId;
}

function _movesIn(init: Msg): number {
  return init.askHistory.length + init.gameState.declaredSuits.length;
}

function _seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function _sameResult(a: Msg, b: Msg): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'ask_result') return a.askerId === b.askerId && a.targetId === b.targetId && a.cardId === b.cardId;
  return a.declarerId === b.declarerId && a.halfSuitId === b.halfSuitId;
}

function _sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

// A broadcast result as the move that made it, so the log describes both the same way.
function _resultAsMove(msg: Msg): [string, Move] {
  if (msg.type === 'ask_result') {
    return [msg.askerId, { type: 'ask_card', targetPlayerId: msg.targetId, cardId: msg.cardId, hit: msg.success }];
  }
  return [msg.declarerId, { type: 'declare_suit', halfSuitId: msg.halfSuitId, assignment: msg.assignment ?? {} }];
}
