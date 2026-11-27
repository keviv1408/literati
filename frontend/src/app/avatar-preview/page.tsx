'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import AskSpeechBubbleOverlay from '@/components/AskSpeechBubbleOverlay';
import Avatar from '@/components/Avatar';
import CircularGameTable from '@/components/CircularGameTable';
import DeclaredBooksTable from '@/components/DeclaredBooksTable';
import { TableScore } from '@/components/GameHeader';
import { CREATURE_NAMES } from '@/components/creatures/kind';
import TableCardTransfer from '@/components/creatures/TableCardTransfer';
import { VoiceProvider } from '@/contexts/VoiceContext';
import { useAskResultAnimations } from '@/hooks/useAskResultAnimations';
import { applyStep, type Step, type TableState } from '@/lib/tutorial/engine';
import { PRACTICE_DEAL } from '@/lib/tutorial/quickTurn';
import { PLAYERS } from '@/lib/tutorial/script';
import { askPayloadFor, toGamePlayers } from '@/lib/tutorial/table';
import { cardLabel, type AskResultPayload, type CardId } from '@/types/game';
import { AVATAR_IDS, getAvatarCreature } from '@/utils/avatar';
import styles from './page.module.css';

const DEAL: TableState = {
  ...PRACTICE_DEAL,
  turn: 'maya',
  hands: { ...PRACTICE_DEAL.hands, you: ['1_d', '8_c', '5_d', '12_s'], ana: ['2_d', '3_d', '11_c'] },
};

const OPTIONS = AVATAR_IDS.map(id => ({ id, name: CREATURE_NAMES[getAvatarCreature(id, '')] }));
type Frame = { table: TableState; result: AskResultPayload };

function _name(id: string) {
  return PLAYERS.find(player => player.id === id)?.name;
}

function AnimalSelect({ label, player, avatar, disabled, onChange }: {
  label: string; player: string; avatar: string; disabled: boolean; onChange: (id: string) => void;
}) {
  return (
    <label className={styles.picker}>
      <span className={styles.portrait} aria-hidden="true"><Avatar avatarId={avatar} displayName={player} size="sm" /></span>
      <span className={styles.pickerLabel}>{label} · {player}</span>
      <select aria-label={label} value={avatar} disabled={disabled} onChange={event => onChange(event.target.value)}>
        {OPTIONS.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
      </select>
    </label>
  );
}

export default function AvatarPreviewPage() {
  const [asker, setAsker] = useState('avatar-3');
  const [opponent, setOpponent] = useState('avatar-6');
  const [round, setRound] = useState<{ frames: Frame[]; index: number }>({ frames: [], index: 0 });
  const active = round.frames[round.index]?.result ?? null;
  const frame = round.frames[Math.min(round.index, round.frames.length - 1)];
  const table = frame?.table ?? DEAL;
  const finishAskAnimation = useCallback((result: AskResultPayload) => {
    setRound(current => current.frames[current.index]?.result === result
      ? { ...current, index: current.index + 1 } : current);
  }, []);
  const { cardFlight, clearAskAnimation, askDeniedCue, askSpeechBubble } =
    useAskResultAnimations(frame?.result ?? null, {
      getPlayerDisplayName: _name, nextAskAnimation: active, finishAskAnimation,
    });
  const players = toGamePlayers(table).map(player => ({
    ...player,
    avatarId: player.playerId === 'maya' ? asker : player.playerId === 'ana' ? opponent : player.avatarId,
  }));

  function _play(cards: CardId[]) {
    let before = DEAL;
    const frames = cards.map(card => {
      const step: Step = { kind: 'ask', asker: 'maya', target: 'ana', card, text: '' };
      const result = askPayloadFor(step, before)!;
      if (cards.length > 1) result.batchCardIds = cards;
      before = applyStep(before, step, PLAYERS);
      return { result, table: before };
    });
    setRound({ frames, index: 0 });
  }

  const result = frame?.result;
  const message = result ? result.success ? `Maya collected ${cardLabel(result.cardId)} from Ana.`
    : `Ana doesn't have the ${cardLabel(result.cardId)}.` : 'Choose an ask to play.';
  return (
    <VoiceProvider roomCode={null} bearerToken={null} isGuest canJoin={false}>
      <main className={styles.preview}>
        <header className={styles.header}>
          <Link className={styles.back} href="/" aria-label="Back to Literati">←</Link>
          <h1>Avatar preview</h1>
          <TableScore scores={table.scores} myTeamId={1} />
        </header>
        <div className={`game-table-space ${styles.table}`}>
          <CircularGameTable players={players} myPlayerId="you" playerCount={6}
            currentTurnPlayerId={active?.askerId ?? table.turn} indicatorActive={false}>
            <DeclaredBooksTable declaredSuits={table.declared} playerCount={6} />
          </CircularGameTable>
          <TableCardTransfer denial={askDeniedCue} flight={cardFlight} onComplete={clearAskAnimation} />
        </div>
        <footer className={styles.controls}>
          <div className={styles.tools}>
            <div className={styles.pickers}>
              <AnimalSelect label="Asker" player="Maya" avatar={asker} onChange={setAsker} disabled={!!active} />
              <AnimalSelect label="Opponent" player="Ana" avatar={opponent} onChange={setOpponent} disabled={!!active} />
            </div>
            <div className={styles.actions} role="group" aria-label="Play an ask">
              <button type="button" disabled={!!active} onClick={() => _play(['2_d'])}>Successful ask</button>
              <button type="button" disabled={!!active} onClick={() => _play(['4_d'])}>Denied ask</button>
              <button type="button" disabled={!!active} onClick={() => _play(['2_d', '3_d', '4_d'])}>Three-card ask</button>
            </div>
          </div>
          <p role="status">
            {round.frames.length > 1 && `${Math.min(round.index + 1, round.frames.length)} of ${round.frames.length} · `}
            {message}
          </p>
        </footer>
        {askSpeechBubble && <AskSpeechBubbleOverlay bubble={askSpeechBubble} />}
      </main>
    </VoiceProvider>
  );
}
