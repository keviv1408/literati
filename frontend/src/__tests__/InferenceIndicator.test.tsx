/**
 * @jest-environment jsdom
 *
 * Unit tests for InferenceIndicator — Sub-AC 37c
 *
 * Coverage:
 *   • Returns null when inference map is empty and no sharePercent
 *   • Renders confirmed badge when confirmed cards exist
 *   • Renders excluded badge when excluded cards exist
 *   • Renders both badges when both exist
 *   • Renders uniform-distribution share badge when sharePercent > 0
 *   • Does NOT render share badge when sharePercent is 0
 *   • Does NOT render share badge when sharePercent is undefined
 *   • Renders only share badge when inference map is empty but sharePercent > 0
 *   • Share badge shows correct ~XX% format
 *   • data-testid attributes present
 *   • Screen reader accessible label includes all relevant info
 *   • data-player-id attribute set correctly
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import InferenceIndicator from '@/components/InferenceIndicator';
import type { PlayerInference } from '@/hooks/useCardInference';

// ── Helpers ────────────────────────────────────────────────────────────────────

function renderIndicator(
  inference: PlayerInference,
  sharePercent?: number,
  playerId = 'player-1',
) {
  return render(
    <InferenceIndicator
      playerId={playerId}
      inference={inference}
      sharePercent={sharePercent}
    />,
  );
}

// ── Null / empty state ─────────────────────────────────────────────────────────

describe('InferenceIndicator — empty state', () => {
  it('renders null when inference is empty and no sharePercent', () => {
    const { container } = renderIndicator({});
    expect(container.firstChild).toBeNull();
  });

  it('renders null when sharePercent is 0', () => {
    const { container } = renderIndicator({}, 0);
    expect(container.firstChild).toBeNull();
  });

  it('renders null when sharePercent is undefined', () => {
    const { container } = renderIndicator({}, undefined);
    expect(container.firstChild).toBeNull();
  });
});

// ── Confirmed badge ───────────────────────────────────────────────────────────

describe('InferenceIndicator — confirmed badge', () => {
  it('renders the confirmed badge when confirmed cards exist', () => {
    const { container } = renderIndicator({ '5_h': 'confirmed' });
    const badge = container.querySelector('[data-testid="inference-confirmed-badge"]');
    expect(badge).not.toBeNull();
  });

  it('shows the confirmed count', () => {
    const { container } = renderIndicator({
      '5_h': 'confirmed',
      '3_h': 'confirmed',
    });
    const badge = container.querySelector('[data-testid="inference-confirmed-badge"]');
    expect(badge?.textContent).toContain('2');
  });

  it('does NOT render confirmed badge when no confirmed entries', () => {
    const { container } = renderIndicator({ '5_h': 'excluded' });
    expect(container.querySelector('[data-testid="inference-confirmed-badge"]')).toBeNull();
  });
});

// ── Excluded badge ────────────────────────────────────────────────────────────

describe('InferenceIndicator — excluded badge', () => {
  it('renders the excluded badge when excluded cards exist', () => {
    const { container } = renderIndicator({ '5_h': 'excluded' });
    const badge = container.querySelector('[data-testid="inference-excluded-badge"]');
    expect(badge).not.toBeNull();
  });

  it('shows the excluded count', () => {
    const { container } = renderIndicator({
      '5_h': 'excluded',
      '3_h': 'excluded',
      '2_h': 'excluded',
    });
    const badge = container.querySelector('[data-testid="inference-excluded-badge"]');
    expect(badge?.textContent).toContain('3');
  });

  it('does NOT render excluded badge when no excluded entries', () => {
    const { container } = renderIndicator({ '5_h': 'confirmed' });
    expect(container.querySelector('[data-testid="inference-excluded-badge"]')).toBeNull();
  });
});

// ── Share % badge (uniform distribution) ─────────────────────────────────────

describe('InferenceIndicator — uniform-distribution share badge', () => {
  it('renders the share badge when sharePercent > 0', () => {
    const { container } = renderIndicator({}, 33);
    const badge = container.querySelector('[data-testid="inference-share-badge"]');
    expect(badge).not.toBeNull();
  });

  it('shows the ~XX% format', () => {
    const { container } = renderIndicator({}, 42);
    const badge = container.querySelector('[data-testid="inference-share-badge"]');
    expect(badge?.textContent).toContain('~42%');
  });

  it('renders only the share badge when inference map is empty', () => {
    const { container } = renderIndicator({}, 25);
    const wrapper = container.querySelector('[data-testid="inference-indicator"]');
    expect(wrapper).not.toBeNull();
    expect(container.querySelector('[data-testid="inference-confirmed-badge"]')).toBeNull();
    expect(container.querySelector('[data-testid="inference-excluded-badge"]')).toBeNull();
    expect(container.querySelector('[data-testid="inference-share-badge"]')).not.toBeNull();
  });

  it('renders all three badges together', () => {
    const { container } = renderIndicator(
      { '5_h': 'confirmed', '3_h': 'excluded' },
      50,
    );
    expect(container.querySelector('[data-testid="inference-confirmed-badge"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="inference-excluded-badge"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="inference-share-badge"]')).not.toBeNull();
  });

  it('does not render share badge when sharePercent is 0', () => {
    const { container } = renderIndicator({ '5_h': 'confirmed' }, 0);
    expect(container.querySelector('[data-testid="inference-share-badge"]')).toBeNull();
  });

  it('share badge title includes uniform distribution description', () => {
    const { container } = renderIndicator({}, 33);
    const badge = container.querySelector('[data-testid="inference-share-badge"]') as HTMLElement;
    expect(badge?.title).toContain('uniform distribution');
  });
});

// ── Accessibility ──────────────────────────────────────────────────────────────

describe('InferenceIndicator — accessibility', () => {
  it('has data-testid="inference-indicator" on root', () => {
    const { container } = renderIndicator({ '5_h': 'confirmed' });
    expect(container.querySelector('[data-testid="inference-indicator"]')).not.toBeNull();
  });

  it('sets data-player-id correctly', () => {
    const { container } = renderIndicator({ '5_h': 'confirmed' }, undefined, 'player-xyz');
    const indicator = container.querySelector('[data-testid="inference-indicator"]') as HTMLElement;
    expect(indicator?.getAttribute('data-player-id')).toBe('player-xyz');
  });

  it('sr-only label mentions confirmed count', () => {
    renderIndicator({ '5_h': 'confirmed' });
    const srText = document.querySelector('.sr-only');
    expect(srText?.textContent).toContain('1 card confirmed');
  });

  it('sr-only label mentions excluded count', () => {
    renderIndicator({ '5_h': 'excluded', '3_h': 'excluded' });
    const srText = document.querySelector('.sr-only');
    expect(srText?.textContent).toContain('2 cards excluded');
  });

  it('sr-only label mentions uniform distribution probability', () => {
    renderIndicator({}, 40);
    const srText = document.querySelector('.sr-only');
    expect(srText?.textContent).toContain('~40% probability');
  });
});
