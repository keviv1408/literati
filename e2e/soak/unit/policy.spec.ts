import { expect, test } from '@playwright/test';
import assert from 'node:assert/strict';
import { applyAsk, applyDeclaration, validateAsk, validateDeclaration } from '../../../backend/src/game/gameEngine';
import { MISS_BUDGET } from '../lib/limits';
import { Model } from '../lib/model';
import { halfSuits, isFinalDeclaration, legalMisses, pickMove, toWire, type Move } from '../lib/policy';
import { createRng, type Rng } from '../lib/rng';
import { fixedGame, handsOf, initsOf, newGame, PLAYERS } from './game';

type _Ask = Extract<Move, { type: 'ask_card' }>;

// Always the first option and always yes, so a test sees the first rule the policy allows.
const _EAGER: Rng = { next: () => 0, int: (min) => min, pick: (items) => items[0], chance: () => true };

function _model(): Model {
  return Model.fromInits(initsOf(fixedGame()));
}

function _pick(model: Model, holderId: string, rng: Rng = _EAGER, missesLeft = MISS_BUDGET): Move {
  return pickMove(model, holderId, { openChoice: null, missesLeft, rng });
}

function _modelHands(model: Model): Record<string, string[]> {
  return Object.fromEntries(PLAYERS.map((p) => [p, [...model.hands.get(p)!].sort()]));
}

// The engine has no choice after a declaration, so this plays the socket server's: the declarer holds the turn and picks.
function _playGame(seed: number, onAsk?: (model: Model, holderId: string, move: _Ask) => void): { moves: number; misses: number } {
  const gs = newGame();
  const where = `seed ${seed}, deal ${JSON.stringify(handsOf(gs))}`;
  const model = Model.fromInits(initsOf(gs));
  const rng = createRng(seed);
  let openChoice: string[] | null = null;
  let moves = 0;
  let misses = 0;
  while (gs.status === 'active') {
    assert.ok(moves < 400, `${where}: no end in 400 moves`);
    const holderId = gs.currentTurnPlayerId;
    assert.equal(model.turn, holderId, where);
    const move = pickMove(model, holderId, { openChoice, missesLeft: MISS_BUDGET - misses, rng });
    moves++;
    if (move.type === 'ask_card') {
      onAsk?.(model, holderId, move);
      assert.deepEqual(validateAsk(gs, holderId, move.targetPlayerId, move.cardId), { valid: true }, `${where}, move ${moves}`);
      const { success } = applyAsk(gs, holderId, move.targetPlayerId, move.cardId);
      assert.equal(success, move.hit, `${where}, move ${moves}`);
      if (!success) misses++;
      model.applyAsk(holderId, move.targetPlayerId, move.cardId, success);
      model.settle('ask', [gs.currentTurnPlayerId]);
    } else if (move.type === 'declare_suit') {
      assert.deepEqual(validateDeclaration(gs, holderId, move.halfSuitId, move.assignment), { valid: true }, `${where}, move ${moves}`);
      const { correct, winningTeam } = applyDeclaration(gs, holderId, move.halfSuitId, move.assignment);
      assert.ok(correct, `${where}, move ${moves}`);
      model.applyDeclaration(move.halfSuitId, winningTeam);
      const saved = gs.currentTurnPlayerId;
      const eligible = gs.players
        .filter((p: any) => p.teamId === winningTeam && gs.hands.get(p.playerId).size > 0)
        .map((p: any) => p.playerId);
      if (gs.status === 'active' && eligible.length > 1) {
        gs.currentTurnPlayerId = holderId;
        openChoice = eligible;
        model.settle('declaration', [holderId, saved]);
      } else {
        model.settle('declaration', [saved]);
      }
    } else {
      // The checks handleChooseNextTurn makes.
      if (openChoice) assert.ok(openChoice.includes(move.chosenPlayerId), `${where}, move ${moves}`);
      assert.equal(model.teams.get(move.chosenPlayerId), model.teams.get(holderId), `${where}, move ${moves}`);
      assert.ok(gs.hands.get(move.chosenPlayerId).size > 0, `${where}, move ${moves}`);
      gs.currentTurnPlayerId = move.chosenPlayerId;
      openChoice = null;
      model.settle('handoff', [move.chosenPlayerId]);
    }
    assert.deepEqual(_modelHands(model), handsOf(gs), `${where}, move ${moves}`);
  }
  assert.equal(gs.declaredSuits.size, 8, where);
  assert.ok(misses <= MISS_BUDGET, `${where}: ${misses} misses`);
  return { moves, misses };
}

test('a holder with an open choice hands off to an eligible player', () => {
  // p0 holds all of low_s, so without the open choice it would declare.
  const model = _model();
  const chosen = new Set<string>();
  for (let seed = 1; seed <= 20; seed++) {
    const move = pickMove(model, 'p0', { openChoice: ['p2', 'p4'], missesLeft: MISS_BUDGET, rng: createRng(seed) });
    expect(move.type).toBe('choose_next_turn');
    if (move.type === 'choose_next_turn') chosen.add(move.chosenPlayerId);
  }
  expect([...chosen].sort()).toEqual(['p2', 'p4']);
});

test('a holder with no cards hands off to a teammate with cards', () => {
  const model = _model();
  const p2 = model.hands.get('p2')!;
  for (const p of ['p0', 'p4']) {
    for (const card of model.hands.get(p)!) p2.add(card);
    model.hands.get(p)!.clear();
  }
  expect(_pick(model, 'p0', createRng(1))).toEqual({ type: 'choose_next_turn', chosenPlayerId: 'p2' });
});

test('a full half-suit is declared with the true assignment', () => {
  // Team 1 holds all of high_h across p2 and p4; _EAGER would miss if the policy reached the ask rule.
  const model = _model();
  for (const card of ['8_h', '9_h']) {
    model.hands.get('p2')!.delete(card);
    model.hands.get('p4')!.add(card);
  }
  expect(_pick(model, 'p4')).toEqual({
    type: 'declare_suit',
    halfSuitId: 'high_h',
    assignment: { '8_h': 'p4', '9_h': 'p4', '10_h': 'p2', '11_h': 'p2', '12_h': 'p2', '13_h': 'p2' },
  });
});

test('no legal miss means a hit', () => {
  // p0's only half-suit is low_s, and p1, the only opponent with cards, holds the rest of it.
  const model = _model();
  const lowSpades = halfSuits().get('low_s')!;
  const rest = [...halfSuits().values()].flat().filter((card) => !lowSpades.includes(card));
  model.hands = new Map([
    ['p0', new Set(lowSpades.slice(0, 1))],
    ['p1', new Set(lowSpades.slice(1))],
    ['p2', new Set(rest)],
    ['p3', new Set()],
    ['p4', new Set()],
    ['p5', new Set()],
  ]);
  expect(legalMisses(model, 'p0')).toEqual([]);
  expect(_pick(model, 'p0')).toEqual({ type: 'ask_card', targetPlayerId: 'p1', cardId: '2_s', hit: true });
});

test('misses stop when the budget is 0', () => {
  // p1 holds no full half-suit of its team, so it asks.
  const model = _model();
  expect(_pick(model, 'p1', _EAGER, 1)).toMatchObject({ type: 'ask_card', hit: false });
  expect(_pick(model, 'p1', _EAGER, 0)).toMatchObject({ type: 'ask_card', hit: true });
});

test('toWire strips hit, and only the eighth declaration is final', () => {
  expect(toWire({ type: 'ask_card', targetPlayerId: 'p1', cardId: '10_s', hit: true })).toEqual({
    type: 'ask_card',
    targetPlayerId: 'p1',
    cardId: '10_s',
  });
  const model = _model();
  const declare: Move = { type: 'declare_suit', halfSuitId: 'low_s', assignment: {} };
  expect(isFinalDeclaration(model, declare)).toBe(false);
  for (const halfSuitId of [...halfSuits().keys()].slice(1)) model.declared.set(halfSuitId, 1);
  expect(isFinalDeclaration(model, declare)).toBe(true);
  expect(isFinalDeclaration(model, { type: 'choose_next_turn', chosenPlayerId: 'p2' })).toBe(false);
});

test('every ask is legal', () => {
  for (let seed = 1; seed <= 50; seed++) {
    _playGame(seed, (model, holderId, move) => {
      const where = `seed ${seed}, ${holderId} asks ${move.targetPlayerId} for ${move.cardId}`;
      const [halfSuitId, cards] = [...halfSuits()].find(([, ids]) => ids.includes(move.cardId))!;
      const hand = model.hands.get(holderId)!;
      const target = model.hands.get(move.targetPlayerId)!;
      assert.ok(!hand.has(move.cardId), `${where}: holds it`);
      assert.ok(cards.some((card) => card !== move.cardId && hand.has(card)), `${where}: holds nothing of ${halfSuitId}`);
      assert.notEqual(model.teams.get(move.targetPlayerId), model.teams.get(holderId), `${where}: a teammate`);
      assert.ok(target.size > 0, `${where}: target has no cards`);
      assert.ok(!model.declared.has(halfSuitId), `${where}: ${halfSuitId} is declared`);
      assert.equal(target.has(move.cardId), move.hit, `${where}: hit is wrong`);
    });
  }
});

test('200 seeded games end with 8 declarations', () => {
  const moves = Array.from({ length: 200 }, (_, i) => _playGame(i + 1).moves).sort((a, b) => a - b);
  test.info().annotations.push({ type: 'moves', description: `median ${(moves[99] + moves[100]) / 2}, max ${moves[199]}` });
});
