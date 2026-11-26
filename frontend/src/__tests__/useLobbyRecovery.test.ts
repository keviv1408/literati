import { renderHook } from '@testing-library/react';
import type { WsStatus } from '@/hooks/useRoomSocket';

const mockCalls: string[] = [];

jest.mock('@/lib/roomMembership', () => ({
  clearRoomMembership: (code: string) => mockCalls.push(`clearRoomMembership:${code}`),
}));

jest.mock('@/lib/api', () => ({
  invalidateGuestToken: () => mockCalls.push('invalidateGuestToken'),
}));

import { useLobbyRecovery } from '@/hooks/useLobbyRecovery';

interface Props {
  roomCode: string | null;
  wsStatus: WsStatus;
  stopCode: number | null;
}

const retry = jest.fn(() => mockCalls.push('retry'));

function _render(initial: Props) {
  return renderHook((props: Props) => useLobbyRecovery({ ...props, retry }), {
    initialProps: initial,
  });
}

const RECOVERY_CALLS = ['clearRoomMembership:ABC123', 'invalidateGuestToken', 'retry'];

beforeEach(() => {
  mockCalls.length = 0;
  retry.mockClear();
});

describe('useLobbyRecovery', () => {
  it('clears the membership, drops the token and retries once on a 4001, recovering on that render', () => {
    const seen: boolean[] = [];
    const { result } = renderHook(
      (props: Props) => {
        const out = useLobbyRecovery({ ...props, retry });
        seen.push(out.recovering);
        return out;
      },
      { initialProps: { roomCode: 'ABC123', wsStatus: 'error', stopCode: 4001 } },
    );

    expect(seen[0]).toBe(true);
    expect(mockCalls).toEqual(RECOVERY_CALLS);
    expect(result.current.recovering).toBe(true);
  });

  it('does nothing on a second 4001 with no connected in between', () => {
    const { result, rerender } = _render({ roomCode: 'ABC123', wsStatus: 'error', stopCode: 4001 });

    rerender({ roomCode: 'ABC123', wsStatus: 'idle', stopCode: null });
    expect(result.current.recovering).toBe(false);

    rerender({ roomCode: 'ABC123', wsStatus: 'error', stopCode: 4001 });
    expect(mockCalls).toEqual(RECOVERY_CALLS);
    expect(result.current.recovering).toBe(false);
  });

  it('recovers again after the socket reached connected', () => {
    const { result, rerender } = _render({ roomCode: 'ABC123', wsStatus: 'error', stopCode: 4001 });

    rerender({ roomCode: 'ABC123', wsStatus: 'idle', stopCode: null });
    rerender({ roomCode: 'ABC123', wsStatus: 'connected', stopCode: null });
    rerender({ roomCode: 'ABC123', wsStatus: 'error', stopCode: 4001 });

    expect(mockCalls).toEqual([...RECOVERY_CALLS, ...RECOVERY_CALLS]);
    expect(result.current.recovering).toBe(true);
  });

  it.each([4004, 4005, 4006, 4010])('ignores stop code %i', (code) => {
    const { result } = _render({ roomCode: 'ABC123', wsStatus: 'error', stopCode: code });

    expect(mockCalls).toEqual([]);
    expect(result.current.recovering).toBe(false);
  });

  it('does nothing without a room code', () => {
    const { result } = _render({ roomCode: null, wsStatus: 'error', stopCode: 4001 });

    expect(mockCalls).toEqual([]);
    expect(result.current.recovering).toBe(false);
  });
});
