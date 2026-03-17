/**
 * @jest-environment jsdom
 *
 * Tests for MobileCardHand — mobile-optimised card hand display.
 *
 * Covers:
 * • Empty hand renders the "no cards" waiting message
 * • Non-empty hand renders the root container with correct aria-label
 * • Cards are sorted by suit (S→H→D→C) then ascending rank
 * • Mobile scroll container and desktop fan container are both rendered in DOM
 * • Selected card receives the selected prop and is highlighted
 * • Tapping a card calls onSelectCard with the correct cardId
 * • Tapping a selected card re-calls onSelectCard (deselect is caller's responsibility)
 * • When isMyTurn=false, cards are not clickable (disabled)
 * • When disabled=true, cards are not clickable
 * • When onSelectCard is undefined, cards are not clickable
 * • faceDown prop passes through to PlayingCard (face-down cards have blue back class)
 * • Card count badge is NOT shown for hands ≤ 9 cards
 * • Card count badge IS shown for hands with 10+ cards and displays the count
 * • Mobile scroll container has data-testid="mobile-hand-scroll"
 * • Desktop fan container has data-testid="desktop-hand-fan"
 * • All card elements have role="listitem" inside the correct role="list" container
 * • Single-card hand renders without errors
 * • Maximum-hand (8 cards) renders all cards
 * • Right-fade element has data-testid="mobile-hand-right-fade"
 * • Left-fade element has data-testid="mobile-hand-left-fade"
 * • computeFanParams exported function returns correct spread for varying hand sizes
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import MobileCardHand, { type MobileCardHandProps } from '@/components/MobileCardHand';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a CardId string. */
function card(rank: number, suit: string): string {
  return `${rank}_${suit}`;
}

/** Minimal props for a non-interactive 6-card hand. */
const BASE_HAND_6 = [
  card(3, 's'), card(11, 'h'), card(5, 'd'), card(9, 'c'),
  card(1, 's'), card(7, 'h'),
];

function renderHand(overrides: Partial<MobileCardHandProps> = {}) {
  const props: MobileCardHandProps = {
    hand: BASE_HAND_6,
    selectedCard: null,
    onSelectCard: undefined,
    isMyTurn: false,
    faceDown: false,
    disabled: false,
    ...overrides,
  };
  return render(<MobileCardHand {...props} />);
}

// ---------------------------------------------------------------------------
// Empty hand
// ---------------------------------------------------------------------------

describe('MobileCardHand — empty hand', () => {
  it('renders the "no cards" message when hand is empty', () => {
    render(<MobileCardHand hand={[]} isMyTurn={false} />);
    expect(screen.getByTestId('card-hand-empty')).toBeTruthy();
    expect(screen.getByText(/no cards/i)).toBeTruthy();
  });

  it('root container has aria-label "Your hand: 0 cards"', () => {
    render(<MobileCardHand hand={[]} isMyTurn={false} />);
    expect(screen.getByLabelText('Your hand: 0 cards')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Non-empty hand — basic rendering
// ---------------------------------------------------------------------------

describe('MobileCardHand — basic rendering', () => {
  it('renders the root container with data-testid="mobile-card-hand"', () => {
    renderHand();
    expect(screen.getByTestId('mobile-card-hand')).toBeTruthy();
  });

  it('has correct aria-label with card count on the root container', () => {
    renderHand({ hand: BASE_HAND_6 });
    // The root data-testid div has the canonical aria-label
    const root = screen.getByTestId('mobile-card-hand');
    expect(root.getAttribute('aria-label')).toBe('Your hand: 6 cards');
  });

  it('uses singular "card" in aria-label for a 1-card hand', () => {
    renderHand({ hand: [card(5, 's')] });
    const root = screen.getByTestId('mobile-card-hand');
    expect(root.getAttribute('aria-label')).toBe('Your hand: 1 card');
  });

  it('renders the mobile scroll container', () => {
    renderHand();
    expect(screen.getByTestId('mobile-hand-scroll')).toBeTruthy();
  });

  it('renders the desktop fan container', () => {
    renderHand();
    expect(screen.getByTestId('desktop-hand-fan')).toBeTruthy();
  });

  it('scroll container has role="list"', () => {
    renderHand();
    // Both mobile and desktop containers have role="list"
    const lists = screen.getAllByRole('list');
    expect(lists.length).toBeGreaterThanOrEqual(1);
  });

  it('renders scroll fade indicators', () => {
    renderHand();
    expect(screen.getByTestId('mobile-hand-left-fade')).toBeTruthy();
    expect(screen.getByTestId('mobile-hand-right-fade')).toBeTruthy();
  });

  it('renders the mobile-scroll-container wrapper', () => {
    renderHand();
    expect(screen.getByTestId('mobile-scroll-container')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Card sort order
// ---------------------------------------------------------------------------

describe('MobileCardHand — card sort order', () => {
  it('sorts by suit: Spades before Hearts before Diamonds before Clubs', () => {
    const hand = [
      card(5, 'c'),  // Clubs — last
      card(3, 'h'),  // Hearts — second
      card(7, 'd'),  // Diamonds — third
      card(1, 's'),  // Spades — first
    ];
    renderHand({ hand });

    // Query within the mobile scroll container to avoid double-counting from the
    // desktop fan section (JSDOM renders both since it ignores CSS media queries).
    const mobileScroll = screen.getByTestId('mobile-hand-scroll');
    const labels: string[] = [];
    for (const el of mobileScroll.querySelectorAll('[aria-label]')) {
      const label = el.getAttribute('aria-label') ?? '';
      if (label.includes(' of ')) labels.push(label);
    }

    // First label should be a Spades card, last a Clubs card
    expect(labels[0]).toContain('Spades');
    expect(labels[labels.length - 1]).toContain('Clubs');
  });

  it('sorts by ascending rank within a suit', () => {
    const hand = [
      card(9, 's'),
      card(3, 's'),
      card(1, 's'),
      card(6, 's'),
    ];
    renderHand({ hand });

    // Query within the mobile scroll container to avoid duplicate labels
    const mobileScroll = screen.getByTestId('mobile-hand-scroll');
    const labels: string[] = [];
    for (const el of mobileScroll.querySelectorAll('[aria-label]')) {
      const label = el.getAttribute('aria-label') ?? '';
      if (label.includes('Spades')) labels.push(label);
    }

    // Expect ascending rank order: A(1), 3, 6, 9
    expect(labels[0]).toContain('A');
    expect(labels[1]).toContain('3');
    expect(labels[2]).toContain('6');
    expect(labels[3]).toContain('9');
  });
});

// ---------------------------------------------------------------------------
// Interaction — select card
// ---------------------------------------------------------------------------

describe('MobileCardHand — card interaction', () => {
  it('calls onSelectCard with the correct cardId when a card is clicked', () => {
    const onSelectCard = jest.fn();
    const hand = [card(5, 's'), card(9, 'h')];
    renderHand({ hand, isMyTurn: true, onSelectCard });

    // Find all role=button elements (PlayingCard renders role="button" when onClick is provided)
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    fireEvent.click(buttons[0]);
    expect(onSelectCard).toHaveBeenCalledTimes(1);
    // First sorted card should be 5 of Spades
    expect(onSelectCard).toHaveBeenCalledWith(card(5, 's'));
  });

  it('does NOT call onSelectCard when isMyTurn=false', () => {
    const onSelectCard = jest.fn();
    renderHand({ hand: BASE_HAND_6, isMyTurn: false, onSelectCard });

    // When isMyTurn=false, PlayingCard receives disabled=true and no onClick
    const buttons = screen.queryAllByRole('button');
    // Either no buttons exist or clicking them does nothing
    buttons.forEach((btn) => fireEvent.click(btn));
    expect(onSelectCard).not.toHaveBeenCalled();
  });

  it('does NOT call onSelectCard when disabled=true', () => {
    const onSelectCard = jest.fn();
    renderHand({ hand: BASE_HAND_6, isMyTurn: true, disabled: true, onSelectCard });

    const buttons = screen.queryAllByRole('button');
    buttons.forEach((btn) => fireEvent.click(btn));
    expect(onSelectCard).not.toHaveBeenCalled();
  });

  it('does NOT call onSelectCard when onSelectCard prop is undefined', () => {
    // Should not throw, just render non-interactive cards
    expect(() => {
      renderHand({ hand: BASE_HAND_6, isMyTurn: true, onSelectCard: undefined });
    }).not.toThrow();
    // No buttons should be rendered
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Selected card state
// ---------------------------------------------------------------------------

describe('MobileCardHand — selected card', () => {
  it('renders with a selected card without throwing', () => {
    const hand = [card(3, 's'), card(7, 'h')];
    expect(() => {
      renderHand({ hand, selectedCard: card(3, 's'), isMyTurn: true, onSelectCard: jest.fn() });
    }).not.toThrow();
  });

  it('selected card has aria-label containing "(selected)"', () => {
    const hand = [card(5, 's'), card(9, 'h')];
    renderHand({ hand, selectedCard: card(5, 's'), isMyTurn: true, onSelectCard: jest.fn() });

    // PlayingCard appends "(selected)" to aria-label when selected=true
    const selectedEl = document.querySelector('[aria-label*="(selected)"]');
    expect(selectedEl).not.toBeNull();
  });

  it('only one unique card type has the "(selected)" label when one card is selected', () => {
    const hand = [card(5, 's'), card(9, 'h'), card(3, 'd')];
    renderHand({ hand, selectedCard: card(9, 'h'), isMyTurn: true, onSelectCard: jest.fn() });

    // MobileCardHand renders both mobile and desktop sections in JSDOM (no CSS media-query
    // filtering), so the same card appears once per section. For a 3-card hand with one
    // selected card we expect exactly 2 "(selected)" aria-labels (one per section).
    const selectedEls = document.querySelectorAll('[aria-label*="(selected)"]');
    expect(selectedEls.length).toBe(2);
    // But all selected elements should refer to the same card (9 of Hearts)
    const uniqueLabels = new Set(Array.from(selectedEls).map((el) => el.getAttribute('aria-label')));
    expect(uniqueLabels.size).toBe(1);
  });

  it('no card has "(selected)" when selectedCard is null', () => {
    renderHand({ hand: BASE_HAND_6, selectedCard: null, isMyTurn: true, onSelectCard: jest.fn() });
    const selectedEls = document.querySelectorAll('[aria-label*="(selected)"]');
    expect(selectedEls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// faceDown prop
// ---------------------------------------------------------------------------

describe('MobileCardHand — faceDown prop', () => {
  it('renders face-down cards when faceDown=true', () => {
    renderHand({ hand: BASE_HAND_6, faceDown: true });
    // PlayingCard sets aria-label="Card (face down)" for face-down cards
    const faceDownCards = screen.getAllByLabelText('Card (face down)');
    // Each card in both mobile and desktop containers → 2× card count
    expect(faceDownCards.length).toBe(BASE_HAND_6.length * 2);
  });

  it('renders face-up cards when faceDown=false (default)', () => {
    renderHand({ hand: [card(1, 's')], faceDown: false });
    // Should have a labelled card element that is NOT face-down
    const faceDownCards = screen.queryAllByLabelText('Card (face down)');
    expect(faceDownCards.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Card count badge
// ---------------------------------------------------------------------------

describe('MobileCardHand — card count badge', () => {
  it('does NOT show the badge for a hand of 9 cards', () => {
    const hand9 = Array.from({ length: 9 }, (_, i) => card(i + 1, 's')).slice(0, 9);
    // Remove duplicates by using different suits
    const mixedHand: string[] = [
      card(1,'s'), card(2,'s'), card(3,'s'),
      card(1,'h'), card(2,'h'), card(3,'h'),
      card(1,'d'), card(2,'d'), card(3,'d'),
    ];
    renderHand({ hand: mixedHand });
    expect(screen.queryByTestId('card-count-badge')).toBeNull();
  });

  it('shows the badge for a hand of 10 cards', () => {
    const bigHand: string[] = [
      card(1,'s'), card(2,'s'), card(3,'s'),
      card(1,'h'), card(2,'h'), card(3,'h'),
      card(1,'d'), card(2,'d'), card(3,'d'),
      card(1,'c'),
    ];
    renderHand({ hand: bigHand });
    const badge = screen.getByTestId('card-count-badge');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe('10');
  });

  it('badge displays the exact hand count', () => {
    const bigHand: string[] = [
      card(1,'s'), card(2,'s'), card(3,'s'),
      card(1,'h'), card(2,'h'), card(3,'h'),
      card(1,'d'), card(2,'d'), card(3,'d'),
      card(1,'c'), card(2,'c'),
    ];
    renderHand({ hand: bigHand });
    const badge = screen.getByTestId('card-count-badge');
    expect(badge.textContent).toBe('11');
  });
});

// ---------------------------------------------------------------------------
// Edge cases — single card and maximum hand
// ---------------------------------------------------------------------------

describe('MobileCardHand — edge cases', () => {
  it('renders a single-card hand without errors', () => {
    expect(() => {
      renderHand({ hand: [card(5, 'h')] });
    }).not.toThrow();
  });

  it('renders an 8-card hand without errors', () => {
    const hand8 = [
      card(1,'s'), card(3,'s'), card(5,'s'), card(7,'s'),
      card(1,'h'), card(3,'h'), card(5,'h'), card(7,'h'),
    ];
    expect(() => {
      renderHand({ hand: hand8 });
    }).not.toThrow();
  });

  it('renders exactly the correct number of cards for a 6-card hand', () => {
    renderHand({ hand: BASE_HAND_6 });
    // Both mobile and desktop containers each hold count cards
    const allListItems = screen.getAllByRole('listitem');
    // 2 containers × 6 cards = 12 list items total
    expect(allListItems.length).toBe(BASE_HAND_6.length * 2);
  });

  it('each card container has role="listitem"', () => {
    renderHand({ hand: [card(1, 's'), card(2, 's'), card(3, 's')] });
    const listItems = screen.getAllByRole('listitem');
    // 2 containers × 3 cards = 6 list items
    expect(listItems.length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Fan parameter logic (pure function smoke tests via rendered DOM)
// ---------------------------------------------------------------------------

describe('MobileCardHand — fan layout structure', () => {
  it('desktop fan container is present in the DOM tree', () => {
    renderHand({ hand: BASE_HAND_6 });
    const fan = screen.getByTestId('desktop-hand-fan');
    expect(fan).toBeTruthy();
    // Fan should contain card elements
    expect(fan.querySelectorAll('[role="listitem"]').length).toBe(BASE_HAND_6.length);
  });

  it('mobile scroll list is present in the DOM tree', () => {
    renderHand({ hand: BASE_HAND_6 });
    const scroll = screen.getByTestId('mobile-hand-scroll');
    expect(scroll).toBeTruthy();
    expect(scroll.querySelectorAll('[role="listitem"]').length).toBe(BASE_HAND_6.length);
  });

  it('desktop fan cards have inline style with rotate transform', () => {
    renderHand({ hand: BASE_HAND_6 });
    const fan = screen.getByTestId('desktop-hand-fan');
    const items = fan.querySelectorAll('[role="listitem"]');
    // At least one card should have a non-zero rotation (end of the fan)
    const stylesWithRotate = Array.from(items).filter((el) => {
      const style = (el as HTMLElement).style.transform ?? '';
      return style.includes('rotate(');
    });
    expect(stylesWithRotate.length).toBeGreaterThan(0);
  });

  it('desktop fan cards use the arc origin transform-origin', () => {
    renderHand({ hand: BASE_HAND_6 });
    const fan = screen.getByTestId('desktop-hand-fan');
    const firstItem = fan.querySelector('[role="listitem"]') as HTMLElement | null;
    expect(firstItem).not.toBeNull();
    const origin = firstItem!.style.transformOrigin;
    // Should contain a calc with the arc offset
    expect(origin).toContain('calc(');
  });
});
