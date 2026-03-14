'use strict';

/**
 * Bot player generation for the lobby fill timer.
 *
 * When the 2-minute lobby countdown expires (or the host manually starts with
 * an unfull room), this module generates bot players to occupy any empty seats.
 *
 * Bot IDs follow the "bot_<timestamp>_<seatIndex>" format so that
 * isBotId() in apps/server/src/bots.ts recognises them.
 *
 * Bot names follow the Docker-style adjective_noun convention defined in
 * packages/shared/src/botNames.ts.  This JS implementation uses a compatible
 * subset of the same word lists so bot names are consistent across the stack.
 */

// ---------------------------------------------------------------------------
// Word lists (Docker-style adjective + scientist/pioneer noun)
// ---------------------------------------------------------------------------

const BOT_ADJECTIVES = [
  'admiring',   'adoring',    'amazing',    'blissful',   'bold',
  'brave',      'charming',   'clever',     'compassionate', 'confident',
  'cool',       'dazzling',   'determined', 'dreamy',     'eager',
  'elastic',    'elegant',    'epic',       'fervent',    'festive',
  'focused',    'friendly',   'funny',      'gallant',    'gifted',
  'gracious',   'happy',      'hardcore',   'hopeful',    'hungry',
  'infallible', 'inspiring',  'intelligent','jolly',      'jovial',
  'keen',       'kind',       'laughing',   'loving',     'lucid',
  'magical',    'nifty',      'nostalgic',  'optimistic', 'peaceful',
  'quirky',     'relaxed',    'reverent',   'romantic',   'serene',
  'sharp',      'silly',      'sleepy',     'stoic',      'sweet',
  'tender',     'trusting',   'upbeat',     'vibrant',    'vigilant',
  'wonderful',  'youthful',   'zealous',    'zen',
];

const BOT_NOUNS = [
  // Computing & Math
  'turing',     'lovelace',   'hopper',     'dijkstra',   'knuth',
  'torvalds',   'wozniak',    'ritchie',    'thompson',   'shannon',
  'babbage',    'boole',      'hamming',    'liskov',     'lamport',
  // Physics
  'curie',      'einstein',   'feynman',    'hawking',    'tesla',
  'faraday',    'newton',     'galileo',    'fermi',      'planck',
  'noether',    'bohr',       'dirac',
  // Math
  'euler',      'gauss',      'ramanujan',  'pascal',     'archimedes',
  'fibonacci',  'hilbert',    'godel',      'cantor',     'riemann',
  // Biology & CS
  'darwin',     'pasteur',    'franklin',   'crick',
  'edison',     'bell',       'hubble',     'sagan',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Capitalise the first letter of a word, lower-casing the rest.
 *
 * @param {string} word
 * @returns {string}
 */
function _cap(word) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Convert an adjective_noun key to a display name ("Quirky Turing").
 *
 * @param {string} key
 * @returns {string}
 */
function _keyToDisplayName(key) {
  return key.split('_').map(_cap).join(' ');
}

/**
 * Generate a unique bot name key (adjective_noun) that is not already taken.
 *
 * @param {Set<string>} usedKeys - Keys already assigned in this session.
 * @returns {string} A unique adjective_noun key.
 */
function _generateUniqueBotKey(usedKeys) {
  let attempts = 0;
  const maxAttempts = 300;

  while (attempts < maxAttempts) {
    const adj  = BOT_ADJECTIVES[Math.floor(Math.random() * BOT_ADJECTIVES.length)];
    const noun = BOT_NOUNS[Math.floor(Math.random() * BOT_NOUNS.length)];
    const key  = `${adj}_${noun}`;
    if (!usedKeys.has(key)) return key;
    attempts++;
  }

  // Fallback: attach a numeric suffix (astronomically unlikely to be needed)
  for (let suffix = 2; ; suffix++) {
    const base = `${BOT_ADJECTIVES[0]}_${BOT_NOUNS[0]}_${suffix}`;
    if (!usedKeys.has(base)) return base;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate bot seat descriptors for all unoccupied seats in a lobby.
 *
 * Returns an array of LobbySeat-shaped objects (matching lobbyManager's
 * expected shape) — one per empty seat.
 *
 * BALANCE GUARANTEE
 * -----------------
 * The algorithm guarantees that the final game will have exactly
 * Math.floor(playerCount / 2) players on each team, regardless of how
 * many humans are present or which teams they chose:
 *
 *   1. Count existing players per team from occupiedSeats (both humans and
 *      any pre-placed bots).
 *   2. Compute the per-team deficit: target − current (clamped to ≥ 0).
 *   3. For each empty seat, prefer the "natural" team (even → T1, odd → T2)
 *      to maintain the T1-T2-T1-T2 clockwise table-layout alternation.
 *      If the natural team's deficit is already satisfied, cross-assign to
 *      the other team so the overall count still reaches the target.
 *
 * This approach respects the existing human distribution: if humans are
 * skewed toward one team, bots fill the under-represented team first.
 *
 * @param {number}              playerCount   - Total seats in the room (6 or 8).
 * @param {Map<number, Object>} occupiedSeats - seatIndex → LobbySeat (with teamId).
 * @returns {Array<Object>} Bot LobbySeat descriptors for every empty seat.
 */
function fillWithBots(playerCount, occupiedSeats) {
  const target = Math.floor(playerCount / 2); // players needed per team

  // ── Step 1: Count existing players per team ──────────────────────────────
  let countT1 = 0;
  let countT2 = 0;
  for (const seat of occupiedSeats.values()) {
    if (seat.teamId === 1) countT1++;
    else                   countT2++;
  }

  // ── Step 2: Per-team deficit (how many bots each team needs) ─────────────
  let needT1 = Math.max(0, target - countT1);
  let needT2 = Math.max(0, target - countT2);

  // ── Step 3: Collect display names already in use to avoid duplicates ─────
  const usedKeys = new Set();
  for (const seat of occupiedSeats.values()) {
    if (seat.isBot && seat.displayName) {
      usedKeys.add(seat.displayName.toLowerCase().split(' ').join('_'));
    }
  }

  const bots   = [];
  const nowMs  = Date.now();

  // ── Step 4: Assign bots to empty seats ────────────────────────────────────
  for (let seatIndex = 0; seatIndex < playerCount; seatIndex++) {
    if (occupiedSeats.has(seatIndex)) continue; // seat occupied — skip

    // Natural parity: even seat → Team 1, odd seat → Team 2.
    // This preserves the T1-T2-T1-T2 alternating clockwise table layout.
    const naturalTeam = seatIndex % 2 === 0 ? 1 : 2;

    // Select team: use natural parity if that team still has deficit;
    // otherwise cross-assign to the other team to maintain overall balance.
    let teamId;
    if (naturalTeam === 1) {
      teamId = /** @type {1|2} */ (needT1 > 0 ? 1 : 2);
    } else {
      teamId = /** @type {1|2} */ (needT2 > 0 ? 2 : 1);
    }

    // Consume one slot from the chosen team's deficit counter.
    if (teamId === 1) needT1--;
    else              needT2--;

    const nameKey = _generateUniqueBotKey(usedKeys);
    usedKeys.add(nameKey);

    bots.push({
      seatIndex,
      playerId:    `bot_${nowMs}_${seatIndex}`,
      displayName: _keyToDisplayName(nameKey),
      avatarId:    null,
      teamId,
      isBot:       true,
      isGuest:     false,
    });
  }

  return bots;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  fillWithBots,

  // Exposed for unit-testing the helper logic
  _keyToDisplayName,
};
