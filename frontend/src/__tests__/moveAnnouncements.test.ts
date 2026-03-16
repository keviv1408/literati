/**
 * @jest-environment jsdom
 */

import {
  cancelMoveAnnouncement,
  speakMoveAnnouncement,
  toSpokenMoveText,
} from '@/lib/moveAnnouncements';

describe('moveAnnouncements', () => {
  const cancel = jest.fn();
  const speak = jest.fn();
  const getVoices = jest.fn(() => [{ lang: 'en-US', default: true }]);

  beforeEach(() => {
    window.localStorage.clear();
    cancel.mockClear();
    speak.mockClear();
    getVoices.mockClear();

    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { cancel, speak, getVoices },
    });

    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: class SpeechSynthesisUtteranceMock {
        text: string;
        rate = 1;
        pitch = 1;
        volume = 1;
        voice: unknown = null;

        constructor(text: string) {
          this.text = text;
        }
      },
    });
  });

  it('expands card symbols into speech-friendly text', () => {
    expect(toSpokenMoveText('Viv asked vv for Q♥ — denied')).toBe(
      'Viv asked vv for queen of hearts. denied.',
    );
    expect(toSpokenMoveText('vv asked Eager Thompson for K♠ — got it')).toBe(
      'vv asked Eager Thompson for king of spades. got it.',
    );
  });

  it('uses speech synthesis to announce the move', () => {
    speakMoveAnnouncement('Dreamy Shannon asked Viv for A♦ — denied');

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0].text).toBe(
      'Dreamy Shannon asked Viv for ace of diamonds. denied.',
    );
  });

  it('cancels any in-flight announcement', () => {
    cancelMoveAnnouncement();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
