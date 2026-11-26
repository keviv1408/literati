import React from 'react';

interface StartPanelState {
  isSpectator: boolean;
  amIHost: boolean;
  isCancelled: boolean;
  isMatchmaking: boolean;
}

// The server seats a spectate-page browser as a player and can flag it host, so the host flag wins.
export function showStartPanel({ isSpectator, amIHost, isCancelled, isMatchmaking }: StartPanelState): boolean {
  return !isCancelled && !isMatchmaking && (!isSpectator || amIHost);
}

interface LobbyStartControlProps {
  isHost: boolean;
  hostName: string | null;
  children: React.ReactNode;
}

export function LobbyStartControl({ isHost, hostName, children }: LobbyStartControlProps) {
  if (isHost) return <>{children}</>;
  return (
    <p className="text-xs text-slate-400 text-center" role="status" data-testid="waiting-for-host">
      {hostName ? `Waiting for ${hostName} to start the game` : 'Waiting for a host…'}
    </p>
  );
}
