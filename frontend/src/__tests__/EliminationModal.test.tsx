/**
 * @jest-environment jsdom
 *
 * Unit tests for EliminationModal —
 *
 * Covers:
 * 1. Modal renders with correct heading and description
 * 2. Eligible teammates are listed as buttons
 * 3. Clicking a teammate button calls onChoose with their ID
 * 4. When no eligible teammates: shows informational message (no buttons)
 * 5. When no eligible teammates: auto-calls onChoose('') after 4 seconds
 * 6. data-testid attributes are present
 * 7. aria-label on teammate buttons
 * 8. role="dialog" and aria-modal present
 * 9. Multiple teammates all rendered
 * 10. Skull emoji rendered in header
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import EliminationModal from '@/components/EliminationModal';
import type { ChooseTurnRecipientPromptPayload } from '@/types/game';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePrompt(
  overrides: Partial<ChooseTurnRecipientPromptPayload> = {}
): ChooseTurnRecipientPromptPayload {
  return {
    type: 'choose_turn_recipient_prompt',
    eliminatedPlayerId: 'p1',
    eligibleTeammates: [
      { playerId: 'p2', displayName: 'Bob' },
      { playerId: 'p3', displayName: 'Carol' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

// ── 1. Modal renders heading and description ──────────────────────────────────

describe('EliminationModal — structure', () => {
  it('renders the "eliminated" heading', () => {
    render(<EliminationModal prompt={makePrompt()} onChoose={jest.fn()} />);
    expect(screen.getByRole('heading', { name: /eliminated/i })).toBeInTheDocument();
  });

  it('renders the explanatory description', () => {
    render(<EliminationModal prompt={makePrompt()} onChoose={jest.fn()} />);
    expect(screen.getByText(/your hand is empty/i)).toBeInTheDocument();
  });

  it('renders the skull emoji', () => {
    render(<EliminationModal prompt={makePrompt()} onChoose={jest.fn()} />);
    // emoji is rendered as text content
    expect(screen.getByTestId('elimination-modal').textContent).toContain('💀');
  });

  it('has role="dialog" and aria-modal="true"', () => {
    render(<EliminationModal prompt={makePrompt()} onChoose={jest.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('data-testid', 'elimination-modal');
  });
});

// ── 2. Eligible teammates listed ──────────────────────────────────────────────

describe('EliminationModal — with eligible teammates', () => {
  it('renders a button for each eligible teammate', () => {
    render(<EliminationModal prompt={makePrompt()} onChoose={jest.fn()} />);
    expect(screen.getByRole('button', { name: /Bob/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Carol/i })).toBeInTheDocument();
  });

  it('renders "choose a teammate" instruction text', () => {
    render(<EliminationModal prompt={makePrompt()} onChoose={jest.fn()} />);
    expect(screen.getByText(/choose a teammate/i)).toBeInTheDocument();
  });

  it('each button has a descriptive aria-label', () => {
    render(<EliminationModal prompt={makePrompt()} onChoose={jest.fn()} />);
    expect(
      screen.getByRole('button', { name: /pass future turns to Bob/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /pass future turns to Carol/i })
    ).toBeInTheDocument();
  });

  it('applies data-testid with recipient ID on each button', () => {
    render(<EliminationModal prompt={makePrompt()} onChoose={jest.fn()} />);
    expect(screen.getByTestId('recipient-button-p2')).toBeInTheDocument();
    expect(screen.getByTestId('recipient-button-p3')).toBeInTheDocument();
  });
});

// ── 3. Clicking a teammate calls onChoose ────────────────────────────────────

describe('EliminationModal — selecting a recipient', () => {
  it('calls onChoose with the teammate playerId when button is clicked', () => {
    const onChoose = jest.fn();
    render(<EliminationModal prompt={makePrompt()} onChoose={onChoose} />);
    fireEvent.click(screen.getByTestId('recipient-button-p2'));
    expect(onChoose).toHaveBeenCalledWith('p2');
  });

  it('calls onChoose for the second teammate when their button is clicked', () => {
    const onChoose = jest.fn();
    render(<EliminationModal prompt={makePrompt()} onChoose={onChoose} />);
    fireEvent.click(screen.getByTestId('recipient-button-p3'));
    expect(onChoose).toHaveBeenCalledWith('p3');
  });

  it('does NOT call onChoose automatically when eligible teammates exist', () => {
    const onChoose = jest.fn();
    render(<EliminationModal prompt={makePrompt()} onChoose={onChoose} />);
    act(() => { jest.advanceTimersByTime(5000); });
    expect(onChoose).not.toHaveBeenCalled();
  });
});

// ── 4 & 5. No eligible teammates ─────────────────────────────────────────────

describe('EliminationModal — no eligible teammates', () => {
  const emptyPrompt = makePrompt({ eligibleTeammates: [] });

  it('shows informational "entire team eliminated" message', () => {
    render(<EliminationModal prompt={emptyPrompt} onChoose={jest.fn()} />);
    expect(screen.getByText(/entire team has been eliminated/i)).toBeInTheDocument();
  });

  it('does NOT render any teammate buttons', () => {
    render(<EliminationModal prompt={emptyPrompt} onChoose={jest.fn()} />);
    expect(screen.queryByTestId(/recipient-button-/)).not.toBeInTheDocument();
  });

  it('shows "Closing automatically…" pulse text', () => {
    render(<EliminationModal prompt={emptyPrompt} onChoose={jest.fn()} />);
    expect(screen.getByText(/closing automatically/i)).toBeInTheDocument();
  });

  it('auto-calls onChoose("") after 4 seconds', () => {
    const onChoose = jest.fn();
    render(<EliminationModal prompt={emptyPrompt} onChoose={onChoose} />);
    act(() => { jest.advanceTimersByTime(3999); });
    expect(onChoose).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(1); });
    expect(onChoose).toHaveBeenCalledWith('');
  });

  it('auto-call fires exactly once', () => {
    const onChoose = jest.fn();
    render(<EliminationModal prompt={emptyPrompt} onChoose={onChoose} />);
    act(() => { jest.advanceTimersByTime(10_000); });
    expect(onChoose).toHaveBeenCalledTimes(1);
  });
});

// ── 9. Multiple teammates ─────────────────────────────────────────────────────

describe('EliminationModal — multiple teammates', () => {
  it('renders all 3 buttons for a 4-player team (3 eligible)', () => {
    const prompt = makePrompt({
      eligibleTeammates: [
        { playerId: 'p2', displayName: 'Bob' },
        { playerId: 'p3', displayName: 'Carol' },
        { playerId: 'p4', displayName: 'Dave' },
      ],
    });
    render(<EliminationModal prompt={prompt} onChoose={jest.fn()} />);
    expect(screen.getByTestId('recipient-button-p2')).toBeInTheDocument();
    expect(screen.getByTestId('recipient-button-p3')).toBeInTheDocument();
    expect(screen.getByTestId('recipient-button-p4')).toBeInTheDocument();
  });
});
