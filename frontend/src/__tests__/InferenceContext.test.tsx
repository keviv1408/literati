/**
 * @jest-environment jsdom
 *
 * Unit tests for InferenceContext / InferenceProvider — Sub-AC 37d
 *
 * Coverage:
 *   InferenceProvider — player mode (isSpectator=false):
 *     1. inferenceMode defaults to false
 *     2. toggleInferenceMode() sets inferenceMode to true
 *     3. toggleInferenceMode() toggles back to false
 *     4. isSpectator is false
 *     5. cardInferences is passed through correctly
 *
 *   InferenceProvider — spectator mode (isSpectator=true):
 *     6. inferenceMode is always true
 *     7. toggleInferenceMode() is a no-op (cannot turn off)
 *     8. isSpectator is true
 *     9. cardInferences is passed through correctly
 *
 *   useInferenceContext — outside provider:
 *     10. Throws an error when called outside InferenceProvider
 *
 *   InferenceProvider — cardInferences prop updates:
 *     11. Updated cardInferences prop flows through to consumers
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { InferenceProvider, useInferenceContext } from '@/contexts/InferenceContext';
import type { CardInferenceState } from '@/hooks/useCardInference';

// ── Helper: Consumer component that reads from context ───────────────────────

function InferenceConsumer() {
  const { inferenceMode, isSpectator, cardInferences } = useInferenceContext();
  return (
    <div>
      <span data-testid="inference-mode">{String(inferenceMode)}</span>
      <span data-testid="is-spectator">{String(isSpectator)}</span>
      <span data-testid="card-inference-keys">{Object.keys(cardInferences).join(',')}</span>
    </div>
  );
}

function ToggleConsumer() {
  const { inferenceMode, toggleInferenceMode } = useInferenceContext();
  return (
    <div>
      <span data-testid="inference-mode">{String(inferenceMode)}</span>
      <button data-testid="toggle-btn" onClick={toggleInferenceMode}>Toggle</button>
    </div>
  );
}

// ── Player mode ───────────────────────────────────────────────────────────────

describe('InferenceProvider — player mode (isSpectator=false)', () => {
  it('inferenceMode defaults to false', () => {
    render(
      <InferenceProvider isSpectator={false} cardInferences={{}}>
        <InferenceConsumer />
      </InferenceProvider>,
    );
    expect(screen.getByTestId('inference-mode').textContent).toBe('false');
  });

  it('toggleInferenceMode() sets inferenceMode to true', () => {
    render(
      <InferenceProvider isSpectator={false} cardInferences={{}}>
        <ToggleConsumer />
      </InferenceProvider>,
    );

    expect(screen.getByTestId('inference-mode').textContent).toBe('false');

    act(() => {
      screen.getByTestId('toggle-btn').click();
    });

    expect(screen.getByTestId('inference-mode').textContent).toBe('true');
  });

  it('toggleInferenceMode() toggles back to false', () => {
    render(
      <InferenceProvider isSpectator={false} cardInferences={{}}>
        <ToggleConsumer />
      </InferenceProvider>,
    );

    act(() => { screen.getByTestId('toggle-btn').click(); });
    expect(screen.getByTestId('inference-mode').textContent).toBe('true');

    act(() => { screen.getByTestId('toggle-btn').click(); });
    expect(screen.getByTestId('inference-mode').textContent).toBe('false');
  });

  it('isSpectator is false', () => {
    render(
      <InferenceProvider isSpectator={false} cardInferences={{}}>
        <InferenceConsumer />
      </InferenceProvider>,
    );
    expect(screen.getByTestId('is-spectator').textContent).toBe('false');
  });

  it('cardInferences is passed through correctly', () => {
    const inferences: CardInferenceState = {
      'player-1': { '5_h': 'confirmed' },
      'player-2': { '3_s': 'excluded' },
    };
    render(
      <InferenceProvider isSpectator={false} cardInferences={inferences}>
        <InferenceConsumer />
      </InferenceProvider>,
    );
    const keys = screen.getByTestId('card-inference-keys').textContent;
    expect(keys).toContain('player-1');
    expect(keys).toContain('player-2');
  });
});

// ── Spectator mode ────────────────────────────────────────────────────────────

describe('InferenceProvider — spectator mode (isSpectator=true)', () => {
  it('inferenceMode is always true', () => {
    render(
      <InferenceProvider isSpectator={true} cardInferences={{}}>
        <InferenceConsumer />
      </InferenceProvider>,
    );
    expect(screen.getByTestId('inference-mode').textContent).toBe('true');
  });

  it('toggleInferenceMode() is a no-op — inferenceMode stays true', () => {
    render(
      <InferenceProvider isSpectator={true} cardInferences={{}}>
        <ToggleConsumer />
      </InferenceProvider>,
    );

    expect(screen.getByTestId('inference-mode').textContent).toBe('true');

    // Attempt to toggle — should remain true
    act(() => { screen.getByTestId('toggle-btn').click(); });
    expect(screen.getByTestId('inference-mode').textContent).toBe('true');

    // Second attempt — still true
    act(() => { screen.getByTestId('toggle-btn').click(); });
    expect(screen.getByTestId('inference-mode').textContent).toBe('true');
  });

  it('isSpectator is true', () => {
    render(
      <InferenceProvider isSpectator={true} cardInferences={{}}>
        <InferenceConsumer />
      </InferenceProvider>,
    );
    expect(screen.getByTestId('is-spectator').textContent).toBe('true');
  });

  it('cardInferences is passed through correctly for spectators', () => {
    const inferences: CardInferenceState = {
      'alice': { 'A_h': 'confirmed', '2_h': 'excluded' },
    };
    render(
      <InferenceProvider isSpectator={true} cardInferences={inferences}>
        <InferenceConsumer />
      </InferenceProvider>,
    );
    expect(screen.getByTestId('card-inference-keys').textContent).toContain('alice');
  });
});

// ── useInferenceContext outside provider ──────────────────────────────────────

describe('useInferenceContext — outside InferenceProvider', () => {
  it('throws an error when called outside InferenceProvider', () => {
    // Suppress error boundary output in tests
    const originalError = console.error;
    console.error = jest.fn();

    expect(() => {
      renderHook(() => useInferenceContext());
    }).toThrow();

    console.error = originalError;
  });
});

// ── cardInferences prop updates ───────────────────────────────────────────────

describe('InferenceProvider — cardInferences prop updates', () => {
  it('updated cardInferences prop flows through to consumers', () => {
    const inferences1: CardInferenceState = { 'alice': { '5_h': 'confirmed' } };
    const inferences2: CardInferenceState = {
      'alice': { '5_h': 'confirmed' },
      'bob': { '3_s': 'excluded' },
    };

    const { rerender } = render(
      <InferenceProvider isSpectator={false} cardInferences={inferences1}>
        <InferenceConsumer />
      </InferenceProvider>,
    );

    let keys = screen.getByTestId('card-inference-keys').textContent ?? '';
    expect(keys).toContain('alice');
    expect(keys).not.toContain('bob');

    rerender(
      <InferenceProvider isSpectator={false} cardInferences={inferences2}>
        <InferenceConsumer />
      </InferenceProvider>,
    );

    keys = screen.getByTestId('card-inference-keys').textContent ?? '';
    expect(keys).toContain('alice');
    expect(keys).toContain('bob');
  });
});
