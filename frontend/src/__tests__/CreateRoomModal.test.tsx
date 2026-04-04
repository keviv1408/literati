/**
 * @jest-environment jsdom
 *
 * Tests for CreateRoomModal — * • After createRoom() resolves, the modal immediately transitions to the
 * "Room Created!" confirmation phase.
 * • The confirmation phase displays the room code, invite URL, and spectator
 * URL (…?spectate=1) before any navigation occurs.
 * • Copy buttons for invite and spectator links call navigator.clipboard.
 * • "Enter Room →" button navigates to /room/<code> and calls onClose.
 * • Overlay click does NOT close the modal while in the success phase.
 * • sessionStorage cache helpers (getCreatedRoomCacheKey, cacheCreatedRoom,
 * consumeCreatedRoom) store and consume room data correctly.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock next/navigation
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// Mock the API module
const mockCreateRoom = jest.fn();
jest.mock('@/lib/api', () => ({
  createRoom: (...args: unknown[]) => mockCreateRoom(...args),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      message: string,
      public readonly body?: unknown
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

jest.mock('@/contexts/GuestContext', () => ({
  useGuest: () => ({
    guestSession: {
      displayName: 'TestPlayer',
      sessionId: 'guest-session-123',
    },
  }),
}));

// Mock clipboard
const mockWriteText = jest.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: mockWriteText },
  writable: true,
  configurable: true,
});

// jsdom defaults window.location.origin to 'http://localhost'.
// All expected URLs in tests use this default origin.

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import CreateRoomModal, {
  getCreatedRoomCacheKey,
  cacheCreatedRoom,
  consumeCreatedRoom,
} from '@/components/CreateRoomModal';
import { ApiError } from '@/lib/api';
import type { Room } from '@/types/room';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_ROOM: Room = {
  id: 'room-uuid-1234',
  code: 'ABCD12',
  invite_code: 'abcdef1234567890',
  spectator_token: 'spectatortoken12345678901234567890ab',
  host_user_id: 'user-uuid-5678',
  player_count: 6,
  card_removal_variant: 'remove_7s',
  status: 'waiting',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

function renderModal(props: Partial<React.ComponentProps<typeof CreateRoomModal>> = {}) {
  const onClose = jest.fn();
  return {
    onClose,
    ...render(
      <CreateRoomModal
        open={true}
        displayName="TestPlayer"
        onClose={onClose}
        {...props}
      />
    ),
  };
}

// ---------------------------------------------------------------------------
// sessionStorage helper tests
// ---------------------------------------------------------------------------

describe('sessionStorage helpers', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('getCreatedRoomCacheKey returns uppercase-keyed string', () => {
    expect(getCreatedRoomCacheKey('abcd12')).toBe('literati_created_room_ABCD12');
    expect(getCreatedRoomCacheKey('ABCD12')).toBe('literati_created_room_ABCD12');
  });

  it('cacheCreatedRoom stores room under the correct key', () => {
    cacheCreatedRoom(MOCK_ROOM);
    const raw = sessionStorage.getItem('literati_created_room_ABCD12');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.code).toBe('ABCD12');
    expect(parsed.player_count).toBe(6);
  });

  it('consumeCreatedRoom returns the room and removes it from storage', () => {
    cacheCreatedRoom(MOCK_ROOM);
    const result = consumeCreatedRoom('ABCD12');
    expect(result).not.toBeNull();
    expect(result!.code).toBe('ABCD12');
    // Should be removed after consumption
    expect(sessionStorage.getItem('literati_created_room_ABCD12')).toBeNull();
  });

  it('consumeCreatedRoom is case-insensitive (normalises to uppercase)', () => {
    cacheCreatedRoom(MOCK_ROOM);
    const result = consumeCreatedRoom('abcd12');
    expect(result).not.toBeNull();
    expect(result!.code).toBe('ABCD12');
  });

  it('consumeCreatedRoom returns null when nothing is cached', () => {
    expect(consumeCreatedRoom('XXXXXX')).toBeNull();
  });

  it('consumeCreatedRoom returns null for corrupted JSON', () => {
    sessionStorage.setItem('literati_created_room_BADKEY', 'not-json{{{');
    expect(consumeCreatedRoom('BADKEY')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CreateRoomModal — form phase (pre-submit)
// ---------------------------------------------------------------------------

describe('CreateRoomModal — form phase', () => {
  it('renders the form with player count and variant options', () => {
    renderModal();
    expect(screen.getByText('Create Private Room')).toBeDefined();
    expect(screen.getByLabelText('6 players')).toBeDefined();
    expect(screen.getByLabelText('8 players')).toBeDefined();
  });

  it('closes when Cancel button is clicked', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when overlay is clicked (form phase)', () => {
    const { onClose } = renderModal();
    // The overlay is aria-hidden; find it by its position (first child div)
    const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows error message on API failure', async () => {
    mockCreateRoom.mockRejectedValueOnce(
      new ApiError(500, 'Server error')
    );
    renderModal();
    fireEvent.click(screen.getByText('Create Room'));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
      expect(screen.getByText('Server error')).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// CreateRoomModal — success phase
// ---------------------------------------------------------------------------

describe('CreateRoomModal — success phase ', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mockCreateRoom.mockResolvedValue({ room: MOCK_ROOM });
    mockPush.mockClear();
    mockWriteText.mockClear();
  });

  async function renderAndSubmit() {
    const result = renderModal();
    await act(async () => {
      fireEvent.click(screen.getByText('Create Room'));
    });
    return result;
  }

  it('shows "Room Created!" heading immediately after createRoom resolves', async () => {
    await renderAndSubmit();
    await waitFor(() => {
      expect(screen.getByText('Room Created!')).toBeDefined();
    });
    // Form should no longer be visible
    expect(screen.queryByText('Create Private Room')).toBeNull();
  });

  it('displays the room code prominently', async () => {
    await renderAndSubmit();
    await waitFor(() => {
      expect(screen.getByTestId('room-code-display')).toBeDefined();
      expect(screen.getByTestId('room-code-display').textContent).toBe('ABCD12');
    });
  });

  it('displays the invite URL (without ?spectate)', async () => {
    await renderAndSubmit();
    await waitFor(() => {
      const inviteEl = screen.getByTestId('invite-url-display');
      expect(inviteEl.textContent).toBe('http://localhost/room/ABCD12');
    });
  });

  it('displays the spectator URL with ?spectate=1', async () => {
    await renderAndSubmit();
    await waitFor(() => {
      const spectatorEl = screen.getByTestId('spectator-url-display');
      expect(spectatorEl.textContent).toBe(
        'http://localhost/room/ABCD12?spectate=1'
      );
    });
  });

  it('shows confirmation panel data-testid', async () => {
    await renderAndSubmit();
    await waitFor(() => {
      expect(screen.getByTestId('room-created-confirmation')).toBeDefined();
    });
  });

  it('caches the room in sessionStorage after successful creation', async () => {
    await renderAndSubmit();
    await waitFor(() => {
      expect(screen.getByTestId('room-created-confirmation')).toBeDefined();
    });
    const cached = sessionStorage.getItem('literati_created_room_ABCD12');
    expect(cached).not.toBeNull();
    const parsed = JSON.parse(cached!);
    expect(parsed.code).toBe('ABCD12');
  });

  it('"Enter Room →" button navigates to /room/<code> and calls onClose', async () => {
    const { onClose } = await renderAndSubmit();
    await waitFor(() => {
      expect(screen.getByTestId('enter-room-btn')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('enter-room-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/room/ABCD12');
  });

  it('copy invite button calls clipboard.writeText with invite URL', async () => {
    await renderAndSubmit();
    await waitFor(() => {
      expect(screen.getByTestId('copy-invite-btn')).toBeDefined();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-invite-btn'));
    });
    expect(mockWriteText).toHaveBeenCalledWith(
      'http://localhost/room/ABCD12'
    );
  });

  it('copy spectator button calls clipboard.writeText with spectator URL', async () => {
    await renderAndSubmit();
    await waitFor(() => {
      expect(screen.getByTestId('copy-spectator-btn')).toBeDefined();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-spectator-btn'));
    });
    expect(mockWriteText).toHaveBeenCalledWith(
      'http://localhost/room/ABCD12?spectate=1'
    );
  });

  it('overlay click does NOT close the modal during the success phase', async () => {
    const { onClose } = await renderAndSubmit();
    await waitFor(() => {
      expect(screen.getByTestId('room-created-confirmation')).toBeDefined();
    });
    const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement;
    fireEvent.click(backdrop);
    // onClose should NOT have been called
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does NOT navigate immediately — only navigates when Enter Room is clicked', async () => {
    await renderAndSubmit();
    await waitFor(() => {
      expect(screen.getByTestId('room-created-confirmation')).toBeDefined();
    });
    // Navigation should not have happened yet
    expect(mockPush).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CreateRoomModal — 409 conflict handling
// ---------------------------------------------------------------------------

describe('CreateRoomModal — 409 conflict', () => {
  it('navigates to the lobby when 409 contains an existing waiting room', async () => {
    mockCreateRoom.mockRejectedValueOnce(
      new ApiError(409, 'Conflict', {
        existingRoom: { code: 'EXIST1', status: 'waiting' },
      })
    );
    const { onClose } = renderModal();
    await act(async () => {
      fireEvent.click(screen.getByText('Create Room'));
    });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/room/EXIST1');
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('navigates to the game when 409 contains an in-progress room', async () => {
    mockCreateRoom.mockRejectedValueOnce(
      new ApiError(409, 'Conflict', {
        existingRoom: { code: 'EXIST1', status: 'in_progress' },
      })
    );
    const { onClose } = renderModal();
    await act(async () => {
      fireEvent.click(screen.getByText('Create Room'));
    });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/game/EXIST1');
      expect(onClose).toHaveBeenCalled();
    });
  });
});
