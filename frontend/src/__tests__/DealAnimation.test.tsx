import { act, render, screen } from '@testing-library/react';
import CircularGameTable from '@/components/CircularGameTable';
import { queueOpeningDeal, takeOpeningDeal } from '@/lib/openingDeal';
import type { GamePlayer } from '@/types/game';

jest.mock('@/contexts/VoiceContext', () => ({ useVoice: () => ({ getSeatState: () => null }) }));
jest.mock('@/components/GamePlayerSeat', () => () => null);

it.each([6, 8] as const)('deals all 48 cards clockwise into the rotated %i seats in under 1.6 seconds', count => {
  jest.useFakeTimers();
  const players = Array.from({ length: count }, (_, i) => ({ playerId: String(i), seatIndex: i })) as GamePlayer[];
  const finish = jest.fn();
  const { unmount } = render(<CircularGameTable players={players} myPlayerId="2" playerCount={count}
    currentTurnPlayerId="2" indicatorActive onOpeningDealComplete={finish} />);
  const overlay = screen.getByTestId('deal-animation');
  expect(overlay.parentElement).toBe(screen.getByTestId('circular-game-table'));
  const cards = [...overlay.querySelectorAll<HTMLElement>('[data-deal-seat]')];
  expect(cards).toHaveLength(48);
  expect(cards.map(card => Number(card.dataset.dealSeat))).toEqual(
    Array.from({ length: 48 }, (_, i) => (2 - i % count + count) % count),
  );
  expect(parseFloat(cards[0].style.getPropertyValue('--dy'))).toBeGreaterThan(0);
  expect(parseFloat(cards[1].style.getPropertyValue('--dx'))).toBeLessThan(0);
  act(() => jest.advanceTimersByTime(1500));
  expect(finish).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(100));
  expect(finish).toHaveBeenCalledTimes(1);
  unmount();
  jest.useRealTimers();
});

it('requires a fresh start from the same lobby for each opening deal', () => {
  expect(takeOpeningDeal('HOTEL')).toBe(false);
  queueOpeningDeal('HOTEL');
  expect(takeOpeningDeal('OTHER')).toBe(false);
  queueOpeningDeal('HOTEL');
  expect(takeOpeningDeal('HOTEL')).toBe(true);
  expect(takeOpeningDeal('HOTEL')).toBe(false);
  queueOpeningDeal('HOTEL');
  expect(takeOpeningDeal('HOTEL')).toBe(true);
});
