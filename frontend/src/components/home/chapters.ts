export interface Chapter {
  title: string;
  copy: string;
  caption: string;
  labels: [text: string, x: number, y: number][];
}

export const chapters: Chapter[] = [
  {
    title: 'Take a seat.',
    copy: 'In this classic six-player hand, two teams sit in alternating seats. You, Raj and Ana play together. Everyone gets eight cards. Your team wins points by finding sets of six.',
    caption: 'Three seats on each side',
    labels: [['You', 50, 89], ['Maya', 20, 79], ['Raj', 20, 44], ['Lin', 50, 34], ['Ana', 80, 44], ['Omar', 80, 79]],
  },
  {
    title: 'Think in sixes.',
    copy: 'Take the sevens out. Each suit now splits in two: ace through six, and eight through king. Each group of six is a half-suit. These six cards are the low diamonds.',
    caption: 'Low diamonds · A through 6',
    labels: [],
  },
  {
    title: 'Read your hand.',
    copy: 'You look down and find the ace, three and five of diamonds. Holding even one low diamond lets you ask for another. Your first target is the six.',
    caption: 'Your low diamonds',
    labels: [['You', 50, 81]],
  },
  {
    title: 'Ask for one card.',
    copy: '“Maya, do you have the six of diamonds?” Pick one opponent and name one card. It must be missing from your hand and belong to a half-suit you hold.',
    caption: 'Your request · 6♦',
    labels: [['You', 28, 82], ['Maya', 76, 73]],
  },
  {
    title: 'A yes keeps the turn.',
    copy: 'Maya has the six. She hands it over, and everyone sees it move. You now hold four low diamonds and get to ask again.',
    caption: 'Maya gives you the six',
    labels: [['You', 50, 82]],
  },
  {
    title: 'A no passes it.',
    copy: 'This time you ask Lin for the two of diamonds. Lin says no. Your cards stay put, and Lin takes the next turn.',
    caption: 'The turn passes to Lin',
    labels: [['You', 31, 80], ['Lin · next turn', 77, 73]],
  },
  {
    title: 'Listen between turns.',
    copy: 'A few turns later, Ana asks Maya for the three of diamonds. You hold that card, so you know the answer. Her question also tells you she holds at least one low diamond.',
    caption: 'Ana’s question gives you a clue',
    labels: [['Your three', 24, 75], ['Ana’s hidden cards', 73, 75]],
  },
  {
    title: 'Track the missing two.',
    copy: 'Over the next few turns, you see Ana collect the two and the four. Neither moves again. With four in your hand and two in hers, your team can account for all six.',
    caption: 'You hold four · Ana holds two',
    labels: [['You', 29, 76], ['Ana', 76, 76]],
  },
  {
    title: 'Call the set.',
    copy: 'On your turn, declare low diamonds. Name who has each card: “I have ace, three, five and six. Ana has two and four.” One wrong owner gives the point to the other team.',
    caption: 'Your declaration · all six accounted for',
    labels: [['You · A 3 5 6', 50, 45], ['Ana · 2 4', 50, 91]],
  },
  {
    title: 'Bank the point.',
    copy: 'Every owner matches. Your team scores one point and the six cards leave play. There are eight sets to win. If the score ends four apiece, the team that won high diamonds wins the game.',
    caption: 'Low diamonds · won by your team',
    labels: [['Your team  +1', 50, 83]],
  },
];
