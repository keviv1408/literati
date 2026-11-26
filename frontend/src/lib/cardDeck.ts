import back from '@/assets/hotel-back.webp';
import sheet from '@/assets/hotel-deck.webp';
import type { CardRank, CardSuit } from '@/types/game';

export const backUrl = back.src;
export const deckUrl = sheet.src;
const suitRows: Record<CardSuit, number> = { h: 0, d: 1, c: 2, s: 3 };

export function cardBackground(rank: CardRank, suit: CardSuit) {
  if (rank === 7) return undefined;
  const index = suitRows[suit] * 12 + rank - (rank > 7 ? 2 : 1);
  return {
    backgroundImage: `url("${deckUrl}")`,
    backgroundSize: '800% 600%',
    backgroundPosition: `${(index % 8) * 100 / 7}% ${Math.floor(index / 8) * 20}%`,
    backgroundRepeat: 'no-repeat',
  };
}

let preparedImage: HTMLImageElement | undefined;
let preparing: Promise<void> | undefined;

export function isDeckReady() {
  return Boolean(preparedImage);
}

export function warmCardDeck() {
  if (preparing) return preparing;
  const image = new Image();
  image.src = deckUrl;
  if (!image.decode) return Promise.resolve();
  preparing = image.decode().then(() => {
    // The hand, picker and animations share this decoded sheet.
    preparedImage = image;
  }).catch(() => {
    preparing = undefined;
  });
  return preparing;
}
