/**
 * @jest-environment jsdom
 *
 * Tests for DesktopCardHand — desktop card hand display
 *
 * Coverage:
 * Rendering
 * • Renders the desktop hand container (data-testid="desktop-card-hand")
 * • Shows empty-state message when hand is empty
 * • Renders all cards in the hand
 * • Renders suit-group containers for each suit present
 * • Shows suit symbol labels (♠ ♥ ♦ ♣) above each group
 *
 * Sorting
 * • Cards are sorted by suit: spades → hearts → diamonds → clubs
 * • Within a suit, cards are sorted low-to-high (A first)
 * • Sorted order respects the remove_7s variant (7 excluded from ranks)
 * • Sorted order respects the remove_2s variant (2 excluded from ranks)
 * • Sorted order respects the remove_8s variant (8 excluded from ranks)
 *
 * Half-suit boundary
 * • Renders half-suit boundary notch when variant provided and suit has cards spanning the boundary
 * • Does NOT render boundary notch when all cards are in the same half-suit
 * • Does NOT render boundary notch when variant is not provided
 *
 * Selection
 * • No card is selected by default
 * • Selected card has aria "selected" in its label
 * • Clicking a card calls onSelectCard with the correct cardId
 * • onSelectCard is not called when disabled
 * • onSelectCard is not called when isMyTurn is false
 * • onSelectCard is not called when canInteract is false (no callback provided)
 *
 * Card count
 * • Card count badge shown for hands with ≥8 cards
 * • Card count badge NOT shown for hands with <8 cards
 *
 * Accessibility
 * • Root has aria-label "Your hand: N cards"
 * • Each suit group has a descriptive aria-label
 * • Each card wrapper is a listitem
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import DesktopCardHand from '@/components/DesktopCardHand';
import type { CardId } from '@/types/game';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderHand(props: {
  hand: CardId[];
  selectedCard?: CardId | null;
  onSelectCard?: (c: CardId) => void;
  isMyTurn?: boolean;
  disabled?: boolean;
  variant?: 'remove_2s' | 'remove_7s' | 'remove_8s';
}) {
  return render(
    <DesktopCardHand
      hand={props.hand}
      selectedCard={props.selectedCard ?? null}
      onSelectCard={props.onSelectCard}
      isMyTurn={props.isMyTurn ?? true}
      disabled={props.disabled ?? false}
      variant={props.variant}
    />
  );
}

// Simple 6-card hand spanning all 4 suits
const MIXED_HAND: CardId[] = ['1_s', '5_h', '3_d', '9_c', '13_s', '2_h'];

// 8-card hand for count-badge tests
const LARGE_HAND: CardId[] = [
  '1_s', '3_s', '5_s',
  '1_h', '3_h',
  '1_d', '3_d',
  '1_c',
];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('DesktopCardHand — rendering', () => {
  it('renders the desktop hand container', () => {
    renderHand({ hand: MIXED_HAND });
    expect(screen.getByTestId('desktop-card-hand')).toBeInTheDocument();
  });

  it('shows empty-state message when hand is empty', () => {
    renderHand({ hand: [] });
    expect(screen.getByTestId('desktop-hand-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('desktop-card-hand')).not.toBeInTheDocument();
  });

  it('renders all cards in the hand', () => {
    renderHand({ hand: MIXED_HAND });
    for (const cardId of MIXED_HAND) {
      expect(screen.getByTestId(`card-wrapper-${cardId}`)).toBeInTheDocument();
    }
  });

  it('renders a suit-group for each suit present in the hand', () => {
    renderHand({ hand: MIXED_HAND });
    // MIXED_HAND has s, h, d, c
    expect(screen.getByTestId('suit-group-s')).toBeInTheDocument();
    expect(screen.getByTestId('suit-group-h')).toBeInTheDocument();
    expect(screen.getByTestId('suit-group-d')).toBeInTheDocument();
    expect(screen.getByTestId('suit-group-c')).toBeInTheDocument();
  });

  it('shows suit symbol labels above each group', () => {
    renderHand({ hand: MIXED_HAND });
    expect(screen.getByTestId('suit-label-s')).toHaveTextContent('♠');
    expect(screen.getByTestId('suit-label-h')).toHaveTextContent('♥');
    expect(screen.getByTestId('suit-label-d')).toHaveTextContent('♦');
    expect(screen.getByTestId('suit-label-c')).toHaveTextContent('♣');
  });

  it('does not render a suit-group for an absent suit', () => {
    // Hand with only spades
    renderHand({ hand: ['1_s', '3_s', '5_s'] });
    expect(screen.getByTestId('suit-group-s')).toBeInTheDocument();
    expect(screen.queryByTestId('suit-group-h')).not.toBeInTheDocument();
    expect(screen.queryByTestId('suit-group-d')).not.toBeInTheDocument();
    expect(screen.queryByTestId('suit-group-c')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe('DesktopCardHand — sorting', () => {
  it('places all spades before hearts before diamonds before clubs', () => {
    renderHand({ hand: MIXED_HAND });

    const spadeGroup = screen.getByTestId('suit-group-s');
    const heartGroup = screen.getByTestId('suit-group-h');
    const diamondGroup = screen.getByTestId('suit-group-d');
    const clubGroup = screen.getByTestId('suit-group-c');

    // DOM order: spades appears before hearts which appears before clubs
    const groups = [spadeGroup, heartGroup, diamondGroup, clubGroup];
    for (let i = 0; i < groups.length - 1; i++) {
      const pos = groups[i].compareDocumentPosition(groups[i + 1]);
      // DOCUMENT_POSITION_FOLLOWING = 4
      expect(pos & 4).toBe(4);
    }
  });

  it('sorts cards within a suit low-to-high (Ace first)', () => {
    // 5 spades in shuffled order
    const spadesHand: CardId[] = ['13_s', '1_s', '5_s', '3_s', '9_s'];
    renderHand({ hand: spadesHand });

    const spadeGroup = screen.getByTestId('suit-group-s');
    const wrappers = within(spadeGroup).getAllByTestId(/^card-wrapper-/);
    const renderedIds = wrappers.map((el) =>
      el.getAttribute('data-testid')!.replace('card-wrapper-', '')
    );

    // With no variant: ranks in all-rank order [1,2,3,...,13]
    // We have ranks 1,3,5,9,13 — expect them sorted ascending by rank
    expect(renderedIds).toEqual(['1_s', '3_s', '5_s', '9_s', '13_s']);
  });

  it('sorts within a suit correctly for remove_7s variant (7 removed)', () => {
    // Hand includes spades on both sides of where 7 would be
    const hand: CardId[] = ['9_s', '1_s', '6_s', '8_s', '3_s'];
    renderHand({ hand, variant: 'remove_7s' });

    const spadeGroup = screen.getByTestId('suit-group-s');
    const wrappers = within(spadeGroup).getAllByTestId(/^card-wrapper-/);
    const renderedIds = wrappers.map((el) =>
      el.getAttribute('data-testid')!.replace('card-wrapper-', '')
    );

    // remove_7s: remaining ranks = [1,2,3,4,5,6,8,9,10,11,12,13]
    // Our cards sorted: 1, 3, 6, 8, 9
    expect(renderedIds).toEqual(['1_s', '3_s', '6_s', '8_s', '9_s']);
  });

  it('sorts within a suit correctly for remove_2s variant (2 removed)', () => {
    const hand: CardId[] = ['3_h', '1_h', '13_h', '5_h'];
    renderHand({ hand, variant: 'remove_2s' });

    const heartGroup = screen.getByTestId('suit-group-h');
    const wrappers = within(heartGroup).getAllByTestId(/^card-wrapper-/);
    const renderedIds = wrappers.map((el) =>
      el.getAttribute('data-testid')!.replace('card-wrapper-', '')
    );
    // remove_2s: remaining ranks = [1,3,4,5,6,7,8,9,10,11,12,13]
    // Our cards sorted: 1, 3, 5, 13
    expect(renderedIds).toEqual(['1_h', '3_h', '5_h', '13_h']);
  });

  it('sorts within a suit correctly for remove_8s variant (8 removed)', () => {
    const hand: CardId[] = ['9_d', '8_d', '6_d', '1_d'];
    // 8 should NOT be in the hand for this variant, but the sort should still work
    // Let's test with valid cards:
    const validHand: CardId[] = ['9_d', '6_d', '1_d', '13_d'];
    renderHand({ hand: validHand, variant: 'remove_8s' });

    const diamondGroup = screen.getByTestId('suit-group-d');
    const wrappers = within(diamondGroup).getAllByTestId(/^card-wrapper-/);
    const renderedIds = wrappers.map((el) =>
      el.getAttribute('data-testid')!.replace('card-wrapper-', '')
    );
    // remove_8s: remaining ranks = [1,2,3,4,5,6,7,9,10,11,12,13]
    // Our cards sorted: 1, 6, 9, 13
    expect(renderedIds).toEqual(['1_d', '6_d', '9_d', '13_d']);
  });
});

// ---------------------------------------------------------------------------
// Half-suit boundary
// ---------------------------------------------------------------------------

describe('DesktopCardHand — half-suit boundary notch', () => {
  it('renders the boundary notch when variant is provided and hand spans the boundary', () => {
    // remove_7s: low half = [1,2,3,4,5,6], high half = [8,9,10,11,12,13]
    // Hand: 6_s (rank index 5, last of low) and 8_s (rank index 6, first of high)
    const hand: CardId[] = ['6_s', '8_s', '1_s', '9_s'];
    renderHand({ hand, variant: 'remove_7s' });
    expect(screen.getByTestId('half-suit-boundary-s')).toBeInTheDocument();
  });

  it('does NOT render the boundary notch when all cards are in the low half', () => {
    // remove_7s: low half = [1,2,3,4,5,6]
    const hand: CardId[] = ['1_s', '3_s', '5_s'];
    renderHand({ hand, variant: 'remove_7s' });
    expect(screen.queryByTestId('half-suit-boundary-s')).not.toBeInTheDocument();
  });

  it('does NOT render the boundary notch when all cards are in the high half', () => {
    // remove_7s: high half = [8,9,10,11,12,13]
    const hand: CardId[] = ['9_s', '11_s', '13_s'];
    renderHand({ hand, variant: 'remove_7s' });
    expect(screen.queryByTestId('half-suit-boundary-s')).not.toBeInTheDocument();
  });

  it('does NOT render the boundary notch when no variant provided', () => {
    // Without variant all cards are treated as having unknown priority
    const hand: CardId[] = ['1_s', '3_s', '9_s', '13_s'];
    renderHand({ hand });
    expect(screen.queryByTestId('half-suit-boundary-s')).not.toBeInTheDocument();
  });

  it('renders boundary notch for remove_2s variant correctly', () => {
    // remove_2s: low half = [1,3,4,5,6,7], high half = [8,9,10,11,12,13]
    // rank 7 is index 5 (last of low), rank 8 is index 6 (first of high)
    const hand: CardId[] = ['1_h', '3_h', '7_h', '8_h', '9_h'];
    renderHand({ hand, variant: 'remove_2s' });
    expect(screen.getByTestId('half-suit-boundary-h')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe('DesktopCardHand — selection', () => {
  it('calls onSelectCard with the correct cardId when a card is clicked', () => {
    const onSelectCard = jest.fn();
    renderHand({ hand: MIXED_HAND, onSelectCard, isMyTurn: true });

    const wrapper = screen.getByTestId('card-wrapper-1_s');
    const button = within(wrapper).getByRole('button');
    fireEvent.click(button);
    expect(onSelectCard).toHaveBeenCalledWith('1_s');
  });

  it('does NOT call onSelectCard when disabled is true', () => {
    const onSelectCard = jest.fn();
    renderHand({ hand: MIXED_HAND, onSelectCard, isMyTurn: true, disabled: true });

    // Cards should have role=img (not button) when disabled
    const card = screen.getAllByRole('img')[0];
    fireEvent.click(card);
    expect(onSelectCard).not.toHaveBeenCalled();
  });

  it('does NOT call onSelectCard when isMyTurn is false', () => {
    const onSelectCard = jest.fn();
    renderHand({ hand: MIXED_HAND, onSelectCard, isMyTurn: false });

    const card = screen.getAllByRole('img')[0];
    fireEvent.click(card);
    expect(onSelectCard).not.toHaveBeenCalled();
  });

  it('does NOT call onSelectCard when no onSelectCard callback is provided', () => {
    // No callback — should render without errors
    expect(() => {
      renderHand({ hand: MIXED_HAND, isMyTurn: true });
    }).not.toThrow();
  });

  it('renders the selected card with "selected" in its aria-label', () => {
    // onSelectCard must be provided so PlayingCard renders role="button"
    const onSelectCard = jest.fn();
    renderHand({ hand: MIXED_HAND, selectedCard: '1_s', isMyTurn: true, onSelectCard });
    // PlayingCard with selected=true adds "(selected)" to aria-label
    const selectedCard = screen.getByRole('button', { name: /A of Spades \(selected\)/i });
    expect(selectedCard).toBeInTheDocument();
  });

  it('keyboard Enter triggers onSelectCard', () => {
    const onSelectCard = jest.fn();
    renderHand({ hand: ['1_s'], onSelectCard, isMyTurn: true });

    const button = screen.getByRole('button', { name: /A of Spades/i });
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(onSelectCard).toHaveBeenCalledWith('1_s');
  });

  it('keyboard Space triggers onSelectCard', () => {
    const onSelectCard = jest.fn();
    renderHand({ hand: ['5_h'], onSelectCard, isMyTurn: true });

    const button = screen.getByRole('button', { name: /5 of Hearts/i });
    fireEvent.keyDown(button, { key: ' ' });
    expect(onSelectCard).toHaveBeenCalledWith('5_h');
  });
});

// ---------------------------------------------------------------------------
// Card count badge
// ---------------------------------------------------------------------------

describe('DesktopCardHand — card count badge', () => {
  it('shows count badge for a hand with 8 or more cards', () => {
    renderHand({ hand: LARGE_HAND }); // LARGE_HAND has exactly 8 cards
    expect(screen.getByTestId('desktop-hand-count')).toBeInTheDocument();
    expect(screen.getByTestId('desktop-hand-count')).toHaveTextContent('8 cards');
  });

  it('does NOT show count badge for a hand with fewer than 8 cards', () => {
    renderHand({ hand: MIXED_HAND }); // 6 cards
    expect(screen.queryByTestId('desktop-hand-count')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe('DesktopCardHand — accessibility', () => {
  it('root has correct aria-label with card count', () => {
    renderHand({ hand: MIXED_HAND });
    expect(screen.getByTestId('desktop-card-hand')).toHaveAttribute(
      'aria-label',
      'Your hand: 6 cards'
    );
  });

  it('uses singular "card" for a 1-card hand', () => {
    renderHand({ hand: ['1_s'] });
    expect(screen.getByTestId('desktop-card-hand')).toHaveAttribute(
      'aria-label',
      'Your hand: 1 card'
    );
  });

  it('each suit group has a descriptive aria-label', () => {
    renderHand({ hand: ['1_s', '3_s', '5_h'] });
    expect(screen.getByTestId('suit-group-s')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Spades')
    );
    expect(screen.getByTestId('suit-group-h')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Hearts')
    );
  });

  it('each card wrapper has role listitem', () => {
    renderHand({ hand: ['1_s', '5_h'] });
    const wrappers = screen.getAllByRole('listitem');
    expect(wrappers.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// CardHand integration (desktop branch)
// ---------------------------------------------------------------------------

describe('CardHand — desktop branch renders DesktopCardHand', () => {
  it('renders desktop-card-hand inside CardHand', async () => {
    // Dynamic import to avoid import order issues
    const { default: CardHand } = await import('@/components/CardHand');
    render(
      <CardHand
        hand={['1_s', '3_h', '5_d']}
        isMyTurn={true}
        variant="remove_7s"
      />
    );
    expect(screen.getByTestId('desktop-card-hand')).toBeInTheDocument();
  });

  it('passes variant through CardHand to DesktopCardHand for boundary notch', async () => {
    const { default: CardHand } = await import('@/components/CardHand');
    // remove_7s: 6_s (low) and 8_s (high) span the boundary
    render(
      <CardHand
        hand={['1_s', '6_s', '8_s', '13_s']}
        isMyTurn={true}
        variant="remove_7s"
      />
    );
    expect(screen.getByTestId('half-suit-boundary-s')).toBeInTheDocument();
  });
});
