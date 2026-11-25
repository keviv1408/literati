jest.mock('posthog-js', () => ({ __esModule: true, default: { capture: jest.fn() } }));

import posthog from 'posthog-js';
import type { CaptureResult } from 'posthog-js';
import { redactUrls, trackGameInit, trackGameOver, trackSocketDropped } from '@/lib/analytics';

const capture = posthog.capture as jest.Mock;

beforeEach(() => {
  capture.mockReset();
  localStorage.clear();
  jest.restoreAllMocks();
  process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
});

it('counts a game once, even when game_init arrives again after a reload', () => {
  trackGameInit('ABCDEF', 'active', 6);
  trackGameInit('ABCDEF', 'active', 6);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture).toHaveBeenCalledWith('game_started', { player_count: 6 });
});

it('ignores a game that is not active', () => {
  trackGameInit('ABCDEF', 'completed', 6);
  expect(capture).not.toHaveBeenCalled();
});

it('reports a finish only for a game it counted', () => {
  trackGameOver('ABCDEF');
  expect(capture).not.toHaveBeenCalled();
  trackGameInit('ABCDEF', 'active', 8);
  trackGameOver('ABCDEF');
  expect(capture).toHaveBeenLastCalledWith('game_finished', { player_count: 8 });
  trackGameOver('ABCDEF');
  expect(capture).toHaveBeenCalledTimes(2);
});

it('counts a rematch in the same room as a new game', () => {
  trackGameInit('ABCDEF', 'active', 6);
  trackGameOver('ABCDEF');
  trackGameInit('ABCDEF', 'active', 6);
  expect(capture.mock.calls.map((c) => c[0])).toEqual(['game_started', 'game_finished', 'game_started']);
});

it('reports a dropped socket with its close code', () => {
  trackSocketDropped(1006);
  expect(capture).toHaveBeenCalledWith('game_socket_dropped', { close_code: 1006 });
});

it('sends nothing without a key', () => {
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  trackGameInit('ABCDEF', 'active', 6);
  trackGameOver('ABCDEF');
  trackSocketDropped(1006);
  expect(capture).not.toHaveBeenCalled();
});

it('never throws when PostHog throws', () => {
  capture.mockImplementation(() => { throw new Error('blocked'); });
  expect(() => {
    trackGameInit('ABCDEF', 'active', 6);
    trackGameOver('ABCDEF');
    trackSocketDropped(1006);
  }).not.toThrow();
});

it('never throws when storage is unavailable', () => {
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  expect(() => {
    trackGameInit('ABCDEF', 'active', 6);
    trackGameOver('ABCDEF');
  }).not.toThrow();
});

describe('redactUrls', () => {
  const event = (over: Partial<CaptureResult>) =>
    ({ uuid: 'u', event: '$pageview', properties: {}, ...over }) as CaptureResult;

  it('strips the query string and hash from URL properties', () => {
    const out = redactUrls(event({
      properties: {
        $current_url: 'https://x.test/game/ABCDEF?spectatorToken=secret#top',
        $referrer: 'https://x.test/room/ABCDEF?spectate=1',
        player_count: 6,
      },
    }));
    expect(out?.properties).toEqual({
      $current_url: 'https://x.test/game/ABCDEF',
      $referrer: 'https://x.test/room/ABCDEF',
      player_count: 6,
    });
  });

  it('strips them from person properties too', () => {
    const out = redactUrls(event({
      $set: { $current_url: 'https://x.test/game/A?spectatorToken=s' },
      $set_once: { $initial_current_url: 'https://x.test/game/A?spectatorToken=s' },
    }));
    expect(out?.$set).toEqual({ $current_url: 'https://x.test/game/A' });
    expect(out?.$set_once).toEqual({ $initial_current_url: 'https://x.test/game/A' });
  });

  it('passes null through', () => {
    expect(redactUrls(null)).toBeNull();
  });
});
