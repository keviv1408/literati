/**
 * @jest-environment jsdom
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import InlineAskTray, { getAvailableAskHalfSuits } from '@/components/InlineAskTray';
import type { DeclaredSuit } from '@/types/game';

function renderTray(overrides: Partial<React.ComponentProps<typeof InlineAskTray>> = {}) {
  const props: React.ComponentProps<typeof InlineAskTray> = {
    myHand: ['3_h', '5_h', '9_s'],
    variant: 'remove_7s',
    halfSuitId: 'low_h',
    selectedCardIds: [],
    onToggleCard: jest.fn(),
    isLoading: false,
    ...overrides,
  };

  return { ...render(<InlineAskTray {...props} />), props };
}

describe('InlineAskTray', () => {
  it('renders only the missing cards for the selected half-suit', () => {
    renderTray();
    expect(screen.getByTestId('inline-ask-card-1_h')).toBeTruthy();
    expect(screen.getByTestId('inline-ask-card-2_h')).toBeTruthy();
    expect(screen.queryByTestId('inline-ask-card-3_h')).toBeNull();
    expect(screen.queryByTestId('inline-ask-card-5_h')).toBeNull();
  });

  it('calls onToggleCard when an ask card is picked', () => {
    const onToggleCard = jest.fn();
    renderTray({ onToggleCard });
    fireEvent.click(screen.getByTestId('inline-ask-card-1_h'));
    expect(onToggleCard).toHaveBeenCalledWith('1_h');
  });

  it('shows the multi-select opponent prompt once cards are selected', () => {
    renderTray({ selectedCardIds: ['1_h', '2_h'] });
    expect(screen.getByTestId('inline-ask-step-opponent').textContent).toContain('2 cards');
    expect(screen.getByTestId('inline-ask-selected-count').textContent).toContain('2 selected');
  });

  it('does not render the old back/cancel tray controls', () => {
    renderTray();
    expect(screen.queryByTestId('inline-ask-back')).toBeNull();
    expect(screen.queryByTestId('inline-ask-cancel')).toBeNull();
  });

  it('filters declared and completed half-suits from the askable helper', () => {
    const declaredSuits: DeclaredSuit[] = [
      { halfSuitId: 'low_h', teamId: 1, declaredBy: 'p1' },
    ];

    expect(
      getAvailableAskHalfSuits(['1_h', '2_h', '3_h', '4_h', '5_h', '6_h', '9_s'], [], 'remove_7s'),
    ).toEqual(['high_s']);

    expect(
      getAvailableAskHalfSuits(['3_h', '5_h', '9_s'], declaredSuits, 'remove_7s'),
    ).toEqual(['high_s']);
  });
});
