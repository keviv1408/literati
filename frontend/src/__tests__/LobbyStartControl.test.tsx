/**
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { LobbyStartControl, showStartPanel } from '@/components/LobbyStartControl';

describe('LobbyStartControl', () => {
  it('shows the host the start button and no waiting line', () => {
    render(
      <LobbyStartControl isHost hostName="Ada">
        <button type="button">Start Game</button>
      </LobbyStartControl>,
    );

    expect(screen.getByRole('button', { name: 'Start Game' })).toBeInTheDocument();
    expect(screen.queryByTestId('waiting-for-host')).not.toBeInTheDocument();
  });

  it('tells a non-host which player they are waiting for', () => {
    render(
      <LobbyStartControl isHost={false} hostName="Asha">
        <button type="button">Start Game</button>
      </LobbyStartControl>,
    );

    expect(screen.getByTestId('waiting-for-host')).toHaveTextContent(
      /^Waiting for Asha to start the game$/,
    );
    expect(screen.queryByRole('button', { name: 'Start Game' })).not.toBeInTheDocument();
  });

  it('tells a non-host they are waiting for a host when none is connected', () => {
    render(
      <LobbyStartControl isHost={false} hostName={null}>
        <button type="button">Start Game</button>
      </LobbyStartControl>,
    );

    expect(screen.getByTestId('waiting-for-host')).toHaveTextContent(/^Waiting for a host…$/);
    expect(screen.queryByRole('button', { name: 'Start Game' })).not.toBeInTheDocument();
  });
});

describe('showStartPanel', () => {
  it.each`
    isSpectator | amIHost  | isCancelled | isMatchmaking | expected
    ${false}    | ${false} | ${false}    | ${false}      | ${true}
    ${false}    | ${true}  | ${false}    | ${false}      | ${true}
    ${true}     | ${false} | ${false}    | ${false}      | ${false}
    ${true}     | ${true}  | ${false}    | ${false}      | ${true}
    ${false}    | ${true}  | ${true}     | ${false}      | ${false}
    ${true}     | ${true}  | ${true}     | ${false}      | ${false}
    ${false}    | ${true}  | ${false}    | ${true}       | ${false}
    ${true}     | ${true}  | ${false}    | ${true}       | ${false}
  `(
    'spectator=$isSpectator host=$amIHost cancelled=$isCancelled matchmaking=$isMatchmaking -> $expected',
    ({ isSpectator, amIHost, isCancelled, isMatchmaking, expected }) => {
      expect(showStartPanel({ isSpectator, amIHost, isCancelled, isMatchmaking })).toBe(expected);
    },
  );
});
