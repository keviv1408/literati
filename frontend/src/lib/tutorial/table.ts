import type { AskResultPayload, GamePlayer } from '@/types/game';
import { askSucceeds, type Step, type TableState } from './engine';
import { PLAYERS } from './script';

export function toGamePlayers(state: TableState): GamePlayer[] {
  return PLAYERS.map((p, seatIndex) => ({
    playerId: p.id,
    displayName: p.name,
    avatarId: p.avatarId ?? null,
    teamId: p.teamId,
    seatIndex,
    cardCount: state.hands[p.id].length,
    isBot: false,
    isGuest: true,
    isCurrentTurn: state.turn === p.id,
    isEliminated: state.hands[p.id].length === 0,
  }));
}

export function askPayloadFor(step: Step, before: TableState): AskResultPayload | null {
  if (step.kind !== 'ask') return null;
  const success = askSucceeds(before, step);
  return {
    type: 'ask_result',
    askerId: step.asker,
    targetId: step.target,
    cardId: step.card,
    success,
    newTurnPlayerId: success ? step.asker : step.target,
    lastMove: '',
  };
}
