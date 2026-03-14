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
    render(<LastMoveDisplay message="Alice asked Dave for 9♠ — denied" />);
    expect(screen.getByText('Alice asked Dave for 9♠ — denied')).toBeTruthy();
  });

  it('has aria-live="polite"', () => {
    render(<LastMoveDisplay message="some move" />);
    const el = screen.getByText('some move');
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
    expect(screen.getByText(msg)).toBeTruthy();
  });

  it('renders ask-denied message: "[player] asked [player] for [card] — denied"', () => {
    const msg = 'Alice asked Dave for 9♠ — denied';
    render(<LastMoveDisplay message={msg} />);
    expect(screen.getByText(msg)).toBeTruthy();
  });

  it('renders correct-declaration message: "[player] declared [suit] — correct! Team N scores"', () => {
    const msg = 'Alice declared Low Spades — correct! Team 1 scores';
    render(<LastMoveDisplay message={msg} />);
    expect(screen.getByText(msg)).toBeTruthy();
  });

  it('renders incorrect-declaration message: "[player] declared [suit] — incorrect! Team N scores"', () => {
    const msg = 'Charlie declared High Hearts — incorrect! Team 2 scores';
    render(<LastMoveDisplay message={msg} />);
    expect(screen.getByText(msg)).toBeTruthy();
  });

  it('spectator testId "spectator-last-move" works correctly', () => {
    const msg = 'Bob asked Eve for K♦ — denied';
    render(<LastMoveDisplay message={msg} testId="spectator-last-move" />);
    const el = screen.getByTestId('spectator-last-move');
    expect(el.textContent).toBe(msg);
  });

  it('updates display when message changes', () => {
    const { rerender } = render(<LastMoveDisplay message="first move" />);
    expect(screen.getByText('first move')).toBeTruthy();

    rerender(<LastMoveDisplay message="second move" />);
    expect(screen.queryByText('first move')).toBeNull();
    expect(screen.getByText('second move')).toBeTruthy();
  });

  it('disappears when message changes to null', () => {
    const { rerender } = render(<LastMoveDisplay message="some move" />);
    expect(screen.getByText('some move')).toBeTruthy();

    rerender(<LastMoveDisplay message={null} />);
    expect(screen.queryByText('some move')).toBeNull();
  });
});
