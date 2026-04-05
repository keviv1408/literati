import { getHalfSuitCards } from '@/types/game';
import type {
  CardId,
  DeclarationFailedPayload,
  DeclarationResultPayload,
  GamePlayer,
} from '@/types/game';

export interface DeclarationSeatRevealCard {
  cardId: CardId;
  isWrong: boolean;
  claimedByName: string | null;
}

export const FAILED_DECLARATION_SEAT_REVEAL_MS = 7_000;

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

/**
 * Group declaration cards by assigned holder for successful declarations.
 * All cards are marked correct because the assignment is the final truth.
 */
export function buildSuccessfulDeclarationSeatRevealMap(
  payload: DeclarationResultPayload,
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s',
): Map<string, DeclarationSeatRevealCard[]> {
  const cards = getHalfSuitCards(payload.halfSuitId, variant);
  const revealByPlayerId = new Map<string, DeclarationSeatRevealCard[]>();

  for (const cardId of cards) {
    const assignedPlayerId = payload.assignment[cardId];
    if (!assignedPlayerId) continue;

    const revealCards = revealByPlayerId.get(assignedPlayerId) ?? [];
    revealCards.push({
      cardId,
      isWrong: false,
      claimedByName: null,
    });
    revealByPlayerId.set(assignedPlayerId, revealCards);
  }

  return revealByPlayerId;
}
