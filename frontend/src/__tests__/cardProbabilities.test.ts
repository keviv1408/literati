/**
 * @jest-environment node
 *
 * Unit tests for cardProbabilities utility — Sub-AC 37c
 *
 * Coverage:
 *   getDeclaredCardIds
 *     • returns empty set for no declared suits
 *     • includes all 6 cards for a single declared suit (remove_7s)
 *     • includes cards from multiple declared suits
 *     • uses correct ranks for remove_2s variant
 *     • uses correct ranks for remove_8s variant
 *
 *   computeCardProbabilities
 *     • returns empty object for a card in myHand
 *     • returns empty object for a declared card
 *     • returns empty object when all other players have 0 cards
 *     • single opponent: returns 100% for that opponent
 *     • equal card counts: returns equal probability for each player
 *     • unequal card counts: weights by card count
 *     • local player excluded from probability map
 *     • probabilities round to nearest integer
 *     • spectator mode (myPlayerId null): all players included
 *
 *   computePlayerSharePercent
 *     • returns 0 for local player
 *     • returns 0 when all others have 0 cards
 *     • equal distribution across 3 opponents
 *     • weighted by card count
 *     • spectator sees non-zero share for all players
 *
 *   computeHalfSuitProbabilities
 *     • returns empty map when variant is null (handled upstream)
 *     • cards in myHand map to empty ProbabilityMap
 *     • unknown cards map to non-empty ProbabilityMap
 */

import {
  getDeclaredCardIds,
  computeCardProbabilities,
  computePlayerSharePercent,
  computeHalfSuitProbabilities,
} from '@/utils/cardProbabilities';
import type { GamePlayer, DeclaredSuit } from '@/types/game';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makePlayer(overrides: Partial<GamePlayer> = {}): GamePlayer {
  return {
    playerId: 'p1',
    displayName: 'Alice',
    avatarId: null,
    teamId: 1,
    seatIndex: 0,
    cardCount: 6,
    isBot: false,
    isGuest: false,
    isCurrentTurn: false,
    ...overrides,
  };
}

const REMOVE_7S = 'remove_7s' as const;
const REMOVE_2S = 'remove_2s' as const;
const REMOVE_8S = 'remove_8s' as const;

// ── getDeclaredCardIds ─────────────────────────────────────────────────────────

describe('getDeclaredCardIds', () => {
  it('returns empty set when no suits declared', () => {
    const set = getDeclaredCardIds([], REMOVE_7S);
    expect(set.size).toBe(0);
  });

  it('returns 6 cards for low_s in remove_7s variant', () => {
    const declared: DeclaredSuit[] = [{ halfSuitId: 'low_s', teamId: 1, declaredBy: 'p1' }];
    const set = getDeclaredCardIds(declared, REMOVE_7S);
    // Low spades in remove_7s: ranks 1,2,3,4,5,6
    expect(set.size).toBe(6);
    expect(set.has('1_s')).toBe(true);
    expect(set.has('6_s')).toBe(true);
    expect(set.has('7_s')).toBe(false); // removed
    expect(set.has('8_s')).toBe(false); // high suit
  });

  it('accumulates cards from multiple declared suits', () => {
    const declared: DeclaredSuit[] = [
      { halfSuitId: 'low_s', teamId: 1, declaredBy: 'p1' },
      { halfSuitId: 'high_h', teamId: 2, declaredBy: 'p2' },
    ];
    const set = getDeclaredCardIds(declared, REMOVE_7S);
    expect(set.size).toBe(12); // 6 + 6
  });

  it('uses correct ranks for remove_2s variant (low suit = 1,3,4,5,6,7)', () => {
    const declared: DeclaredSuit[] = [{ halfSuitId: 'low_c', teamId: 1, declaredBy: 'p1' }];
    const set = getDeclaredCardIds(declared, REMOVE_2S);
    // remove_2s: remaining = 1,3,4,5,6,7,8,9,10,11,12,13; low = 1,3,4,5,6,7
    expect(set.has('1_c')).toBe(true);
    expect(set.has('3_c')).toBe(true);
    expect(set.has('7_c')).toBe(true);
    expect(set.has('2_c')).toBe(false); // removed rank
    expect(set.has('8_c')).toBe(false); // in high suit
  });

  it('uses correct ranks for remove_8s variant (low suit = 1,2,3,4,5,6)', () => {
    const declared: DeclaredSuit[] = [{ halfSuitId: 'low_d', teamId: 1, declaredBy: 'p1' }];
    const set = getDeclaredCardIds(declared, REMOVE_8S);
    // remove_8s: remaining = 1,2,3,4,5,6,7,9,10,11,12,13; low = 1,2,3,4,5,6
    expect(set.has('1_d')).toBe(true);
    expect(set.has('6_d')).toBe(true);
    expect(set.has('7_d')).toBe(false); // in high suit
    expect(set.has('8_d')).toBe(false); // removed rank
  });
});

// ── computeCardProbabilities ──────────────────────────────────────────────────

describe('computeCardProbabilities', () => {
  it('returns {} for a card in myHand', () => {
    const players = [
      makePlayer({ playerId: 'me', cardCount: 6 }),
      makePlayer({ playerId: 'opp', teamId: 2, cardCount: 6 }),
    ];
    const result = computeCardProbabilities('1_s', 'me', ['1_s'], players, new Set());
    expect(result).toEqual({});
  });

  it('returns {} for a declared card', () => {
    const declared = new Set(['3_h']);
    const players = [
      makePlayer({ playerId: 'me', cardCount: 6 }),
      makePlayer({ playerId: 'opp', teamId: 2, cardCount: 6 }),
    ];
    const result = computeCardProbabilities('3_h', 'me', [], players, declared);
    expect(result).toEqual({});
  });

  it('returns {} when all other players have 0 cards', () => {
    const players = [
      makePlayer({ playerId: 'me', cardCount: 6 }),
      makePlayer({ playerId: 'opp1', teamId: 2, cardCount: 0 }),
      makePlayer({ playerId: 'opp2', teamId: 2, cardCount: 0 }),
    ];
    const result = computeCardProbabilities('5_c', 'me', [], players, new Set());
    expect(result).toEqual({});
  });

  it('returns 100% for the only opponent when they have all the cards', () => {
    const players = [
      makePlayer({ playerId: 'me', cardCount: 6 }),
      makePlayer({ playerId: 'opp', teamId: 2, cardCount: 6 }),
    ];
    const result = computeCardProbabilities('5_c', 'me', [], players, new Set());
    expect(result).toEqual({ opp: 100 });
  });

  it('distributes equally among 3 opponents with equal card counts', () => {
    const players = [
      makePlayer({ playerId: 'me',   cardCount: 6 }),
      makePlayer({ playerId: 'opp1', cardCount: 4, teamId: 2 }),
      makePlayer({ playerId: 'opp2', cardCount: 4, teamId: 2 }),
      makePlayer({ playerId: 'opp3', cardCount: 4, teamId: 2 }),
    ];
    const result = computeCardProbabilities('5_c', 'me', [], players, new Set());
    // total non-local = 12; each = 4/12 = 33%
    expect(result.opp1).toBe(33);
    expect(result.opp2).toBe(33);
    expect(result.opp3).toBe(33);
  });

  it('weights probability by card count (unequal distribution)', () => {
    const players = [
      makePlayer({ playerId: 'me',   cardCount: 6 }),
      makePlayer({ playerId: 'opp1', cardCount: 6, teamId: 2 }),
      makePlayer({ playerId: 'opp2', cardCount: 2, teamId: 2 }),
    ];
    // total non-local = 8; opp1 = 6/8 = 75%, opp2 = 2/8 = 25%
    const result = computeCardProbabilities('5_c', 'me', [], players, new Set());
    expect(result.opp1).toBe(75);
    expect(result.opp2).toBe(25);
  });

  it('excludes the local player from the probability map', () => {
    const players = [
      makePlayer({ playerId: 'me',   cardCount: 6 }),
      makePlayer({ playerId: 'opp1', cardCount: 6, teamId: 2 }),
    ];
    const result = computeCardProbabilities('5_c', 'me', [], players, new Set());
    expect('me' in result).toBe(false);
    expect('opp1' in result).toBe(true);
  });

  it('handles spectator mode (myPlayerId null) — all players included', () => {
    const players = [
      makePlayer({ playerId: 'p1', cardCount: 4 }),
      makePlayer({ playerId: 'p2', cardCount: 4, teamId: 2 }),
    ];
    const result = computeCardProbabilities('5_c', null, [], players, new Set());
    // Both players are non-local; total = 8; each = 4/8 = 50%
    expect(result.p1).toBe(50);
    expect(result.p2).toBe(50);
  });

  it('excludes players with 0 cards from the probability distribution', () => {
    const players = [
      makePlayer({ playerId: 'me',   cardCount: 6 }),
      makePlayer({ playerId: 'opp1', cardCount: 6, teamId: 2 }),
      makePlayer({ playerId: 'opp2', cardCount: 0, teamId: 2 }),
    ];
    const result = computeCardProbabilities('5_c', 'me', [], players, new Set());
    // opp2 has 0 cards, excluded; opp1 gets 100%
    expect(result.opp1).toBe(100);
    expect('opp2' in result).toBe(false);
  });

  it('rounds probabilities to nearest integer', () => {
    // 1/3 = 33.33... → rounds to 33
    const players = [
      makePlayer({ playerId: 'me',   cardCount: 3 }),
      makePlayer({ playerId: 'a', cardCount: 1, teamId: 2 }),
      makePlayer({ playerId: 'b', cardCount: 1, teamId: 2 }),
      makePlayer({ playerId: 'c', cardCount: 1, teamId: 2 }),
    ];
    const result = computeCardProbabilities('5_c', 'me', [], players, new Set());
    expect(result.a).toBe(33);
    expect(result.b).toBe(33);
    expect(result.c).toBe(33);
  });
});

// ── computePlayerSharePercent ─────────────────────────────────────────────────

describe('computePlayerSharePercent', () => {
  it('returns 0 for the local player', () => {
    const me = makePlayer({ playerId: 'me', cardCount: 6 });
    const players = [
      me,
      makePlayer({ playerId: 'opp', cardCount: 6, teamId: 2 }),
    ];
    expect(computePlayerSharePercent(me, 'me', players)).toBe(0);
  });

  it('returns 0 when all others have 0 cards', () => {
    const target = makePlayer({ playerId: 'opp', cardCount: 0, teamId: 2 });
    const players = [
      makePlayer({ playerId: 'me', cardCount: 6 }),
      target,
    ];
    expect(computePlayerSharePercent(target, 'me', players)).toBe(0);
  });

  it('equal share for 3 opponents with equal card counts', () => {
    const opp1 = makePlayer({ playerId: 'opp1', cardCount: 4, teamId: 2 });
    const players = [
      makePlayer({ playerId: 'me',   cardCount: 6 }),
      opp1,
      makePlayer({ playerId: 'opp2', cardCount: 4, teamId: 2 }),
      makePlayer({ playerId: 'opp3', cardCount: 4, teamId: 2 }),
    ];
    // total = 12; opp1 = 4/12 = 33%
    expect(computePlayerSharePercent(opp1, 'me', players)).toBe(33);
  });

  it('weighted share for unequal card counts', () => {
    const bigOpp = makePlayer({ playerId: 'big', cardCount: 9, teamId: 2 });
    const players = [
      makePlayer({ playerId: 'me',    cardCount: 6 }),
      bigOpp,
      makePlayer({ playerId: 'small', cardCount: 3, teamId: 2 }),
    ];
    // total = 12; big = 9/12 = 75%
    expect(computePlayerSharePercent(bigOpp, 'me', players)).toBe(75);
  });

  it('spectator (myPlayerId null) sees non-zero share for all players', () => {
    const p1 = makePlayer({ playerId: 'p1', cardCount: 6 });
    const players = [p1, makePlayer({ playerId: 'p2', cardCount: 6, teamId: 2 })];
    // total = 12; p1 = 6/12 = 50%
    expect(computePlayerSharePercent(p1, null, players)).toBe(50);
  });
});

// ── computeHalfSuitProbabilities ─────────────────────────────────────────────

describe('computeHalfSuitProbabilities', () => {
  const players = [
    makePlayer({ playerId: 'me',  cardCount: 6 }),
    makePlayer({ playerId: 'opp', cardCount: 6, teamId: 2 }),
  ];

  it('returns {} (no probs) for cards in myHand', () => {
    // Low spades in remove_7s: 1_s, 2_s, 3_s, 4_s, 5_s, 6_s
    const myHand = ['1_s', '2_s', '3_s', '4_s', '5_s', '6_s'];
    const result = computeHalfSuitProbabilities('low_s', REMOVE_7S, 'me', myHand, players, new Set());
    // All 6 cards are in hand → all empty maps
    for (const probs of Object.values(result)) {
      expect(Object.keys(probs).length).toBe(0);
    }
  });

  it('returns non-empty probs for unknown cards', () => {
    const result = computeHalfSuitProbabilities('low_s', REMOVE_7S, 'me', [], players, new Set());
    // No cards in hand → all 6 cards have probability map
    const entries = Object.values(result);
    expect(entries.length).toBe(6);
    for (const probs of entries) {
      expect(probs.opp).toBe(100); // only opponent has cards
    }
  });

  it('returns 6 entries for 6-card half-suit', () => {
    const result = computeHalfSuitProbabilities('high_d', REMOVE_7S, 'me', [], players, new Set());
    expect(Object.keys(result).length).toBe(6);
  });

  it('excludes declared cards from probabilities', () => {
    // Declare low_s (6 cards)
    const declared: DeclaredSuit[] = [{ halfSuitId: 'low_s', teamId: 1, declaredBy: 'me' }];
    const { getDeclaredCardIds: getIds } = require('@/utils/cardProbabilities');
    const declaredIds = getIds(declared, REMOVE_7S);
    const result = computeHalfSuitProbabilities('low_s', REMOVE_7S, 'me', [], players, declaredIds);
    // All low_s cards are declared → all empty maps
    for (const probs of Object.values(result)) {
      expect(Object.keys(probs).length).toBe(0);
    }
  });
});
