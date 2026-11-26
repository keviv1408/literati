import { createGameState, serializeForPlayer } from '../../../backend/src/game/gameState';
import type { Msg } from '../../tests/helpers/gameWire';
import { halfSuits } from '../lib/policy';

export const PLAYERS = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];

// The backend's own game object, seated as the lobby seats six: team 1 on even seats, team 2 on odd.
export function newGame(): any {
  return createGameState({
    roomCode: 'SOAK01',
    roomId: 'room-1',
    variant: 'remove_7s',
    playerCount: 6,
    seats: PLAYERS.map((playerId, seatIndex) => ({
      seatIndex,
      playerId,
      displayName: `Soak ${seatIndex + 1}`,
      avatarId: null,
      teamId: seatIndex % 2 === 0 ? 1 : 2,
      isBot: false,
      isGuest: true,
    })),
  });
}

// Player i holds cards 8i to 8i+7 in half-suit order: p0 has all of low_s, p2 high_h, p3 low_d, p5 high_c.
export function fixedGame(): any {
  const gs = newGame();
  const cards = [...halfSuits().values()].flat();
  PLAYERS.forEach((playerId, i) => gs.hands.set(playerId, new Set(cards.slice(8 * i, 8 * i + 8))));
  return gs;
}

export function initsOf(gs: any): Msg[] {
  return PLAYERS.map((playerId) => serializeForPlayer(gs, playerId));
}

export function handsOf(gs: any): Record<string, string[]> {
  return Object.fromEntries(PLAYERS.map((playerId) => [playerId, [...gs.hands.get(playerId)].sort()]));
}
