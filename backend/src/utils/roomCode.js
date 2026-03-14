/**
 * Room code utilities for Literature game rooms.
 *
 * Room codes are 6-character uppercase alphanumeric strings (excluding easily
 * confused characters like 0/O and 1/I/L) to give ~1.6 billion combinations
 * while remaining easy for players to type or share verbally.
 *
 * Also provides:
 *   generateInviteCode()      — 16-char hex token for player invite links
 *   generateSpectatorToken()  — 32-char hex token for spectator view links
 */

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

/**
 * Generates a single random room code.
 * @returns {string} 6-character uppercase alphanumeric code
 */
function generateRoomCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

/**
 * Generates a unique room code by checking against existing codes in Supabase.
 * Retries up to maxAttempts times before throwing.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} [maxAttempts=10]
 * @returns {Promise<string>} A unique room code not currently in use
 */
async function generateUniqueRoomCode(supabase, maxAttempts = 10) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = generateRoomCode();

    const { data, error } = await supabase
      .from('rooms')
      .select('code')
      .eq('code', code)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to check room code uniqueness: ${error.message}`);
    }

    if (!data) {
      // No existing room with this code — it's unique
      return code;
    }
  }

  throw new Error(
    `Unable to generate unique room code after ${maxAttempts} attempts`
  );
}

/**
 * Generates a cryptographically secure player invite code.
 *
 * 8 random bytes encoded as a 16-character uppercase hex string.
 * Provides 64 bits of entropy — collision-resistant for typical game volumes.
 *
 * @returns {string} 16-character uppercase hex string (e.g. "A3F2C91E7B046D52")
 */
function generateInviteCode() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

/**
 * Generates a cryptographically secure spectator view token.
 *
 * 16 random bytes encoded as a 32-character uppercase hex string.
 * Provides 128 bits of entropy — suitable as a secret bearer token.
 *
 * @returns {string} 32-character uppercase hex string
 */
function generateSpectatorToken() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

module.exports = {
  generateRoomCode,
  generateUniqueRoomCode,
  generateInviteCode,
  generateSpectatorToken,
};
