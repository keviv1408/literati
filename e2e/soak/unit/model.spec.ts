import { expect, test } from '@playwright/test';
import { applyAsk, applyDeclaration, validateAsk, validateDeclaration } from '../../../backend/src/game/gameEngine';
import { SoakFailure } from '../lib/fail';
import { Model } from '../lib/model';
import { halfSuits, type Move } from '../lib/policy';
import { fixedGame, handsOf, initsOf } from './game';

interface _Game {
  gs: any;
  model: Model;
}

function _start(): _Game {
  const gs = fixedGame();
  return { gs, model: Model.fromInits(initsOf(gs)) };
}

function _total(model: Model): number {
  return [...model.hands.values()].reduce((n, hand) => n + hand.size, 0);
}

// One settled ask, played on the backend's engine and in the model, as the driver sees it.
function _ask(g: _Game, targetId: string, cardId: string): void {
  const askerId = g.gs.currentTurnPlayerId;
  expect(validateAsk(g.gs, askerId, targetId, cardId), `${askerId} asks ${targetId} for ${cardId}`).toEqual({ valid: true });
  const { success } = applyAsk(g.gs, askerId, targetId, cardId);
  g.model.applyAsk(askerId, targetId, cardId, success);
  g.model.settle('ask', [g.gs.currentTurnPlayerId]);
}

function _assignment(gs: any, halfSuitId: string): Record<string, string> {
  const holderOf = (card: string) => [...gs.hands].find(([, hand]) => hand.has(card))[0];
  return Object.fromEntries(halfSuits().get(halfSuitId)!.map((card) => [card, holderOf(card)]));
}

// The server saves the engine's holder, then parks the turn on the declarer while two teammates hold cards.
function _declare(g: _Game, halfSuitId: string): void {
  const declarerId = g.gs.currentTurnPlayerId;
  const assignment = _assignment(g.gs, halfSuitId);
  expect(validateDeclaration(g.gs, declarerId, halfSuitId, assignment), `${declarerId} declares ${halfSuitId}`).toEqual({ valid: true });
  const { winningTeam } = applyDeclaration(g.gs, declarerId, halfSuitId, assignment);
  g.model.applyDeclaration(halfSuitId, winningTeam);
  const saved = g.gs.currentTurnPlayerId;
  const withCards = g.gs.players.filter((p: any) => p.teamId === winningTeam && g.gs.hands.get(p.playerId).size > 0);
  g.model.settle('declaration', withCards.length > 1 ? [declarerId, saved] : [saved]);
}

function _handoff(g: _Game, chosenId: string): void {
  g.gs.currentTurnPlayerId = chosenId;
  g.model.settle('handoff', [chosenId]);
}

// p0 declares low_s, then takes the rest of high_s from p1 and holds nothing else.
function _takeHighSpades(): _Game {
  const g = _start();
  _declare(g, 'low_s');
  for (const card of ['10_s', '11_s', '12_s', '13_s']) _ask(g, 'p1', card);
  return g;
}

// p0 declares high_s with its last cards: the engine gives the turn to p2, the server parks it on p0.
function _eliminated(): _Game {
  const g = _takeHighSpades();
  _declare(g, 'high_s');
  return g;
}

// Both teams declare and team 2 takes team 1's loose cards, until only p0's high_s and p1's low_h are left.
function _teamOneDownToHighSpades(): _Game {
  const g = _start();
  const steps = ['low_s', 'p3 10_s', 'p4 10_d', 'p4 11_d', 'p4 12_d', 'p4 13_d', 'high_d', 'low_d', 'p4 1_c', 'p4 2_c',
    'p4 3_c', 'p4 4_c', 'low_c', 'high_c', 'p2 5_h', 'p2 6_h', 'p2 8_s', 'high_h', 'p1 10_s', 'p1 11_s', 'p1 12_s', 'p1 13_s'];
  for (const step of steps) {
    const [first, card] = step.split(' ');
    if (card) _ask(g, first, card);
    else _declare(g, first);
  }
  return g;
}

// p0 hits p1, p0 misses p3, p3 hits p4. snaps[i] is the server's state after i of them.
function _threeAsks(): { g: _Game; snaps: any[] } {
  const g = _start();
  const snaps = [structuredClone(g.gs)];
  for (const [targetId, cardId] of [['p1', '10_s'], ['p3', '11_s'], ['p4', '10_d']]) {
    _ask(g, targetId, cardId);
    snaps.push(structuredClone(g.gs));
  }
  return { g, snaps };
}

test('fromInits rejects a bot, a short hand, a shared card', () => {
  const inits = initsOf(fixedGame());
  const model = Model.fromInits(inits);
  expect(model.turn).toBe('p0');
  expect([...model.teams.values()].sort()).toEqual([1, 1, 1, 2, 2, 2]);
  expect(model.history).toHaveLength(1);

  const bot = structuredClone(inits);
  bot[3].players[1].isBot = true;
  const short = structuredClone(inits);
  short[0].myHand.pop();
  const shared = structuredClone(inits);
  shared[1].myHand[0] = shared[0].myHand[0];
  for (const bad of [bot, short, shared]) expect(() => Model.fromInits(bad)).toThrow(SoakFailure);
});

test('a hit moves one card and keeps the count at 48', () => {
  const { model } = _start();
  model.applyAsk('p0', 'p1', '10_s', true);
  model.settle('ask', ['p0']);
  expect(model.hands.get('p0')!.has('10_s')).toBe(true);
  expect(model.hands.get('p1')!.has('10_s')).toBe(false);
  expect(_total(model)).toBe(48);
  expect(model.asks).toBe(1);
});

test('a result the model cannot explain fails', () => {
  const { model } = _start();
  expect(() => model.applyAsk('p0', 'p3', '10_s', true)).toThrow(SoakFailure);
  expect(() => model.applyAsk('p0', 'p1', '10_s', false)).toThrow(SoakFailure);
  expect(() => model.applyDeclaration('low_s', 2)).toThrow(SoakFailure);
  expect(() => model.applyDeclaration('high_s', 1)).toThrow(SoakFailure);
  expect(model.declared.size).toBe(0);
});

test('a declaration removes six cards and scores one', () => {
  const { model } = _start();
  model.applyDeclaration('low_s', 1);
  model.settle('declaration', ['p0']);
  expect([...model.hands.get('p0')!].sort()).toEqual(['8_s', '9_s']);
  expect(model.scores).toEqual({ team1: 1, team2: 0 });
  expect(model.declared.get('low_s')).toBe(1);
  expect(_total(model)).toBe(42);
  expect(model.declarations).toBe(1);
});

test('settle pushes a checkpoint with sorted hands and both holders', () => {
  const g = _eliminated();
  const tip = g.model.history.at(-1)!;
  expect(g.model.history.map((cp) => cp.kind)).toEqual(['start', 'declaration', 'ask', 'ask', 'ask', 'ask', 'declaration']);
  expect(tip).toMatchObject({ kind: 'declaration', asks: 4, declarations: 2, turns: ['p0', 'p2'], scores: { team1: 2, team2: 0 } });
  expect(tip.declared).toEqual({ low_s: 1, high_s: 1 });
  expect(tip.hands).toEqual(handsOf(g.gs));
  for (const cards of Object.values(tip.hands)) expect(cards).toEqual([...cards].sort());
  expect(g.model.turn).toBe('p0');
});

test('matchRestart accepts the tip with 0 lost', () => {
  const { g, snaps } = _threeAsks();
  expect(g.model.matchRestart(initsOf(snaps[3]), null)).toEqual({ lostMoves: 0, pendingKept: false });
  expect(g.model.history).toHaveLength(4);
  expect(g.model.turn).toBe('p3');
});

test('accepts two moves back with 2 lost and truncates the history', () => {
  const { g, snaps } = _threeAsks();
  expect(g.model.matchRestart(initsOf(snaps[1]), null)).toEqual({ lostMoves: 2, pendingKept: false });
  expect(g.model.history).toHaveLength(2);
  expect(g.model.asks).toBe(1);
  expect(g.model.turn).toBe('p0');
  expect(Object.fromEntries([...g.model.hands].map(([p, hand]) => [p, [...hand].sort()]))).toEqual(handsOf(snaps[1]));
});

test('rejects three moves back', () => {
  const { g, snaps } = _threeAsks();
  expect(() => g.model.matchRestart(initsOf(snaps[0]), null)).toThrow(/lost 3 moves/);
});

test('accepts the pending ask applied', () => {
  // A hit keeps the turn on the asker; a miss hands it to the target.
  for (const [targetId, holder] of [['p1', 'p0'], ['p3', 'p3']]) {
    const g = _start();
    const pending: Move = { type: 'ask_card', targetPlayerId: targetId, cardId: '10_s', hit: holder === 'p0' };
    applyAsk(g.gs, 'p0', targetId, '10_s');
    expect(g.model.matchRestart(initsOf(g.gs), pending)).toEqual({ lostMoves: 0, pendingKept: true });
    expect(g.model.turn).toBe(holder);
    expect(g.model.asks).toBe(1);
    expect(g.model.history.at(-1)).toMatchObject({ kind: 'ask', turns: [holder], hands: handsOf(g.gs) });
  }

  const lost = _start();
  const pending: Move = { type: 'ask_card', targetPlayerId: 'p1', cardId: '10_s', hit: true };
  expect(lost.model.matchRestart(initsOf(lost.gs), pending)).toEqual({ lostMoves: 0, pendingKept: false });

  const elsewhere = _start();
  applyAsk(elsewhere.gs, 'p0', 'p1', '10_s');
  elsewhere.gs.currentTurnPlayerId = 'p2';
  expect(() => elsewhere.model.matchRestart(initsOf(elsewhere.gs), pending)).toThrow(/turn on p2/);
});

test('accepts the pending declaration applied with the turn on a teammate', () => {
  const g = _takeHighSpades();
  const assignment = _assignment(g.gs, 'high_s');
  applyDeclaration(g.gs, 'p0', 'high_s', assignment);
  expect(g.gs.currentTurnPlayerId).toBe('p2');
  const pending: Move = { type: 'declare_suit', halfSuitId: 'high_s', assignment };
  expect(g.model.matchRestart(initsOf(g.gs), pending)).toEqual({ lostMoves: 0, pendingKept: true });
  expect(g.model.turn).toBe('p2');
  expect(g.model.declarations).toBe(2);
  expect(g.model.scores).toEqual({ team1: 2, team2: 0 });
  expect(g.model.declared.get('high_s')).toBe(1);

  const opponent = _takeHighSpades();
  applyDeclaration(opponent.gs, 'p0', 'high_s', assignment);
  opponent.gs.currentTurnPlayerId = 'p1';
  expect(() => opponent.model.matchRestart(initsOf(opponent.gs), pending)).toThrow(/turn on p1/);
});

test('a pending declaration that empties its team leaves the turn with an opponent who has cards', () => {
  const ready = _teamOneDownToHighSpades();
  const highSpades = halfSuits().get('high_s')!;
  expect(handsOf(ready.gs)).toEqual({ p0: [...highSpades].sort(), p1: [...halfSuits().get('low_h')!].sort(), p2: [], p3: [], p4: [], p5: [] });
  const assignment = _assignment(ready.gs, 'high_s');
  const pending: Move = { type: 'declare_suit', halfSuitId: 'high_s', assignment };

  for (const [turn, kept] of [['p1', true], ['p3', false]] as const) {
    const g = _teamOneDownToHighSpades();
    applyDeclaration(g.gs, 'p0', 'high_s', assignment);
    expect(g.gs.status).toBe('active');
    if (kept) {
      expect(g.gs.currentTurnPlayerId).toBe('p1');
      expect(g.model.matchRestart(initsOf(g.gs), pending)).toEqual({ lostMoves: 0, pendingKept: true });
      expect(g.model.turn).toBe('p1');
      expect(g.model.declarations).toBe(7);
    } else {
      g.gs.currentTurnPlayerId = turn;
      expect(() => g.model.matchRestart(initsOf(g.gs), pending)).toThrow(/turn on p3/);
    }
  }
});

test('after a declaration accepts the saved holder and the parked holder', () => {
  for (const turn of ['p2', 'p0']) {
    const g = _eliminated();
    g.gs.currentTurnPlayerId = turn;
    expect(g.model.matchRestart(initsOf(g.gs), null)).toEqual({ lostMoves: 0, pendingKept: false });
    expect(g.model.turn).toBe(turn);
    expect(g.model.history).toHaveLength(7);
  }
});

test('an eliminated declarer followed by a handoff', () => {
  for (const [turn, kind, length] of [['p2', 'declaration', 7], ['p4', 'handoff', 8]] as const) {
    const g = _eliminated();
    _handoff(g, 'p4');
    g.gs.currentTurnPlayerId = turn;
    expect(g.model.matchRestart(initsOf(g.gs), null)).toEqual({ lostMoves: 0, pendingKept: false });
    expect(g.model.history).toHaveLength(length);
    expect(g.model.history.at(-1)!.kind).toBe(kind);
    expect(g.model.turn).toBe(turn);
  }

  const g = _eliminated();
  _handoff(g, 'p4');
  g.gs.currentTurnPlayerId = 'p1';
  expect(() => g.model.matchRestart(initsOf(g.gs), null)).toThrow(/turn on p1/);
});

test('rejects inits that disagree with each other', () => {
  const { g, snaps } = _threeAsks();
  const spoilers: ((inits: any[]) => void)[] = [
    (inits) => (inits[2].gameState.currentTurnPlayerId = 'p0'),
    (inits) => inits[4].askHistory.pop(),
    (inits) => (inits[1].gameState.scores.team1 = 1),
    (inits) => inits[5].gameState.declaredSuits.push({ halfSuitId: 'low_s', teamId: 1, declaredBy: 'p0' }),
    (inits) => inits[0].myHand.push(inits[1].myHand[0]),
  ];
  for (const spoil of spoilers) {
    const inits = initsOf(snaps[3]);
    spoil(inits);
    expect(() => g.model.matchRestart(inits, null)).toThrow(SoakFailure);
  }
  expect(g.model.history).toHaveLength(4);
});

test('rejects hands that differ from the checkpoint', () => {
  const { g, snaps } = _threeAsks();
  snaps[3].hands.get('p0').delete('1_s');
  snaps[3].hands.get('p1').add('1_s');
  expect(() => g.model.matchRestart(initsOf(snaps[3]), null)).toThrow(/p0's hand/);
});
