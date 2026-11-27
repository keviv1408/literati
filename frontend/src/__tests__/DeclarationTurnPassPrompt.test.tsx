/** @jest-environment jsdom */
import { render, screen } from '@testing-library/react';
import DeclarationTurnPassPrompt from '@/components/DeclarationTurnPassPrompt';

it('switches from guidance to confirmation after the chooser taps a seat', () => {
  const { rerender } = render(<DeclarationTurnPassPrompt isMyTurn chooserName="VV" pending={false} />);
  expect(screen.getByRole('status')).toHaveTextContent('Tap a highlighted teammate to play next.');
  rerender(<DeclarationTurnPassPrompt isMyTurn chooserName="VV" pending />);
  expect(screen.getByRole('status')).toHaveTextContent('Passing the turn…');
});

it.each([['VV', 'VV'], [null, 'Someone']])('identifies the chooser for waiting players', (chooserName, expected) => {
  render(<DeclarationTurnPassPrompt isMyTurn={false} chooserName={chooserName} pending={false} />);
  expect(screen.getByRole('status')).toHaveTextContent(`${expected} is choosing who plays next.`);
});
