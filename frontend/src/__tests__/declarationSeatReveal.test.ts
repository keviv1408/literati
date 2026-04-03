/**
 * @jest-environment jsdom
 */

import {
  buildDeclarationSeatRevealMap,
  FAILED_DECLARATION_SEAT_REVEAL_MS,
} from '@/lib/declarationSeatReveal';
import type { DeclarationFailedPayload, GamePlayer } from '@/types/game';

const PLAYERS: GamePlayer[] = [
  {
    playerId: 'p1',
    displayName: 'Alice',
    avatarId: null,
    teamId: 1,
    seatIndex: 0,
    cardCount: 3,
    isBot: false,
    isGuest: false,
    isCurrentTurn: false,
  },
  {
    playerId: 'p2',
    displayName: 'Bob',
    avatarId: null,
    teamId: 1,
    seatIndex: 2,
    cardCount: 3,
    isBot: false,
    isGuest: false,
    isCurrentTurn: false,
  },
];

function buildPayload(): DeclarationFailedPayload {
  return {
    type: 'declarationFailed',
    declarerId: 'p1',
    halfSuitId: 'low_s',
    winningTeam: 2,
    assignment: {
      '1_s': 'p1',
      '2_s': 'p1',
      '3_s': 'p1',
      '4_s': 'p2',
      '5_s': 'p2',
      '6_s': 'p2',
    },
    wrongAssignmentDiffs: [
      {
        card: '2_s',
        claimedPlayerId: 'p1',
        actualPlayerId: 'p2',
      },
    ],
    actualHolders: {
      '1_s': 'p1',
      '2_s': 'p2',
      '3_s': 'p1',
      '4_s': 'p2',
      '5_s': 'p2',
      '6_s': 'p2',
    },
    lastMove: 'Alice declared Low Spades — incorrect! Team 2 scores',
  };
}

describe('buildDeclarationSeatRevealMap', () => {
  it('groups reveal cards by the actual holder', () => {
    const revealByPlayer = buildDeclarationSeatRevealMap(
      buildPayload(),
      PLAYERS,
      'remove_7s',
    );

    expect(revealByPlayer.get('p1')?.map((entry) => entry.cardId)).toEqual(['1_s', '3_s']);
    expect(revealByPlayer.get('p2')?.map((entry) => entry.cardId)).toEqual(['2_s', '4_s', '5_s', '6_s']);
  });

  it('marks only diffed cards as wrong and resolves the claimed player name', () => {
    const revealByPlayer = buildDeclarationSeatRevealMap(
      buildPayload(),
      PLAYERS,
      'remove_7s',
    );

    const wrongEntry = revealByPlayer.get('p2')?.find((entry) => entry.cardId === '2_s');
    const correctEntry = revealByPlayer.get('p1')?.find((entry) => entry.cardId === '1_s');

    expect(wrongEntry).toMatchObject({ isWrong: true, claimedByName: 'Alice' });
    expect(correctEntry).toMatchObject({ isWrong: false, claimedByName: null });
  });
});

describe('FAILED_DECLARATION_SEAT_REVEAL_MS', () => {
  it('keeps the prototype reveal brief', () => {
    expect(FAILED_DECLARATION_SEAT_REVEAL_MS).toBe(4500);
  });
});
