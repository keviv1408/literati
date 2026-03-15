/**
 * @jest-environment jsdom
 *
 * Tests for CardFlipWrapper — Sub-AC 2 of AC 33.
 *
 * CardFlipWrapper renders a playing card with a 3-D flip animation that
 * transitions from card-back (face-down) to card-face (face-up) on mount.
 *
 * Coverage:
 *
 *   Structure
 *   • Renders the perspective container (data-testid="card-flip-wrapper")
 *   • Renders the inner flip div (data-testid="card-flip-inner")
 *   • Renders a front face (data-testid="card-flip-front")
 *   • Renders a back face (data-testid="card-flip-back")
 *
 *   Front face
 *   • Renders a face-up PlayingCard (has rank/suit text, NOT aria "face down")
 *   • Forwards the `selected` prop to the front-face PlayingCard
 *   • Forwards `disabled` and `onClick` to the front-face PlayingCard
 *   • Forwards `size` to the front-face PlayingCard
 *
 *   Back face
 *   • Renders a face-down PlayingCard (aria-label contains "face down")
 *   • Back face has aria-hidden="true" (excluded from accessibility tree)
 *   • Back face div has transform: rotateY(180deg)
 *
 *   Animation class
 *   • Inner flip div carries the animate-card-flip-reveal CSS class
 *
 *   Perspective container
 *   • Root div has inline perspective style applied
 *
 *   Default props
 *   • selected defaults to false (no "(selected)" in front aria-label)
 *   • disabled defaults to false (no opacity-40 class on front card)
 *   • size defaults to "md" (w-12 class on front card)
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CardFlipWrapper from '@/components/CardFlipWrapper';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWrapper(overrides: Partial<Parameters<typeof CardFlipWrapper>[0]> = {}) {
  const defaults = { cardId: '5_s' };
  return render(<CardFlipWrapper {...defaults} {...overrides} />);
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe('CardFlipWrapper — structure', () => {
  it('renders the perspective wrapper with data-testid="card-flip-wrapper"', () => {
    renderWrapper();
    expect(screen.getByTestId('card-flip-wrapper')).toBeTruthy();
  });

  it('renders the inner flip div with data-testid="card-flip-inner"', () => {
    renderWrapper();
    expect(screen.getByTestId('card-flip-inner')).toBeTruthy();
  });

  it('renders a front face container with data-testid="card-flip-front"', () => {
    renderWrapper();
    expect(screen.getByTestId('card-flip-front')).toBeTruthy();
  });

  it('renders a back face container with data-testid="card-flip-back"', () => {
    renderWrapper();
    expect(screen.getByTestId('card-flip-back')).toBeTruthy();
  });

  it('front face is a child of the inner flip div', () => {
    renderWrapper();
    const inner = screen.getByTestId('card-flip-inner');
    const front = screen.getByTestId('card-flip-front');
    expect(inner.contains(front)).toBe(true);
  });

  it('back face is a child of the inner flip div', () => {
    renderWrapper();
    const inner = screen.getByTestId('card-flip-inner');
    const back  = screen.getByTestId('card-flip-back');
    expect(inner.contains(back)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Front face — face-up PlayingCard
// ---------------------------------------------------------------------------

describe('CardFlipWrapper — front face', () => {
  it('renders a face-up PlayingCard (aria-label does NOT contain "face down")', () => {
    renderWrapper({ cardId: '5_s' });
    // The face-up card should have an aria-label like "5 of Spades"
    const front = screen.getByTestId('card-flip-front');
    const faceUpCard = front.querySelector('[aria-label]');
    expect(faceUpCard?.getAttribute('aria-label')).not.toContain('face down');
    expect(faceUpCard?.getAttribute('aria-label')).not.toContain('face-down');
  });

  it('front card aria-label contains the rank and suit', () => {
    renderWrapper({ cardId: '1_s' });
    const front = screen.getByTestId('card-flip-front');
    const card = front.querySelector('[aria-label]');
    expect(card?.getAttribute('aria-label')).toContain('Spades');
  });

  it('forwards selected=true to front-face card (aria-label includes "(selected)")', () => {
    renderWrapper({ cardId: '5_s', selected: true });
    const front = screen.getByTestId('card-flip-front');
    const card = front.querySelector('[aria-label]');
    expect(card?.getAttribute('aria-label')).toContain('(selected)');
  });

  it('with selected=false, aria-label does NOT contain "(selected)"', () => {
    renderWrapper({ cardId: '5_s', selected: false });
    const front = screen.getByTestId('card-flip-front');
    const card = front.querySelector('[aria-label]');
    expect(card?.getAttribute('aria-label')).not.toContain('(selected)');
  });

  it('forwards disabled=true to front-face card (adds opacity-40 class)', () => {
    renderWrapper({ cardId: '5_s', disabled: true });
    const front = screen.getByTestId('card-flip-front');
    const card = front.firstElementChild as HTMLElement;
    expect(card?.className).toContain('opacity-40');
  });

  it('with disabled=false, front card does NOT have opacity-40 class', () => {
    renderWrapper({ cardId: '5_s', disabled: false });
    const front = screen.getByTestId('card-flip-front');
    const card = front.firstElementChild as HTMLElement;
    expect(card?.className).not.toContain('opacity-40');
  });

  it('forwards onClick to front-face card — callback fires on click', async () => {
    const user = userEvent.setup();
    const onClick = jest.fn();
    renderWrapper({ cardId: '5_s', onClick });
    // Front face card should be a button (role="button") since onClick is provided
    const front = screen.getByTestId('card-flip-front');
    const button = front.querySelector('[role="button"]') as HTMLElement;
    expect(button).toBeTruthy();
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('no click handler on front card when onClick not provided', () => {
    renderWrapper({ cardId: '5_s' });
    const front = screen.getByTestId('card-flip-front');
    // Without onClick, card should render as role="img" not role="button"
    const img = front.querySelector('[role="img"]');
    expect(img).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Back face — face-down PlayingCard
// ---------------------------------------------------------------------------

describe('CardFlipWrapper — back face', () => {
  it('renders a face-down PlayingCard inside the back face container', () => {
    renderWrapper({ cardId: '5_s' });
    const back = screen.getByTestId('card-flip-back');
    // Face-down card should have aria-label "Card (face down)"
    const faceDownCard = back.querySelector('[aria-label="Card (face down)"]');
    expect(faceDownCard).toBeTruthy();
  });

  it('back face container has aria-hidden="true"', () => {
    renderWrapper();
    const back = screen.getByTestId('card-flip-back');
    expect(back.getAttribute('aria-hidden')).toBe('true');
  });

  it('back face div has transform: rotateY(180deg) in inline style', () => {
    renderWrapper();
    const back = screen.getByTestId('card-flip-back');
    const style = back.getAttribute('style') ?? '';
    expect(style).toContain('rotateY(180deg)');
  });

  it('back face div is absolutely positioned (position: absolute in style)', () => {
    renderWrapper();
    const back = screen.getByTestId('card-flip-back');
    const style = back.getAttribute('style') ?? '';
    expect(style).toContain('absolute');
  });
});

// ---------------------------------------------------------------------------
// Animation class
// ---------------------------------------------------------------------------

describe('CardFlipWrapper — animation class', () => {
  it('inner flip div has the animate-card-flip-reveal CSS class', () => {
    renderWrapper();
    const inner = screen.getByTestId('card-flip-inner');
    expect(inner.className).toContain('animate-card-flip-reveal');
  });
});

// ---------------------------------------------------------------------------
// Perspective container
// ---------------------------------------------------------------------------

describe('CardFlipWrapper — perspective container', () => {
  it('root wrapper has a perspective value in its inline style', () => {
    renderWrapper();
    const wrapper = screen.getByTestId('card-flip-wrapper');
    const style = wrapper.getAttribute('style') ?? '';
    expect(style).toContain('perspective');
  });
});

// ---------------------------------------------------------------------------
// Default props
// ---------------------------------------------------------------------------

describe('CardFlipWrapper — default props', () => {
  it('selected defaults to false — front card has no "(selected)" in aria-label', () => {
    renderWrapper({ cardId: '5_s' });
    const front = screen.getByTestId('card-flip-front');
    const card = front.querySelector('[aria-label]');
    expect(card?.getAttribute('aria-label')).not.toContain('(selected)');
  });

  it('disabled defaults to false — front card does not have opacity-40', () => {
    renderWrapper({ cardId: '5_s' });
    const front = screen.getByTestId('card-flip-front');
    const card = front.firstElementChild as HTMLElement;
    expect(card?.className).not.toContain('opacity-40');
  });

  it('size defaults to "md" — front card has w-12 class', () => {
    renderWrapper({ cardId: '5_s' });
    const front = screen.getByTestId('card-flip-front');
    const card = front.firstElementChild as HTMLElement;
    expect(card?.className).toContain('w-12');
  });

  it('size="sm" — front card has w-9 class', () => {
    renderWrapper({ cardId: '5_s', size: 'sm' });
    const front = screen.getByTestId('card-flip-front');
    const card = front.firstElementChild as HTMLElement;
    expect(card?.className).toContain('w-9');
  });

  it('size="lg" — front card has w-16 class', () => {
    renderWrapper({ cardId: '5_s', size: 'lg' });
    const front = screen.getByTestId('card-flip-front');
    const card = front.firstElementChild as HTMLElement;
    expect(card?.className).toContain('w-16');
  });
});

// ---------------------------------------------------------------------------
// Card variant rendering
// ---------------------------------------------------------------------------

describe('CardFlipWrapper — card identity', () => {
  it('renders the correct rank symbol for an Ace of Spades', () => {
    renderWrapper({ cardId: '1_s' });
    const front = screen.getByTestId('card-flip-front');
    // Should have "A" somewhere in the front face (Ace rank label)
    expect(front.textContent).toContain('A');
  });

  it('renders the correct rank symbol for a King of Hearts', () => {
    renderWrapper({ cardId: '13_h' });
    const front = screen.getByTestId('card-flip-front');
    expect(front.textContent).toContain('K');
  });

  it('renders the correct suit symbol ♠ for a spades card', () => {
    renderWrapper({ cardId: '5_s' });
    const front = screen.getByTestId('card-flip-front');
    expect(front.textContent).toContain('♠');
  });

  it('renders the correct suit symbol ♥ for a hearts card', () => {
    renderWrapper({ cardId: '3_h' });
    const front = screen.getByTestId('card-flip-front');
    expect(front.textContent).toContain('♥');
  });

  it('renders the correct suit symbol ♦ for a diamonds card', () => {
    renderWrapper({ cardId: '7_d' });
    const front = screen.getByTestId('card-flip-front');
    expect(front.textContent).toContain('♦');
  });

  it('renders the correct suit symbol ♣ for a clubs card', () => {
    renderWrapper({ cardId: '9_c' });
    const front = screen.getByTestId('card-flip-front');
    expect(front.textContent).toContain('♣');
  });
});

// ---------------------------------------------------------------------------
// Integration: CardHand passes newlyArrivedCardId through to DesktopCardHand
// ---------------------------------------------------------------------------

describe('CardFlipWrapper — integration with DesktopCardHand', () => {
  // These tests import DesktopCardHand directly to verify it conditionally
  // renders CardFlipWrapper when newlyArrivedCardId matches the card.

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const DesktopCardHand = require('@/components/DesktopCardHand').default;

  function renderDesktop(newlyArrivedCardId: string | null = null) {
    return render(
      <DesktopCardHand
        hand={['5_s', '6_s', '7_h']}
        isMyTurn={false}
        variant="remove_7s"
        newlyArrivedCardId={newlyArrivedCardId}
      />
    );
  }

  it('does NOT render CardFlipWrapper when newlyArrivedCardId is null', () => {
    renderDesktop(null);
    expect(screen.queryByTestId('card-flip-wrapper')).toBeNull();
  });

  it('renders CardFlipWrapper for the matching card when newlyArrivedCardId is set', () => {
    renderDesktop('5_s');
    expect(screen.getByTestId('card-flip-wrapper')).toBeTruthy();
  });

  it('renders only ONE CardFlipWrapper even when hand has multiple cards', () => {
    renderDesktop('5_s');
    expect(screen.getAllByTestId('card-flip-wrapper')).toHaveLength(1);
  });

  it('does NOT render CardFlipWrapper when newlyArrivedCardId is not in the hand', () => {
    renderDesktop('2_s'); // 2_s is not in the hand
    expect(screen.queryByTestId('card-flip-wrapper')).toBeNull();
  });

  it('does NOT render CardFlipWrapper when faceDown=true (deal animation path)', () => {
    render(
      <DesktopCardHand
        hand={['5_s']}
        isMyTurn={false}
        faceDown={true}
        newlyArrivedCardId="5_s"
      />
    );
    expect(screen.queryByTestId('card-flip-wrapper')).toBeNull();
  });
});
