'use client';

import { useEffect, useEffectEvent, useState } from 'react';
import type { AskSpeechBubbleState } from '@/components/AskSpeechBubbleOverlay';
import { getPlayerSeatElement } from '@/hooks/useAskResultAnimations';
import type { AskResultPayload, DeclarationResultPayload, GamePlayer } from '@/types/game';
import { hashString } from '@/utils/avatar';

export const ASK_REPLY_DELAY_MS = 1400;
export const REACTION_BUBBLE_MS = 1200;
const GIVEN_LINES = [
  'ggwp. All yours.',
  'wtfff, how did you know?',
  'Can I pay in snacks?',
  'Fine. Take good care of it.',
  'god dayum. Here you go.',
  'Is my hand face up?',
  'I want visitation rights.',
  'There goes my whole plan.',
  'Do I get a receipt?',
];
const DENIED_LINES = [
  'Wrong number, bestie.',
  'Go fish. Wait, wrong game.',
  'Check my sleeves too?',
  'Nope. Love the confidence.',
  'My lawyer says no.',
  'Fresh out of those.',
  'All vibes, no cards.',
  'All that suspense for a nope.',
  'Got any other theories?',
];
const DECLARED_LINES = ['Declared! 🎉', 'Nailed it 🎯', 'Called it 🙌', 'Half-suit secured 🔥'];

// Keyed on the event so every client shows the same line.
function pickLine(lines: readonly string[], key: string): string {
  return lines[hashString(key) % lines.length];
}

function _askReply(move: AskResultPayload, players: readonly GamePlayer[]): string {
  const lines = move.success ? GIVEN_LINES : DENIED_LINES;
  const key = `${move.askerId}|${move.targetId}|${move.cardId}`;
  const line = lines[hashString(key) % (lines.length + 1)];
  if (line) return line;

  const asker = players.find(player => player.playerId === move.askerId);
  const alternatives = players.filter(player =>
    asker && player.teamId !== asker.teamId && player.playerId !== move.targetId &&
    player.cardCount > 0 && !player.isEliminated,
  ).sort((a, b) => a.seatIndex - b.seatIndex);
  if (!alternatives.length) return pickLine(lines, key);
  const other = alternatives[hashString(key) % alternatives.length];
  return `You can ask ${other.displayName} too, y’know.`;
}

export function useReactionBubble(
  lastAskResult: AskResultPayload | null,
  lastDeclareResult: DeclarationResultPayload | null,
  players: readonly GamePlayer[],
): AskSpeechBubbleState | null {
  const move = lastAskResult ?? lastDeclareResult;
  const askReply = useEffectEvent((ask: AskResultPayload) => _askReply(ask, players));
  const [shown, setShown] = useState<{ move: typeof move; bubble: AskSpeechBubbleState } | null>(null);

  useEffect(() => {
    if (!move) return;
    const isAsk = move.type === 'ask_result';
    if (!isAsk && (!move.correct || move.timedOut)) return;
    const playerId = isAsk ? move.targetId : move.declarerId;
    const delay = isAsk ? ASK_REPLY_DELAY_MS : 0;
    const showTimer = setTimeout(() => {
      const seat = getPlayerSeatElement(playerId);
      if (!seat) return;
      const bubble: AskSpeechBubbleState = isAsk
        ? { seat, variant: move.success ? 'given' : 'denied', text: askReply(move) }
        : { seat, variant: 'declared', text: pickLine(DECLARED_LINES, `${playerId}|${move.halfSuitId}`) };
      setShown({ move, bubble });
    }, delay);
    const hideTimer = setTimeout(() => setShown(null), delay + REACTION_BUBBLE_MS);
    return () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
    };
  }, [move]);

  return shown && shown.move === move ? shown.bubble : null;
}
