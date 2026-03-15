/**
 * @literati/shared — public API
 *
 * All shared utilities exported from a single entry point so consumers
 * can import from "@literati/shared" without knowing internal file paths.
 */

export {
  BOT_ADJECTIVES,
  BOT_NOUNS,
  generateBotName,
  formatBotName,
  isBotName,
  generateUniqueBotNames,
  createBotPlayer,
} from "./botNames";

export type { BotName, BotPlayer } from "./botNames";

export {
  DEFAULT_ELLIPSE,
  computeSeatPositions,
  getCurrentPlayerPosition,
  ellipsePoint,
  angleForVisualIndex,
} from "./seatLayout";

export type { EllipseConfig, SeatPosition } from "./seatLayout";
