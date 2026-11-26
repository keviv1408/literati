'use strict';

const { isRoomHost, hostColumns, storedHostId } = require('../rooms/roomHost');

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
