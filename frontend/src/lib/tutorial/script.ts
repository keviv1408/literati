/**
 * The scripted 6-player tutorial hand. Card IDs are "{rank}_{suit}"
 * (1=A, 11=J, 12=Q, 13=K). Variant is remove_7s: Low = A-6, High = 8-K.
 *
 * The deal is engineered so one storyline covers: ask/turn-pass, signaling,
 * blocking, a correct declaration, passing the turn to a blocked teammate,
 * and a forced wrong declaration.
 */

import type { Step, TableState, TutorialPlayer } from './engine';

export const PLAYERS: TutorialPlayer[] = [
  { id: 'you', name: 'You', teamId: 1 },
  { id: 'maya', name: 'Maya', teamId: 2 },
  { id: 'raj', name: 'Raj', teamId: 1 },
  { id: 'lin', name: 'Lin', teamId: 2 },
  { id: 'ana', name: 'Ana', teamId: 1 },
  { id: 'omar', name: 'Omar', teamId: 2 },
];

export const INITIAL_STATE: TableState = {
  hands: {
    you: ['1_d', '3_d', '5_d', '12_s', '9_h', '13_h', '4_c', '6_s'],
    maya: ['6_d', '13_s', '10_s', '11_s', '3_h', '8_d', '2_c', '12_h'],
    raj: ['8_c', '9_c', '10_c', '11_c', '9_s', '8_s', '5_c', '1_h'],
    lin: ['12_c', '13_c', '4_h', '2_s', '3_s', '11_d', '6_c', '10_h'],
    ana: ['2_d', '4_d', '5_h', '1_s', '4_s', '9_d', '12_d', '3_c'],
    omar: ['2_h', '6_h', '5_s', '10_d', '1_c', '8_h', '11_h', '13_d'],
  },
  turn: 'you',
  scores: { team1: 0, team2: 0 },
  declared: [],
};

// "A few turns later": Team 2 has declared Low Spades and High Diamonds,
// and Omar is left holding nothing but Low Hearts.
const LATE_GAME: TableState = {
  hands: {
    you: ['12_s', '9_s', '9_h', '13_h', '4_c'],
    maya: ['3_h', '13_s', '10_s', '11_s', '12_h', '2_c'],
    raj: ['8_s', '5_c'],
    lin: ['4_h', '10_h', '6_c'],
    ana: ['8_h', '11_h', '1_c', '3_c'],
    omar: ['1_h', '2_h', '5_h', '6_h'],
  },
  turn: 'omar',
  scores: { team1: 2, team2: 2 },
  declared: [
    { halfSuitId: 'low_d', teamId: 1, declaredBy: 'you' },
    { halfSuitId: 'high_c', teamId: 1, declaredBy: 'raj' },
    { halfSuitId: 'low_s', teamId: 2, declaredBy: 'lin' },
    { halfSuitId: 'high_d', teamId: 2, declaredBy: 'maya' },
  ],
};

export const SCRIPT: Step[] = [
  {
    kind: 'intro',
    title: 'Welcome to Literature',
    body: [
      'Welcome to the game of Literature, where your memory is tested and fun is made.',
      'This walkthrough plays one 6-player hand with every card face up, so you can see why each move is made. It takes about five minutes.',
      'You will learn how to ask for cards, how to signal to your teammates, how to block an opponent, and when to declare.',
    ],
  },
  {
    kind: 'intro',
    title: 'The 8 half-suits',
    showHalfSuits: true,
    body: [
      'Literature uses 48 cards: a standard deck with the 7s removed.',
      'Each suit is split into a Low half (A to 6) and a High half (8 to K). That gives 8 half-suits of 6 cards each. Half-suits are what you collect.',
      'Six players form two teams of three, seated alternately, and each player is dealt 8 cards. The first team to win 5 of the 8 half-suits wins.',
    ],
  },
  {
    kind: 'intro',
    title: 'The base rule',
    body: [
      'On your turn, ask one opponent for one specific card. You must already hold a card from that half-suit, you cannot ask for a card you hold, and you never ask a teammate.',
      'If they have it, they hand it over and you go again. If they do not, your turn ends and they play next.',
      'Instead of asking, you can declare a half-suit: name which teammate holds each of its six cards. Get it right and your team scores. Get any card wrong and the other team scores.',
    ],
  },
  {
    kind: 'note',
    text: 'Here is the table. All hands are face up for this tutorial; in a real game you only see your own 8 cards. You are on Team 1 with Raj and Ana. It is your turn.',
    focus: ['you'],
  },
  {
    kind: 'note',
    text: 'Look at your hand: you hold A, 3 and 5 of diamonds, three of the six Low Diamonds. That makes Low Diamonds a good half-suit to collect. Maya holds the 6.',
    focus: ['you', 'maya'],
    cards: ['1_d', '3_d', '5_d', '6_d'],
  },
  {
    kind: 'ask',
    asker: 'you',
    target: 'maya',
    card: '6_d',
    text: 'You ask Maya for the 6 of diamonds. She has it, so she hands it over and you keep the turn.',
  },
  {
    kind: 'ask',
    asker: 'you',
    target: 'lin',
    card: '2_d',
    text: 'You ask Lin for the 2 of diamonds. Lin does not have it (Ana does, but in a real game you could not see that). Your turn ends and Lin plays next.',
  },
  {
    kind: 'note',
    text: 'Nothing is wasted though. Everyone at the table now knows you hold at least one Low Diamond, because you asked for one. Ana, your teammate, holds the 2 and the 4. She now knows exactly who wants them.',
    focus: ['you', 'ana'],
    cards: ['2_d', '4_d'],
  },
  {
    kind: 'ask',
    asker: 'lin',
    target: 'raj',
    card: '9_c',
    text: 'Lin holds the Q and K of clubs and goes after High Clubs. She asks Raj for the 9 of clubs. Raj has it, so Lin keeps going.',
  },
  {
    kind: 'ask',
    asker: 'lin',
    target: 'ana',
    card: '10_c',
    text: 'Lin guesses that Ana has the 10 of clubs. Wrong: Raj has it. The turn passes to Ana. Notice what Raj learned: Lin is collecting High Clubs and now holds his 9.',
    // Raj is now "blocked" on High Clubs; this pays off after the declaration.
  },
  {
    kind: 'note',
    text: 'Ana holds the 2 and 4 of diamonds and knows you are collecting Low Diamonds. She cannot ask you for cards and cannot hand hers over. But she can signal.',
    focus: ['ana'],
    cards: ['2_d', '4_d'],
  },
  {
    kind: 'ask',
    asker: 'ana',
    target: 'maya',
    card: '3_d',
    text: 'Ana asks Maya for a Low Diamond she does not hold: the 3. Maya does not have it, so the turn passes to Maya. The ask still did its job: everyone now knows Ana holds Low Diamonds too.',
  },
  {
    kind: 'note',
    text: 'That is a signal. You hold A, 3, 5 and 6; Ana just told you she has some of the rest. Signals cost a turn and opponents hear them too, so use them when a teammate clearly needs the information.',
    focus: ['you', 'ana'],
    cards: ['1_d', '3_d', '5_d', '6_d', '2_d', '4_d'],
  },
  {
    kind: 'ask',
    asker: 'maya',
    target: 'raj',
    card: '9_s',
    text: 'Maya holds K, J and 10 of spades and goes hunting for High Spades. She asks Raj for the 9 of spades and gets it. Four of six.',
  },
  {
    kind: 'ask',
    asker: 'maya',
    target: 'you',
    card: '8_s',
    text: 'Maya asks you for the 8 of spades. You do not have it (Raj does). The turn passes to you.',
  },
  {
    kind: 'note',
    text: 'Danger. Maya holds four High Spades: K, J, 10 and 9. The missing two are your Q and Raj’s 8. If she gets the turn back she will keep hunting for them.',
    focus: ['maya', 'you', 'raj'],
    cards: ['13_s', '11_s', '10_s', '9_s', '12_s', '8_s'],
  },
  {
    kind: 'choice',
    prompt: 'Your turn. What do you do?',
    focus: ['you', 'maya'],
    options: [
      {
        label: 'Ask Maya for the 9 of spades',
        correct: true,
        feedback:
          'Yes. You watched Maya take the 9 from Raj, so you know for certain she has it. Taking it is called blocking: she cannot finish High Spades without going through you.',
      },
      {
        label: 'Ask Omar for the 2 of diamonds',
        feedback:
          'Ana just signaled she holds Low Diamonds, so the 2 is more likely with her. And Maya is one turn away from High Spades. Deal with the threat first.',
      },
      {
        label: 'Ask Maya for the K of spades',
        feedback:
          'You can see the K in her hand here, but in a real game you could not. Maya was dealt it and nobody saw it move. Ask for a card you know about: the 9 you watched her take from Raj.',
      },
    ],
  },
  {
    kind: 'ask',
    asker: 'you',
    target: 'maya',
    card: '9_s',
    text: 'You take the 9 of spades. Maya is down to three High Spades, you hold two and Raj one. She is blocked, and you keep the turn.',
  },
  {
    kind: 'note',
    text: 'Now, Low Diamonds. You hold A, 3, 5 and 6. Ana signaled she holds some. With hands face up you can see she holds both the 2 and the 4, so your team has all six.',
    focus: ['you', 'ana'],
    cards: ['1_d', '3_d', '5_d', '6_d', '2_d', '4_d'],
  },
  {
    kind: 'choice',
    prompt: 'You still have the turn. What now?',
    focus: ['you', 'ana'],
    options: [
      {
        label: 'Declare Low Diamonds',
        correct: true,
        feedback:
          'Right. Your team holds all six and you know where each one is. Declaring scores the point before an opponent can steal a card.',
      },
      {
        label: 'Ask Maya for the 10 of spades',
        feedback:
          'Tempting, but you would be guessing: you never saw the 10 move. Lock in the point you are sure of first.',
      },
      {
        label: 'Ask Omar for the 2 of diamonds',
        feedback:
          'Your own teammate holds that card. A failed ask hands Omar the turn. Declare instead.',
      },
    ],
  },
  {
    kind: 'choice',
    prompt:
      'To declare, you name who on your team holds each card. A, 3, 5 and 6 of diamonds are yours. Who holds the 2 and the 4?',
    focus: ['you', 'raj', 'ana'],
    cards: ['2_d', '4_d'],
    options: [
      {
        label: 'Ana holds both',
        correct: true,
        feedback: 'Both are with Ana. A declaration only counts if every card is placed right.',
      },
      {
        label: 'Raj holds both',
        feedback: 'Look at Ana’s hand: the 2 and the 4 are both there. One misplaced card fails the whole declaration.',
      },
      {
        label: 'Ana has the 2, Raj has the 4',
        feedback: 'Look at Ana’s hand: the 2 and the 4 are both there. One misplaced card fails the whole declaration.',
      },
    ],
  },
  {
    kind: 'declare',
    declarer: 'you',
    halfSuit: 'low_d',
    assignment: { '1_d': 'you', '3_d': 'you', '5_d': 'you', '6_d': 'you', '2_d': 'ana', '4_d': 'ana' },
    text: 'Correct! Low Diamonds goes to Team 1 and its six cards leave the game. Team 1 leads 1 to 0.',
  },
  {
    kind: 'choice',
    prompt: 'After a correct declaration your team picks who plays next. Who should it be?',
    focus: ['you', 'raj', 'ana'],
    options: [
      {
        label: 'Raj',
        correct: true,
        feedback:
          'Raj is being blocked: Lin took his 9 of clubs and is collecting High Clubs herself. He still holds 8, 10 and J, and he watched the 9 go, so he can take it straight back.',
      },
      {
        label: 'You',
        feedback:
          'You could, but your best half-suit is gone. Raj is stuck behind Lin on High Clubs and can act right now.',
      },
      {
        label: 'Ana',
        feedback:
          'Ana is not close on any half-suit. Raj is, and he is being blocked. Give the turn to the teammate who needs it most.',
      },
    ],
  },
  { kind: 'turn', to: 'raj', text: 'You pass the turn to Raj.' },
  {
    kind: 'ask',
    asker: 'raj',
    target: 'lin',
    card: '9_c',
    text: 'Raj asks Lin for the 9 of clubs and takes it back. Then he reasons: Lin had to hold a High Club to ask for one, so she has at least one more.',
  },
  {
    kind: 'ask',
    asker: 'raj',
    target: 'lin',
    card: '12_c',
    text: 'Raj guesses the Q of clubs. Lin has it.',
  },
  {
    kind: 'ask',
    asker: 'raj',
    target: 'lin',
    card: '13_c',
    text: 'And the K. Raj now holds all six High Clubs himself.',
  },
  {
    kind: 'declare',
    declarer: 'raj',
    halfSuit: 'high_c',
    assignment: { '8_c': 'raj', '9_c': 'raj', '10_c': 'raj', '11_c': 'raj', '12_c': 'raj', '13_c': 'raj' },
    text: 'Raj declares High Clubs. Correct. Team 1 leads 2 to 0. Passing him the turn paid off.',
  },
  {
    kind: 'snapshot',
    state: LATE_GAME,
    text: 'Let us skip ahead a few turns. Team 2 fought back and declared Low Spades and High Diamonds. It is 2 to 2 and Omar has the turn.',
  },
  {
    kind: 'note',
    text: 'Look at Omar’s hand: only Low Hearts remain, and the other two Low Hearts are with his teammates Maya and Lin. He cannot ask an opponent for a Low Heart (none of us has one) and he cannot ask for anything else (you must hold a card of the half-suit you ask for). His only legal move is to declare.',
    focus: ['omar', 'maya', 'lin'],
    cards: ['1_h', '2_h', '5_h', '6_h', '3_h', '4_h'],
  },
  {
    kind: 'note',
    text: 'Here is his problem: he never saw the 3 or the 4 of hearts move, so he does not know which teammate holds which. He has to guess.',
    focus: ['omar'],
    cards: ['3_h', '4_h'],
  },
  {
    kind: 'declare',
    declarer: 'omar',
    halfSuit: 'low_h',
    assignment: { '1_h': 'omar', '2_h': 'omar', '5_h': 'omar', '6_h': 'omar', '3_h': 'maya', '4_h': 'maya' },
    text: 'Omar guesses that Maya holds both. Wrong: the 4 was with Lin. A wrong declaration gives the point to the other team. Team 1 leads 3 to 2.',
  },
  {
    kind: 'note',
    text: 'The lesson: information runs out. Before your hand shrinks to a single half-suit, make sure your team has signaled who holds what. Sometimes you will still be forced to guess. That is Literature.',
    focus: ['omar'],
  },
  {
    kind: 'intro',
    title: 'You know the game',
    body: [
      'Ask opponents for cards in half-suits you hold. A yes keeps your turn; a no passes it, but every ask tells the table something.',
      'Signal by asking for a half-suit your teammate is collecting. Block by taking cards you saw an opponent collect.',
      'Declare only when you know where every card is. Wrong declarations score for the other team.',
      'After declaring, pass the turn to the teammate who is being blocked.',
    ],
  },
  {
    kind: 'intro',
    title: 'Extra spice, once the basics feel easy',
    final: true,
    body: [
      'The bluff: ask for a card in a half-suit you hold only one of and do not care about. Opponents may waste turns defending it. Careful: your teammates are fooled too.',
      'The quiet hand: do not signal a half-suit right away. Let the opponents ask around first so more cards are revealed, then strike once you know where everything is. The risk is that a teammate declares it wrong, or an opponent grabs your cards first.',
      'Both are ways to enjoy the game more once memory and the base rule feel natural. Now go play a real hand.',
    ],
  },
];
