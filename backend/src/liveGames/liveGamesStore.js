'use strict';

/**
 * Live Games Store — in-memory registry of all active in-progress games.
 *
 * Tracks every room that is currently:
 * • 'waiting' — lobby phase, players are connecting
 * • 'in_progress' — active game running
 *
 * Completed or cancelled rooms are removed automatically when the game ends.
 *
 * Published events (via EventEmitter):
 * 'game_added' (game) — a new live game was registered
 * 'game_updated' (game) — a live game's fields were changed
 * 'game_removed' ({ roomCode }) — a game was removed (completed / cancelled)
 *
 * LiveGame shape:
 * {
 * roomCode: string, /6-char uppercase code
 * playerCount: number, // max capacity (6 or 8)
 * currentPlayers: number, // players currently connected
 * cardVariant: string, // 'remove_2s' | 'remove_7s' | 'remove_8s'
 * spectatorUrl: string, // frontend path used to spectate
 * scores: { team1: number, team2: number },
 * status: 'waiting' | 'in_progress',
 * createdAt: number, // epoch ms — when the room was created
 * startedAt: number | null, // epoch ms — when in_progress began
 * }
 *
 * The computed field `elapsedMs` is NOT stored here; callers derive it from
 * `startedAt ?? createdAt` at serve time.
 */

const EventEmitter = require('events');

class LiveGamesStore extends EventEmitter {
  constructor() {
    super();
    // Map<roomCode (uppercase), LiveGame>
    this._games = new Map();
  }

  // ── Write operations ─────────────────────────────────────────────────────

  /**
   * Register a brand-new live game.
   *
   * @param {{
   * roomCode: string,
   * playerCount: number,
   * currentPlayers: number,
   * cardVariant: string,
   * spectatorUrl: string,
   * scores?: { team1: number, team2: number },
   * status?: 'waiting' | 'in_progress',
   * createdAt?: number,
   * startedAt?: number | null,
   * }} data
   * @returns {Object} The stored LiveGame object
   */
  addGame(data) {
    const key = data.roomCode.toUpperCase();
    const game = {
      roomCode:       key,
      playerCount:    data.playerCount,
      currentPlayers: data.currentPlayers ?? 0,
      cardVariant:    data.cardVariant,
      spectatorUrl:   data.spectatorUrl,
      scores:         data.scores ?? { team1: 0, team2: 0 },
      status:         data.status ?? 'waiting',
      createdAt:      data.createdAt ?? Date.now(),
      startedAt:      data.startedAt ?? null,
    };
    this._games.set(key, game);
    this.emit('game_added', game);
    return game;
  }

  /**
   * Apply a partial update to a live game.
   * No-op (and returns null) if the room code is not registered.
   *
   * @param {string} roomCode
   * @param {Partial<LiveGame>} patch
   * @returns {Object|null} The updated LiveGame, or null if not found
   */
  updateGame(roomCode, patch) {
    const key = roomCode.toUpperCase();
    const existing = this._games.get(key);
    if (!existing) return null;

    const updated = { ...existing, ...patch, roomCode: key };
    this._games.set(key, updated);
    this.emit('game_updated', updated);
    return updated;
  }

  /**
   * Remove a live game (called when the game completes or is cancelled).
   *
   * @param {string} roomCode
   * @returns {boolean} true if a game was removed, false if not found
   */
  removeGame(roomCode) {
    const key = roomCode.toUpperCase();
    if (!this._games.has(key)) return false;
    this._games.delete(key);
    this.emit('game_removed', { roomCode: key });
    return true;
  }

  // ── Read operations ──────────────────────────────────────────────────────

  /**
   * Return a snapshot of all live games, each augmented with a computed
   * `elapsedMs` field (milliseconds since game started, or since room
   * was created if still waiting).
   *
   * @returns {Object[]}
   */
  getAll() {
    const now = Date.now();
    return Array.from(this._games.values()).map((g) => ({
      ...g,
      elapsedMs: now - (g.startedAt ?? g.createdAt),
    }));
  }

  /**
   * Retrieve a single live game by room code (without elapsedMs augmentation).
   *
   * @param {string} roomCode
   * @returns {Object|undefined}
   */
  get(roomCode) {
    return this._games.get(roomCode.toUpperCase());
  }

  /**
   * Return the total number of tracked live games.
   * @returns {number}
   */
  get size() {
    return this._games.size;
  }

  // ── Test helpers ─────────────────────────────────────────────────────────

  /** Reset all stored games. Only call from test code. */
  _clearAll() {
    this._games.clear();
  }

  /** Direct access to the internal map — for assertions only. */
  _getGames() {
    return this._games;
  }
}

// Export a module-level singleton so all subsystems share the same instance.
const liveGamesStore = new LiveGamesStore();

module.exports = liveGamesStore;
module.exports.LiveGamesStore = LiveGamesStore; // exported for unit testing
