/**
 * @jest-environment jsdom
 *
 * AC 35: Last-move display shows full public details.
 *
 * Coverage:
 *   1. Renders nothing when message is null
 *   2. Renders nothing when message is undefined
 *   3. Renders nothing when message is empty string
 *   4. Renders the message text when provided
 *   5. Has aria-live="polite" for screen reader announcements
 *   6. Has aria-label="Last move"
 *   7. Default data-testid is "last-move-display"
 *   8. Custom testId overrides the default
 *   9. Renders ask-success message correctly
 *  10. Renders ask-denied message correctly
 *  11. Renders correct-declaration message correctly
 *  12. Renders incorrect-declaration message correctly
 *  13. Spectator testId variant ("spectator-last-move")
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import LastMoveDisplay from '@/components/LastMoveDisplay';
import type { GamePlayer } from '@/types/game';

const PLAYERS: GamePlayer[] = [
  {
    playerId: 'p1',
    displayName: 'Alice',
    avatarId: null,
    teamId: 1,
    seatIndex: 0,
    cardCount: 6,
    isBot: false,
    isGuest: true,
    isCurrentTurn: false,
  },
  {
    playerId: 'p2',
    displayName: 'Bob',
    avatarId: null,
    teamId: 2,
    seatIndex: 1,
    cardCount: 6,
    isBot: false,
    isGuest: true,
    isCurrentTurn: false,
  },
];

describe('LastMoveDisplay', () => {
  it('renders nothing when message is null', () => {
    const { container } = render(<LastMoveDisplay message={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when message is undefined', () => {
    const { container } = render(<LastMoveDisplay message={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when message is empty string', () => {
    const { container } = render(<LastMoveDisplay message="" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the message text when provided', () => {
    const msg = 'Alice asked Dave for 9♠ — denied';
    render(<LastMoveDisplay message={msg} />);
    expect(screen.getByTestId('last-move-display').textContent).toContain(msg);
  });

  it('has aria-live="polite"', () => {
    render(<LastMoveDisplay message="some move" />);
    const el = screen.getByTestId('last-move-display');
    expect(el.getAttribute('aria-live')).toBe('polite');
  });

  it('has aria-label="Last move"', () => {
    render(<LastMoveDisplay message="some move" />);
    const el = screen.getByLabelText('Last move');
    expect(el).toBeTruthy();
  });

  it('default data-testid is "last-move-display"', () => {
    render(<LastMoveDisplay message="test msg" />);
    expect(screen.getByTestId('last-move-display')).toBeTruthy();
  });

  it('custom testId overrides the default', () => {
    render(<LastMoveDisplay message="test msg" testId="spectator-last-move" />);
    expect(screen.getByTestId('spectator-last-move')).toBeTruthy();
    expect(screen.queryByTestId('last-move-display')).toBeNull();
  });

  it('renders ask-success message: "[player] asked [player] for [card] — got it"', () => {
    const msg = 'Alice asked Dave for 9♠ — got it';
    render(<LastMoveDisplay message={msg} />);
    expect(screen.getByTestId('last-move-display').textContent).toContain(msg);
  });

  it('renders combined ask-success message with multiple cards', () => {
    const msg = 'Alice asked Bob for 8♣, 10♣, and J♣ — got them';
    render(<LastMoveDisplay message={msg} players={PLAYERS} myPlayerId="p1" />);
    expect(screen.getByTestId('last-move-display').textContent).toContain(msg);
    expect(screen.getByText('8♣').className).toContain('text-slate-900');
    expect(screen.getByText('10♣').className).toContain('text-slate-900');
    expect(screen.getByText('J♣').className).toContain('text-slate-900');
  });

  it('renders combined ask message with mixed got and denied cards', () => {
    const msg = 'Alice asked Bob for 8♣ and 10♣ — got 8♣; denied 10♣';
    render(<LastMoveDisplay message={msg} players={PLAYERS} myPlayerId="p1" />);
    expect(screen.getByTestId('last-move-display').textContent).toContain(msg);
  });

  it('renders a multi-card ask preview without an outcome', () => {
    const msg = 'Alice asked Bob for 8♣, 10♣, and J♣';
    render(<LastMoveDisplay message={msg} players={PLAYERS} myPlayerId="p1" />);
    expect(screen.getByTestId('last-move-display').textContent).toContain(msg);
    expect(screen.getByText('8♣').className).toContain('text-slate-900');
  });

  it('renders ask-denied message: "[player] asked [player] for [card] — denied"', () => {
    const msg = 'Alice asked Dave for 9♠ — denied';
    render(<LastMoveDisplay message={msg} />);
    expect(screen.getByTestId('last-move-display').textContent).toContain(msg);
  });

  it('renders correct-declaration message: "[player] declared [suit] — correct! Team N scores"', () => {
    const msg = 'Alice declared Low Spades — correct! Team 1 scores';
    render(<LastMoveDisplay message={msg} />);
    expect(screen.getByTestId('last-move-display').textContent).toContain(msg);
  });

  it('renders incorrect-declaration message: "[player] declared [suit] — incorrect! Team N scores"', () => {
    const msg = 'Charlie declared High Hearts — incorrect! Team 2 scores';
    render(<LastMoveDisplay message={msg} />);
    expect(screen.getByTestId('last-move-display').textContent).toContain(msg);
  });

  it('spectator testId "spectator-last-move" works correctly', () => {
    const msg = 'Bob asked Eve for K♦ — denied';
    render(<LastMoveDisplay message={msg} testId="spectator-last-move" />);
    const el = screen.getByTestId('spectator-last-move');
    expect(el.textContent).toBe(msg);
  });

  it('updates display when message changes', () => {
    const { rerender } = render(<LastMoveDisplay message="first move" />);
    expect(screen.getByTestId('last-move-display').textContent).toContain('first move');

    rerender(<LastMoveDisplay message="second move" />);
    expect(screen.queryByText('first move')).toBeNull();
    expect(screen.getByTestId('last-move-display').textContent).toContain('second move');
  });

  it('disappears when message changes to null', () => {
    const { rerender } = render(<LastMoveDisplay message="some move" />);
    expect(screen.getByText('some move')).toBeTruthy();

    rerender(<LastMoveDisplay message={null} />);
    expect(screen.queryByText('some move')).toBeNull();
  });

  it('colors my-team and opponent names for ask messages', () => {
    render(
      <LastMoveDisplay
        message="Alice asked Bob for 9♠ — denied"
        players={PLAYERS}
        myPlayerId="p1"
      />
    );

    expect(screen.getByText('Alice').className).toContain('text-emerald-700');
    expect(screen.getByText('Bob').className).toContain('text-violet-700');
  });

  it('colors card tokens by suit (red for hearts/diamonds)', () => {
    render(
      <LastMoveDisplay
        message="Alice asked Bob for 6♦ — got it"
        players={PLAYERS}
        myPlayerId="p1"
      />
    );

    expect(screen.getByText('6♦').className).toContain('text-red-600');
  });

  it('uses a high-contrast light panel background and bigger text', () => {
    render(<LastMoveDisplay message="Alice asked Bob for 9♠ — denied" />);
    const panel = screen.getByTestId('last-move-display');
    expect(panel.className).toContain('bg-slate-100/95');
    expect(panel.className).toContain('text-base');
    expect(panel.className).toContain('sm:text-lg');
  });
});
