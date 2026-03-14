'use strict';

/**
 * Unit tests for rematchStore.js (rematch voting logic).
 *
 * Coverage:
 *   initRematch:
 *     1. Creates a vote state for the room
 *     2. Auto-votes yes for all bots
 *     3. Returns correct initial summary
 *     4. Fires onTimeout after REMATCH_VOTE_TIMEOUT_MS
 *     5. Re-initialising clears any existing state/timer
 *   castVote:
 *     6. Human player can vote yes
 *     7. Human player can vote no
 *     8. Bot player vote cannot be overridden (returns existing yes vote)
 *     9. Returns null if no active vote for room
 *    10. Unknown player returns null
 *   getVoteSummary:
 *    11. Returns null for unknown room
 *    12. Returns correct yesCount / noCount / totalCount
 *    13. majorityReached is true when yesCount >= majority
 *    14. majorityDeclined is true when remaining votes cannot reach majority
 *    15. playerVotes shows null for not-yet-voted humans
 *   clearRematch:
 *    16. Removes state so hasRematch returns false
 *    17. Cancels the auto-decline timer (no callback fires after clear)
 *   Majority thresholds:
 *    18. 6-player game: majority = 4 (floor(6/2)+1)
 *    19. 8-player game: majority = 5 (floor(8/2)+1)
 *    20. All-bot 6-player game: auto yes → majorityReached immediately
 *    21. 6-player, 2 bots + 4 humans: bots vote yes; need 2 more human yes
 */

jest.useFakeTimers();

const {
  initRematch,
  castVote,
  getVoteSummary,
  hasRematch,
  clearRematch,
  REMATCH_VOTE_TIMEOUT_MS,
  _clearAll,
} = require('../game/rematchStore');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHumanPlayer(id) {
  return { playerId: id, displayName: id, isBot: false, isGuest: false, teamId: 1, seatIndex: 0 };
}

function makeBotPlayer(id) {
  return { playerId: id, displayName: id, isBot: true, isGuest: false, teamId: 2, seatIndex: 1 };
}

function make6Players() {
  return [
    makeHumanPlayer('h1'),
    makeHumanPlayer('h2'),
    makeHumanPlayer('h3'),
    makeHumanPlayer('h4'),
    makeHumanPlayer('h5'),
    makeHumanPlayer('h6'),
  ];
}

function make6WithBots() {
  // 2 bots, 4 humans
  return [
    makeHumanPlayer('h1'),
    makeHumanPlayer('h2'),
    makeHumanPlayer('h3'),
    makeHumanPlayer('h4'),
    makeBotPlayer('b1'),
    makeBotPlayer('b2'),
  ];
}

function make8Players() {
  return Array.from({ length: 8 }, (_, i) => makeHumanPlayer(`h${i + 1}`));
}

function makeAllBots(count = 6) {
  return Array.from({ length: count }, (_, i) => makeBotPlayer(`b${i + 1}`));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _clearAll();
});

afterEach(() => {
  _clearAll();
  jest.clearAllTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('initRematch', () => {
  test('1. creates vote state for the room', () => {
    initRematch('ROOM1', make6Players(), jest.fn());
    expect(hasRematch('ROOM1')).toBe(true);
  });

  test('2. auto-votes yes for all bots', () => {
    const summary = initRematch('ROOM1', make6WithBots(), jest.fn());
    // b1 and b2 should already have yes votes
    expect(summary.votes['b1']).toBe(true);
    expect(summary.votes['b2']).toBe(true);
    expect(summary.yesCount).toBe(2); // 2 bot yes votes immediately
  });

  test('3. returns correct initial summary', () => {
    const summary = initRematch('ROOM1', make6Players(), jest.fn());
    expect(summary).toMatchObject({
      yesCount:       0,
      noCount:        0,
      totalCount:     6,
      majority:       4,  // floor(6/2)+1 = 4
      majorityReached: false,
    });
    expect(summary.playerVotes).toHaveLength(6);
    // All humans: vote === null (not yet voted)
    for (const pv of summary.playerVotes) {
      expect(pv.vote).toBeNull();
    }
  });

  test('4. fires onTimeout after REMATCH_VOTE_TIMEOUT_MS', () => {
    const onTimeout = jest.fn();
    initRematch('ROOM1', make6Players(), onTimeout);
    expect(onTimeout).not.toHaveBeenCalled();
    jest.advanceTimersByTime(REMATCH_VOTE_TIMEOUT_MS);
    expect(onTimeout).toHaveBeenCalledWith('ROOM1');
    expect(hasRematch('ROOM1')).toBe(false);
  });

  test('5. re-initialising clears any existing state/timer', () => {
    const firstTimeout = jest.fn();
    initRematch('ROOM1', make6Players(), firstTimeout);
    // Re-init before first timeout fires
    initRematch('ROOM1', make6Players(), jest.fn());
    // Advance past the first timeout — old timer should NOT fire
    jest.advanceTimersByTime(REMATCH_VOTE_TIMEOUT_MS);
    expect(firstTimeout).not.toHaveBeenCalled();
  });
});

describe('castVote', () => {
  test('6. human player can vote yes', () => {
    initRematch('ROOM1', make6Players(), jest.fn());
    const summary = castVote('ROOM1', 'h1', true);
    expect(summary).not.toBeNull();
    expect(summary.votes['h1']).toBe(true);
    expect(summary.yesCount).toBe(1);
  });

  test('7. human player can vote no', () => {
    initRematch('ROOM1', make6Players(), jest.fn());
    const summary = castVote('ROOM1', 'h1', false);
    expect(summary.votes['h1']).toBe(false);
    expect(summary.noCount).toBe(1);
  });

  test('8. bot player vote cannot be overridden — stays true', () => {
    const players = make6WithBots();
    initRematch('ROOM1', players, jest.fn());
    // Try to override bot vote with false
    const summary = castVote('ROOM1', 'b1', false);
    expect(summary.votes['b1']).toBe(true); // unchanged
    expect(summary.yesCount).toBe(2); // both bots still voting yes
  });

  test('9. returns null if no active vote for room', () => {
    const result = castVote('NOROOM', 'h1', true);
    expect(result).toBeNull();
  });

  test('10. unknown player returns null', () => {
    initRematch('ROOM1', make6Players(), jest.fn());
    const result = castVote('ROOM1', 'stranger', true);
    expect(result).toBeNull();
  });
});

describe('getVoteSummary', () => {
  test('11. returns null for unknown room', () => {
    expect(getVoteSummary('NOPE')).toBeNull();
  });

  test('12. returns correct yesCount / noCount / totalCount', () => {
    initRematch('ROOM1', make6Players(), jest.fn());
    castVote('ROOM1', 'h1', true);
    castVote('ROOM1', 'h2', true);
    castVote('ROOM1', 'h3', false);

    const s = getVoteSummary('ROOM1');
    expect(s.yesCount).toBe(2);
    expect(s.noCount).toBe(1);
    expect(s.totalCount).toBe(6);
  });

  test('13. majorityReached is true when yesCount >= majority', () => {
    initRematch('ROOM1', make6Players(), jest.fn()); // majority = 4
    castVote('ROOM1', 'h1', true);
    castVote('ROOM1', 'h2', true);
    castVote('ROOM1', 'h3', true);
    expect(getVoteSummary('ROOM1').majorityReached).toBe(false);
    castVote('ROOM1', 'h4', true); // 4th yes → majority!
    expect(getVoteSummary('ROOM1').majorityReached).toBe(true);
  });

  test('14. majorityDeclined is true when remaining votes cannot reach majority', () => {
    initRematch('ROOM1', make6Players(), jest.fn()); // majority = 4
    // 3 no votes: max possible yes = 3 < 4 → declined
    castVote('ROOM1', 'h1', false);
    castVote('ROOM1', 'h2', false);
    castVote('ROOM1', 'h3', false);
    expect(getVoteSummary('ROOM1').majorityDeclined).toBe(true);
  });

  test('15. playerVotes shows null for not-yet-voted humans', () => {
    initRematch('ROOM1', make6Players(), jest.fn());
    castVote('ROOM1', 'h1', true);
    const s = getVoteSummary('ROOM1');
    const h1vote = s.playerVotes.find((pv) => pv.playerId === 'h1');
    const h2vote = s.playerVotes.find((pv) => pv.playerId === 'h2');
    expect(h1vote.vote).toBe(true);
    expect(h2vote.vote).toBeNull();
  });
});

describe('clearRematch', () => {
  test('16. removes state so hasRematch returns false', () => {
    initRematch('ROOM1', make6Players(), jest.fn());
    expect(hasRematch('ROOM1')).toBe(true);
    clearRematch('ROOM1');
    expect(hasRematch('ROOM1')).toBe(false);
  });

  test('17. cancels the auto-decline timer (no callback fires after clear)', () => {
    const onTimeout = jest.fn();
    initRematch('ROOM1', make6Players(), onTimeout);
    clearRematch('ROOM1');
    jest.advanceTimersByTime(REMATCH_VOTE_TIMEOUT_MS + 100);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe('Majority thresholds', () => {
  test('18. 6-player game: majority = 4', () => {
    const s = initRematch('ROOM1', make6Players(), jest.fn());
    expect(s.majority).toBe(4);
    expect(s.totalCount).toBe(6);
  });

  test('19. 8-player game: majority = 5', () => {
    const s = initRematch('ROOM1', make8Players(), jest.fn());
    expect(s.majority).toBe(5);
    expect(s.totalCount).toBe(8);
  });

  test('20. all-bot 6-player game: auto yes → majorityReached immediately', () => {
    const s = initRematch('ROOM1', makeAllBots(6), jest.fn());
    // 6 bots × auto-yes = 6 yes votes, majority = 4 → immediate majority
    expect(s.yesCount).toBe(6);
    expect(s.majorityReached).toBe(true);
  });

  test('21. 6-player with 2 bots + 4 humans: bots vote yes; need 2 more human yes', () => {
    initRematch('ROOM1', make6WithBots(), jest.fn()); // majority = 4, bots give 2 yes
    expect(getVoteSummary('ROOM1').yesCount).toBe(2);
    expect(getVoteSummary('ROOM1').majorityReached).toBe(false);
    castVote('ROOM1', 'h1', true); // 3 yes
    expect(getVoteSummary('ROOM1').majorityReached).toBe(false);
    castVote('ROOM1', 'h2', true); // 4 yes = majority!
    expect(getVoteSummary('ROOM1').majorityReached).toBe(true);
  });
});
