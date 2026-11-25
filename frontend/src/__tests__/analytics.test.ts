jest.mock('posthog-js', () => ({
  __esModule: true,
  default: { capture: jest.fn(), captureException: jest.fn() },
}));

import posthog from 'posthog-js';
import type { CaptureResult } from 'posthog-js';
import {
  redactUrls,
  reportPendingSocketDrop,
  trackEvent,
  trackException,
  trackGameInit,
  trackGameOver,
  trackSocketDropped,
  trackSocketRecovered,
} from '@/lib/analytics';

const capture = posthog.capture as jest.Mock;
const captureException = posthog.captureException as jest.Mock;
const DROP_KEY = 'literati:socket-dropped';

beforeEach(() => {
  capture.mockReset();
  captureException.mockReset();
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

it('forgets a counted game once it is no longer active', () => {
  trackGameInit('ABCDEF', 'active', 6);
  trackGameInit('ABCDEF', 'completed', 6);
  trackGameOver('ABCDEF');
  expect(capture.mock.calls.map((c) => c[0])).toEqual(['game_started']);
  trackGameInit('ABCDEF', 'active', 8);
  expect(capture).toHaveBeenCalledTimes(2);
  expect(capture).toHaveBeenLastCalledWith('game_started', { player_count: 8 });
});

it('stores a closed socket and reports it with how it was detected', () => {
  trackSocketDropped({ closeCode: 1006, detectedBy: 'close' });
  expect(capture).not.toHaveBeenCalled();
  expect(localStorage.getItem(DROP_KEY)).toBe('{"close_code":1006,"detected_by":"close"}');
  reportPendingSocketDrop();
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture).toHaveBeenCalledWith('game_socket_dropped', { close_code: 1006, detected_by: 'close' });
  expect(localStorage.getItem(DROP_KEY)).toBeNull();
});

it('reports a heartbeat drop without a close code', () => {
  trackSocketDropped({ closeCode: null, detectedBy: 'heartbeat' });
  expect(localStorage.getItem(DROP_KEY)).toBe('{"detected_by":"heartbeat"}');
  reportPendingSocketDrop();
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture.mock.calls[0][0]).toBe('game_socket_dropped');
  expect(capture.mock.calls[0][1]).toStrictEqual({ detected_by: 'heartbeat' });
});

it('reads a bare close code stored by an older build as a close drop', () => {
  localStorage.setItem(DROP_KEY, '1006');
  reportPendingSocketDrop();
  expect(capture).toHaveBeenCalledWith('game_socket_dropped', { close_code: 1006, detected_by: 'close' });
});

it('sends only the checked fields of a stored drop', () => {
  localStorage.setItem(DROP_KEY, '{"close_code":1006,"detected_by":"close","token":"x"}');
  reportPendingSocketDrop();
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture.mock.calls[0][1]).toStrictEqual({ close_code: 1006, detected_by: 'close' });
});

it.each([
  'nope',
  '{"detected_by":"bogus"}',
  '{"close_code":"1006","detected_by":"close"}',
])('drops a stored value it cannot read: %s', (stored) => {
  localStorage.setItem(DROP_KEY, stored);
  reportPendingSocketDrop();
  expect(capture).not.toHaveBeenCalled();
  expect(localStorage.getItem(DROP_KEY)).toBeNull();
});

it('reports a stored drop once', () => {
  trackSocketDropped({ closeCode: 1006, detectedBy: 'close' });
  reportPendingSocketDrop();
  reportPendingSocketDrop();
  expect(capture).toHaveBeenCalledTimes(1);
});

it('reports a recovery in whole seconds with how the drop was detected', () => {
  trackSocketRecovered(3.4, 'close');
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture).toHaveBeenCalledWith('game_socket_recovered', { seconds_down: 3, detected_by: 'close' });
});

it('reports no socket drop when none was stored', () => {
  reportPendingSocketDrop();
  expect(capture).not.toHaveBeenCalled();
});

it('sends a named event with its properties', () => {
  trackEvent('rematch_vote_submitted', { vote: 'yes' });
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture).toHaveBeenCalledWith('rematch_vote_submitted', { vote: 'yes' });
});

it('reports an exception', () => {
  const error = new Error('boom');
  trackException(error);
  expect(captureException).toHaveBeenCalledTimes(1);
  expect(captureException).toHaveBeenCalledWith(error);
});

it('sends nothing without a key', () => {
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  trackEvent('rematch_vote_submitted', { vote: 'yes' });
  trackException(new Error('boom'));
  trackGameInit('ABCDEF', 'active', 6);
  trackGameOver('ABCDEF');
  trackSocketDropped({ closeCode: 1006, detectedBy: 'close' });
  reportPendingSocketDrop();
  trackSocketRecovered(3.4, 'close');
  expect(capture).not.toHaveBeenCalled();
  expect(captureException).not.toHaveBeenCalled();
  expect(localStorage.getItem(DROP_KEY)).toBeNull();
});

it('never throws when PostHog throws', () => {
  capture.mockImplementation(() => { throw new Error('blocked'); });
  captureException.mockImplementation(() => { throw new Error('blocked'); });
  expect(() => {
    trackEvent('rematch_vote_submitted', { vote: 'yes' });
    trackException(new Error('boom'));
    trackGameInit('ABCDEF', 'active', 6);
    trackGameOver('ABCDEF');
    trackSocketDropped({ closeCode: 1006, detectedBy: 'close' });
    reportPendingSocketDrop();
    trackSocketRecovered(3.4, 'close');
  }).not.toThrow();
});

it('never throws when storage is unavailable', () => {
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  expect(() => {
    trackGameInit('ABCDEF', 'active', 6);
    trackGameOver('ABCDEF');
    trackSocketDropped({ closeCode: 1006, detectedBy: 'close' });
    reportPendingSocketDrop();
  }).not.toThrow();
  expect(capture).not.toHaveBeenCalled();
});

it('sends nothing when only storage writes fail', () => {
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  expect(() => {
    trackGameInit('ABCDEF', 'active', 6);
    trackSocketDropped({ closeCode: 1006, detectedBy: 'close' });
    reportPendingSocketDrop();
  }).not.toThrow();
  expect(capture).not.toHaveBeenCalled();
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

  it('strips them from nested exception stack frames', () => {
    const out = redactUrls(event({
      properties: {
        $exception_list: [{
          stacktrace: {
            frames: [{ filename: 'https://x.test/game/A?spectatorToken=s', lineno: 3, function: 'f' }],
          },
        }],
      },
    }));
    expect(out?.properties.$exception_list[0].stacktrace.frames[0]).toEqual({
      filename: 'https://x.test/game/A',
      lineno: 3,
      function: 'f',
    });
  });

  it('strips them from URLs inside free text', () => {
    const out = redactUrls(event({
      properties: {
        $exception_list: [{
          value: "Failed to construct 'WebSocket': The URL 'wss://api.x.test/ws/game/A?token=t&spectatorToken=s' is invalid.",
        }],
      },
    }));
    expect(out?.properties.$exception_list[0].value).toBe(
      "Failed to construct 'WebSocket': The URL 'wss://api.x.test/ws/game/A' is invalid.",
    );
  });

  it('leaves text with ? and # but no URL alone', () => {
    const out = redactUrls(event({ properties: { message: 'Why? Because #1' } }));
    expect(out?.properties.message).toBe('Why? Because #1');
  });

  it('handles a long run of scheme characters before :// quickly', () => {
    const message = `${'a'.repeat(50_000)}://${'b'.repeat(50_000)}`;
    const start = performance.now();
    const out = redactUrls(event({ properties: { message } }));
    expect(performance.now() - start).toBeLessThan(500);
    expect(out?.properties.message).toBe(message);
  });

  it('matches URL keys in any case', () => {
    const out = redactUrls(event({
      $set_once: { $Initial_Current_URL: 'https://x.test/game/A?spectatorToken=s' },
    }));
    expect(out?.$set_once).toEqual({ $Initial_Current_URL: 'https://x.test/game/A' });
  });

  it('passes null through', () => {
    expect(redactUrls(null)).toBeNull();
  });
});
