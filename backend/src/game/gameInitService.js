'use strict';

/**
 * Game Initialization Service
 *
 * Provides the canonical empty-seat detection and bot auto-fill pipeline
 * that runs at game start for both private rooms (host-initiated via the
 * REST endpoint POST /api/rooms/:code/start) and matchmaking rooms
 * (auto-start triggered by handleAutoStartMatchmaking in roomSocketServer).
 *
 * ── Empty-Seat Detection Pipeline ─────────────────────────────────────────
 *
 *   detectEmptySeats(playerCount, occupiedSeats)
 *     → identifies which seat indices have no human player
 *
 *   buildBotSeats(playerCount, occupiedSeats)
 *     → delegates to botFiller.fillWithBots() to generate bot seat descriptors
 *       for every empty index
 *
 *   buildGameSeats(playerCount, occupiedSeats)
 *     → orchestrates detection + bot fill, returning the merged sorted seat array
 *
 *   initializeGame(options)
 *     → full initialization entry point: detect → fill → createGame
 *
 * ── Design Intent ──────────────────────────────────────────────────────────
 *
 * This service is the SINGLE location that reasons about seat occupancy at
 * game-start time.  Neither roomSocketServer.js nor routes/rooms.js should
 * contain their own empty-seat detection loops.  Both call initializeGame()
 * (or buildGameSeats() + createGame() directly) to keep the logic testable
 * and consistent across start paths.
 *
 * ── Seat Layout Convention ─────────────────────────────────────────────────
 *
 * Even seatIndex (0, 2, 4, …) → Team 1
 * Odd  seatIndex (1, 3, 5, …) → Team 2
 *
 * This alternating layout is enforced by buildOccupiedSeats() in
 * roomSocketServer.js (which builds the human occupiedSeats Map) and by
 * botFiller.fillWithBots() which follows the same parity rule for bots.
 *
 * @module gameInitService
 */

const { fillWithBots } = require('../matchmaking/botFiller');

// ---------------------------------------------------------------------------
// Empty-seat detection
// ---------------------------------------------------------------------------

/**
 * Detect which seat indices are unfilled at game start.
 *
 * Iterates over the full range [0, playerCount) and identifies every
 * index that is NOT present in the occupiedSeats Map.
 *
 * This is an O(playerCount) operation and is called exactly once per
 * game-start sequence.
 *
 * @param {number}              playerCount   - Total seat count (6 or 8).
 * @param {Map<number, Object>} occupiedSeats - seatIndex → LobbySeat for
 *                                              human players already in the lobby.
 * @returns {number[]} Sorted array of empty seat indices (ascending).
 *
 * @example
 * // 6-player room; humans occupy seats 0, 1, 4 → empty: 2, 3, 5
 * const occupied = new Map([[0, ...], [1, ...], [4, ...]]);
 * detectEmptySeats(6, occupied); // → [2, 3, 5]
 */
function detectEmptySeats(playerCount, occupiedSeats) {
  const empty = [];
  for (let i = 0; i < playerCount; i++) {
    if (!occupiedSeats.has(i)) {
      empty.push(i);
    }
  }
  return empty;
}

// ---------------------------------------------------------------------------
// Bot seat generation
// ---------------------------------------------------------------------------

/**
 * Build bot seat descriptors for all empty slots in a game lobby.
 *
 * Thin, named wrapper around botFiller.fillWithBots() that makes the
 * bot-generation step explicit and independently testable in isolation
 * from the detection step.
 *
 * Each returned descriptor follows the LobbySeat shape:
 *   {
 *     seatIndex:   number,       // empty slot index
 *     playerId:    string,       // "bot_<timestamp>_<seatIndex>"
 *     displayName: string,       // Docker-style adjective_noun name
 *     avatarId:    null,
 *     teamId:      1|2,          // parity of seatIndex
 *     isBot:       true,
 *     isGuest:     false,
 *   }
 *
 * @param {number}              playerCount   - Total seat count (6 or 8).
 * @param {Map<number, Object>} occupiedSeats - Seats already claimed by humans.
 * @returns {Array<Object>} Bot LobbySeat descriptors, one per empty seat.
 */
function buildBotSeats(playerCount, occupiedSeats) {
  return fillWithBots(playerCount, occupiedSeats);
}

// ---------------------------------------------------------------------------
// Full seat-array construction
// ---------------------------------------------------------------------------

/**
 * Build the complete, sorted seat array for a game by merging human seats
 * with auto-generated bot seats for every empty slot.
 *
 * This function is the core of the empty-seat detection pipeline:
 *   1. Calls detectEmptySeats() to identify unfilled slot indices.
 *   2. Calls buildBotSeats() to generate bot descriptors for those slots.
 *   3. Merges and sorts the combined seat array by seatIndex (ascending).
 *
 * @param {number}              playerCount   - Total seat count (6 or 8).
 * @param {Map<number, Object>} occupiedSeats - Human seats from
 *                                              roomSocketServer.buildOccupiedSeats().
 * @returns {{
 *   allSeats:   Array<Object>,  - Merged human + bot seats, sorted by seatIndex.
 *   botSeats:   Array<Object>,  - Bot-only entries (used in botsAdded broadcast).
 *   emptySlots: number[],       - Seat indices that were unfilled before bot fill.
 * }}
 */
function buildGameSeats(playerCount, occupiedSeats) {
  const emptySlots = detectEmptySeats(playerCount, occupiedSeats);
  const botSeats   = buildBotSeats(playerCount, occupiedSeats);

  // Merge human seats (from Map values) with bot seats, then sort by seatIndex.
  const allSeats = [...occupiedSeats.values(), ...botSeats]
    .sort((a, b) => a.seatIndex - b.seatIndex);

  return { allSeats, botSeats, emptySlots };
}

// ---------------------------------------------------------------------------
// Full initialization entry point
// ---------------------------------------------------------------------------

/**
 * Initialize a new game from a room configuration and a pre-built occupied-seat Map.
 *
 * This is the canonical entry point for the game initialization service.
 * Callers provide the occupied-seats Map (from roomSocketServer.buildOccupiedSeats)
 * and a `createGame` function reference (from gameSocketServer).  This design
 * keeps the service free of hard module dependencies and fully testable with mocks.
 *
 * Pipeline:
 *   1. detectEmptySeats() — identify unfilled slot indices.
 *   2. buildBotSeats()    — generate bot descriptors for each empty slot.
 *   3. Merge + sort       — produce the definitive seat array.
 *   4. createGame()       — delegate to gameSocketServer to create in-memory state.
 *
 * @param {{
 *   roomCode:      string,
 *   roomId:        string,
 *   variant:       'remove_2s'|'remove_7s'|'remove_8s',
 *   playerCount:   6|8,
 *   occupiedSeats: Map<number, Object>,
 *   createGame:    (options: {
 *     roomCode:    string,
 *     roomId:      string,
 *     variant:     string,
 *     playerCount: number,
 *     seats:       Array<Object>,
 *   }) => Object,
 * }} options
 * @returns {{
 *   gameState:  Object,        - The newly created in-memory GameState.
 *   allSeats:   Array<Object>, - Complete sorted seat array (humans + bots).
 *   botSeats:   Array<Object>, - Bot seats only (for the botsAdded broadcast).
 *   emptySlots: number[],      - Seat indices that were empty before bot fill.
 * }}
 * @throws {Error} Re-throws any error from createGame() so callers can handle it.
 */
function initializeGame({ roomCode, roomId, variant, playerCount, occupiedSeats, createGame }) {
  // ── Step 1 & 2: Detect empty seats and generate bots ──────────────────────
  const { allSeats, botSeats, emptySlots } = buildGameSeats(playerCount, occupiedSeats);

  // ── Step 3: Create in-memory game state ───────────────────────────────────
  const gameState = createGame({ roomCode, roomId, variant, playerCount, seats: allSeats });

  return { gameState, allSeats, botSeats, emptySlots };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  detectEmptySeats,
  buildBotSeats,
  buildGameSeats,
  initializeGame,
};
