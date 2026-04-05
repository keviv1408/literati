/**
 * @jest-environment jsdom
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import InlineDeclareTray from '@/components/InlineDeclareTray';

function renderTray(overrides: Partial<React.ComponentProps<typeof InlineDeclareTray>> = {}) {
  const props: React.ComponentProps<typeof InlineDeclareTray> = {
    halfSuitId: 'low_s',
    unassignedCards: ['2_s', '3_s'],
    selectedCard: null,
    onTapCard: jest.fn(),
    totalCards: 6,
    assignedCount: 1,
    onTimerExpiry: jest.fn(),
    isComplete: false,
    isLoading: false,
    onConfirm: jest.fn(),
    ...overrides,
  };

  return { ...render(<InlineDeclareTray {...props} />), props };
}

describe('InlineDeclareTray', () => {
  it('does not render the old back/cancel tray controls', () => {
    renderTray();
    expect(screen.queryByTestId('inline-declare-back')).toBeNull();
    expect(screen.queryByTestId('inline-declare-cancel')).toBeNull();
  });

  it('calls onTapCard when an unassigned card is picked', () => {
    const onTapCard = jest.fn();
    renderTray({ onTapCard });
    fireEvent.click(screen.getByLabelText(/2 of spades/i));
    expect(onTapCard).toHaveBeenCalledWith('2_s');
  });

  it('shows the outside-click cancel hint in the declare instructions', () => {
    renderTray();
    expect(screen.getByText(/Click anywhere outside to cancel/i)).toBeTruthy();
  });

  it('renders confirm only when the declaration is complete', () => {
    const { rerender, props } = renderTray();
    expect(screen.queryByTestId('inline-declare-confirm')).toBeNull();

    rerender(
      <InlineDeclareTray
        {...props}
        unassignedCards={[]}
        assignedCount={6}
        isComplete={true}
      />,
    );

    expect(screen.getByTestId('inline-declare-confirm')).toBeTruthy();
  });
});
