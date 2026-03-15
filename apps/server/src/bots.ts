/**
 * Server-side bot management for the Literati card game.
 *
 * Handles bot creation, turn execution delegation, and integration
 * with the game room system when human players are absent.
 */

import {
  generateUniqueBotNames,
  createBotPlayer,
  formatBotName,
} from "@literati/shared";
import type { BotPlayer } from "@literati/shared";

/**
 * Fill empty seats in a game room with bot players.
 *
 * Seats alternate T1-T2-T1-T2 clockwise around the oval table.
 * Bot names are Docker-style auto-generated and unique within the game.
 *
 * BALANCE GUARANTEE
 * -----------------
 * The algorithm guarantees that the final game will have exactly
 * totalSeats / 2 players on each team:
 *
 *   1. Count existing humans per team to compute each team's deficit.
 *   2. For each empty seat, prefer the "natural" team (even seat → T1,
 *      odd seat → T2) to maintain the alternating table layout.
 *      If the natural team's deficit is already met, cross-assign to the
 *      other team so the overall count still reaches the target.
 *
 * This respects the existing human distribution: skewed human teams result
 * in compensating bot assignments.
 *
 * @param totalSeats - Total player count (6 or 8)
 * @param humanPlayers - Already-joined human player descriptors
 * @returns Array of bot players to fill the remaining seats
 */
export function fillSeatsWithBots(
  totalSeats: 6 | 8,
  humanPlayers: Array<{ id: string; seatIndex: number; teamId: 1 | 2 }>
): BotPlayer[] {
  const occupiedSeatIndices = new Set(humanPlayers.map((p) => p.seatIndex));
  const existingNames = humanPlayers.map((p) => p.id);

  const target = totalSeats / 2; // players needed per team

  // Step 1: Count humans per team and compute deficits
  let humanT1 = 0;
  let humanT2 = 0;
  for (const p of humanPlayers) {
    if (p.teamId === 1) humanT1++;
    else humanT2++;
  }
  let needT1 = Math.max(0, target - humanT1);
  let needT2 = Math.max(0, target - humanT2);

  // Step 2: Determine empty seats and assign team IDs based on deficit
  const emptySeats: Array<{ seatIndex: number; teamId: 1 | 2 }> = [];
  for (let seat = 0; seat < totalSeats; seat++) {
    if (occupiedSeatIndices.has(seat)) continue;

    // Natural parity: even seat → Team 1, odd seat → Team 2
    const naturalTeam: 1 | 2 = seat % 2 === 0 ? 1 : 2;

    // Cross-assign if the natural team's deficit is already satisfied
    let teamId: 1 | 2;
    if (naturalTeam === 1) {
      teamId = needT1 > 0 ? 1 : 2;
    } else {
      teamId = needT2 > 0 ? 2 : 1;
    }

    if (teamId === 1) needT1--;
    else needT2--;

    emptySeats.push({ seatIndex: seat, teamId });
  }

  if (emptySeats.length === 0) return [];

  // Step 3: Generate unique bot names (avoiding collisions with existing names)
  const botNames = generateUniqueBotNames(emptySeats.length, existingNames);

  return emptySeats.map(({ seatIndex, teamId }, i) => {
    const botId = `bot_${Date.now()}_${seatIndex}`;
    const name = botNames[i];
    return {
      id: botId,
      name,
      displayName: formatBotName(name),
      isBot: true as const,
      teamId,
      seatIndex,
    };
  });
}

/**
 * Serialized bot player shape for storage in Supabase and WebSocket broadcast.
 */
export interface SerializedBotPlayer {
  id: string;
  display_name: string;
  bot_name_key: string; // The raw "adjective_noun" key for regeneration
  is_bot: true;
  team_id: 1 | 2;
  seat_index: number;
}

/**
 * Convert a BotPlayer to its Supabase-serializable form.
 */
export function serializeBotPlayer(bot: BotPlayer): SerializedBotPlayer {
  return {
    id: bot.id,
    display_name: bot.displayName,
    bot_name_key: bot.name,
    is_bot: true,
    team_id: bot.teamId,
    seat_index: bot.seatIndex,
  };
}

/**
 * Restore a BotPlayer from its serialized Supabase form.
 */
export function deserializeBotPlayer(row: SerializedBotPlayer): BotPlayer {
  return createBotPlayer(row.id, row.team_id, row.seat_index, row.bot_name_key);
}

/**
 * Check whether a given player ID belongs to a bot (bot IDs start with "bot_").
 */
export function isBotId(playerId: string): boolean {
  return playerId.startsWith("bot_");
}
