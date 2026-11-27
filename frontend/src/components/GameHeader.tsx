'use client';

import { useEffect, useRef, useState, type ComponentProps } from 'react';
import type { GameWsStatus } from '@/hooks/useGameSocket';
import type { PublicGameState } from '@/types/game';
import KnowledgePanel from './KnowledgePanel';
import MuteToggle from './MuteToggle';

interface GameHeaderProps {
  gameState: PublicGameState | null;
  myTeamId: 1 | 2 | null;
  wsStatus: GameWsStatus;
  muted: boolean;
  onToggleMute: () => void;
  onGoHome: () => void;
  onBotSpeed: (delayMs: number) => void;
  knowledge: Omit<ComponentProps<typeof KnowledgePanel>, 'onClose'>;
}

const CONNECTION_LABELS: Record<GameWsStatus, string> = {
  idle: 'Waiting',
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
  error: 'Connection error',
};

export function TableScore({ scores, myTeamId }: {
  scores?: PublicGameState['scores'];
  myTeamId: 1 | 2 | null;
}) {
  const visible = myTeamId ? scores : undefined;
  const ours = myTeamId === 2 ? visible?.team2 : visible?.team1;
  const theirs = myTeamId === 2 ? visible?.team1 : visible?.team2;
  return (
    <div className="header-score" role="status" aria-label="Score" data-testid="game-score" data-team={myTeamId}>
      <span>Us</span> <strong>{ours ?? '–'}</strong>
      <span className="score-divider" aria-hidden="true">·</span>
      <strong>{theirs ?? '–'}</strong> <span>Them</span>
    </div>
  );
}

export default function GameHeader({
  gameState, myTeamId, wsStatus, muted, onToggleMute, onGoHome, onBotSpeed, knowledge,
}: GameHeaderProps) {
  const [panel, setPanel] = useState<'controls' | 'knowledge' | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const connected = wsStatus === 'connected';
  const status = CONNECTION_LABELS[wsStatus];
  const delay = gameState?.botDelayMs ?? 5000;
  function closePanel() {
    setPanel(null);
    trigger.current?.focus();
  }

  useEffect(() => {
    if (!panel) return;
    function dismissOutside(event: PointerEvent) {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) setPanel(null);
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') closePanel();
    }
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [panel]);

  return (
    <header className="player-header">
      <button type="button" onClick={onGoHome} aria-label="Home" className="header-button">←</button>
      <TableScore scores={gameState?.scores} myTeamId={myTeamId} />
      <div className="header-menu" ref={menu} onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setPanel(null);
      }}>
        <button type="button" ref={trigger} className="header-button"
          aria-label={connected ? 'Game menu' : `Game menu, ${status.toLowerCase()}`}
          aria-expanded={panel !== null} aria-controls={panel ? 'game-header-panel' : undefined}
          data-testid="game-menu-toggle" onClick={() => setPanel(panel ? null : 'controls')}>
          <span aria-hidden="true" className="menu-ellipsis">•••</span>
          {!connected && <span aria-hidden="true" className="menu-connection-dot" />}
        </button>
        {panel === 'controls' && (
          <div id="game-header-panel" className="header-panel" role="group" aria-label="Game controls">
            <button type="button" className="header-menu-row" onClick={() => setPanel('knowledge')} data-testid="knowledge-toggle">
              <span aria-hidden="true">🧠</span> What I know <span aria-hidden="true" className="menu-value">›</span>
            </button>
            <MuteToggle className="header-menu-row" muted={muted} onToggle={onToggleMute} />
            <label className="header-bot-speed">
              <span>Bot speed <span className="menu-value" data-testid="bot-speed-value">{delay / 1000}s</span></span>
              <input type="range" min={3000} max={12000} step={1000} value={delay}
                onChange={(event) => onBotSpeed(Number(event.target.value))} disabled={!connected}
                aria-label="Bot speed" data-testid="bot-speed-slider" />
            </label>
            <div className="header-connection" data-testid="ws-status-indicator">
              <span className={connected ? 'connected-dot' : 'offline-dot'} aria-hidden="true" />
              {status}
            </div>
          </div>
        )}
        {panel === 'knowledge' && (
          <div id="game-header-panel">
            <KnowledgePanel {...knowledge} onClose={closePanel} />
          </div>
        )}
      </div>
    </header>
  );
}
