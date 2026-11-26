import { SUIT_SYMBOLS, type CardSuit } from '@/types/game';

const outlines: Record<string, string> = {
  A: 'M-32 90 0 0 32 90 M-21 61H21',
  '2': 'M-28 18Q-21 0 1 0C28 0 38 22 20 41L-29 90H30',
  '3': 'M-28 10Q-15 0 1 0C36 0 38 40 2 43H-5C40 40 40 90 2 90Q-17 90-29 79',
  '4': 'M17 90V0L-32 61H32',
  '5': 'M26 0H-23L-27 41Q-13 35 1 35C39 35 40 90 1 90Q-17 90-29 79',
  '6': 'M24 5Q15 0 5 0C-22 0-32 30-32 55C-32 77-21 90 0 90C38 90 39 36 3 36Q-17 36-31 54',
  '7': 'M-29 0H29L-13 90',
  '8': 'M0 43C-35 40-35 0 0 0S36 40 0 43C-40 46-39 90 0 90S40 46 0 43Z',
  '9': 'M-24 85Q-15 90-5 90C22 90 32 60 32 35C32 13 21 0 0 0C-38 0-39 54-3 54Q17 54 31 36',
  '10': 'M-46 13-29 0V90 M-43 90H-15 M18 0C-13 0-13 90 18 90S49 0 18 0Z',
  J: 'M-10 0H25 M17 0V61Q17 90-6 90Q-23 90-30 75',
  Q: 'M0 0C-42 0-42 83 0 83S42 0 0 0Z M9 65 32 90',
  K: 'M-26 0V90 M28 0-23 52 M-7 37 31 90',
};

const pips: Record<CardSuit, string> = {
  h: 'M50 94C43 83 4 60 4 32C4 6 37 0 50 23C63 0 96 6 96 32C96 60 57 83 50 94Z',
  d: 'M50 2 94 50 50 98 6 50Z',
  c: 'M50 4C68 4 78 25 63 40C86 25 102 42 97 61C92 78 72 84 57 68Q59 84 72 96H28Q41 83 43 68C29 84 9 78 4 62C-1 42 14 26 38 40C23 25 32 4 50 4Z',
  s: 'M50 2C58 18 94 37 96 54C100 78 75 88 57 69Q59 84 72 96H28Q41 84 43 69C25 88 0 78 4 54C6 37 42 18 50 2Z',
};

// The alternate rules can deal sevens, which have no hotel illustration.
const sevenPips = [[67,70], [133,70], [100,110], [67,150], [133,150], [67,230], [133,230]];

export default function CardMarkings({ rank, suit }: { rank: string; suit: CardSuit }) {
  const ink = suit === 'h' || suit === 'd' ? '#b51d17' : '#20211d';
  const corner = (
    <g>
      <path d={outlines[rank]} transform="translate(24 10) scale(.36)"
        fill="none" stroke={ink} strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
      <path d={pips[suit]} transform="translate(13 56) scale(.22)" />
    </g>
  );
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300" preserveAspectRatio="none"
      width="100%" height="100%" fill={ink} data-rank={rank} aria-hidden="true">
      <title>{rank} {SUIT_SYMBOLS[suit]}</title>
      {corner}
      <g transform="translate(200 300) rotate(180)">{corner}</g>
      {rank === '7' && sevenPips.map(([x, y]) => (
        <g key={x + '-' + y} transform={`translate(${x} ${y}) rotate(${y > 150 ? 180 : 0})`}>
          <path d={pips[suit]} transform="scale(.37) translate(-50 -50)" />
        </g>
      ))}
    </svg>
  );
}
