/**
 * Tests for guest display name validation logic.
 */

import {
  validateDisplayName,
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
} from '@/types/user';

describe('validateDisplayName', () => {
  // ── Valid names ────────────────────────────────────────────────────────────
  describe('valid names', () => {
    it('accepts a simple alphabetic name', () => {
      expect(validateDisplayName('Alice')).toBeNull();
    });

    it('accepts a name with numbers', () => {
      expect(validateDisplayName('Player123')).toBeNull();
    });

    it('accepts a name with allowed punctuation', () => {
      expect(validateDisplayName("O'Brien")).toBeNull();
      expect(validateDisplayName('Card-Shark')).toBeNull();
      expect(validateDisplayName('user_name')).toBeNull();
      expect(validateDisplayName('J.R.')).toBeNull();
    });

    it('accepts a name with internal spaces', () => {
      expect(validateDisplayName('Alice Johnson')).toBeNull();
    });

    it('accepts a name at exactly max length', () => {
      const name = 'A'.repeat(DISPLAY_NAME_MAX_LENGTH);
      expect(validateDisplayName(name)).toBeNull();
    });

    it('accepts a single character name (minimum valid)', () => {
      expect(validateDisplayName('A')).toBeNull();
    });

    it('trims surrounding whitespace before validating', () => {
      // "  Alice  " trims to "Alice" — should be valid
      expect(validateDisplayName('  Alice  ')).toBeNull();
    });
  });

  // ── Empty / whitespace ─────────────────────────────────────────────────────
  describe('empty / whitespace-only names', () => {
    it('rejects an empty string', () => {
      expect(validateDisplayName('')).not.toBeNull();
    });

    it('rejects a whitespace-only string', () => {
      expect(validateDisplayName('   ')).not.toBeNull();
    });

    it('returns an error message for empty input', () => {
      const err = validateDisplayName('');
      expect(typeof err).toBe('string');
      expect(err!.length).toBeGreaterThan(0);
    });
  });

  // ── Too long ───────────────────────────────────────────────────────────────
  describe('names exceeding max length', () => {
    it('rejects a name one character over max length', () => {
      const name = 'A'.repeat(DISPLAY_NAME_MAX_LENGTH + 1);
      expect(validateDisplayName(name)).not.toBeNull();
    });

    it('rejects a very long name', () => {
      expect(validateDisplayName('A'.repeat(100))).not.toBeNull();
    });

    it('error message mentions the max length', () => {
      const name = 'A'.repeat(DISPLAY_NAME_MAX_LENGTH + 1);
      const err = validateDisplayName(name);
      expect(err).toContain(String(DISPLAY_NAME_MAX_LENGTH));
    });
  });

  // ── Disallowed characters ──────────────────────────────────────────────────
  describe('names with disallowed characters', () => {
    it('rejects names with angle brackets (XSS vector)', () => {
      expect(validateDisplayName('<script>')).not.toBeNull();
    });

    it('rejects names with emoji', () => {
      expect(validateDisplayName('Player🃏')).not.toBeNull();
    });

    it('rejects names with @ symbol', () => {
      expect(validateDisplayName('user@example')).not.toBeNull();
    });

    it('rejects names with # symbol', () => {
      expect(validateDisplayName('user#tag')).not.toBeNull();
    });

    it('rejects names with slash', () => {
      expect(validateDisplayName('path/name')).not.toBeNull();
    });
  });

  // ── Error message format ───────────────────────────────────────────────────
  describe('error message contract', () => {
    it('returns null (not a string) for valid input', () => {
      expect(validateDisplayName('ValidName')).toBeNull();
    });

    it('returns a non-empty string for invalid input', () => {
      const err = validateDisplayName('');
      expect(err).toBeTruthy();
    });
  });

  // ── DISPLAY_NAME_MIN_LENGTH constant ──────────────────────────────────────
  describe('constants', () => {
    it('MIN_LENGTH is at least 1', () => {
      expect(DISPLAY_NAME_MIN_LENGTH).toBeGreaterThanOrEqual(1);
    });

    it('MAX_LENGTH is at most 30', () => {
      expect(DISPLAY_NAME_MAX_LENGTH).toBeLessThanOrEqual(30);
    });

    it('MAX_LENGTH is greater than MIN_LENGTH', () => {
      expect(DISPLAY_NAME_MAX_LENGTH).toBeGreaterThan(DISPLAY_NAME_MIN_LENGTH);
    });
  });
});
