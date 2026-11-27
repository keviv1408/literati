'use strict';

const { _claimRoomStart, _cancelWaitingRoom, isRoomHost, hostColumns, storedHostId } = require('../rooms/roomHost');

const { setGame, deleteGame } = require('../game/gameStore');

describe('starting status recovery', () => {
  it.each(['waiting', 'completed'])('restores %s after the database commits but its response is lost', async previousStatus => {
    const write = {
      eq: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockRejectedValue(new Error('lost response')),
    };
    const db = { from: jest.fn().mockReturnThis(), update: jest.fn().mockReturnValue(write) };
    await expect(_claimRoomStart(db, 'ABCDEF', previousStatus)).rejects.toThrow('lost response');
    expect(db.update.mock.calls).toEqual([[{ status: 'starting' }], [{ status: previousStatus }]]);
    expect(write.eq).toHaveBeenCalledWith('status', 'starting');
  });

  it.each([
    ['start', false], ['abandon', false], ['start', true], ['abandon', true],
  ])('recovers for %s after both writes lose responses (rollback committed: %s)', async (action, rollbackCommitted) => {
    jest.useFakeTimers();
    let status = 'waiting';
    let calls = 0;
    const db = { from: () => ({
      update: ({ status: next }) => {
        const filters = {};
        const chain = {
          eq(key, value) { filters[key] = [value]; return chain; },
          in(key, values) { filters[key] = values; return chain; },
          select() { return chain; },
          async maybeSingle() {
            calls++;
            if (calls === 2 && !rollbackCommitted) throw new Error('rollback offline');
            const matches = filters.status.includes(status);
            if (matches) status = next;
            if (calls <= 2) throw new Error('lost response');
            return { data: matches ? { code: 'ABCDEF' } : null, error: null };
          },
          then(resolve, reject) { return chain.maybeSingle().then(resolve, reject); },
        };
        return chain;
      },
    }) };
    try {
      await expect(_claimRoomStart(db, 'ABCDEF', 'waiting', 'host_user_id', 'owner')).rejects.toThrow('lost response');
      expect(status).toBe(rollbackCommitted ? 'waiting' : 'starting');
      if (!rollbackCommitted) await jest.advanceTimersByTimeAsync(1000);
      expect(status).toBe('waiting');
      const claimed = action === 'start'
        ? await _claimRoomStart(db, 'ABCDEF', 'waiting', 'host_user_id', 'owner')
        : await _cancelWaitingRoom(db, 'ABCDEF', 'host_user_id', 'owner');
      expect(claimed).toBe(true);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(status).toBe(action === 'start' ? 'starting' : 'cancelled');
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves an already dealt game alone on a failed competing request', async () => {
    const db = { from: jest.fn().mockReturnThis(), update: jest.fn(() => { throw new Error('lost response'); }) };
    setGame('ABCDEF', { status: 'active' });
    try {
      await expect(_claimRoomStart(db, 'ABCDEF', 'waiting')).rejects.toThrow('lost response');
      expect(db.update).toHaveBeenCalledTimes(1);
    } finally {
      deleteGame('ABCDEF');
    }
  });
});

describe('isRoomHost', () => {
  it('is true for the registered host', () => {
    expect(isRoomHost({ host_user_id: 'u', host_guest_id: null }, 'u')).toBe(true);
  });

  it('is true for the guest host', () => {
    expect(isRoomHost({ host_user_id: null, host_guest_id: 'g' }, 'g')).toBe(true);
  });

  it('is false for a different id', () => {
    expect(isRoomHost({ host_user_id: 'u', host_guest_id: null }, 'other')).toBe(false);
    expect(isRoomHost({ host_user_id: null, host_guest_id: 'g' }, 'other')).toBe(false);
  });

  it.each([null, undefined, ''])('is false for %p even when both columns are null', (playerId) => {
    expect(isRoomHost({ host_user_id: null, host_guest_id: null }, playerId)).toBe(false);
  });
});

describe('hostColumns', () => {
  it('puts a guest in host_guest_id', () => {
    expect(hostColumns('g', true)).toEqual({ host_user_id: null, host_guest_id: 'g' });
  });

  it('puts a registered user in host_user_id', () => {
    expect(hostColumns('u', false)).toEqual({ host_user_id: 'u', host_guest_id: null });
  });
});

describe('storedHostId', () => {
  it('returns host_user_id when set', () => {
    expect(storedHostId({ host_user_id: 'u', host_guest_id: null })).toBe('u');
  });

  it('returns host_guest_id when set', () => {
    expect(storedHostId({ host_user_id: null, host_guest_id: 'g' })).toBe('g');
  });

  it('returns null when neither is set', () => {
    expect(storedHostId({ host_user_id: null, host_guest_id: null })).toBeNull();
  });
});
