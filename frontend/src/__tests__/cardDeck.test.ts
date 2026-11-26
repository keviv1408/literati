import { cardBackground, deckUrl } from '@/lib/cardDeck';
import type { CardRank, CardSuit } from '@/types/game';

it('selects the matching illustration across suit boundaries and the missing sevens', () => {
  const cases: [CardRank, CardSuit, number, number][] = [
    [1, 'h', 0, 0], [6, 'h', 5, 0], [8, 'h', 6, 0], [10, 'h', 0, 1],
    [1, 'd', 4, 1], [13, 'd', 7, 2], [1, 'c', 0, 3],
    [1, 's', 4, 4], [13, 's', 7, 5],
  ];
  for (const [rank, suit, column, row] of cases) {
    expect(cardBackground(rank, suit)).toMatchObject({
      backgroundImage: `url("${deckUrl}")`,
      backgroundPosition: `${column * 100 / 7}% ${row * 20}%`,
    });
  }
  for (const suit of ['h', 'd', 'c', 's'] as const) {
    expect(cardBackground(7, suit)).toBeUndefined();
  }
});
