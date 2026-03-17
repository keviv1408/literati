/**
 * @jest-environment jsdom
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import InlineAskTray from '@/components/InlineAskTray';
import type { DeclaredSuit } from '@/types/game';

function renderTray(overrides: Partial<React.ComponentProps<typeof InlineAskTray>> = {}) {
  const props: React.ComponentProps<typeof InlineAskTray> = {
    myHand: ['3_h', '5_h', '9_s'],
    variant: 'remove_7s',
    declaredSuits: [],
    selectedHalfSuit: null,
    selectedCardId: null,
    onSelectHalfSuit: jest.fn(),
    onSelectCard: jest.fn(),
    onBack: jest.fn(),
    onCancel: jest.fn(),
    isLoading: false,
    ...overrides,
  };

  return { ...render(<InlineAskTray {...props} />), props };
}

describe('InlineAskTray', () => {
  it('shows the available half-suits from the player hand', () => {
    renderTray();
    expect(screen.getByTestId('inline-ask-halfsuit-low_h')).toBeTruthy();
    expect(screen.getByTestId('inline-ask-halfsuit-high_s')).toBeTruthy();
  });

  it('calls onSelectHalfSuit when a half-suit is chosen', () => {
    const onSelectHalfSuit = jest.fn();
    renderTray({ onSelectHalfSuit });
    fireEvent.click(screen.getByTestId('inline-ask-halfsuit-low_h'));
    expect(onSelectHalfSuit).toHaveBeenCalledWith('low_h');
  });

  it('renders only the missing cards once a half-suit is selected', () => {
    renderTray({ selectedHalfSuit: 'low_h' });
    expect(screen.getByTestId('inline-ask-card-1_h')).toBeTruthy();
    expect(screen.getByTestId('inline-ask-card-2_h')).toBeTruthy();
    expect(screen.queryByTestId('inline-ask-card-3_h')).toBeNull();
    expect(screen.queryByTestId('inline-ask-card-5_h')).toBeNull();
  });

  it('calls onSelectCard when an ask card is picked', () => {
    const onSelectCard = jest.fn();
    renderTray({ selectedHalfSuit: 'low_h', onSelectCard });
    fireEvent.click(screen.getByTestId('inline-ask-card-1_h'));
    expect(onSelectCard).toHaveBeenCalledWith('1_h');
  });

  it('calls onBack and onCancel from the tray controls', () => {
    const onBack = jest.fn();
    const onCancel = jest.fn();
    renderTray({ selectedHalfSuit: 'low_h', onBack, onCancel });
    fireEvent.click(screen.getByTestId('inline-ask-back'));
    fireEvent.click(screen.getByTestId('inline-ask-cancel'));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('hides declared half-suits from the chooser', () => {
    const declaredSuits: DeclaredSuit[] = [
      { halfSuitId: 'low_h', teamId: 1, declaredBy: 'p1' },
    ];
    renderTray({ declaredSuits });
    expect(screen.queryByTestId('inline-ask-halfsuit-low_h')).toBeNull();
  });
});
