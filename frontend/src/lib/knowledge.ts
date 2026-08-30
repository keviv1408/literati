import { getCardHalfSuit } from '@/types/game';
import type { AskRecord, CardId, HalfSuitId } from '@/types/game';

type Variant = 'remove_2s' | 'remove_7s' | 'remove_8s';

export interface PlayerKnowledge {
  /** Cards this player is known to hold. */
  has: CardId[];
  /** Cards this player is known not to hold (as of their last ask involving it). */
  lacks: CardId[];
  /** Half-suits this player has asked about, so they held a card in each at the time. */
  halfSuits: HalfSuitId[];
}

function bucket<T>(map: Map<string, Set<T>>, id: string): Set<T> {
  let set = map.get(id);
  if (!set) {
    set = new Set<T>();
    map.set(id, set);
  }
  return set;
}

/**
 * Replay the public ask log into per-player knowledge. Everything here was
 * visible to the whole table; nothing is inferred from hidden hands.
 *
 * ponytail: "halfSuits" is a naive heuristic (a player may since have lost
 * every card of that half-suit). Track per-card transfers per half-suit if
 * players find it misleading.
 */
export function buildKnowledge(
  asks: AskRecord[],
  declaredSuits: HalfSuitId[],
  variant: Variant,
): Record<string, PlayerKnowledge> {
  const has = new Map<string, Set<CardId>>();
  const lacks = new Map<string, Set<CardId>>();
  const suits = new Map<string, Set<HalfSuitId>>();

  const give = (id: string, card: CardId) => {
    bucket(has, id).add(card);
    bucket(lacks, id).delete(card);
  };
  const deny = (id: string, card: CardId) => {
    bucket(lacks, id).add(card);
    bucket(has, id).delete(card);
  };

  for (const ask of asks) {
    const halfSuit = getCardHalfSuit(ask.cardId, variant);
    if (halfSuit) bucket(suits, ask.askerId).add(halfSuit);
    // You can only ask for a card you don't hold, so the asker lacks it either way
    // until a success hands it over.
    deny(ask.askerId, ask.cardId);
    deny(ask.targetId, ask.cardId);
    if (ask.success) give(ask.askerId, ask.cardId);
  }

  const declared = new Set(declaredSuits);
  const live = (card: CardId) => !declared.has(getCardHalfSuit(card, variant) ?? '');

  const result: Record<string, PlayerKnowledge> = {};
  for (const id of new Set([...has.keys(), ...lacks.keys(), ...suits.keys()])) {
    result[id] = {
      has: [...(has.get(id) ?? [])].filter(live),
      lacks: [...(lacks.get(id) ?? [])].filter(live),
      halfSuits: [...(suits.get(id) ?? [])].filter((hs) => !declared.has(hs)),
    };
  }
  return result;
}
