import { cardLabel, type AskResultPayload, type CardId } from '@/types/game';

export interface AskMoveBatch {
  askerId: string;
  targetId: string;
  requestedCardIds: CardId[];
  hasExplicitBatch: boolean;
  successfulCardIds: CardId[];
  deniedCardIds: CardId[];
}

function formatNaturalList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function arraysEqual(left: CardId[], right: CardId[]): boolean {
  return left.length === right.length && left.every((cardId, index) => cardId === right[index]);
}

function getRequestedCardIds(result: AskResultPayload): {
  cardIds: CardId[];
  hasExplicitBatch: boolean;
} {
  const batchCardIds = Array.isArray(result.batchCardIds)
    ? result.batchCardIds.filter((cardId): cardId is CardId => typeof cardId === 'string')
    : [];

  if (batchCardIds.length === 0) {
    return { cardIds: [result.cardId], hasExplicitBatch: false };
  }

  const dedupedCardIds: CardId[] = [];
  for (const cardId of batchCardIds) {
    if (!dedupedCardIds.includes(cardId)) dedupedCardIds.push(cardId);
  }
  if (!dedupedCardIds.includes(result.cardId)) {
    dedupedCardIds.unshift(result.cardId);
  }

  return {
    cardIds: dedupedCardIds,
    hasExplicitBatch: dedupedCardIds.length > 1,
  };
}

export function advanceAskMoveBatch(
  currentBatch: AskMoveBatch | null,
  result: AskResultPayload,
): AskMoveBatch {
  const { cardIds: requestedCardIds, hasExplicitBatch } = getRequestedCardIds(result);
  const canAppend =
    currentBatch &&
    currentBatch.askerId === result.askerId &&
    currentBatch.targetId === result.targetId &&
    currentBatch.deniedCardIds.length === 0 &&
    (
      currentBatch.hasExplicitBatch || hasExplicitBatch
        ? arraysEqual(currentBatch.requestedCardIds, requestedCardIds)
        : true
    );

  const nextBatch = canAppend
    ? {
        ...currentBatch,
        requestedCardIds: [...currentBatch.requestedCardIds],
        successfulCardIds: [...currentBatch.successfulCardIds],
        deniedCardIds: [...currentBatch.deniedCardIds],
      }
    : {
        askerId: result.askerId,
        targetId: result.targetId,
        requestedCardIds: [...requestedCardIds],
        hasExplicitBatch,
        successfulCardIds: [],
        deniedCardIds: [],
      };

  if (!nextBatch.hasExplicitBatch && !nextBatch.requestedCardIds.includes(result.cardId)) {
    nextBatch.requestedCardIds.push(result.cardId);
  }

  if (result.success) {
    nextBatch.successfulCardIds.push(result.cardId);
  } else {
    nextBatch.deniedCardIds.push(result.cardId);
  }

  return nextBatch;
}

export function buildAskMoveSummaryMessage(
  batch: AskMoveBatch,
  lastResult: AskResultPayload,
  askerName: string,
  targetName: string,
): string | null {
  const attemptedCardIds = [...batch.successfulCardIds, ...batch.deniedCardIds];
  const requestedCardIds = batch.requestedCardIds.length > 0
    ? batch.requestedCardIds
    : attemptedCardIds;
  const isBatchStillRunning =
    requestedCardIds.length > attemptedCardIds.length &&
    lastResult.success &&
    lastResult.newTurnPlayerId === lastResult.askerId &&
    batch.deniedCardIds.length === 0;

  if (requestedCardIds.length > 1 && isBatchStillRunning) {
    const requestedLabels = requestedCardIds.map((cardId) => cardLabel(cardId));
    return `${askerName} asked ${targetName} for ${formatNaturalList(requestedLabels)}`;
  }

  if (attemptedCardIds.length <= 1) return null;

  const attemptedLabels = attemptedCardIds.map((cardId) => cardLabel(cardId));
  const successfulLabels = batch.successfulCardIds.map((cardId) => cardLabel(cardId));
  const deniedLabels = batch.deniedCardIds.map((cardId) => cardLabel(cardId));

  if (deniedLabels.length === 0) {
    return `${askerName} asked ${targetName} for ${formatNaturalList(attemptedLabels)} — got them`;
  }

  if (successfulLabels.length === 0) {
    return `${askerName} asked ${targetName} for ${formatNaturalList(attemptedLabels)} — denied`;
  }

  return `${askerName} asked ${targetName} for ${formatNaturalList(attemptedLabels)} — got ${formatNaturalList(successfulLabels)}; denied ${formatNaturalList(deniedLabels)}`;
}
