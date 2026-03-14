/**
 * Tests for src/utils/cardSort.ts
 *
 * Covers:
 *   - HALF_SUIT_DISPLAY_ORDER export contains all 8 half-suit IDs in the
 *     correct canonical order (low/high within each suit, suits s→h→d→c)
 *   - sortHandByHalfSuit groups cards by half-suit bucket
 *   - sortHandByHalfSuit sorts by rank within each half-suit
 *   - sortHandByHalfSuit is correct for all three variants
 *   - Empty hand returns empty array
 *   - Single-card hand is returned unchanged
 *   - Cards from different half-suits in the same suit appear in the right order
 *   - Input array is not mutated
 */

import { sortHandByHalfSuit, HALF_SUIT_DISPLAY_ORDER } from '@/utils/cardSort';
import type { CardId } from '@/types/game';
import { getCardHalfSuit } from '@/types/game';

// ── HALF_SUIT_DISPLAY_ORDER ───────────────────────────────────────────────────

describe('HALF_SUIT_DISPLAY_ORDER', () => {
  it('contains exactly 8 entries', () => {
    expect(Object.keys(HALF_SUIT_DISPLAY_ORDER)).toHaveLength(8);
  });

  it('assigns order 0 to low_s (first) and 7 to high_c (last)', () => {
    expect(HALF_SUIT_DISPLAY_ORDER['low_s']).toBe(0);
    expect(HALF_SUIT_DISPLAY_ORDER['high_c']).toBe(7);
  });

  it('puts low before high within each suit', () => {
    for (const suit of ['s', 'h', 'd', 'c']) {
      expect(HALF_SUIT_DISPLAY_ORDER[`low_${suit}`])
        .toBeLessThan(HALF_SUIT_DISPLAY_ORDER[`high_${suit}`]);
    }
  });

  it('orders suits as s → h → d → c', () => {
    const suits = ['s', 'h', 'd', 'c'];
    for (let i = 0; i < suits.length - 1; i++) {
      // Both low and high of the earlier suit should precede both tiers of
      // the later suit.
      expect(HALF_SUIT_DISPLAY_ORDER[`high_${suits[i]}`])
        .toBeLessThan(HALF_SUIT_DISPLAY_ORDER[`low_${suits[i + 1]}`]);
    }
  });

  it('all values are unique integers', () => {
    const values = Object.values(HALF_SUIT_DISPLAY_ORDER);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
    for (const v of values) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

// ── sortHandByHalfSuit — basic behaviour ─────────────────────────────────────

describe('sortHandByHalfSuit — basic', () => {
  it('returns an empty array for an empty hand', () => {
    expect(sortHandByHalfSuit([], 'remove_7s')).toEqual([]);
  });

  it('returns the same single card for a one-card hand', () => {
    expect(sortHandByHalfSuit(['5_s'], 'remove_7s')).toEqual(['5_s']);
  });

  it('does not mutate the original array', () => {
    const hand: CardId[] = ['13_c', '1_s', '9_h'];
    const copy = [...hand];
    sortHandByHalfSuit(hand, 'remove_7s');
    expect(hand).toEqual(copy);
  });
});

// ── sortHandByHalfSuit — grouping by half-suit ────────────────────────────────

describe('sortHandByHalfSuit — half-suit grouping', () => {
  /**
   * Helper: verify that for a given sorted array no card appears
   * "after" a card that belongs to a later half-suit bucket.
   */
  function assertGrouped(sorted: CardId[], variant: 'remove_2s' | 'remove_7s' | 'remove_8s') {
    let lastOrder = -1;
    for (const card of sorted) {
      const hs = getCardHalfSuit(card, variant)!;
      const order = HALF_SUIT_DISPLAY_ORDER[hs] ?? 99;
      expect(order).toBeGreaterThanOrEqual(lastOrder);
      lastOrder = order;
    }
  }

  it('groups by half-suit for remove_7s variant', () => {
    // Mix of all suits and low/high tiers
    const hand: CardId[] = [
      '9_c', '1_s', '10_h', '4_d', '13_s', '3_h', '6_c', '11_d',
    ];
    const sorted = sortHandByHalfSuit(hand, 'remove_7s');
    assertGrouped(sorted, 'remove_7s');
  });

  it('groups by half-suit for remove_2s variant', () => {
    const hand: CardId[] = [
      '9_c', '3_s', '10_h', '4_d', '13_s', '4_h', '6_c', '11_d',
    ];
    const sorted = sortHandByHalfSuit(hand, 'remove_2s');
    assertGrouped(sorted, 'remove_2s');
  });

  it('groups by half-suit for remove_8s variant', () => {
    const hand: CardId[] = [
      '9_c', '1_s', '10_h', '4_d', '13_s', '3_h', '6_c', '11_d',
    ];
    const sorted = sortHandByHalfSuit(hand, 'remove_8s');
    assertGrouped(sorted, 'remove_8s');
  });

  it('low spades appear before high spades', () => {
    // remove_7s: low_s = A,2,3,4,5,6; high_s = 8,9,10,J,Q,K
    const hand: CardId[] = ['9_s', '3_s', '13_s', '1_s', '10_s'];
    const sorted = sortHandByHalfSuit(hand, 'remove_7s');
    const lowIdx = sorted.indexOf('1_s');
    const highIdx = sorted.indexOf('9_s');
    expect(lowIdx).toBeLessThan(highIdx);
  });

  it('spades (any tier) appear before hearts (any tier)', () => {
    const hand: CardId[] = ['10_h', '1_s', '9_s', '4_h'];
    const sorted = sortHandByHalfSuit(hand, 'remove_7s');
    // Last spade index < first heart index
    const lastSpadeIdx = Math.max(sorted.indexOf('1_s'), sorted.indexOf('9_s'));
    const firstHeartIdx = Math.min(sorted.indexOf('10_h'), sorted.indexOf('4_h'));
    expect(lastSpadeIdx).toBeLessThan(firstHeartIdx);
  });

  it('diamonds appear before clubs', () => {
    const hand: CardId[] = ['9_c', '3_d', '1_d', '10_c'];
    const sorted = sortHandByHalfSuit(hand, 'remove_7s');
    const lastDiamondIdx = Math.max(sorted.indexOf('3_d'), sorted.indexOf('1_d'));
    const firstClubIdx = Math.min(sorted.indexOf('9_c'), sorted.indexOf('10_c'));
    expect(lastDiamondIdx).toBeLessThan(firstClubIdx);
  });
});

// ── sortHandByHalfSuit — rank ordering within half-suit ───────────────────────

describe('sortHandByHalfSuit — rank ordering within half-suit', () => {
  it('sorts low spades by ascending rank (remove_7s)', () => {
    // low_s for remove_7s: 1,2,3,4,5,6
    const hand: CardId[] = ['6_s', '2_s', '4_s', '1_s', '3_s', '5_s'];
    const sorted = sortHandByHalfSuit(hand, 'remove_7s');
    expect(sorted).toEqual(['1_s', '2_s', '3_s', '4_s', '5_s', '6_s']);
  });

  it('sorts high spades by ascending rank (remove_7s)', () => {
    // high_s for remove_7s: 8,9,10,11,12,13
    const hand: CardId[] = ['13_s', '10_s', '8_s', '12_s', '9_s', '11_s'];
    const sorted = sortHandByHalfSuit(hand, 'remove_7s');
    expect(sorted).toEqual(['8_s', '9_s', '10_s', '11_s', '12_s', '13_s']);
  });

  it('sorts low hearts by ascending rank (remove_2s)', () => {
    // low_h for remove_2s: 1,3,4,5,6,7 (2 removed)
    const hand: CardId[] = ['7_h', '3_h', '5_h', '1_h', '4_h', '6_h'];
    const sorted = sortHandByHalfSuit(hand, 'remove_2s');
    expect(sorted).toEqual(['1_h', '3_h', '4_h', '5_h', '6_h', '7_h']);
  });

  it('sorts high clubs by ascending rank (remove_8s)', () => {
    // remove_8s removes 8; high_c = 9,10,11,12,13 (and 7 is high_c? let's check)
    // remove_8s: remaining = [1,2,3,4,5,6,7,9,10,11,12,13]
    //            low_c = [1,2,3,4,5,6], high_c = [7,9,10,11,12,13]
    const hand: CardId[] = ['13_c', '9_c', '7_c', '11_c', '10_c', '12_c'];
    const sorted = sortHandByHalfSuit(hand, 'remove_8s');
    expect(sorted).toEqual(['7_c', '9_c', '10_c', '11_c', '12_c', '13_c']);
  });
});

// ── sortHandByHalfSuit — full hand scenarios ─────────────────────────────────

describe('sortHandByHalfSuit — full hand scenarios', () => {
  it('correctly orders a full 8-card hand (remove_7s)', () => {
    // Deliberately shuffled: one card from each of 8 half-suits
    const hand: CardId[] = [
      '9_c',   // high_c
      '1_s',   // low_s
      '10_h',  // high_h
      '4_d',   // low_d
      '13_s',  // high_s
      '3_h',   // low_h
      '11_d',  // high_d
      '6_c',   // low_c
    ];
    const sorted = sortHandByHalfSuit(hand, 'remove_7s');

    // Verify order: low_s, high_s, low_h, high_h, low_d, high_d, low_c, high_c
    expect(sorted[0]).toBe('1_s');
    expect(sorted[1]).toBe('13_s');
    expect(sorted[2]).toBe('3_h');
    expect(sorted[3]).toBe('10_h');
    expect(sorted[4]).toBe('4_d');
    expect(sorted[5]).toBe('11_d');
    expect(sorted[6]).toBe('6_c');
    expect(sorted[7]).toBe('9_c');
  });

  it('handles a hand with cards only from one half-suit', () => {
    // All low spades (remove_7s: 1,2,3,4,5,6)
    const hand: CardId[] = ['5_s', '2_s', '4_s', '1_s', '3_s', '6_s'];
    const sorted = sortHandByHalfSuit(hand, 'remove_7s');
    expect(sorted).toEqual(['1_s', '2_s', '3_s', '4_s', '5_s', '6_s']);
  });

  it('handles a hand with cards spanning multiple suits but same tier', () => {
    // All "low" cards from different suits
    const hand: CardId[] = ['4_c', '3_d', '2_h', '1_s', '5_d', '6_c', '4_h', '3_s'];
    const sorted = sortHandByHalfSuit(hand, 'remove_7s');
    // All low_s first, then low_h, then low_d, then low_c
    const hsSeq = sorted.map((c) => getCardHalfSuit(c, 'remove_7s'));
    expect(hsSeq).toEqual([
      'low_s', 'low_s',
      'low_h', 'low_h',
      'low_d', 'low_d',
      'low_c', 'low_c',
    ]);
  });

  it('variant remove_2s: low tier starts at 1, skips 2', () => {
    // remove_2s: remaining = [1,3,4,5,6,7,8,9,10,11,12,13]
    // low_s = 1,3,4,5,6,7  |  high_s = 8,9,10,11,12,13
    const hand: CardId[] = ['8_s', '3_s', '1_s', '10_s', '5_s', '13_s'];
    const sorted = sortHandByHalfSuit(hand, 'remove_2s');
    // Low spades first (1,3,5), then high spades (8,10,13)
    expect(sorted).toEqual(['1_s', '3_s', '5_s', '8_s', '10_s', '13_s']);
  });

  it('variant remove_8s: low tier includes 7, high tier starts at 9', () => {
    // remove_8s: remaining = [1,2,3,4,5,6,7,9,10,11,12,13]
    // low_s = 1,2,3,4,5,6  |  high_s = 7,9,10,11,12,13
    const hand: CardId[] = ['7_s', '3_s', '1_s', '10_s', '5_s', '13_s'];
    const sorted = sortHandByHalfSuit(hand, 'remove_8s');
    // Low spades (1,3,5) first, then high spades (7,10,13)
    expect(sorted).toEqual(['1_s', '3_s', '5_s', '7_s', '10_s', '13_s']);
  });
});
