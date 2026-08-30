/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import {
  DENIED_REACTION_DELAY_MS,
  REACTION_BUBBLE_MS,
  useReactionBubble,
} from '@/hooks/useReactionBubble';
import type { AskResultPayload, DeclarationResultPayload } from '@/types/game';

function mountSeat(playerId: string, rect: Partial<DOMRect>) {
  const el = document.createElement('div');
  el.setAttribute('data-player-id', playerId);
  el.getBoundingClientRect = () =>
    ({ top: 0, left: 0, width: 100, height: 60, bottom: 60, right: 100, ...rect }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

const deniedAsk: AskResultPayload = {
  type: 'ask_result',
  askerId: 'a',
  targetId: 't',
  cardId: 'AS',
  success: false,
  newTurnPlayerId: 't',
  lastMove: '',
};

const correctDeclare: DeclarationResultPayload = {
  type: 'declaration_result',
  declarerId: 'd',
  halfSuitId: 'high_spades',
  correct: true,
  winningTeam: 1,
  newTurnPlayerId: 'd',
  assignment: {},
  lastMove: '',
};

describe('useReactionBubble', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '';
  });
  afterEach(() => jest.useRealTimers());

  it('shows a delayed denied bubble at the asked player, clear of the denied card, then hides it', () => {
    mountSeat('t', { top: 700, bottom: 760 });
    const { result } = renderHook(() => useReactionBubble(deniedAsk, null));
    expect(result.current).toBeNull();

    act(() => jest.advanceTimersByTime(DENIED_REACTION_DELAY_MS));
    expect(result.current?.variant).toBe('denied');
    expect(result.current?.placement).toBe('below');
    expect(result.current?.anchorY).toBe(700 + 112 + 10);

    act(() => jest.advanceTimersByTime(REACTION_BUBBLE_MS));
    expect(result.current).toBeNull();
  });

  it('ignores successful asks', () => {
    mountSeat('t', {});
    const { result } = renderHook(() => useReactionBubble({ ...deniedAsk, success: true }, null));
    act(() => jest.advanceTimersByTime(DENIED_REACTION_DELAY_MS));
    expect(result.current).toBeNull();
  });

  it('shows a declared bubble immediately for a correct declaration only', () => {
    mountSeat('d', { top: 10, bottom: 70 });
    const { result, rerender } = renderHook(
      ({ declare }: { declare: DeclarationResultPayload }) => useReactionBubble(null, declare),
      { initialProps: { declare: correctDeclare } },
    );
    act(() => jest.advanceTimersByTime(20));
    expect(result.current?.variant).toBe('declared');
    expect(result.current?.placement).toBe('above');

    act(() => jest.advanceTimersByTime(REACTION_BUBBLE_MS));
    expect(result.current).toBeNull();

    rerender({ declare: { ...correctDeclare, correct: false, halfSuitId: 'low_hearts' } });
    expect(result.current).toBeNull();
    rerender({ declare: { ...correctDeclare, timedOut: true, halfSuitId: 'low_clubs' } });
    expect(result.current).toBeNull();
  });
});
