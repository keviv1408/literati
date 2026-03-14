'use strict';

/**
 * Tests for liveGamesStore.js
 *
 * Covers:
 *  - addGame: creates an entry with defaults, emits 'game_added'
 *  - updateGame: patches fields, emits 'game_updated', no-op for unknown code
 *  - removeGame: deletes entry, emits 'game_removed', no-op for unknown code
 *  - getAll: returns all entries with computed elapsedMs
 *  - get: retrieves a single entry without elapsedMs augmentation
 *  - size: reports correct count
 *  - EventEmitter re-use (multiple listeners)
 */

const { LiveGamesStore } = require('../liveGames/liveGamesStore');

describe('LiveGamesStore', () => {
  let store;

  beforeEach(() => {
    store = new LiveGamesStore();
  });

  // ── addGame ────────────────────────────────────────────────────────────────

  describe('addGame', () => {
    it('stores a game and returns the stored object', () => {
      const game = store.addGame({
        roomCode:       'ABCD12',
        playerCount:    6,
        currentPlayers: 3,
        cardVariant:    'remove_7s',
      });

      expect(game.roomCode).toBe('ABCD12');
      expect(game.playerCount).toBe(6);
      expect(game.currentPlayers).toBe(3);
      expect(game.cardVariant).toBe('remove_7s');
      expect(game.scores).toEqual({ team1: 0, team2: 0 });
      expect(game.status).toBe('waiting');
      expect(game.startedAt).toBeNull();
      expect(typeof game.createdAt).toBe('number');
    });

    it('normalises roomCode to uppercase', () => {
      const game = store.addGame({ roomCode: 'abc123', playerCount: 6, currentPlayers: 0, cardVariant: 'remove_2s' });
      expect(game.roomCode).toBe('ABC123');
      expect(store.get('abc123')).toBeDefined();
      expect(store.get('ABC123')).toBeDefined();
    });

    it('accepts explicit scores, status, createdAt, startedAt', () => {
      const now = Date.now();
      const game = store.addGame({
        roomCode:       'XY1234',
        playerCount:    8,
        currentPlayers: 8,
        cardVariant:    'remove_8s',
        scores:         { team1: 3, team2: 2 },
        status:         'in_progress',
        createdAt:      now - 60_000,
        startedAt:      now - 30_000,
      });
      expect(game.scores).toEqual({ team1: 3, team2: 2 });
      expect(game.status).toBe('in_progress');
      expect(game.startedAt).toBe(now - 30_000);
    });

    it('emits game_added with the stored game', () => {
      const listener = jest.fn();
      store.on('game_added', listener);

      store.addGame({ roomCode: 'EMIT01', playerCount: 6, currentPlayers: 1, cardVariant: 'remove_7s' });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].roomCode).toBe('EMIT01');
    });

    it('does NOT overwrite an existing entry — callers should use updateGame', () => {
      store.addGame({ roomCode: 'DUPE01', playerCount: 6, currentPlayers: 1, cardVariant: 'remove_2s' });
      store.addGame({ roomCode: 'DUPE01', playerCount: 8, currentPlayers: 8, cardVariant: 'remove_8s' });

      // Second addGame wins (it's the caller's responsibility to avoid duplicates)
      const g = store.get('DUPE01');
      expect(g.playerCount).toBe(8);
    });
  });

  // ── updateGame ─────────────────────────────────────────────────────────────

  describe('updateGame', () => {
    it('patches the stored game and returns the updated object', () => {
      store.addGame({ roomCode: 'UPD001', playerCount: 6, currentPlayers: 2, cardVariant: 'remove_7s' });
      const updated = store.updateGame('UPD001', { currentPlayers: 5, scores: { team1: 1, team2: 0 } });
      expect(updated.currentPlayers).toBe(5);
      expect(updated.scores).toEqual({ team1: 1, team2: 0 });
      // Other fields preserved
      expect(updated.playerCount).toBe(6);
      expect(updated.cardVariant).toBe('remove_7s');
    });

    it('is case-insensitive on roomCode', () => {
      store.addGame({ roomCode: 'UPD002', playerCount: 6, currentPlayers: 0, cardVariant: 'remove_2s' });
      const updated = store.updateGame('upd002', { currentPlayers: 3 });
      expect(updated.currentPlayers).toBe(3);
    });

    it('emits game_updated with the updated game', () => {
      store.addGame({ roomCode: 'UPD003', playerCount: 6, currentPlayers: 0, cardVariant: 'remove_7s' });
      const listener = jest.fn();
      store.on('game_updated', listener);

      store.updateGame('UPD003', { status: 'in_progress', startedAt: Date.now() });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].status).toBe('in_progress');
    });

    it('returns null and does not emit when roomCode is not registered', () => {
      const listener = jest.fn();
      store.on('game_updated', listener);
      const result = store.updateGame('NOTHERE', { currentPlayers: 9 });
      expect(result).toBeNull();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── removeGame ─────────────────────────────────────────────────────────────

  describe('removeGame', () => {
    it('deletes the entry and returns true', () => {
      store.addGame({ roomCode: 'REM001', playerCount: 6, currentPlayers: 6, cardVariant: 'remove_2s' });
      const result = store.removeGame('REM001');
      expect(result).toBe(true);
      expect(store.get('REM001')).toBeUndefined();
    });

    it('is case-insensitive on roomCode', () => {
      store.addGame({ roomCode: 'REM002', playerCount: 6, currentPlayers: 6, cardVariant: 'remove_7s' });
      store.removeGame('rem002');
      expect(store.get('REM002')).toBeUndefined();
    });

    it('emits game_removed with { roomCode }', () => {
      store.addGame({ roomCode: 'REM003', playerCount: 6, currentPlayers: 6, cardVariant: 'remove_8s' });
      const listener = jest.fn();
      store.on('game_removed', listener);
      store.removeGame('REM003');
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toEqual({ roomCode: 'REM003' });
    });

    it('returns false and does not emit when roomCode is unknown', () => {
      const listener = jest.fn();
      store.on('game_removed', listener);
      const result = store.removeGame('UNKNOWN');
      expect(result).toBe(false);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── getAll ─────────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns an empty array when no games are registered', () => {
      expect(store.getAll()).toEqual([]);
    });

    it('returns all stored games each with a computed elapsedMs', () => {
      const past = Date.now() - 10_000;
      store.addGame({ roomCode: 'GA0001', playerCount: 6, currentPlayers: 6, cardVariant: 'remove_7s', createdAt: past });
      store.addGame({ roomCode: 'GA0002', playerCount: 8, currentPlayers: 4, cardVariant: 'remove_2s', createdAt: past });

      const games = store.getAll();
      expect(games).toHaveLength(2);
      for (const g of games) {
        expect(typeof g.elapsedMs).toBe('number');
        expect(g.elapsedMs).toBeGreaterThanOrEqual(10_000);
      }
    });

    it('uses startedAt for elapsedMs when in_progress', () => {
      const startedAt = Date.now() - 5_000;
      store.addGame({
        roomCode: 'ELAPSED1',
        playerCount: 6,
        currentPlayers: 6,
        cardVariant: 'remove_7s',
        status: 'in_progress',
        createdAt: Date.now() - 120_000,
        startedAt,
      });
      const [g] = store.getAll();
      expect(g.elapsedMs).toBeGreaterThanOrEqual(5_000);
      expect(g.elapsedMs).toBeLessThan(120_000);
    });

    it('falls back to createdAt for elapsedMs when startedAt is null', () => {
      store.addGame({
        roomCode: 'ELAPSED2',
        playerCount: 6,
        currentPlayers: 2,
        cardVariant: 'remove_7s',
        status: 'waiting',
        createdAt: Date.now() - 15_000,
        startedAt: null,
      });
      const [g] = store.getAll();
      expect(g.elapsedMs).toBeGreaterThanOrEqual(15_000);
    });
  });

  // ── get ────────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns the stored game without elapsedMs augmentation', () => {
      store.addGame({ roomCode: 'GET001', playerCount: 6, currentPlayers: 1, cardVariant: 'remove_2s' });
      const g = store.get('GET001');
      expect(g).toBeDefined();
      expect(g.roomCode).toBe('GET001');
      // elapsedMs is NOT present on raw store entries
      expect(g.elapsedMs).toBeUndefined();
    });

    it('returns undefined for an unknown code', () => {
      expect(store.get('NONE99')).toBeUndefined();
    });
  });

  // ── size ───────────────────────────────────────────────────────────────────

  describe('size', () => {
    it('tracks count across add / remove operations', () => {
      expect(store.size).toBe(0);
      store.addGame({ roomCode: 'SZ0001', playerCount: 6, currentPlayers: 1, cardVariant: 'remove_7s' });
      expect(store.size).toBe(1);
      store.addGame({ roomCode: 'SZ0002', playerCount: 8, currentPlayers: 2, cardVariant: 'remove_2s' });
      expect(store.size).toBe(2);
      store.removeGame('SZ0001');
      expect(store.size).toBe(1);
      store.removeGame('SZ0002');
      expect(store.size).toBe(0);
    });
  });

  // ── Multiple listeners ────────────────────────────────────────────────────

  describe('EventEmitter behaviour', () => {
    it('supports multiple listeners for the same event', () => {
      const a = jest.fn();
      const b = jest.fn();
      store.on('game_added', a);
      store.on('game_added', b);

      store.addGame({ roomCode: 'ML0001', playerCount: 6, currentPlayers: 1, cardVariant: 'remove_2s' });

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('once listeners fire only once', () => {
      const once = jest.fn();
      store.once('game_removed', once);

      store.addGame({ roomCode: 'ONCE01', playerCount: 6, currentPlayers: 1, cardVariant: 'remove_7s' });
      store.removeGame('ONCE01');
      store.addGame({ roomCode: 'ONCE01', playerCount: 6, currentPlayers: 1, cardVariant: 'remove_7s' });
      store.removeGame('ONCE01');

      expect(once).toHaveBeenCalledTimes(1);
    });
  });

  // ── _clearAll ────────────────────────────────────────────────────────────

  describe('_clearAll', () => {
    it('resets all stored games', () => {
      store.addGame({ roomCode: 'CLR001', playerCount: 6, currentPlayers: 1, cardVariant: 'remove_7s' });
      store.addGame({ roomCode: 'CLR002', playerCount: 8, currentPlayers: 2, cardVariant: 'remove_2s' });
      store._clearAll();
      expect(store.size).toBe(0);
      expect(store.getAll()).toEqual([]);
    });
  });
});
