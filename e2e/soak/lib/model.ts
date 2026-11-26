import type { Msg } from '../../tests/helpers/gameWire';
import { failure } from './fail';
import { LOST_MOVES_MAX } from './limits';
import { halfSuits, type Move } from './policy';

export type Team = 1 | 2;

export interface Checkpoint {
  kind: 'start' | 'ask' | 'declaration' | 'handoff';
  asks: number;
  declarations: number;
  hands: Record<string, string[]>;
  declared: Record<string, Team>;
  scores: { team1: number; team2: number };
  turns: string[];
}

type _State = Pick<Checkpoint, 'hands' | 'declared' | 'scores'>;

const _PLAYERS = 6;
const _HAND_AT_START = 8;
const _DECK = 48;
const _HALF_SUIT_SIZE = 6;

export class Model {
  hands = new Map<string, Set<string>>();
  teams = new Map<string, Team>();
  declared = new Map<string, Team>();
  scores = { team1: 0, team2: 0 };
  turn = '';
  asks = 0;
  declarations = 0;
  history: Checkpoint[] = [];

  static fromInits(inits: Msg[]): Model {
    const model = new Model();
    const ids = new Set(inits.map((m) => m.myPlayerId));
    if (inits.length !== _PLAYERS || ids.size !== _PLAYERS) {
      throw failure(`start: ${ids.size} different players in ${inits.length} game_init frames, expected ${_PLAYERS}`);
    }
    for (const init of inits) {
      if (init.variant !== 'remove_7s') throw failure(`start: variant ${init.variant}, expected remove_7s`);
      const bot = init.players.find((p: Msg) => p.isBot);
      if (bot) throw failure(`start: ${bot.playerId} is a bot`);
      if (init.myHand.length !== _HAND_AT_START) {
        throw failure(`start: ${init.myPlayerId} holds ${init.myHand.length} cards, expected ${_HAND_AT_START}`);
      }
    }
    for (const p of inits[0].players) model.teams.set(p.playerId, p.teamId);
    const team1 = [...model.teams.values()].filter((team) => team === 1).length;
    if (model.teams.size !== _PLAYERS || team1 !== 3 || [...ids].some((id) => !model.teams.has(id))) {
      throw failure('start: the six players are not three and three on two teams');
    }
    const deck = new Set([...halfSuits().values()].flat());
    const dealt = new Set(inits.flatMap((m) => m.myHand));
    if (dealt.size !== _DECK || [...dealt].some((card) => !deck.has(card))) {
      throw failure(`start: ${dealt.size} different cards dealt, expected the ${_DECK} of remove_7s`);
    }
    // Seat order, so every walk over the players goes the same way.
    for (const playerId of model.teams.keys()) {
      model.hands.set(playerId, new Set(inits.find((m) => m.myPlayerId === playerId)!.myHand));
    }
    model.turn = inits[0].gameState.currentTurnPlayerId;
    model.history.push(model._checkpoint('start', [model.turn]));
    return model;
  }

  applyAsk(askerId: string, targetId: string, cardId: string, success: boolean): void {
    const target = this._hand(targetId);
    if (target.has(cardId) !== success) {
      throw failure(`model: ${targetId} ${success ? 'lacks' : 'holds'} ${cardId}, but ${askerId}'s ask ${success ? 'hit' : 'missed'}`);
    }
    if (!success) return;
    target.delete(cardId);
    this._hand(askerId).add(cardId);
  }

  applyDeclaration(halfSuitId: string, winningTeam: Team): void {
    const cards = halfSuits().get(halfSuitId);
    if (!cards || this.declared.has(halfSuitId)) throw failure(`model: ${halfSuitId} is not an open half-suit`);
    const holders = cards.map((card) => [...this.hands].find(([, hand]) => hand.has(card))?.[0]);
    if (holders.some((playerId) => playerId === undefined || this.teams.get(playerId) !== winningTeam)) {
      throw failure(`model: team ${winningTeam} won ${halfSuitId}, but does not hold all six of it`);
    }
    for (const hand of this.hands.values()) for (const card of cards) hand.delete(card);
    this.declared.set(halfSuitId, winningTeam);
    this.scores[winningTeam === 1 ? 'team1' : 'team2'] += 1;
  }

  settle(kind: Checkpoint['kind'], turns: string[]): void {
    const holders = [...new Set(turns)];
    this.turn = holders[0];
    if (kind === 'ask') this.asks += 1;
    if (kind === 'declaration') this.declarations += 1;
    this.assertConserved();
    this.history.push(this._checkpoint(kind, holders));
  }

  assertConserved(): void {
    const problem = _conservation([...this.hands.values()].map((hand) => [...hand]), this.declared.size);
    if (problem) throw failure(`model: ${problem}`);
  }

  matchRestart(inits: Msg[], pending: Move | null): { lostMoves: number; pendingKept: boolean } {
    const seen = this._agreed(inits);
    const turn: string = inits[0].gameState.currentTurnPlayerId;
    const asks: number = inits[0].askHistory.length;
    const declarations: number = inits[0].gameState.declaredSuits.length;
    const tip = this.history[this.history.length - 1];

    if (pending && pending.type !== 'choose_next_turn') {
      const ask = pending.type === 'ask_card' ? 1 : 0;
      if (asks === tip.asks + ask && declarations === tip.declarations + 1 - ask) {
        this._keepPending(pending, seen, turn);
        return { lostMoves: 0, pendingKept: true };
      }
    }

    const same = this.history.filter((cp) => cp.asks === asks && cp.declarations === declarations);
    const at = `the checkpoint at ${asks} asks and ${declarations} declarations`;
    if (same.length === 0) {
      throw failure(`after restart: no checkpoint has ${asks} asks and ${declarations} declarations (tip ${tip.asks} and ${tip.declarations})`);
    }
    const diff = _diff(same[same.length - 1], seen);
    if (diff) throw failure(`after restart: ${diff} differs from ${at}`);
    const matched = [...same].reverse().find((cp) => cp.turns.includes(turn));
    if (!matched) {
      throw failure(`after restart: turn on ${turn}, but ${at} allows ${[...new Set(same.flatMap((cp) => cp.turns))].join(', ')}`);
    }

    // Counted in checkpoints, because a handoff is a move of its own.
    const index = this.history.indexOf(matched);
    const lostMoves = this.history.length - 1 - index;
    if (lostMoves > LOST_MOVES_MAX) throw failure(`after restart: lost ${lostMoves} moves, limit ${LOST_MOVES_MAX}`);

    this.history = this.history.slice(0, index + 1);
    this._restore(matched);
    this.turn = turn;
    return { lostMoves, pendingKept: false };
  }

  private _keepPending(pending: Exclude<Move, { type: 'choose_next_turn' }>, seen: _State, turn: string): void {
    // The driver sends only the holder's move, and the model's turn is that holder until the move settles.
    const moverId = this.turn;
    const next = new Model();
    next.teams = this.teams;
    next._restore(this._checkpoint('start', []));
    let holders: string[];
    let kind: 'ask' | 'declaration';
    if (pending.type === 'ask_card') {
      const hit = next._hand(pending.targetPlayerId).has(pending.cardId);
      next.applyAsk(moverId, pending.targetPlayerId, pending.cardId, hit);
      holders = [hit ? moverId : pending.targetPlayerId];
      kind = 'ask';
    } else {
      const team = this.teams.get(moverId)!;
      next.applyDeclaration(pending.halfSuitId, team);
      holders = [moverId, ...next._turnAfterDeclaration(team)];
      kind = 'declaration';
    }
    const diff = _diff(next._checkpoint(kind, []), seen);
    if (diff) throw failure(`after restart: the pending ${kind} was saved, but ${diff} differs from it`);
    if (!holders.includes(turn)) {
      throw failure(`after restart: the pending ${kind} was saved with the turn on ${turn}, expected ${holders.join(' or ')}`);
    }
    this.hands = next.hands;
    this.declared = next.declared;
    this.scores = next.scores;
    this.settle(kind, [turn]);
  }

  // As the engine's _resolveValidTurn: the declaring team if it still holds cards, else anyone who does.
  private _turnAfterDeclaration(team: Team): string[] {
    const withCards = [...this.teams.keys()].filter((p) => this._hand(p).size > 0);
    const teammates = withCards.filter((p) => this.teams.get(p) === team);
    return teammates.length > 0 ? teammates : withCards;
  }

  private _agreed(inits: Msg[]): _State {
    const story = (m: Msg) =>
      JSON.stringify([_declaredOf(m), m.gameState.scores.team1, m.gameState.scores.team2, m.gameState.currentTurnPlayerId, m.askHistory]);
    if (inits.some((m) => story(m) !== story(inits[0]))) {
      throw failure('after restart: the six game_init frames disagree on declared half-suits, score, turn or askHistory');
    }
    const ids = inits.map((m) => m.myPlayerId);
    if (ids.length !== this.teams.size || new Set(ids).size !== ids.length || ids.some((id) => !this.teams.has(id))) {
      throw failure(`after restart: game_init frames for ${ids.join(', ')}, expected the six players`);
    }
    const declared = _declaredOf(inits[0]);
    const problem = _conservation(inits.map((m) => m.myHand), Object.keys(declared).length);
    if (problem) throw failure(`after restart: ${problem}`);
    return {
      hands: Object.fromEntries(inits.map((m) => [m.myPlayerId, [...m.myHand].sort()])),
      declared,
      scores: { team1: inits[0].gameState.scores.team1, team2: inits[0].gameState.scores.team2 },
    };
  }

  private _checkpoint(kind: Checkpoint['kind'], turns: string[]): Checkpoint {
    return {
      kind,
      asks: this.asks,
      declarations: this.declarations,
      hands: Object.fromEntries([...this.hands].map(([playerId, hand]) => [playerId, [...hand].sort()])),
      declared: _sortedRecord([...this.declared]),
      scores: { ...this.scores },
      turns: [...turns],
    };
  }

  private _restore(cp: Checkpoint): void {
    this.hands = new Map(Object.entries(cp.hands).map(([playerId, cards]) => [playerId, new Set(cards)]));
    this.declared = new Map(Object.entries(cp.declared));
    this.scores = { ...cp.scores };
    this.asks = cp.asks;
    this.declarations = cp.declarations;
  }

  private _hand(playerId: string): Set<string> {
    const hand = this.hands.get(playerId);
    if (!hand) throw failure(`model: no player ${playerId}`);
    return hand;
  }
}

function _conservation(hands: string[][], declaredCount: number): string | null {
  const cards = hands.flat();
  const expected = _DECK - _HALF_SUIT_SIZE * declaredCount;
  const different = new Set(cards).size;
  if (different === cards.length && cards.length === expected) return null;
  return `hands hold ${cards.length} cards, ${different} different, expected ${expected}`;
}

function _declaredOf(init: Msg): Record<string, Team> {
  return _sortedRecord(init.gameState.declaredSuits.map((d: Msg) => [d.halfSuitId, d.teamId]));
}

function _sortedRecord(entries: [string, Team][]): Record<string, Team> {
  return Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
}

function _diff(want: _State, got: _State): string | null {
  for (const playerId of Object.keys(want.hands)) {
    if (JSON.stringify(want.hands[playerId]) !== JSON.stringify(got.hands[playerId])) return `${playerId}'s hand`;
  }
  if (JSON.stringify(want.declared) !== JSON.stringify(got.declared)) return 'the declared half-suits';
  if (want.scores.team1 !== got.scores.team1 || want.scores.team2 !== got.scores.team2) return 'the score';
  return null;
}
