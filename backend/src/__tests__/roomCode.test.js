const {
  generateRoomCode,
  generateUniqueRoomCode,
  generateInviteCode,
  generateSpectatorToken,
} = require('../utils/roomCode');

describe('generateRoomCode', () => {
  it('returns a 6-character string', () => {
    const code = generateRoomCode();
    expect(code).toHaveLength(6);
  });

  it('contains only allowed characters', () => {
    const ALLOWED = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/;
    for (let i = 0; i < 100; i++) {
      expect(generateRoomCode()).toMatch(ALLOWED);
    }
  });

  it('generates different codes on successive calls', () => {
    const codes = new Set();
    for (let i = 0; i < 20; i++) {
      codes.add(generateRoomCode());
    }
    // With 31^6 ≈ 887 million possibilities, 20 calls should always yield
    // at least 19 unique codes.
    expect(codes.size).toBeGreaterThanOrEqual(19);
  });
});

describe('generateUniqueRoomCode', () => {
  it('returns a code when no collision occurs', async () => {
    const mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    };

    const code = await generateUniqueRoomCode(mockSupabase);
    expect(code).toHaveLength(6);
    expect(mockSupabase.from).toHaveBeenCalledWith('rooms');
  });

  it('retries on collision and returns a unique code', async () => {
    let callCount = 0;
    const mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      // First two calls simulate a collision, third is unique
      maybeSingle: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve({ data: { code: 'EXISTS' }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }),
    };

    const code = await generateUniqueRoomCode(mockSupabase);
    expect(code).toHaveLength(6);
    expect(callCount).toBe(3);
  });

  it('throws after exhausting max attempts', async () => {
    const mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest
        .fn()
        .mockResolvedValue({ data: { code: 'EXISTS' }, error: null }),
    };

    await expect(generateUniqueRoomCode(mockSupabase, 3)).rejects.toThrow(
      'Unable to generate unique room code after 3 attempts'
    );
  });

  it('throws when Supabase returns an error', async () => {
    const mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'DB connection failed' },
      }),
    };

    await expect(generateUniqueRoomCode(mockSupabase)).rejects.toThrow(
      'Failed to check room code uniqueness'
    );
  });
});

// ── generateInviteCode ─────────────────────────────────────────────────────────

describe('generateInviteCode', () => {
  it('returns a 16-character string', () => {
    const code = generateInviteCode();
    expect(code).toHaveLength(16);
  });

  it('contains only uppercase hex characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateInviteCode()).toMatch(/^[0-9A-F]{16}$/);
    }
  });

  it('generates unique values on successive calls', () => {
    const codes = new Set();
    for (let i = 0; i < 20; i++) {
      codes.add(generateInviteCode());
    }
    // 64-bit entropy: extremely unlikely to see a collision in 20 calls
    expect(codes.size).toBe(20);
  });
});

// ── generateSpectatorToken ─────────────────────────────────────────────────────

describe('generateSpectatorToken', () => {
  it('returns a 32-character string', () => {
    const token = generateSpectatorToken();
    expect(token).toHaveLength(32);
  });

  it('contains only uppercase hex characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSpectatorToken()).toMatch(/^[0-9A-F]{32}$/);
    }
  });

  it('generates unique values on successive calls', () => {
    const tokens = new Set();
    for (let i = 0; i < 20; i++) {
      tokens.add(generateSpectatorToken());
    }
    // 128-bit entropy: no collisions expected
    expect(tokens.size).toBe(20);
  });

  it('is longer than invite_code (spectator token has higher entropy)', () => {
    const inviteCode = generateInviteCode();
    const spectatorToken = generateSpectatorToken();
    expect(spectatorToken.length).toBeGreaterThan(inviteCode.length);
  });
});
