'use strict';

/**
 * Unit tests for halfSuits.js
 *
 * Coverage:
 *   buildHalfSuitMap:
 *     1. remove_7s produces 8 half-suits of 6 cards each
 *     2. remove_7s low_s = ['1_s'..'6_s'], high_s = ['8_s'..'13_s']
 *     3. remove_2s low_s = ['1_s','3_s'..'7_s']
 *     4. remove_8s high_s includes 7_s, excludes 8_s
 *     5. Total 48 unique cards across all half-suits for each variant
 *     6. Unknown variant throws
 *   buildCardToHalfSuitMap:
 *     7. Reverse lookup finds correct half-suit
 *   getHalfSuitId:
 *     8. '1_s' in remove_7s → 'low_s'
 *   halfSuitLabel:
 *     9. 'low_s' → 'Low Spades'
 *    10. 'high_d' → 'High Diamonds'
 *   allHalfSuitIds:
 *    11. Returns exactly 8 IDs
 *   TIEBREAKER_HALF_SUIT:
 *    12. Equals 'high_d'
 */

const {
  buildHalfSuitMap,
  buildCardToHalfSuitMap,
  getHalfSuitId,
  halfSuitLabel,
  allHalfSuitIds,
  TIEBREAKER_HALF_SUIT,
} = require('../game/halfSuits');

// ---------------------------------------------------------------------------
// buildHalfSuitMap
// ---------------------------------------------------------------------------

describe('buildHalfSuitMap', () => {
  it('remove_7s produces exactly 8 half-suits', () => {
    const map = buildHalfSuitMap('remove_7s');
    expect(map.size).toBe(8);
  });

  it('each half-suit in remove_7s has exactly 6 cards', () => {
    const map = buildHalfSuitMap('remove_7s');
    for (const [, cards] of map) {
      expect(cards).toHaveLength(6);
    }
  });

  it('remove_7s: low_s contains the correct 6 cards', () => {
    const map = buildHalfSuitMap('remove_7s');
    expect(map.get('low_s')).toEqual(['1_s', '2_s', '3_s', '4_s', '5_s', '6_s']);
  });

  it('remove_7s: high_s contains the correct 6 cards', () => {
    const map = buildHalfSuitMap('remove_7s');
    expect(map.get('high_s')).toEqual(['8_s', '9_s', '10_s', '11_s', '12_s', '13_s']);
  });

  it('remove_2s: low_s contains [1_s,3_s,4_s,5_s,6_s,7_s]', () => {
    const map = buildHalfSuitMap('remove_2s');
    expect(map.get('low_s')).toEqual(['1_s', '3_s', '4_s', '5_s', '6_s', '7_s']);
  });

  it('remove_2s: high_s contains [8_s,9_s,10_s,11_s,12_s,13_s]', () => {
    const map = buildHalfSuitMap('remove_2s');
    expect(map.get('high_s')).toEqual(['8_s', '9_s', '10_s', '11_s', '12_s', '13_s']);
  });

  it('remove_8s: low_s contains [1_s,2_s,3_s,4_s,5_s,6_s]', () => {
    const map = buildHalfSuitMap('remove_8s');
    expect(map.get('low_s')).toEqual(['1_s', '2_s', '3_s', '4_s', '5_s', '6_s']);
  });

  it('remove_8s: high_s includes 7_s and excludes 8_s', () => {
    const map = buildHalfSuitMap('remove_8s');
    expect(map.get('high_s')).toEqual(['7_s', '9_s', '10_s', '11_s', '12_s', '13_s']);
  });

  it('remove_7s: all 48 cards across half-suits are unique', () => {
    const map = buildHalfSuitMap('remove_7s');
    const allCards = [];
    for (const [, cards] of map) allCards.push(...cards);
    expect(allCards).toHaveLength(48);
    expect(new Set(allCards).size).toBe(48);
  });

  it('remove_2s: all 48 cards across half-suits are unique', () => {
    const map = buildHalfSuitMap('remove_2s');
    const allCards = [];
    for (const [, cards] of map) allCards.push(...cards);
    expect(allCards).toHaveLength(48);
    expect(new Set(allCards).size).toBe(48);
  });

  it('remove_8s: all 48 cards across half-suits are unique', () => {
    const map = buildHalfSuitMap('remove_8s');
    const allCards = [];
    for (const [, cards] of map) allCards.push(...cards);
    expect(allCards).toHaveLength(48);
    expect(new Set(allCards).size).toBe(48);
  });

  it('throws on unknown variant', () => {
    expect(() => buildHalfSuitMap('remove_jokers')).toThrow(/Unknown variant/);
  });
});

// ---------------------------------------------------------------------------
// buildCardToHalfSuitMap
// ---------------------------------------------------------------------------

describe('buildCardToHalfSuitMap', () => {
  it('maps every card to a half-suit (48 entries)', () => {
    const map = buildCardToHalfSuitMap('remove_7s');
    expect(map.size).toBe(48);
  });

  it('reverse lookup: 1_s → low_s for remove_7s', () => {
    const map = buildCardToHalfSuitMap('remove_7s');
    expect(map.get('1_s')).toBe('low_s');
  });

  it('reverse lookup: 13_d → high_d for remove_7s', () => {
    const map = buildCardToHalfSuitMap('remove_7s');
    expect(map.get('13_d')).toBe('high_d');
  });

  it('reverse lookup: 7_s → high_s for remove_8s (7 is in the high group when 8 is removed)', () => {
    // remove_8s: remaining ranks = [1,2,3,4,5,6,7,9,10,11,12,13]
    // low group (bottom 6) = [1,2,3,4,5,6], high group (top 6) = [7,9,10,11,12,13]
    const map = buildCardToHalfSuitMap('remove_8s');
    expect(map.get('7_s')).toBe('high_s');
  });

  it('does NOT contain the removed rank (7_s absent in remove_7s)', () => {
    const map = buildCardToHalfSuitMap('remove_7s');
    expect(map.has('7_s')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getHalfSuitId
// ---------------------------------------------------------------------------

describe('getHalfSuitId', () => {
  it('getHalfSuitId("1_s", "remove_7s") returns "low_s"', () => {
    expect(getHalfSuitId('1_s', 'remove_7s')).toBe('low_s');
  });

  it('getHalfSuitId("13_d", "remove_7s") returns "high_d"', () => {
    expect(getHalfSuitId('13_d', 'remove_7s')).toBe('high_d');
  });

  it('getHalfSuitId("8_h", "remove_7s") returns "high_h"', () => {
    expect(getHalfSuitId('8_h', 'remove_7s')).toBe('high_h');
  });

  it('throws when card does not exist in variant (7_s for remove_7s)', () => {
    expect(() => getHalfSuitId('7_s', 'remove_7s')).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// halfSuitLabel
// ---------------------------------------------------------------------------

describe('halfSuitLabel', () => {
  it('"low_s" → "Low Spades"', () => {
    expect(halfSuitLabel('low_s')).toBe('Low Spades');
  });

  it('"high_d" → "High Diamonds"', () => {
    expect(halfSuitLabel('high_d')).toBe('High Diamonds');
  });

  it('"low_h" → "Low Hearts"', () => {
    expect(halfSuitLabel('low_h')).toBe('Low Hearts');
  });

  it('"high_c" → "High Clubs"', () => {
    expect(halfSuitLabel('high_c')).toBe('High Clubs');
  });
});

// ---------------------------------------------------------------------------
// allHalfSuitIds
// ---------------------------------------------------------------------------

describe('allHalfSuitIds', () => {
  it('returns exactly 8 IDs', () => {
    expect(allHalfSuitIds()).toHaveLength(8);
  });

  it('contains all four low suits', () => {
    const ids = allHalfSuitIds();
    expect(ids).toContain('low_s');
    expect(ids).toContain('low_h');
    expect(ids).toContain('low_d');
    expect(ids).toContain('low_c');
  });

  it('contains all four high suits', () => {
    const ids = allHalfSuitIds();
    expect(ids).toContain('high_s');
    expect(ids).toContain('high_h');
    expect(ids).toContain('high_d');
    expect(ids).toContain('high_c');
  });

  it('has no duplicates', () => {
    const ids = allHalfSuitIds();
    expect(new Set(ids).size).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// TIEBREAKER_HALF_SUIT
// ---------------------------------------------------------------------------

describe('TIEBREAKER_HALF_SUIT', () => {
  it('equals "high_d"', () => {
    expect(TIEBREAKER_HALF_SUIT).toBe('high_d');
  });
});
