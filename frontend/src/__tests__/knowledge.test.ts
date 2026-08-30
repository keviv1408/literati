import { buildKnowledge } from '@/lib/knowledge';

const V = 'remove_7s';

describe('buildKnowledge', () => {
  it('a successful ask moves the card to the asker and marks the target as lacking it', () => {
    const k = buildKnowledge([{ askerId: 'a', targetId: 'b', cardId: '9_s', success: true }], [], V);
    expect(k.a).toEqual({ has: ['9_s'], lacks: [], halfSuits: ['high_s'] });
    expect(k.b).toEqual({ has: [], lacks: ['9_s'], halfSuits: [] });
  });

  it('a failed ask marks both asker and target as lacking the card', () => {
    const k = buildKnowledge([{ askerId: 'a', targetId: 'b', cardId: '3_h', success: false }], [], V);
    expect(k.a.lacks).toEqual(['3_h']);
    expect(k.b.lacks).toEqual(['3_h']);
    expect(k.a.halfSuits).toEqual(['low_h']);
  });

  it('later asks override earlier knowledge in order', () => {
    const k = buildKnowledge(
      [
        { askerId: 'a', targetId: 'b', cardId: '9_s', success: true },
        { askerId: 'c', targetId: 'a', cardId: '9_s', success: true },
      ],
      [],
      V,
    );
    expect(k.a.has).toEqual([]);
    expect(k.a.lacks).toEqual(['9_s']);
    expect(k.c.has).toEqual(['9_s']);
  });

  it('drops everything about a declared half-suit', () => {
    const k = buildKnowledge(
      [
        { askerId: 'a', targetId: 'b', cardId: '9_s', success: true },
        { askerId: 'a', targetId: 'b', cardId: '2_d', success: false },
      ],
      ['high_s'],
      V,
    );
    expect(k.a).toEqual({ has: [], lacks: ['2_d'], halfSuits: ['low_d'] });
    expect(k.b).toEqual({ has: [], lacks: ['2_d'], halfSuits: [] });
  });
});
