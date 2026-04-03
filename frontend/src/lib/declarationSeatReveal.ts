import { getHalfSuitCards } from '@/types/game';
import type { CardId, DeclarationFailedPayload, GamePlayer } from '@/types/game';

export interface DeclarationSeatRevealCard {
  cardId: CardId;
  isWrong: boolean;
  claimedByName: string | null;
}

export const FAILED_DECLARATION_SEAT_REVEAL_MS = 4_500;

/**
 * Group failed-declaration reveal cards by their actual holder so the UI can
 * attach a compact card strip directly to each affected seat.
 */
export function buildDeclarationSeatRevealMap(
  payload: DeclarationFailedPayload,
  players: GamePlayer[],
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s',
): Map<string, DeclarationSeatRevealCard[]> {
  const cards = getHalfSuitCards(payload.halfSuitId, variant);
  const displayNameByPlayerId = new Map(
    players.map((player) => [player.playerId, player.displayName]),
  );
  const wrongByCard = new Map(
    payload.wrongAssignmentDiffs.map((diff) => [diff.card, diff]),
  );
  const revealByPlayerId = new Map<string, DeclarationSeatRevealCard[]>();

  for (const cardId of cards) {
    const actualPlayerId = payload.actualHolders[cardId];
    if (!actualPlayerId) continue;

    const diff = wrongByCard.get(cardId);
    const revealCards = revealByPlayerId.get(actualPlayerId) ?? [];

    revealCards.push({
      cardId,
      isWrong: Boolean(diff),
      claimedByName: diff
        ? displayNameByPlayerId.get(diff.claimedPlayerId) ?? diff.claimedPlayerId
        : null,
    });

    revealByPlayerId.set(actualPlayerId, revealCards);
  }

  return revealByPlayerId;
}
