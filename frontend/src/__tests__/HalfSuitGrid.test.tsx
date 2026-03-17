/**
 * Tests for HalfSuitGrid component.
 *
 * Verifies:
 * - Renders 8 slots for all half-suits
 * - Neutral/empty state for unclaimed slots
 * - Team 1 (emerald) coloring for team 1 declarations
 * - Team 2 (violet) coloring for team 2 declarations
 * - Tiebreaker indicator on high-diamonds slot
 * - Correct aria labels for accessibility
 * - Correct data-team attributes
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { HalfSuitGrid, HalfSuitGridProps } from '../components/HalfSuitGrid';
import { DeclaredSuit } from '../types/game';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderGrid(props: Partial<HalfSuitGridProps> = {}) {
  return render(<HalfSuitGrid declaredSuits={[]} {...props} />);
}

function getSlot(halfSuitId: string) {
  return screen.getByTestId(`half-suit-slot-${halfSuitId}`);
}

// ---------------------------------------------------------------------------
// Basic rendering
// ---------------------------------------------------------------------------

describe('HalfSuitGrid — basic rendering', () => {
  it('renders the grid container with role="grid"', () => {
    renderGrid();
    const grid = screen.getByRole('grid', { name: /half-suit scoreboard/i });
    expect(grid).toBeInTheDocument();
  });

  it('renders exactly 8 slots', () => {
    renderGrid();
    const cells = screen.getAllByRole('gridcell');
    expect(cells).toHaveLength(8);
  });

  it('renders a slot for every half-suit ID', () => {
    renderGrid();
    const ids = [
      'high_s', 'high_h', 'high_d', 'high_c',
      'low_s',  'low_h',  'low_d',  'low_c',
    ];
    for (const id of ids) {
      expect(screen.getByTestId(`half-suit-slot-${id}`)).toBeInTheDocument();
    }
  });
});

// ---------------------------------------------------------------------------
// Unclaimed / neutral state
// ---------------------------------------------------------------------------

describe('HalfSuitGrid — unclaimed slots', () => {
  it('all slots have data-team="none" when no suits are declared', () => {
    renderGrid();
    const cells = screen.getAllByRole('gridcell');
    for (const cell of cells) {
      expect(cell).toHaveAttribute('data-team', 'none');
    }
  });

  it('unclaimed slot aria-label contains "Unclaimed"', () => {
    renderGrid();
    const slot = getSlot('low_s');
    expect(slot).toHaveAttribute('aria-label', expect.stringContaining('Unclaimed'));
  });

  it('unclaimed high-diamonds slot aria-label mentions tiebreaker', () => {
    renderGrid();
    const slot = getSlot('high_d');
    expect(slot).toHaveAttribute('aria-label', expect.stringContaining('tiebreaker'));
  });
});

// ---------------------------------------------------------------------------
// Team 1 declarations
// ---------------------------------------------------------------------------

describe('HalfSuitGrid — Team 1 declared slots', () => {
  const team1Declaration: DeclaredSuit = {
    halfSuitId: 'low_s',
    teamId: 1,
    declaredBy: 'player1',
  };

  it('declared slot has data-team="1"', () => {
    renderGrid({ declaredSuits: [team1Declaration] });
    expect(getSlot('low_s')).toHaveAttribute('data-team', '1');
  });

  it('declared Team 1 slot aria-label contains "Team 1"', () => {
    renderGrid({ declaredSuits: [team1Declaration] });
    expect(getSlot('low_s')).toHaveAttribute('aria-label', expect.stringContaining('Team 1'));
  });

  it('declared Team 1 slot has emerald background class', () => {
    renderGrid({ declaredSuits: [team1Declaration] });
    const slot = getSlot('low_s');
    expect(slot.className).toMatch(/emerald/);
  });

  it('non-declared slot stays neutral when only one suit is declared', () => {
    renderGrid({ declaredSuits: [team1Declaration] });
    expect(getSlot('low_h')).toHaveAttribute('data-team', 'none');
  });
});

// ---------------------------------------------------------------------------
// Team 2 declarations
// ---------------------------------------------------------------------------

describe('HalfSuitGrid — Team 2 declared slots', () => {
  const team2Declaration: DeclaredSuit = {
    halfSuitId: 'high_h',
    teamId: 2,
    declaredBy: 'player2',
  };

  it('declared slot has data-team="2"', () => {
    renderGrid({ declaredSuits: [team2Declaration] });
    expect(getSlot('high_h')).toHaveAttribute('data-team', '2');
  });

  it('declared Team 2 slot aria-label contains "Team 2"', () => {
    renderGrid({ declaredSuits: [team2Declaration] });
    expect(getSlot('high_h')).toHaveAttribute('aria-label', expect.stringContaining('Team 2'));
  });

  it('declared Team 2 slot has violet background class', () => {
    renderGrid({ declaredSuits: [team2Declaration] });
    const slot = getSlot('high_h');
    expect(slot.className).toMatch(/violet/);
  });
});

// ---------------------------------------------------------------------------
// Mixed declarations
// ---------------------------------------------------------------------------

describe('HalfSuitGrid — mixed declarations', () => {
  const mixedDeclarations: DeclaredSuit[] = [
    { halfSuitId: 'low_s',  teamId: 1, declaredBy: 'p1' },
    { halfSuitId: 'low_h',  teamId: 2, declaredBy: 'p2' },
    { halfSuitId: 'high_d', teamId: 1, declaredBy: 'p3' },
    { halfSuitId: 'high_c', teamId: 2, declaredBy: 'p4' },
  ];

  it('correctly assigns team colors to 4 declared and 4 neutral slots', () => {
    renderGrid({ declaredSuits: mixedDeclarations });

    expect(getSlot('low_s')).toHaveAttribute('data-team', '1');
    expect(getSlot('low_h')).toHaveAttribute('data-team', '2');
    expect(getSlot('high_d')).toHaveAttribute('data-team', '1');
    expect(getSlot('high_c')).toHaveAttribute('data-team', '2');

    // Neutral slots
    expect(getSlot('low_d')).toHaveAttribute('data-team', 'none');
    expect(getSlot('low_c')).toHaveAttribute('data-team', 'none');
    expect(getSlot('high_s')).toHaveAttribute('data-team', 'none');
    expect(getSlot('high_h')).toHaveAttribute('data-team', 'none');
  });

  it('Team 1 slots use emerald classes; Team 2 slots use violet classes', () => {
    renderGrid({ declaredSuits: mixedDeclarations });

    expect(getSlot('low_s').className).toMatch(/emerald/);
    expect(getSlot('low_h').className).toMatch(/violet/);
    expect(getSlot('high_d').className).toMatch(/emerald/);
    expect(getSlot('high_c').className).toMatch(/violet/);
  });
});

// ---------------------------------------------------------------------------
// Fully declared board
// ---------------------------------------------------------------------------

describe('HalfSuitGrid — fully declared board', () => {
  const allDeclared: DeclaredSuit[] = [
    { halfSuitId: 'low_s',  teamId: 1, declaredBy: 'p1' },
    { halfSuitId: 'low_h',  teamId: 2, declaredBy: 'p2' },
    { halfSuitId: 'low_d',  teamId: 1, declaredBy: 'p3' },
    { halfSuitId: 'low_c',  teamId: 2, declaredBy: 'p4' },
    { halfSuitId: 'high_s', teamId: 1, declaredBy: 'p5' },
    { halfSuitId: 'high_h', teamId: 2, declaredBy: 'p6' },
    { halfSuitId: 'high_d', teamId: 1, declaredBy: 'p7' },
    { halfSuitId: 'high_c', teamId: 2, declaredBy: 'p8' },
  ];

  it('no slot has data-team="none" when all 8 suits are declared', () => {
    renderGrid({ declaredSuits: allDeclared });
    const cells = screen.getAllByRole('gridcell');
    for (const cell of cells) {
      expect(cell).not.toHaveAttribute('data-team', 'none');
    }
  });
});

// ---------------------------------------------------------------------------
// Tiebreaker indicator
// ---------------------------------------------------------------------------

describe('HalfSuitGrid — tiebreaker indicator', () => {
  it('high_d slot aria-label mentions tiebreaker when unclaimed', () => {
    renderGrid();
    expect(getSlot('high_d')).toHaveAttribute('aria-label', expect.stringContaining('tiebreaker'));
  });

  it('high_d slot aria-label mentions tiebreaker when declared by Team 1', () => {
    renderGrid({
      declaredSuits: [{ halfSuitId: 'high_d', teamId: 1, declaredBy: 'p1' }],
    });
    expect(getSlot('high_d')).toHaveAttribute('aria-label', expect.stringContaining('tiebreaker'));
  });

  it('high_d slot aria-label mentions tiebreaker when declared by Team 2', () => {
    renderGrid({
      declaredSuits: [{ halfSuitId: 'high_d', teamId: 2, declaredBy: 'p2' }],
    });
    expect(getSlot('high_d')).toHaveAttribute('aria-label', expect.stringContaining('tiebreaker'));
  });

  it('other slots do NOT mention tiebreaker', () => {
    renderGrid();
    const nonTiebreaker = ['low_s', 'low_h', 'low_d', 'low_c', 'high_s', 'high_h', 'high_c'];
    for (const id of nonTiebreaker) {
      expect(getSlot(id)).not.toHaveAttribute(
        'aria-label',
        expect.stringContaining('tiebreaker')
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Aria labels
// ---------------------------------------------------------------------------

describe('HalfSuitGrid — aria labels', () => {
  it.each([
    ['high_s', 'High Spades: Unclaimed'],
    ['high_h', 'High Hearts: Unclaimed'],
    ['high_d', 'High Diamonds: Unclaimed (tiebreaker)'],
    ['high_c', 'High Clubs: Unclaimed'],
    ['low_s',  'Low Spades: Unclaimed'],
    ['low_h',  'Low Hearts: Unclaimed'],
    ['low_d',  'Low Diamonds: Unclaimed'],
    ['low_c',  'Low Clubs: Unclaimed'],
  ])('slot %s has aria-label "%s" when unclaimed', (id, expectedLabel) => {
    renderGrid();
    expect(getSlot(id)).toHaveAttribute('aria-label', expectedLabel);
  });

  it('declared slot aria-label reflects team', () => {
    renderGrid({
      declaredSuits: [{ halfSuitId: 'low_c', teamId: 2, declaredBy: 'p1' }],
    });
    expect(getSlot('low_c')).toHaveAttribute('aria-label', 'Low Clubs: Team 2');
  });
});

// ---------------------------------------------------------------------------
// className prop forwarding
// ---------------------------------------------------------------------------

describe('HalfSuitGrid — className prop', () => {
  it('applies extra className to the grid wrapper', () => {
    const { container } = renderGrid({ className: 'custom-class' });
    expect(container.firstChild).toHaveClass('custom-class');
  });
});
