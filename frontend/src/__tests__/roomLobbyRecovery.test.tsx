/**
 * @jest-environment jsdom
 *
 * The real room page with the lobby socket mocked: its one recovery from a 4001,
 * its room-token choice, and the host-only Start control.
 */

import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import type { LobbyPlayer, UseRoomSocketOptions, WsStatus } from '@/hooks/useRoomSocket';
import type { Room } from '@/types/room';
import { cacheCreatedRoom } from '@/components/CreateRoomModal';
import { GuestProvider } from '@/contexts/GuestContext';
import { ApiError } from '@/lib/api';
import { saveToken } from '@/lib/backendSession';
import { loadGuestSession, saveGuestSession } from '@/lib/guestSession';
import { saveRoomMembership } from '@/lib/roomMembership';
import RoomLobbyPage from '@/app/room/[roomCode]/page';

const mockRouter = { push: jest.fn(), replace: jest.fn() };
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('@/components/LobbyInviteButton', () => ({
  __esModule: true,
  default: ({ inviteLink }: { inviteLink?: string }) => <div>invite:{inviteLink ?? 'none'}</div>,
}));

const mockGetRoomByCode = jest.fn();
const mockGetGuestBearerToken = jest.fn();
const mockValidateSession = jest.fn();
jest.mock('@/lib/api', () => {
  const actual = jest.requireActual('@/lib/api');
  return {
    ApiError: actual.ApiError,
    invalidateGuestToken: actual.invalidateGuestToken,
    getRoomByCode: (...args: unknown[]) => mockGetRoomByCode(...args),
    getGuestBearerToken: (...args: unknown[]) => mockGetGuestBearerToken(...args),
    validateSession: (...args: unknown[]) => mockValidateSession(...args),
  };
});

interface SocketState {
  wsStatus: WsStatus;
  stopCode: number | null;
}

const mockSocketCalls: UseRoomSocketOptions[] = [];
const mockRefusedTokens = new Set<string>();
let mockSetSocket: (state: SocketState) => void = () => {};
const mockNoPlayers: LobbyPlayer[] = [];
let mockRoster: { players: LobbyPlayer[]; myPlayerId: string | null } = {
  players: mockNoPlayers,
  myPlayerId: null,
};
let mockLobbyStarting = false;

// Stands in for the real socket: idle without a full set of credentials, refused with
// 4001 for a token the server forgot, connecting on any other new set, and otherwise
// whatever status the test drives it to.
jest.mock('@/hooks/useRoomSocket', () => {
  const { useState, useEffect } = jest.requireActual('react');
  // Stable across renders like the real hook's values, so the page's effects settle.
  const fixed = {
    isKicked: false,
    kickReason: null,
    kickPlayer: jest.fn(),
    changeTeam: jest.fn(),
    setAvatar: jest.fn(),
    emit: jest.fn(),
    startGame: jest.fn(() => true),
    lobbyTimer: null,
    errorSeq: 0,
    hostChangedEvent: null,
  };
  return {
    useRoomSocket: (options: UseRoomSocketOptions) => {
      mockSocketCalls.push(options);
      const [state, setState] = useState({ wsStatus: 'idle', stopCode: null });
      mockSetSocket = setState;
      const { roomCode, sessionId, bearerToken } = options;
      useEffect(() => {
        const complete = Boolean(roomCode && sessionId && bearerToken);
        const refused = complete && mockRefusedTokens.has(bearerToken!);
        setState({
          wsStatus: refused ? 'error' : complete ? 'connecting' : 'idle',
          stopCode: refused ? 4001 : null,
        });
      }, [roomCode, sessionId, bearerToken]);
      return {
        ...fixed,
        ...mockRoster,
        lobbyStarting: mockLobbyStarting,
        ...state,
        lastError: state.stopCode ? `Connection closed (${state.stopCode})` : null,
      };
    },
  };
});

const ROOM: Room = {
  id: 'room-1',
  code: 'ABC123',
  invite_code: '0123456789abcdef',
  host_user_id: 'host-1',
  player_count: 6,
  card_removal_variant: 'remove_7s',
  status: 'waiting',
  players: [],
  created_at: '2026-11-26T00:00:00Z',
  updated_at: '2026-11-26T00:00:00Z',
};

const LINK = 'https://literati-ochre.vercel.app/room/ABC123';

const SESSION = {
  isGuest: true,
  sessionId: 'sid-1',
  displayName: 'Ada',
  avatarId: null,
};

const ERROR_SCREEN_ID = 'connection-error-screen';
const ERROR_SCREEN = `[data-testid="${ERROR_SCREEN_ID}"]`;

function _lastToken(): string | null | undefined {
  return mockSocketCalls[mockSocketCalls.length - 1]?.bearerToken;
}

// The tokens the socket was handed from this call on, with consecutive repeats collapsed.
function _tokenChangesSince(index: number): Array<string | null | undefined> {
  return mockSocketCalls
    .slice(index)
    .map((c) => c.bearerToken)
    .filter((token, i, all) => i === 0 || token !== all[i - 1]);
}

// Records every time the error screen enters the DOM, even for a single commit. React
// reuses the page's root div and swaps its data-testid, so attribute records count too.
function _watchErrorScreen(): { seen: () => boolean; stop: () => void } {
  let seen = false;
  const scan = (records: MutationRecord[]) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target as Element;
        if (record.oldValue === ERROR_SCREEN_ID || target.getAttribute('data-testid') === ERROR_SCREEN_ID) {
          seen = true;
        }
        continue;
      }
      record.addedNodes.forEach((node) => {
        if (node instanceof Element && (node.matches(ERROR_SCREEN) || node.querySelector(ERROR_SCREEN))) {
          seen = true;
        }
      });
    }
  };
  const observer = new MutationObserver(scan);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-testid'],
    attributeOldValue: true,
  });
  return {
    seen: () => {
      scan(observer.takeRecords());
      return seen;
    },
    stop: () => observer.disconnect(),
  };
}

function _drive(state: SocketState) {
  act(() => mockSetSocket(state));
}

// A token from before the backend restarted, still in the guest token cache.
function _cacheStaleToken() {
  saveToken('cached-stale', Date.now() + 60 * 60_000, 'Ada', loadGuestSession()!.sessionId);
}

function _renderPage() {
  render(
    <GuestProvider>
      <RoomLobbyPage params={Promise.resolve({ roomCode: 'abc123' })} />
    </GuestProvider>,
  );
}

async function _renderConnecting() {
  _renderPage();
  await waitFor(() => expect(_lastToken()).toBe('token-1'));
  await waitFor(() => expect(screen.queryByTestId('reconnecting-screen')).not.toBeInTheDocument());
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSocketCalls.length = 0;
  mockRefusedTokens.clear();
  mockRoster = { players: mockNoPlayers, myPlayerId: null };
  mockLobbyStarting = false;
  window.localStorage.clear();
  window.sessionStorage.clear();
  saveGuestSession('Ada');
  saveRoomMembership('ABC123', 'stale-room-token', 'sid-0', 'player');
  mockGetRoomByCode.mockResolvedValue({ room: ROOM });
  mockValidateSession.mockResolvedValue(SESSION);
  // clearAllMocks keeps once-queues, so a value a case left unused would leak into the next.
  mockGetGuestBearerToken.mockReset();
  mockGetGuestBearerToken.mockResolvedValueOnce('token-1');
});

describe('room lobby recovery from a refused token', () => {
  it('registers again and reconnects with the fresh token, never showing Connection Error', async () => {
    await _renderConnecting();
    mockGetGuestBearerToken.mockResolvedValueOnce('token-2');
    const watch = _watchErrorScreen();
    const before = mockSocketCalls.length;

    _drive({ wsStatus: 'error', stopCode: 4001 });
    await waitFor(() => expect(_lastToken()).toBe('token-2'));
    _drive({ wsStatus: 'connected', stopCode: null });

    expect(watch.seen()).toBe(false);
    watch.stop();
    expect(_tokenChangesSince(before)).toEqual(['token-1', null, 'token-2']);
  });

  it('shows Connection Error when registering again fails', async () => {
    await _renderConnecting();
    mockGetGuestBearerToken.mockRejectedValueOnce(new Error('Server down'));

    _drive({ wsStatus: 'error', stopCode: 4001 });

    expect(await screen.findByTestId('connection-error-screen')).toBeVisible();
    expect(screen.getByTestId('connection-error-retry-btn')).toBeVisible();
  });

  it('shows Connection Error on a second 4001 with no connected in between', async () => {
    await _renderConnecting();
    mockGetGuestBearerToken.mockResolvedValueOnce('token-2');

    _drive({ wsStatus: 'error', stopCode: 4001 });
    await waitFor(() => expect(_lastToken()).toBe('token-2'));
    await waitFor(() => expect(screen.queryByTestId('reconnecting-screen')).not.toBeInTheDocument());
    _drive({ wsStatus: 'error', stopCode: 4001 });

    expect(await screen.findByTestId('connection-error-screen')).toBeVisible();
    expect(screen.getByTestId('connection-error-retry-btn')).toBeVisible();
  });

  it('drops the stale cached token, so a network error cannot leave the lobby idle', async () => {
    await _renderConnecting();
    _cacheStaleToken();
    mockValidateSession.mockImplementation(async (token: string) => {
      if (token === 'cached-stale') throw new TypeError('Failed to fetch');
      return SESSION;
    });
    mockGetGuestBearerToken.mockResolvedValueOnce('token-2');
    const before = mockSocketCalls.length;

    _drive({ wsStatus: 'error', stopCode: 4001 });
    await waitFor(() => expect(_lastToken()).toBe('token-2'));

    expect(mockSocketCalls[mockSocketCalls.length - 1].sessionId).toBe('sid-1');
    expect(_tokenChangesSince(before)).toEqual(['token-1', null, 'token-2']);
    expect(mockValidateSession).not.toHaveBeenCalledWith('cached-stale');
    expect(screen.queryByTestId('connection-error-screen')).not.toBeInTheDocument();
  });
});

describe('room lobby token choice after a restart', () => {
  it("connects with the fresh token when the stored room token is the same player's", async () => {
    saveRoomMembership('ABC123', 'stale-room-token', 'sid-1', 'player');
    mockRefusedTokens.add('stale-room-token');
    _cacheStaleToken();
    mockValidateSession.mockImplementation(async (token: string) => {
      if (token === 'cached-stale') throw new ApiError(401, 'Unauthorized');
      return SESSION;
    });
    mockGetGuestBearerToken.mockResolvedValueOnce('token-2');

    _renderPage();

    await waitFor(() => expect(_lastToken()).toBe('token-1'));
    expect(_tokenChangesSince(0)).toEqual([null, 'token-1']);
    expect(mockGetGuestBearerToken).toHaveBeenCalledTimes(1);
  });

  it("ignores the stored room token when it is another player's", async () => {
    _renderPage();

    await waitFor(() => expect(_lastToken()).toBe('token-1'));
    expect(_tokenChangesSince(0)).toEqual([null, 'token-1']);
    expect(mockGetGuestBearerToken).toHaveBeenCalledTimes(1);
  });
});

describe('room lobby invite link', () => {
  beforeEach(() => {
    mockGetRoomByCode.mockResolvedValue({ room: ROOM, inviteLink: LINK });
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_BUILD_TARGET;
  });

  it('passes the public invite link to the Android lobby immediately after room creation', async () => {
    process.env.NEXT_PUBLIC_BUILD_TARGET = 'android';
    cacheCreatedRoom(ROOM);

    await _renderConnecting();
    _drive({ wsStatus: 'connected', stopCode: null });

    expect(await screen.findByText(`invite:${LINK}`)).toBeVisible();
  });

  it('passes the public invite link to the Android lobby without a cached room', async () => {
    process.env.NEXT_PUBLIC_BUILD_TARGET = 'android';

    await _renderConnecting();
    _drive({ wsStatus: 'connected', stopCode: null });

    expect(await screen.findByText(`invite:${LINK}`)).toBeVisible();
  });

  it('skips the room lookup when the web lobby has a cached room', async () => {
    delete process.env.NEXT_PUBLIC_BUILD_TARGET;
    cacheCreatedRoom(ROOM);

    await _renderConnecting();
    _drive({ wsStatus: 'connected', stopCode: null });

    expect(await screen.findByText('invite:none')).toBeVisible();
    expect(mockGetRoomByCode).not.toHaveBeenCalled();
  });
});

describe('room lobby start control', () => {
  const _player = (playerId: string, displayName: string, isHost: boolean): LobbyPlayer => ({
    playerId,
    displayName,
    avatarId: null,
    isGuest: true,
    isHost,
  });

  async function _renderLobby(players: LobbyPlayer[], query = '') {
    window.history.replaceState({}, '', `/room/abc123${query}`);
    mockRoster = { players, myPlayerId: 'p-ada' };
    await _renderConnecting();
    _drive({ wsStatus: 'connected', stopCode: null });
  }

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('shows the start button to the player the server flags host', async () => {
    await _renderLobby([_player('p-ada', 'Ada', true), _player('p-asha', 'Asha', false)]);

    expect(await screen.findByRole('button', { name: 'Start with 4 bots' })).toBeEnabled();
    expect(screen.queryByTestId('waiting-for-host')).not.toBeInTheDocument();
  });

  it.each([
    [5, 'Start with 1 bot'],
    [6, 'Start game'],
  ] as const)('labels the start action for %i seated players', async (count, label) => {
    const guests = Array.from({ length: count - 1 }, (_, i) => _player(`p-${i}`, `Guest ${i}`, false));
    await _renderLobby([_player('p-ada', 'Ada', true), ...guests]);

    expect(await screen.findByRole('button', { name: label })).toBeEnabled();
  });

  it('lets the host press Start again after the socket drops and reconnects', async () => {
    await _renderLobby([_player('p-ada', 'Ada', true), _player('p-asha', 'Asha', false)]);
    fireEvent.click(await screen.findByTestId('start-game-btn'));
    expect(screen.getByTestId('start-game-btn')).toBeDisabled();

    _drive({ wsStatus: 'disconnected', stopCode: null });
    _drive({ wsStatus: 'connected', stopCode: null });

    expect(screen.getByTestId('start-game-btn')).toBeEnabled();
  });

  it('tells a non-host which player they are waiting for', async () => {
    await _renderLobby([_player('p-ada', 'Ada', false), _player('p-asha', 'Asha', true)]);

    expect(await screen.findByTestId('waiting-for-host')).toHaveTextContent(
      /^Waiting for Asha to start the game$/,
    );
    expect(screen.queryByTestId('start-game-btn')).not.toBeInTheDocument();
  });

  it('tells a non-host they are waiting for a host when nobody is flagged host', async () => {
    await _renderLobby([_player('p-ada', 'Ada', false), _player('p-asha', 'Asha', false)]);

    expect(await screen.findByTestId('waiting-for-host')).toHaveTextContent(/^Waiting for a host\u2026$/);
    expect(screen.queryByTestId('start-game-btn')).not.toBeInTheDocument();
  });

  it('shows no host line and no button until the roster holds this player', async () => {
    await _renderLobby([]);

    expect(await screen.findByTestId('start-game-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('waiting-for-host')).not.toBeInTheDocument();
    expect(screen.queryByTestId('start-game-btn')).not.toBeInTheDocument();

    mockRoster = { players: [_player('p-ada', 'Ada', false), _player('p-asha', 'Asha', true)], myPlayerId: 'p-ada' };
    _drive({ wsStatus: 'connected', stopCode: null });

    expect(await screen.findByTestId('waiting-for-host')).toHaveTextContent(/^Waiting for Asha to start the game$/);
    expect(screen.queryByTestId('start-game-btn')).not.toBeInTheDocument();
  });

  it('shows a non-host only the starting notice once the game is starting', async () => {
    mockLobbyStarting = true;
    await _renderLobby([_player('p-ada', 'Ada', false), _player('p-asha', 'Asha', true)]);

    expect(await screen.findByTestId('game-starting-notice')).toBeInTheDocument();
    expect(screen.queryByTestId('waiting-for-host')).not.toBeInTheDocument();
  });

  it('shows the start panel on a spectate page when the server flags this browser host', async () => {
    await _renderLobby([_player('p-ada', 'Ada', true)], '?spectate=1');

    expect(await screen.findByTestId('spectator-banner')).toBeInTheDocument();
    expect(screen.getByTestId('start-game-panel')).toBeInTheDocument();
    expect(screen.getByTestId('start-game-btn')).toBeInTheDocument();
  });

  it('hides the start panel on a spectate page without the host flag', async () => {
    await _renderLobby([_player('p-ada', 'Ada', false), _player('p-asha', 'Asha', true)], '?spectate=1');

    expect(await screen.findByTestId('spectator-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('start-game-panel')).not.toBeInTheDocument();
  });
});
