/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import {
  ASK_REPLY_DELAY_MS,
  REACTION_BUBBLE_MS,
  useReactionBubble,
} from '@/hooks/useReactionBubble';
import type { AskResultPayload, DeclarationResultPayload, GamePlayer } from '@/types/game';

function mountSeat(playerId: string, rect: Partial<DOMRect>) {
  const el = document.createElement('div');
  el.setAttribute('data-player-id', playerId);
  el.getBoundingClientRect = () =>
    ({ top: 0, left: 0, width: 100, height: 60, bottom: 60, right: 100, ...rect }) as DOMRect;
  document.querySelector('.game-table-space')!.appendChild(el);
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
    document.body.innerHTML = '<div class="game-table-space"></div>';
  });
  afterEach(() => jest.useRealTimers());

  it('shows a delayed denied bubble at the asked player and then hides it', () => {
    mountSeat('t', { top: 700, bottom: 760 });
    const { result } = renderHook(() => useReactionBubble(deniedAsk, null, []));
    expect(result.current).toBeNull();

    act(() => jest.advanceTimersByTime(ASK_REPLY_DELAY_MS));
    expect(result.current?.variant).toBe('denied');
    expect(result.current?.seat.dataset.playerId).toBe('t');

    act(() => jest.advanceTimersByTime(REACTION_BUBBLE_MS));
    expect(result.current).toBeNull();
  });

  it('immediately retires a visible reply and cancels pending replies when a new ask arrives', () => {
    mountSeat('t', {});
    const { result, rerender } = renderHook(
      ({ ask }) => useReactionBubble(ask, null, []),
      { initialProps: { ask: deniedAsk } },
    );
    act(() => jest.advanceTimersByTime(ASK_REPLY_DELAY_MS));
    expect(result.current?.variant).toBe('denied');
    const next = { ...deniedAsk, askerId: 't', targetId: 'a', success: true };
    rerender({ ask: next });
    expect(result.current).toBeNull();
    rerender({ ask: deniedAsk });
    rerender({ ask: next });
    act(() => jest.advanceTimersByTime(ASK_REPLY_DELAY_MS));
    expect(result.current).toBeNull();
  });

  it('shows one reply at the giver before the next three-second turn', () => {
    const giver = mountSeat('t', {});
    const success = { ...deniedAsk, success: true };
    const { result } = renderHook(() => useReactionBubble(success, null, []));
    expect(result.current).toBeNull();
    act(() => jest.advanceTimersByTime(ASK_REPLY_DELAY_MS));
    expect(result.current).toMatchObject({ seat: giver, variant: 'given', text: expect.any(String) });
    act(() => jest.advanceTimersByTime(REACTION_BUBBLE_MS));
    expect(result.current).toBeNull();
  });

  it('names another eligible opponent using only the public seats', () => {
    mountSeat('t', {});
    const ask = { ...deniedAsk, cardId: '9_s' };
    const base: GamePlayer = {
      playerId: 'a', displayName: 'Asker', teamId: 1, seatIndex: 0, avatarId: null,
      cardCount: 2, isBot: false, isGuest: false, isCurrentTurn: true,
    };
    const players: GamePlayer[] = [
      base, { ...base, playerId: 't', teamId: 2 },
      { ...base, playerId: 'out', teamId: 2, cardCount: 0 },
      { ...base, playerId: 'gone', teamId: 2, isEliminated: true },
      { ...base, playerId: 'other', teamId: 2, displayName: 'Echo' },
    ];
    const { result } = renderHook(() => useReactionBubble(ask, null, players));
    act(() => jest.advanceTimersByTime(ASK_REPLY_DELAY_MS));
    expect(result.current?.text).toBe('You can ask Echo too, y’know.');
  });

  it('shows a declared bubble immediately for a correct declaration only', () => {
    mountSeat('d', { top: 10, bottom: 70 });
    const { result, rerender } = renderHook(
      ({ declare }: { declare: DeclarationResultPayload }) => useReactionBubble(null, declare, []),
      { initialProps: { declare: correctDeclare } },
    );
    act(() => jest.advanceTimersByTime(20));
    expect(result.current?.variant).toBe('declared');
    expect(result.current?.seat.dataset.playerId).toBe('d');

    act(() => jest.advanceTimersByTime(REACTION_BUBBLE_MS));
    expect(result.current).toBeNull();

    rerender({ declare: { ...correctDeclare, correct: false, halfSuitId: 'low_hearts' } });
    expect(result.current).toBeNull();
    rerender({ declare: { ...correctDeclare, timedOut: true, halfSuitId: 'low_clubs' } });
    expect(result.current).toBeNull();
  });
});
