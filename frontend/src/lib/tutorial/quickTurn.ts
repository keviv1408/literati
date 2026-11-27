import type { Step, TableState } from './engine';

type Ask = Extract<Step, { kind: 'ask' }>;

export const PRACTICE_DEAL: TableState = {
  hands: {
    you: ['1_d', '3_d', '5_d', '12_s'],
    maya: ['6_d', '11_s', '13_s'],
    raj: ['4_d', '9_c', '10_c'],
    lin: ['12_c', '13_c', '10_s'],
    ana: ['2_d', '8_c', '11_c'],
    omar: ['8_s', '9_s'],
  },
  turn: 'you',
  scores: { team1: 3, team2: 2 },
  declared: [
    { halfSuitId: 'low_s', teamId: 1, declaredBy: 'ana' },
    { halfSuitId: 'low_c', teamId: 2, declaredBy: 'maya' },
    { halfSuitId: 'low_h', teamId: 1, declaredBy: 'raj' },
    { halfSuitId: 'high_h', teamId: 2, declaredBy: 'omar' },
    { halfSuitId: 'high_d', teamId: 1, declaredBy: 'you' },
  ],
};

export const PRACTICE_ASKS: Ask[] = [
  { kind: 'ask', asker: 'you', target: 'maya', card: '6_d', text: 'You asked Maya for 6♦ — got it' },
  { kind: 'ask', asker: 'you', target: 'lin', card: '2_d', text: 'You asked Lin for 2♦ — denied' },
  { kind: 'ask', asker: 'lin', target: 'raj', card: '9_c', text: 'Lin asked Raj for 9♣ — got it' },
  { kind: 'ask', asker: 'lin', target: 'you', card: '8_c', text: 'Lin asked You for 8♣ — denied' },
];
