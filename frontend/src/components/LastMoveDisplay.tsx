'use client';

/**
 * LastMoveDisplay
 *
 * A compact banner strip that shows the single most-recent game action.
 * Only one move is ever shown at a time (no running history log).
 *
 * Renders nothing when `message` is null / undefined.
 *
 * Accessibility:
 *   - `aria-live="polite"` so screen readers announce each new move
 *   - `aria-label="Last move"` for region identification
 *
 * Example messages produced by the backend:
 *   - "Alice asked Bob for 9♠ — denied"
 *   - "Alice asked Bob for 9♠ — got it"
 *   - "Charlie declared Low Spades — correct! Team 2 scores"
 *   - "Charlie declared High Hearts — incorrect! Team 1 scores"
 */

import type { GamePlayer } from '@/types/game';

interface LastMoveDisplayProps {
  /** The human-readable last-move string from the server, or null when none. */
  message: string | null | undefined;
  /** Current room players so names can be color-coded by team. */
  players?: GamePlayer[];
  /** Current viewer's playerId (for "my team = green, opponent = purple"). */
  myPlayerId?: string | null;
  /** data-testid for automated tests. Defaults to "last-move-display". */
  testId?: string;
}

function teamNameClass(teamId?: 1 | 2, myTeamId?: 1 | 2 | null): string {
  if (!teamId) return 'text-slate-800 font-semibold';
  if (myTeamId) {
    return teamId === myTeamId
      ? 'text-emerald-700 font-semibold'
      : 'text-violet-700 font-semibold';
  }
  return teamId === 1
    ? 'text-emerald-700 font-semibold'
    : 'text-violet-700 font-semibold';
}

function suitClassFromSymbol(symbol: string): string {
  return symbol === '♥' || symbol === '♦'
    ? 'text-red-600 font-semibold'
    : 'text-slate-900 font-semibold';
}

function suitClassFromWord(word: string): string {
  const normalized = word.toLowerCase();
  return normalized === 'hearts' || normalized === 'diamonds'
    ? 'text-red-600 font-semibold'
    : 'text-slate-900 font-semibold';
}

function renderCardToken(cardToken: string) {
  const suit = cardToken.slice(-1);
  if (!['♠', '♥', '♦', '♣'].includes(suit)) {
    return <span className="font-semibold text-slate-900">{cardToken}</span>;
  }
  return <span className={suitClassFromSymbol(suit)}>{cardToken}</span>;
}

function renderCardText(text: string) {
  const parts = text.split(/((?:A|K|Q|J|10|[2-9])[♠♥♦♣])/g);
  return parts.map((part, index) => {
    if (!part) return null;
    if (/^(?:A|K|Q|J|10|[2-9])[♠♥♦♣]$/.test(part)) {
      return <span key={`${part}-${index}`}>{renderCardToken(part)}</span>;
    }
    return <span key={`${part}-${index}`}>{part}</span>;
  });
}

function renderHalfSuitLabel(label: string) {
  const m = label.match(/^(Low|High)\s+(Spades|Hearts|Diamonds|Clubs)$/i);
  if (!m) return <span className="font-semibold text-slate-900">{label}</span>;
  const [, tier, suitWord] = m;
  return (
    <>
      <span className="font-semibold text-slate-800">{tier}</span>{' '}
      <span className={suitClassFromWord(suitWord)}>{suitWord}</span>
    </>
  );
}

function renderTeamScoreText(teamScoreText: string, myTeamId?: 1 | 2 | null) {
  const m = teamScoreText.match(/^Team ([12]) scores$/);
  if (!m) return <span className="font-semibold text-slate-800">{teamScoreText}</span>;
  const teamId = Number(m[1]) as 1 | 2;
  return <span className={teamNameClass(teamId, myTeamId)}>{teamScoreText}</span>;
}

function renderName(name: string, nameToTeam: Map<string, 1 | 2>, myTeamId?: 1 | 2 | null) {
  return <span className={teamNameClass(nameToTeam.get(name), myTeamId)}>{name}</span>;
}

function renderStyledMessage(
  message: string,
  nameToTeam: Map<string, 1 | 2>,
  myTeamId?: 1 | 2 | null
) {
  const askMixedMatch = message.match(/^(.*?) asked (.*?) for (.*?) — got (.*?); denied (.*?)$/);
  if (askMixedMatch) {
    const [, asker, target, requestedCards, gotCards, deniedCards] = askMixedMatch;
    return (
      <>
        {renderName(asker, nameToTeam, myTeamId)}
        <span className="text-slate-700"> asked </span>
        {renderName(target, nameToTeam, myTeamId)}
        <span className="text-slate-700"> for </span>
        {renderCardText(requestedCards)}
        <span className="text-slate-600"> — </span>
        <span className="text-emerald-700 font-semibold">got </span>
        {renderCardText(gotCards)}
        <span className="text-slate-600">; </span>
        <span className="text-rose-700 font-semibold">denied </span>
        {renderCardText(deniedCards)}
      </>
    );
  }

  const askMatch = message.match(/^(.*?) asked (.*?) for (.*?) — (got it|got them|denied)$/);
  if (askMatch) {
    const [, asker, target, requestedCards, outcome] = askMatch;
    const outcomeClass = outcome === 'got it' || outcome === 'got them'
      ? 'text-emerald-700 font-semibold'
      : 'text-rose-700 font-semibold';
    return (
      <>
        {renderName(asker, nameToTeam, myTeamId)}
        <span className="text-slate-700"> asked </span>
        {renderName(target, nameToTeam, myTeamId)}
        <span className="text-slate-700"> for </span>
        {renderCardText(requestedCards)}
        <span className="text-slate-600"> — </span>
        <span className={outcomeClass}>{outcome}</span>
      </>
    );
  }

  const askPreviewMatch = message.match(/^(.*?) asked (.*?) for (.*?)$/);
  if (askPreviewMatch) {
    const [, asker, target, requestedCards] = askPreviewMatch;
    return (
      <>
        {renderName(asker, nameToTeam, myTeamId)}
        <span className="text-slate-700"> asked </span>
        {renderName(target, nameToTeam, myTeamId)}
        <span className="text-slate-700"> for </span>
        {renderCardText(requestedCards)}
      </>
    );
  }

  const declareMatch = message.match(/^(.*?) declared (.*?) — (correct!|incorrect!) (Team [12] scores)$/);
  if (declareMatch) {
    const [, declarer, halfSuitText, verdict, teamScore] = declareMatch;
    const verdictClass = verdict.toLowerCase().startsWith('correct')
      ? 'text-emerald-700 font-semibold'
      : 'text-rose-700 font-semibold';
    return (
      <>
        {renderName(declarer, nameToTeam, myTeamId)}
        <span className="text-slate-700"> declared </span>
        {renderHalfSuitLabel(halfSuitText)}
        <span className="text-slate-600"> — </span>
        <span className={verdictClass}>{verdict}</span>
        <span className="text-slate-700"> </span>
        {renderTeamScoreText(teamScore, myTeamId)}
      </>
    );
  }

  const timeoutDeclMatch = message.match(/^(.*?) ran out of time declaring (.*?) — (Team [12] scores)$/);
  if (timeoutDeclMatch) {
    const [, declarer, halfSuitText, teamScore] = timeoutDeclMatch;
    return (
      <>
        {renderName(declarer, nameToTeam, myTeamId)}
        <span className="text-slate-700"> ran out of time declaring </span>
        {renderHalfSuitLabel(halfSuitText)}
        <span className="text-slate-600"> — </span>
        {renderTeamScoreText(teamScore, myTeamId)}
      </>
    );
  }

  return message;
}

export default function LastMoveDisplay({
  message,
  players,
  myPlayerId = null,
  testId = 'last-move-display',
}: LastMoveDisplayProps) {
  if (!message) return null;

  const nameToTeam = new Map<string, 1 | 2>();
  for (const player of players ?? []) {
    nameToTeam.set(player.displayName, player.teamId);
  }
  const myTeamId =
    myPlayerId
      ? (players ?? []).find((player) => player.playerId === myPlayerId)?.teamId ?? null
      : null;

  return (
    <div
      className="relative z-10 flex items-center justify-center px-4 py-3 bg-slate-100/95 border-b border-slate-300/90 text-base sm:text-lg md:text-xl leading-tight text-slate-800 font-medium shadow-sm"
      aria-live="polite"
      aria-label="Last move"
      data-testid={testId}
    >
      <span className="text-center">
        {renderStyledMessage(message, nameToTeam, myTeamId)}
      </span>
    </div>
  );
}
