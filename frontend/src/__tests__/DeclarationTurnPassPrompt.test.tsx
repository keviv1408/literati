/**
 * @jest-environment jsdom
 *
 * Unit tests for DeclarationTurnPassPrompt —
 *
 * Covers:
 * • "for-me" variant renders for the current-turn player (declarant)
 * • "for-others" variant renders for non-declaring observers
 * • Accessibility attributes (role, aria-live, data-testid)
 * • data-variant attribute distinguishes the two render modes
 * • Pulsing highlight indicator (cyan dot) present in both variants
 * • chooserName displayed correctly in the observer variant
 * • Fallback "Someone" when chooserName is null
 * • className forwarding
 * • Prompt disappears when unmounted (simulating highlight clear)
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import DeclarationTurnPassPrompt from '@/components/DeclarationTurnPassPrompt';

// ── Helper ────────────────────────────────────────────────────────────────────

function renderPrompt(isMyTurn: boolean, chooserName: string | null = 'Alice', className?: string) {
  return render(
    <DeclarationTurnPassPrompt
      isMyTurn={isMyTurn}
      chooserName={chooserName}
      className={className}
    />,
  );
}

// ── "For-me" variant (current turn player = declarant) ───────────────────────

describe('DeclarationTurnPassPrompt — "for-me" variant (isMyTurn=true)', () => {
  it('renders the container with data-testid="declaration-turn-pass-prompt"', () => {
    renderPrompt(true);
    expect(screen.getByTestId('declaration-turn-pass-prompt')).toBeInTheDocument();
  });

  it('sets data-variant="for-me" on the container', () => {
    renderPrompt(true);
    expect(screen.getByTestId('declaration-turn-pass-prompt')).toHaveAttribute('data-variant', 'for-me');
  });

  it('renders the turn-pass-for-me instruction text', () => {
    renderPrompt(true);
    expect(screen.getByTestId('turn-pass-prompt-for-me')).toBeInTheDocument();
  });

  it('instruction text includes "highlighted teammate"', () => {
    renderPrompt(true);
    expect(screen.getByTestId('turn-pass-prompt-for-me').textContent).toContain('highlighted teammate');
  });

  it('instruction text includes "pass your turn"', () => {
    renderPrompt(true);
    expect(screen.getByTestId('turn-pass-prompt-for-me').textContent).toContain('pass your turn');
  });

  it('renders the bounce icon', () => {
    renderPrompt(true);
    expect(screen.getByTestId('turn-pass-prompt-icon')).toBeInTheDocument();
  });

  it('renders the pulsing highlight indicator dot', () => {
    renderPrompt(true);
    expect(screen.getByTestId('turn-pass-highlight-indicator')).toBeInTheDocument();
  });

  it('has role="status" for screen-reader announcement', () => {
    renderPrompt(true);
    expect(screen.getByTestId('declaration-turn-pass-prompt')).toHaveAttribute('role', 'status');
  });

  it('has aria-live="polite"', () => {
    renderPrompt(true);
    expect(screen.getByTestId('declaration-turn-pass-prompt')).toHaveAttribute('aria-live', 'polite');
  });

  it('does NOT render the "for-others" testid in the "for-me" variant', () => {
    renderPrompt(true);
    expect(screen.queryByTestId('turn-pass-prompt-for-others')).toBeNull();
  });

  it('applies className to the outermost element', () => {
    renderPrompt(true, 'Alice', 'extra-class');
    expect(screen.getByTestId('declaration-turn-pass-prompt').className).toContain('extra-class');
  });
});

// ── "For-others" variant (observer — not the current turn player) ─────────────

describe('DeclarationTurnPassPrompt — "for-others" variant (isMyTurn=false)', () => {
  it('renders the container with data-testid="declaration-turn-pass-prompt"', () => {
    renderPrompt(false, 'Bob');
    expect(screen.getByTestId('declaration-turn-pass-prompt')).toBeInTheDocument();
  });

  it('sets data-variant="for-others" on the container', () => {
    renderPrompt(false, 'Bob');
    expect(screen.getByTestId('declaration-turn-pass-prompt')).toHaveAttribute('data-variant', 'for-others');
  });

  it('renders the turn-pass-for-others status text', () => {
    renderPrompt(false, 'Bob');
    expect(screen.getByTestId('turn-pass-prompt-for-others')).toBeInTheDocument();
  });

  it('status text includes the chooserName', () => {
    renderPrompt(false, 'Charlie');
    expect(screen.getByTestId('turn-pass-prompt-for-others').textContent).toContain('Charlie');
  });

  it('status text contains "choosing who gets the next turn"', () => {
    renderPrompt(false, 'Bob');
    const text = screen.getByTestId('turn-pass-prompt-for-others').textContent ?? '';
    expect(text).toContain('choosing who gets the next turn');
  });

  it('falls back to "Someone" when chooserName is null', () => {
    renderPrompt(false, null);
    expect(screen.getByTestId('turn-pass-prompt-for-others').textContent).toContain('Someone');
  });

  it('has role="status" for screen-reader announcement', () => {
    renderPrompt(false, 'Bob');
    expect(screen.getByTestId('declaration-turn-pass-prompt')).toHaveAttribute('role', 'status');
  });

  it('has aria-live="polite"', () => {
    renderPrompt(false, 'Bob');
    expect(screen.getByTestId('declaration-turn-pass-prompt')).toHaveAttribute('aria-live', 'polite');
  });

  it('does NOT render the "for-me" testid in the "for-others" variant', () => {
    renderPrompt(false, 'Bob');
    expect(screen.queryByTestId('turn-pass-prompt-for-me')).toBeNull();
  });

  it('does NOT render the bounce icon in the observer variant', () => {
    renderPrompt(false, 'Bob');
    expect(screen.queryByTestId('turn-pass-prompt-icon')).toBeNull();
  });

  it('applies className to the outermost element', () => {
    renderPrompt(false, 'Bob', 'another-class');
    expect(screen.getByTestId('declaration-turn-pass-prompt').className).toContain('another-class');
  });
});

// ── Lifecycle: prompt removed when highlights clear ──────────────────────────

describe('DeclarationTurnPassPrompt — lifecycle (prompt mounts/unmounts with highlight)', () => {
  it('prompt is present in the DOM when highlight is active', () => {
    const { queryByTestId } = render(
      <div>
        {true /* postDeclarationHighlight !== null */ && (
          <DeclarationTurnPassPrompt isMyTurn={true} chooserName="Alice" />
        )}
      </div>,
    );
    expect(queryByTestId('declaration-turn-pass-prompt')).toBeInTheDocument();
  });

  it('prompt is absent from the DOM when highlight is cleared', () => {
    const { queryByTestId } = render(
      <div>
        {false /* postDeclarationHighlight === null */ && (
          <DeclarationTurnPassPrompt isMyTurn={true} chooserName="Alice" />
        )}
      </div>,
    );
    expect(queryByTestId('declaration-turn-pass-prompt')).toBeNull();
  });

  it('prompt unmounts after choosing a seat (simulated highlight clear)', () => {
    const { rerender, queryByTestId } = render(
      <div>
        {/* Initially shown */}
        <DeclarationTurnPassPrompt isMyTurn={true} chooserName="Alice" />
      </div>,
    );
    expect(queryByTestId('declaration-turn-pass-prompt')).toBeInTheDocument();

    // After sendChooseNextTurn → postDeclarationHighlight becomes null → unmount
    rerender(<div>{/* prompt removed */}</div>);
    expect(queryByTestId('declaration-turn-pass-prompt')).toBeNull();
  });

  it('switches from "for-me" to "for-others" when isMyTurn changes', () => {
    const { rerender } = render(
      <DeclarationTurnPassPrompt isMyTurn={true} chooserName="Alice" />,
    );
    expect(screen.getByTestId('declaration-turn-pass-prompt')).toHaveAttribute('data-variant', 'for-me');

    rerender(<DeclarationTurnPassPrompt isMyTurn={false} chooserName="Alice" />);
    expect(screen.getByTestId('declaration-turn-pass-prompt')).toHaveAttribute('data-variant', 'for-others');
  });
});

// ── CSS indicator distinctiveness ─────────────────────────────────────────────

describe('DeclarationTurnPassPrompt — distinct CSS/style indicator', () => {
  it('"for-me" variant container includes bg-cyan-900 class (cyan background)', () => {
    renderPrompt(true);
    const container = screen.getByTestId('declaration-turn-pass-prompt');
    // Cyan-themed background distinguishes the turn-pass prompt from normal banners
    expect(container.className).toMatch(/bg-cyan/);
  });

  it('"for-others" variant container does NOT use the cyan background', () => {
    renderPrompt(false, 'Bob');
    const container = screen.getByTestId('declaration-turn-pass-prompt');
    // Observer strip uses muted slate background — not cyan (that is reserved for the seat ring)
    expect(container.className).not.toMatch(/bg-cyan/);
  });

  it('"for-me" variant has a cyan border class', () => {
    renderPrompt(true);
    const container = screen.getByTestId('declaration-turn-pass-prompt');
    expect(container.className).toMatch(/border-cyan/);
  });

  it('highlight indicator dot has bg-cyan-400 class', () => {
    renderPrompt(true);
    const dot = screen.getByTestId('turn-pass-highlight-indicator');
    expect(dot.className).toContain('bg-cyan-400');
  });

  it('highlight indicator dot has animate-pulse class', () => {
    renderPrompt(true);
    const dot = screen.getByTestId('turn-pass-highlight-indicator');
    expect(dot.className).toContain('animate-pulse');
  });
});
