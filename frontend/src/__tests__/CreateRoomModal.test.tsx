/**
 * @jest-environment jsdom
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
  it('renders the form with player count options', () => {
    renderModal();
    expect(screen.getByText('Create Private Room')).toBeDefined();
    expect(screen.getByLabelText('6 players')).toBeDefined();
    expect(screen.getByLabelText('8 players')).toBeDefined();
  });

  it('has no card variant picker', () => {
    renderModal();
    expect(screen.queryByText('Card Removal Variant')).toBeNull();
    expect(screen.queryByText('Remove 2s')).toBeNull();
    expect(screen.queryByText('Remove 8s')).toBeNull();
  });

  it('creates the room with 7s removed', async () => {
    mockCreateRoom.mockResolvedValue({ room: MOCK_ROOM });
    renderModal();
    await act(async () => {
      fireEvent.click(screen.getByText('Create Room'));
    });
    expect(mockCreateRoom.mock.lastCall?.[0]).toEqual({
      playerCount: 6,
      cardRemovalVariant: 'remove_7s',
    });
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

describe('CreateRoomModal lobby entry', () => {
  it('opens the new lobby as soon as creation succeeds and caches its room', async () => {
    sessionStorage.clear();
    mockPush.mockClear();
    mockCreateRoom.mockResolvedValueOnce({ room: MOCK_ROOM });
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Create Room' }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/room/ABCD12'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(consumeCreatedRoom('ABCD12')).toEqual(MOCK_ROOM);
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
