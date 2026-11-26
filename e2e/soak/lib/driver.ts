import { setTimeout as sleep } from 'node:timers/promises';
import type { Browser } from '@playwright/test';
import { findFrame, type GameSocket, type Msg } from '../../tests/helpers/gameWire';
import { afterMove, atEnd, scanFrames } from './checks';
import { failure } from './fail';
import { AFTER_MOVE_POLL_MS, GAME_CAP_MS, MISS_BUDGET, PACE_MS, STEP_WAIT_MS } from './limits';
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

const _POLL_MS = 20;

export async function playGame(opts: {
  browser: Browser;
  stack: Stack;
  seed: number;
  size: Size;
  plan?: Kill[];
  outDir: string;
}): Promise<GameResult> {
  const plan = opts.plan ?? buildPlan(opts.seed, opts.size);
  const run = openRun(opts.outDir, opts.seed, plan);
  let table: Table | null = null;
  try {
    table = await openTable(opts.browser, opts.stack);
    const result = await new _Game(table, opts.stack, opts.seed, opts.size, plan, run).play();
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
  ) {
    this.rng = createRng(seed);
    this.capMs = GAME_CAP_MS[size];
  }

  async play(): Promise<GameResult> {
    while (!this.over) {
      this._checkCap();
      // One limit for every wait in the step, so chained waits cannot add up past it.
      const deadline = Date.now() + STEP_WAIT_MS;
      const mover = await this._waitForHolder(deadline);
      const move = pickMove(this.table.model, mover.playerId, {
        openChoice: this.choice?.eligible ?? null,
        missesLeft: this.missesLeft,
        rng: this.rng,
      });
      const final = isFinalDeclaration(this.table.model, move);
      if (final) await this._readyForFinal(deadline);
      await this._play(mover, move, final, deadline);
      if (!this.over) await sleep(this.rng.int(...PACE_MS));
    }
    const result = this._result();
    await atEnd(this.table, this.stack, result, this.plan);
    return result;
  }

  private async _waitForHolder(deadline: number): Promise<Seat> {
    const seat = this._seat(this.table.model.turn);
    await this._until(`${seat.name}, the turn holder, to be up`, () => (isUp(seat) ? seat : undefined), deadline);
    return seat;
  }

  private async _readyForFinal(deadline: number): Promise<void> {
    const waiting = this.plan.filter((kill) => !this.kills.some((record) => record.kill.id === kill.id));
    if (waiting.length > 0) {
      const names = waiting.map((kill) => `${kill.kind} #${kill.id}`).join(', ');
      throw failure(`the game ended before the plan (seed ${this.seed}): ${names} had not run`, { move: this.moves + 1 });
    }
    await this._until('all six seats up for the last declaration', () => (this.table.seats.every(isUp) ? true : undefined), deadline);
  }

  private async _play(mover: Seat, move: Move, final: boolean, deadline: number): Promise<void> {
    const { model } = this.table;
    const number = this.moves + 1;
    const socket = liveSocket(mover)!;
    const from = socket.frames.length;
    const sentAt = Date.now();
    socket.server!.send(JSON.stringify(toWire(move)));

    const settled = await this._settle(mover, move, socket, from, final, deadline);
    if (move.type === 'ask_card') {
      model.applyAsk(mover.playerId, move.targetPlayerId, move.cardId, settled.result!.msg.success);
      if (!move.hit) this.missesLeft -= 1;
    } else if (move.type === 'declare_suit') {
      model.applyDeclaration(move.halfSuitId, mover.team);
    }
    model.settle(settled.kind, settled.turns);
    this.choice = settled.choice;
    this.run.log(`move ${number}: ${this._describe(mover.playerId, move)}; turn ${this._name(model.turn)}`);

    await this._checkResultCopies(settled.result, sentAt, deadline);
    if (!final) await afterMove(this.table, number);
    this.moves = number;
    this.over = final;
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

  // An extra or foreign result means a bot or a server clock played; a seat back after the send may lack the result.
  private async _checkResultCopies(result: _Found | null, sentAt: number, deadline: number): Promise<void> {
    // Scanned first, so a bot's move fails as the bot_takeover before it fails as a foreign result.
    scanFrames(this.table, { move: this.moves + 1 });
    for (const seat of this.table.seats) {
      const socket = liveSocket(seat);
      if (!socket) continue;
      const mark = this.marks.get(socket) ?? 0;
      if (result && findFrame(socket, 'game_init')!.at <= sentAt) {
        await this._until(`${seat.name}'s copy of the ${result.msg.type}`, () => _find(socket, mark, (m) => _sameResult(m, result.msg)), deadline);
      }
      const results = socket.frames.slice(mark).filter(({ msg }) => msg.type === 'ask_result' || msg.type === 'declaration_result');
      const stray = results.find(({ msg }) => !result || !_sameResult(msg, result.msg));
      if (stray || results.length > 1) {
        const what = stray
          ? `a ${stray.msg.type} the driver did not send: ${this._describe(..._resultAsMove(stray.msg))}`
          : `${results.length} copies of its result`;
        throw failure(`socket #${socket.index} got ${what}`, { seat, move: this.moves + 1 });
      }
      this.marks.set(socket, socket.frames.length);
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
