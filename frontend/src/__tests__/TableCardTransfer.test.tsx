import React from 'react';
import { act, render } from '@testing-library/react';
import TableCardTransfer from '@/components/creatures/TableCardTransfer';
import { createRetrievalScene } from '@/components/creatures/retrievalScene';
import AskDeniedAnimation from '@/components/AskDeniedAnimation';
import { FLIGHT_DURATION_MS } from '@/components/CardFlightAnimation';
import type { AskDeniedCueState, CardFlightState } from '@/hooks/useAskResultAnimations';

jest.mock('@/components/creatures/retrievalScene', () => ({ createRetrievalScene: jest.fn() }));

it('waits for a successful grab and keeps a denied card visible if the creature scene stops early', async () => {
  jest.useFakeTimers();
  const replacements = {
    WebGL2RenderingContext: class {},
    ResizeObserver: class { observe() {} disconnect() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    CSS: { escape: (value: string) => value },
  };
  const original = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(window, key)]));
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(window, key, { configurable: true, writable: true, value });
  }
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 48, height: 48, left: 0, top: 0, right: 48, bottom: 48, x: 0, y: 0, toJSON() {},
  });
  let finish: (() => void) | undefined;
  const stop = () => { const callback = finish; finish = undefined; callback?.(); };
  jest.mocked(createRetrievalScene).mockReturnValue({
    warm: jest.fn(), deny: (_seats, _duration, onStop) => { finish = onStop; }, play: (_args, onStop) => { finish = onStop; }, stop, dispose: stop,
  });
  const complete = jest.fn();
  const content = (flight: CardFlightState | null, denial?: AskDeniedCueState) => <div className="game-table-space">
    <div data-player-id="asker"><span className="speech-avatar" data-creature="frog" /></div>
    <div data-player-id="other"><span className="speech-avatar" data-creature="frog" /></div>
    <TableCardTransfer denial={denial} flight={flight} onComplete={complete} />
  </div>;
  const view = render(content(null));
  try {
    await act(async () => {});
    const flight = { askerId: 'asker', cardId: '6_d', fromX: 4, fromY: 6, toX: 20, toY: 30 } as const;
    view.rerender(content(flight));
    expect(finish).toBeDefined();
    view.rerender(content({ ...flight, cardId: '4_d' }));
    act(() => jest.advanceTimersByTime(FLIGHT_DURATION_MS + 100));
    expect(complete).not.toHaveBeenCalled();
    act(stop);
    expect(complete).toHaveBeenCalledTimes(1);
    const targetSeat = view.container.querySelector<HTMLElement>('[data-player-id="other"]')!;
    view.rerender(content(null, {
      askerId: 'asker', targetId: 'other', cardId: '4_d',
      seat: targetSeat, durationMs: 4000,
    }));
    expect(view.container.querySelectorAll('[data-creature="frog"][data-denial-role]')).toHaveLength(2);
    expect(view.queryByTestId('card-flight-card')).toBeNull();
    expect(view.getByTestId('ask-denied-animation').parentElement).toBe(targetSeat.parentElement);
    act(() => jest.advanceTimersByTime(80));
    act(stop);
    expect(view.container.querySelectorAll('[data-denial-role]')).toHaveLength(0);
    expect(complete).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(4000 - 81));
    expect(complete).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(1));
    expect(complete).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    jest.restoreAllMocks();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(window, key, descriptor);
      else Reflect.deleteProperty(window, key);
    }
    jest.useRealTimers();
  }
});

it('finds a clear side for the full-size denied card when both adjacent seats are occupied', () => {
  const seats = [0, 1, 2].map(index => (
    <div className="game-table-seat" key={index}>
      <div data-player-id={index}><span className="speech-avatar" /></div>
    </div>
  ));
  const table = (cue?: AskDeniedCueState) => <div className="game-table-space">
    {seats}
    {cue && <AskDeniedAnimation cue={cue} onComplete={jest.fn()} />}
  </div>;
  const view = render(table());
  const seat = view.container.querySelector<HTMLElement>('[data-player-id="1"]')!;
  const bounds = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const id = this.closest<HTMLElement>('[data-player-id]')?.dataset.playerId;
    if (id !== undefined) return new DOMRect(120 + Number(id) * 50, 20, 48, 44);
    if (this.classList.contains('game-table-space')) return new DOMRect(0, 0, 400, 84);
    return new DOMRect(0, 0, 48, 72);
  });
  try {
    view.rerender(table({ askerId: '0', targetId: '1', cardId: '4_d', seat, durationMs: 4000 }));
    const card = view.getByTestId('ask-denied-animation');
    const left = parseFloat(card.style.left);
    expect(left >= 268 || left + 48 <= 120).toBe(true);
  } finally {
    bounds.mockRestore();
    view.unmount();
  }
});
