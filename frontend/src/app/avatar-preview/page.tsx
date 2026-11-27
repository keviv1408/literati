'use client';

import Link from 'next/link';
import { useState } from 'react';
import AskSpeechBubbleOverlay from '@/components/AskSpeechBubbleOverlay';
import CircularGameTable from '@/components/CircularGameTable';
import DeclaredBooksTable from '@/components/DeclaredBooksTable';
import { TableScore } from '@/components/GameHeader';
import TableCardTransfer from '@/components/creatures/TableCardTransfer';
import { VoiceProvider } from '@/contexts/VoiceContext';
import { useAskResultAnimations } from '@/hooks/useAskResultAnimations';
import { applyStep, type Step, type TableState } from '@/lib/tutorial/engine';
import { PRACTICE_DEAL } from '@/lib/tutorial/quickTurn';
import { PLAYERS } from '@/lib/tutorial/script';
import { askPayloadFor, toGamePlayers } from '@/lib/tutorial/table';
import { cardLabel, type AskResultPayload } from '@/types/game';
import styles from './page.module.css';

const EXAMPLES = [
  { label: 'Frog', avatarId: 'avatar-3', asker: 'maya', target: 'ana', card: '2_d' },
  { label: 'Octopus', avatarId: 'avatar-4', asker: 'lin', target: 'raj', card: '9_c' },
  { label: 'Butterfly', avatarId: 'avatar-12', asker: 'omar', target: 'you', card: '12_s' },
] as const;

const OPPONENT_AVATARS: Record<string, string> = { you: 'avatar-1', raj: 'avatar-2', ana: 'avatar-5' };

type Example = (typeof EXAMPLES)[number];
type Round = { table: TableState; result: AskResultPayload | null; message: string };

function _name(id: string) {
  return PLAYERS.find(player => player.id === id)?.name;
}

export default function AvatarPreviewPage() {
  const [round, setRound] = useState<Round>({
    table: PRACTICE_DEAL,
    result: null,
    message: 'Choose an avatar to collect a card.',
  });
  const players = toGamePlayers(round.table).map(player => ({
    ...player,
    avatarId: EXAMPLES.find(example => example.asker === player.playerId)?.avatarId
      ?? OPPONENT_AVATARS[player.playerId],
  }));
  const { cardFlight, clearCardFlight, askSpeechBubble } = useAskResultAnimations(round.result, {
    getPlayerDisplayName: _name,
  });

  function _play({ asker, target, card }: Example) {
    const message = `${_name(asker)} collected ${cardLabel(card)} from ${target === 'you' ? 'you' : _name(target)}.`;
    const ask: Step = { kind: 'ask', asker, target, card, text: message };
    const before = { ...PRACTICE_DEAL, turn: asker };
    setRound({ table: applyStep(before, ask, PLAYERS), result: askPayloadFor(ask, before), message });
  }

  return (
    <VoiceProvider roomCode={null} bearerToken={null} isGuest canJoin={false}>
      <main className={styles.preview}>
        <header className={styles.header}>
          <Link className={styles.back} href="/" aria-label="Back to Literati">←</Link>
          <h1>Avatar preview</h1>
          <TableScore scores={round.table.scores} myTeamId={1} />
        </header>
        <div className={`game-table-space ${styles.table}`}>
          <CircularGameTable players={players} myPlayerId="you" playerCount={6}
            currentTurnPlayerId={round.result?.askerId ?? null} indicatorActive={false}>
            <DeclaredBooksTable declaredSuits={round.table.declared} playerCount={6} />
          </CircularGameTable>
          <TableCardTransfer flight={cardFlight} onComplete={clearCardFlight} />
        </div>
        <footer className={styles.controls}>
          <div className={styles.examples} role="group" aria-label="Play a successful ask">
            {EXAMPLES.map(example => (
              <button type="button" key={example.asker} onClick={() => _play(example)}
                aria-label={example.label} aria-describedby={`ask-${example.asker}`}
                data-active={round.result?.askerId === example.asker}>
                <span className={styles.card} data-red={example.card.endsWith('_d')} aria-hidden="true">
                  {cardLabel(example.card)}
                </span>
                <span className={styles.labels}>
                  <strong>{example.label}</strong>
                  <small id={`ask-${example.asker}`}>
                    {_name(example.asker)}<span className="sr-only"> asks for {cardLabel(example.card)}.</span>
                  </small>
                </span>
              </button>
            ))}
          </div>
          <p role="status">{round.message}</p>
        </footer>
        {askSpeechBubble && <AskSpeechBubbleOverlay bubble={askSpeechBubble} />}
      </main>
    </VoiceProvider>
  );
}
