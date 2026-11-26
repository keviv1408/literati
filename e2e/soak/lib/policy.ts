import { buildHalfSuitMap } from '../../../backend/src/game/halfSuits';
import { failure } from './fail';
import { MISS_RATE } from './limits';
import type { Model } from './model';
import type { Rng } from './rng';

export type Move =
  | { type: 'ask_card'; targetPlayerId: string; cardId: string; hit: boolean }
  | { type: 'declare_suit'; halfSuitId: string; assignment: Record<string, string> }
  | { type: 'choose_next_turn'; chosenPlayerId: string };

type _Ask = { targetPlayerId: string; cardId: string };

const _HALF_SUITS: Map<string, string[]> = buildHalfSuitMap('remove_7s');

export function halfSuits(): Map<string, string[]> {
  return _HALF_SUITS;
}

export function legalHits(model: Model, holderId: string): _Ask[] {
  return _asks(model, holderId, true);
}

export function legalMisses(model: Model, holderId: string): _Ask[] {
  return _asks(model, holderId, false);
}

export function pickMove(
  model: Model,
  holderId: string,
  ctx: { openChoice: string[] | null; missesLeft: number; rng: Rng },
): Move {
  const team = model.teams.get(holderId);
  const hand = _hand(model, holderId);
  if (ctx.openChoice || hand.size === 0) {
    const choices = (ctx.openChoice ?? [...model.teams.keys()]).filter(
      (p) => model.teams.get(p) === team && _hand(model, p).size > 0,
    );
    if (choices.length === 0) throw failure(`no teammate of ${holderId} has cards to take the turn`);
    return { type: 'choose_next_turn', chosenPlayerId: ctx.rng.pick(choices) };
  }

  const holderOf = _holders(model);
  const full = [..._HALF_SUITS].filter(
    ([id, cards]) =>
      !model.declared.has(id) &&
      cards.some((card) => hand.has(card)) &&
      cards.every((card) => model.teams.get(holderOf.get(card) ?? '') === team),
  );
  if (full.length > 0) {
    const [halfSuitId, cards] = ctx.rng.pick(full);
    return { type: 'declare_suit', halfSuitId, assignment: Object.fromEntries(cards.map((card) => [card, holderOf.get(card)!])) };
  }

  const misses = legalMisses(model, holderId);
  if (ctx.missesLeft > 0 && misses.length > 0 && ctx.rng.chance(MISS_RATE)) {
    return { type: 'ask_card', ...ctx.rng.pick(misses), hit: false };
  }
  const hits = legalHits(model, holderId);
  // A holder with cards and nothing to declare always has a hit: some card of each of its half-suits is with an opponent.
  if (hits.length === 0) throw failure(`${holderId} has no legal ask and nothing to declare`);
  return { type: 'ask_card', ...ctx.rng.pick(hits), hit: true };
}

export function isFinalDeclaration(model: Model, move: Move): boolean {
  return move.type === 'declare_suit' && model.declared.size === _HALF_SUITS.size - 1;
}

export function toWire(move: Move): object {
  if (move.type !== 'ask_card') return { ...move };
  return { type: move.type, targetPlayerId: move.targetPlayerId, cardId: move.cardId };
}

// The rules of gameEngine.js validateAsk. A miss asks any opponent with cards who lacks the card.
function _asks(model: Model, holderId: string, hit: boolean): _Ask[] {
  const team = model.teams.get(holderId);
  const hand = _hand(model, holderId);
  const opponents = [...model.teams.keys()].filter((p) => model.teams.get(p) !== team && _hand(model, p).size > 0);
  const out: _Ask[] = [];
  for (const [id, cards] of _HALF_SUITS) {
    if (model.declared.has(id) || !cards.some((card) => hand.has(card))) continue;
    for (const cardId of cards) {
      if (hand.has(cardId)) continue;
      for (const targetPlayerId of opponents) {
        if (_hand(model, targetPlayerId).has(cardId) === hit) out.push({ targetPlayerId, cardId });
      }
    }
  }
  return out;
}

function _holders(model: Model): Map<string, string> {
  return new Map([...model.hands].flatMap(([playerId, hand]) => [...hand].map((card) => [card, playerId] as const)));
}

function _hand(model: Model, playerId: string): Set<string> {
  return model.hands.get(playerId) ?? new Set();
}
