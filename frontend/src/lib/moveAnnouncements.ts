/**
 * Browser speech-synthesis helpers for announcing the latest public move.
 *
 * Uses the built-in Web Speech API only — no external dependency required.
 */

function getSpeechSynthesis(): SpeechSynthesis | null {
  if (typeof window === 'undefined' || typeof window.speechSynthesis === 'undefined') {
    return null;
  }
  return window.speechSynthesis;
}

export function supportsMoveAnnouncements(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance !== 'undefined'
  );
}

function rankToWord(rank: string): string {
  switch (rank.toUpperCase()) {
    case 'A':
      return 'ace';
    case 'K':
      return 'king';
    case 'Q':
      return 'queen';
    case 'J':
      return 'jack';
    case '10':
      return 'ten';
    default:
      return rank;
  }
}

function suitToWord(symbol: string): string {
  switch (symbol) {
    case '♠':
      return 'spades';
    case '♥':
      return 'hearts';
    case '♦':
      return 'diamonds';
    case '♣':
      return 'clubs';
    default:
      return symbol;
  }
}

export function toSpokenMoveText(message: string): string {
  const withCardsExpanded = message.replace(
    /(^|[\s(])((?:A|K|Q|J|10|[2-9]))([♠♥♦♣])(?=$|[\s).,!?])/g,
    (_match, prefix: string, rank: string, suit: string) =>
      `${prefix}${rankToWord(rank)} of ${suitToWord(suit)}`,
  );

  const withPauseMarkers = withCardsExpanded
    .replace(/\s+—\s+/g, '. ')
    .replace(/\s+-\s+/g, '. ')
    .replace(/\bgot it\b/gi, 'got it.')
    .replace(/\bdenied\b/gi, 'denied.')
    .replace(/\bcorrect!\b/gi, 'correct.')
    .replace(/\bincorrect!\b/gi, 'incorrect.');

  const normalizedWhitespace = withPauseMarkers.replace(/\s+/g, ' ').trim();

  return /[.!?]$/.test(normalizedWhitespace)
    ? normalizedWhitespace
    : `${normalizedWhitespace}.`;
}

function pickVoice(utterance: SpeechSynthesisUtterance, speech: SpeechSynthesis): void {
  const voices = speech.getVoices();
  const preferredVoice =
    voices.find((voice) => /^en[-_]/i.test(voice.lang)) ||
    voices.find((voice) => voice.default) ||
    voices[0];

  if (preferredVoice) {
    utterance.voice = preferredVoice;
  }
}

export function cancelMoveAnnouncement(): void {
  const speech = getSpeechSynthesis();
  speech?.cancel();
}

export function speakMoveAnnouncement(message: string): void {
  const speech = getSpeechSynthesis();

  if (!speech || !supportsMoveAnnouncements()) return;

  const spokenText = toSpokenMoveText(message);
  const utterance = new window.SpeechSynthesisUtterance(spokenText);
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.volume = 1;
  pickVoice(utterance, speech);
  speech.cancel();
  speech.speak(utterance);
}
