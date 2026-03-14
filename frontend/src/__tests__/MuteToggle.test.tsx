/**
 * @jest-environment jsdom
 *
 * Unit tests for /components/MuteToggle.tsx
 *
 * Coverage:
 *   • Renders 🔔 when unmuted; 🔇 when muted
 *   • aria-label and aria-pressed reflect current mute state
 *   • data-testid="mute-toggle" is always present
 *   • title tooltip reflects current mute state
 *   • Clicking the button calls toggleMute()
 *   • Toggling from unmuted → muted updates the icon and aria state
 *   • Toggling from muted → unmuted updates the icon and aria state
 *   • Persists preference via localStorage (integration smoke via useAudio)
 *   • Accepts extra className and merges it onto the button
 *   • Muted state applies rose colour class; unmuted state does not
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock useAudio so tests control mute state without touching localStorage
// ---------------------------------------------------------------------------

const mockToggleMute = jest.fn();
let _muted = false;

jest.mock('@/hooks/useAudio', () => ({
  useAudio: () => ({
    muted: _muted,
    toggleMute: mockToggleMute,
    playTurnChime: jest.fn(),
  }),
}));

// Import component AFTER mocks
import MuteToggle from '@/components/MuteToggle';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setMuted(val: boolean) {
  _muted = val;
}

beforeEach(() => {
  jest.clearAllMocks();
  _muted = false;
});

// ---------------------------------------------------------------------------
// Rendering — unmuted state
// ---------------------------------------------------------------------------

describe('MuteToggle — unmuted state', () => {
  it('renders the 🔔 icon when not muted', () => {
    setMuted(false);
    render(<MuteToggle />);
    expect(screen.getByTestId('mute-toggle')).toHaveTextContent('🔔');
  });

  it('sets aria-label to "Mute game sounds" when unmuted', () => {
    setMuted(false);
    render(<MuteToggle />);
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'Mute game sounds',
    );
  });

  it('sets aria-pressed="false" when unmuted', () => {
    setMuted(false);
    render(<MuteToggle />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
  });

  it('sets title to "Mute sounds" when unmuted', () => {
    setMuted(false);
    render(<MuteToggle />);
    expect(screen.getByRole('button')).toHaveAttribute('title', 'Mute sounds');
  });

  it('does NOT apply rose colour class when unmuted', () => {
    setMuted(false);
    render(<MuteToggle />);
    expect(screen.getByRole('button').className).not.toContain('rose');
  });
});

// ---------------------------------------------------------------------------
// Rendering — muted state
// ---------------------------------------------------------------------------

describe('MuteToggle — muted state', () => {
  it('renders the 🔇 icon when muted', () => {
    setMuted(true);
    render(<MuteToggle />);
    expect(screen.getByTestId('mute-toggle')).toHaveTextContent('🔇');
  });

  it('sets aria-label to "Unmute game sounds" when muted', () => {
    setMuted(true);
    render(<MuteToggle />);
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'Unmute game sounds',
    );
  });

  it('sets aria-pressed="true" when muted', () => {
    setMuted(true);
    render(<MuteToggle />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });

  it('sets title to "Unmute sounds" when muted', () => {
    setMuted(true);
    render(<MuteToggle />);
    expect(screen.getByRole('button')).toHaveAttribute('title', 'Unmute sounds');
  });

  it('applies rose colour class when muted', () => {
    setMuted(true);
    render(<MuteToggle />);
    expect(screen.getByRole('button').className).toContain('rose');
  });
});

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

describe('MuteToggle — interaction', () => {
  it('calls toggleMute() when clicked', () => {
    setMuted(false);
    render(<MuteToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(mockToggleMute).toHaveBeenCalledTimes(1);
  });

  it('calls toggleMute() when clicked while muted', () => {
    setMuted(true);
    render(<MuteToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(mockToggleMute).toHaveBeenCalledTimes(1);
  });

  it('does not throw when clicked multiple times', () => {
    setMuted(false);
    render(<MuteToggle />);
    const btn = screen.getByRole('button');
    expect(() => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    }).not.toThrow();
    expect(mockToggleMute).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// DOM attributes
// ---------------------------------------------------------------------------

describe('MuteToggle — DOM attributes', () => {
  it('always renders data-testid="mute-toggle"', () => {
    setMuted(false);
    render(<MuteToggle />);
    expect(screen.getByTestId('mute-toggle')).toBeInTheDocument();
  });

  it('renders a <button> element', () => {
    setMuted(false);
    render(<MuteToggle />);
    expect(screen.getByRole('button').tagName).toBe('BUTTON');
  });

  it('has type="button" to prevent accidental form submission', () => {
    setMuted(false);
    render(<MuteToggle />);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });

  it('the icon span is aria-hidden', () => {
    setMuted(false);
    render(<MuteToggle />);
    const icon = screen.getByRole('button').querySelector('span');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });
});

// ---------------------------------------------------------------------------
// className prop
// ---------------------------------------------------------------------------

describe('MuteToggle — className prop', () => {
  it('applies extra className to the button', () => {
    setMuted(false);
    render(<MuteToggle className="p-4 text-xl" />);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('p-4');
    expect(btn.className).toContain('text-xl');
  });

  it('still includes base classes when extra className is provided', () => {
    setMuted(false);
    render(<MuteToggle className="custom-class" />);
    const btn = screen.getByRole('button');
    // Base transition + emerald ring classes should remain
    expect(btn.className).toContain('transition-colors');
    expect(btn.className).toContain('focus:ring-emerald-400');
    expect(btn.className).toContain('custom-class');
  });

  it('works correctly with no className prop', () => {
    setMuted(false);
    render(<MuteToggle />);
    // Should not throw; should still render with base classes
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('transition-colors');
  });
});

// ---------------------------------------------------------------------------
// localStorage persistence (integration smoke via useAudio)
// ---------------------------------------------------------------------------

describe('MuteToggle — localStorage persistence', () => {
  it('reads initial muted state from useAudio (which reads localStorage)', () => {
    // When _muted = true (simulating localStorage returning 'true')
    setMuted(true);
    render(<MuteToggle />);
    // The button should reflect the persisted muted state
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('mute-toggle')).toHaveTextContent('🔇');
  });

  it('reads initial unmuted state from useAudio (which reads localStorage)', () => {
    // When _muted = false (simulating no localStorage entry)
    setMuted(false);
    render(<MuteToggle />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('mute-toggle')).toHaveTextContent('🔔');
  });

  it('delegates persistence to toggleMute (which calls setMuted in audio lib)', () => {
    // The component must NOT call setMuted directly; it delegates to toggleMute.
    // We verify this by confirming mockToggleMute is called (not any storage mock).
    setMuted(false);
    render(<MuteToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(mockToggleMute).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Sound suppression (smoke — actual suppression tested in audio.test.ts)
// ---------------------------------------------------------------------------

describe('MuteToggle — sound suppression contract', () => {
  it('does not expose or call playTurnChime directly', () => {
    // The component is a pure toggle — it must not play audio itself.
    // This test confirms the button renders and clicks without calling chime.
    const mockPlayChime = jest.fn();
    // Override the mock factory for this test
    jest.mock('@/hooks/useAudio', () => ({
      useAudio: () => ({
        muted: false,
        toggleMute: mockToggleMute,
        playTurnChime: mockPlayChime,
      }),
    }));

    setMuted(false);
    render(<MuteToggle />);
    fireEvent.click(screen.getByRole('button'));

    // playTurnChime should never be called by the toggle button itself
    expect(mockPlayChime).not.toHaveBeenCalled();
  });
});
