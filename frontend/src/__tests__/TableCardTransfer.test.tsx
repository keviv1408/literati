import React from 'react';
import { act, render } from '@testing-library/react';
import TableCardTransfer from '@/components/creatures/TableCardTransfer';
import { createRetrievalScene } from '@/components/creatures/retrievalScene';
import { FLIGHT_DURATION_MS } from '@/components/CardFlightAnimation';
import type { AskDeniedCueState, CardFlightState } from '@/hooks/useAskResultAnimations';

jest.mock('@/components/creatures/retrievalScene', () => ({ createRetrievalScene: jest.fn() }));

it('lets the active creature finish and cancels the previous grab without clearing the next card', async () => {
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
  const content = (flight: CardFlightState | null, denial?: AskDeniedCueState) => <div>
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
    view.rerender(content(null, {
      askerId: 'asker', targetId: 'other', cardId: '4_d',
      seatLeft: 0, seatTop: 0, seatWidth: 48, seatHeight: 48,
    }));
    expect(view.container.querySelectorAll('[data-creature="frog"][data-denial-role]')).toHaveLength(2);
    expect(view.queryByTestId('card-flight-card')).toBeNull();
    act(stop);
    expect(view.container.querySelectorAll('[data-denial-role]')).toHaveLength(0);
    expect(complete).toHaveBeenCalledTimes(1);
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
