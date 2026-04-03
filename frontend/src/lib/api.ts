/**
 * Literati API client.
 *
 * All communication with the backend Express server goes through this module.
 * Auth strategy:
 *   - Guests:            frontend calls POST /api/auth/guest to obtain a bearer
 *                        token, which is cached in localStorage via backendSession.ts.
 *   - Registered users:  registration via POST /api/auth/register (backend uses
 *                        Supabase Admin API with email_confirm:true — no email gate);
 *                        sign-in via Supabase browser client signInWithPassword().
 *
 * The base URL is controlled by NEXT_PUBLIC_API_URL (defaults to localhost:3012
 * for local development; set to the Railway/Fly.io URL in production).
 */

import { getCachedToken, saveToken, clearToken } from './backendSession';
import type {
  CreateRoomPayload,
  CreateRoomResponse,
  InviteCodeResponse,
} from '@/types/room';
import type { GameSummaryResponse } from '@/types/game';

export interface VoiceJoinResponse {
  roomName: string;
  roomUrl: string;
  meetingToken: string;
  expiresAt: string;
}

// ── Config ───────────────────────────────────────────────────────────────────

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3012';

// ── Error class ──────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Raw response body if available */
    public readonly body?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── Internal fetch helper ────────────────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  init: RequestInit & { token?: string }
): Promise<T> {
  const { token, headers: extraHeaders, ...rest } = init;

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(extraHeaders as Record<string, string>),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const res = await fetch(`${API_URL}${path}`, { ...rest, headers });

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const message =
      (body as { error?: string } | undefined)?.error ??
      `HTTP ${res.status}`;
    throw new ApiError(res.status, message, body);
  }

  return res.json() as Promise<T>;
}

// ── Guest auth ────────────────────────────────────────────────────────────────

interface GuestAuthResponse {
  token: string;
  session: {
    sessionId: string;
    displayName: string;
    avatarId: string;
    isGuest: true;
    /** Unix ms */
    expiresAt: number;
  };
  validAvatarIds: string[];
  sessionTtlMs: number;
}

/**
 * Return a valid backend bearer token for the given guest display name.
 *
 * If a cached (non-expired) token already exists it is returned immediately.
 * Otherwise the guest is registered with the backend and the returned token
 * is cached for future calls.
 */
export async function getGuestBearerToken(
  displayName: string,
  recoveryKey?: string | null,
): Promise<string> {
  // 1. Check cache — avoids a network round-trip on every action.
  const cached = getCachedToken(displayName, recoveryKey);
  if (cached) return cached;

  // 2. Register with the backend and get a fresh token.
  const data = await apiFetch<GuestAuthResponse>('/api/auth/guest', {
    method: 'POST',
    body: JSON.stringify({
      displayName,
      ...(recoveryKey ? { recoveryKey } : {}),
    }),
  });

  saveToken(data.token, data.session.expiresAt, displayName, recoveryKey);
  return data.token;
}

/** Invalidate the cached backend token (call on guest logout / name change). */
export function invalidateGuestToken(): void {
  clearToken();
}

// ── Registered-user auth ──────────────────────────────────────────────────────

export interface RegisterPayload {
  email: string;
  password: string;
  displayName: string;
  avatarId?: string;
}

export interface AuthUserInfo {
  id: string;
  email: string;
  displayName: string;
  avatarId: string | null;
}

export interface RegisterResponse {
  /** Present when account creation also succeeds at auto sign-in. */
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  user: AuthUserInfo;
  /** Set when account was created but auto sign-in failed (client should login). */
  message?: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthUserInfo;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Create a new registered account (email + password).
 *
 * The backend uses Supabase Admin's createUser with email_confirm: true,
 * so the account is usable IMMEDIATELY — no email verification step.
 * A fresh user_stats row (wins, losses, etc.) is created atomically
 * by the on_auth_user_created database trigger.
 *
 * @throws ApiError on validation failure (400), duplicate email (409),
 *         or server error (500).
 */
export async function registerUser(payload: RegisterPayload): Promise<RegisterResponse> {
  return apiFetch<RegisterResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * Sign in with email and password via the backend.
 * Returns a Supabase JWT access token valid for immediate game access.
 *
 * @throws ApiError on validation failure (400) or bad credentials (401).
 */
export async function loginUser(
  email: string,
  password: string
): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

/**
 * Invalidate the current registered-user session server-side.
 *
 * @param token  The current Supabase access JWT (Authorization: Bearer).
 * @throws ApiError on 401 (already expired) or 403 (guest token used).
 */
export async function logoutUser(token: string): Promise<void> {
  await apiFetch<{ message: string }>('/api/auth/logout', {
    method: 'POST',
    token,
  });
}

/**
 * Exchange a Supabase refresh token for a new access token.
 * Public endpoint — no Authorization header required.
 *
 * @throws ApiError on 400 (missing/invalid payload) or 401 (token expired).
 */
export async function refreshAccessToken(
  refreshTokenValue: string
): Promise<RefreshResponse> {
  return apiFetch<RefreshResponse>('/api/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken: refreshTokenValue }),
  });
}

// ── Rooms ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/rooms — Create a new private game room.
 *
 * @param payload       Player count and card-removal variant chosen by the host.
 * @param displayName   Guest display name used to obtain a bearer token (guests only).
 * @param bearerToken   Pre-authenticated bearer token for registered users (Supabase
 *                      JWT). When provided the guest-token fetch is skipped entirely.
 *
 * @returns The newly created room record.
 * @throws  ApiError on validation failure, conflict, or server error.
 */
export async function createRoom(
  payload: CreateRoomPayload,
  displayName: string,
  bearerToken?: string,
  recoveryKey?: string | null,
): Promise<CreateRoomResponse> {
  const submitCreateRoom = async (token: string) =>
    apiFetch<CreateRoomResponse>('/api/rooms', {
      method: 'POST',
      token,
      body: JSON.stringify(payload),
    });

  // Registered users supply their own Supabase JWT; guests need a backend token.
  const token = bearerToken ?? (await getGuestBearerToken(displayName, recoveryKey));

  try {
    return await submitCreateRoom(token);
  } catch (err) {
    // Guest 401s usually mean the backend restarted and lost its in-memory
    // session store. Clear the stale cache, mint a fresh guest token, and
    // retry once transparently so the user does not need to refresh.
    if (err instanceof ApiError && err.status === 401 && !bearerToken) {
      clearToken();
      const retryToken = await getGuestBearerToken(displayName, recoveryKey);
      return submitCreateRoom(retryToken);
    }
    throw err;
  }
}

/**
 * GET /api/stats/game-summary/:roomCode
 *
 * Public completed-game summary with per-player declaration and ask metrics.
 */
export async function getGameSummary(roomCode: string): Promise<GameSummaryResponse> {
  return apiFetch<GameSummaryResponse>(`/api/stats/game-summary/${roomCode.toUpperCase()}`, {
    method: 'GET',
  });
}

/**
 * GET /api/rooms/:code — Fetch room details by 6-char room code.
 * Public endpoint — no auth required.
 */
export async function getRoomByCode(
  code: string
): Promise<{ room: import('@/types/room').Room }> {
  return apiFetch(`/api/rooms/${code.toUpperCase()}`, { method: 'GET' });
}

/**
 * GET /api/rooms/invite/:inviteCode
 *
 * Resolve a 16-char hex player invite code to room code + metadata.
 * Public endpoint — no auth required.
 *
 * Use this when a player enters their invite code manually in the Join
 * Room flow.  The returned `roomCode` can then be used to navigate to
 * `/room/<roomCode>` or to call `getRoomByCode()` for the full record.
 *
 * @param inviteCode  16-char hex token from the room's invite_code field
 *                    (case-insensitive; will be uppercased before sending).
 *
 * @throws ApiError(400) for an invalid invite code format.
 * @throws ApiError(404) when no matching room is found.
 * @throws ApiError(410) when the room is no longer accepting players.
 */
export async function getRoomByInviteCode(
  inviteCode: string
): Promise<InviteCodeResponse> {
  return apiFetch<InviteCodeResponse>(
    `/api/rooms/invite/${inviteCode.toUpperCase()}`,
    { method: 'GET' }
  );
}

/**
 * POST /api/rooms/:roomCode/voice/join
 *
 * Returns the Daily room URL plus a short-lived meeting token for the
 * authenticated player in the active game.
 */
export async function joinRoomVoice(
  roomCode: string,
  bearerToken: string
): Promise<VoiceJoinResponse> {
  return apiFetch<VoiceJoinResponse>(
    `/api/rooms/${roomCode.toUpperCase()}/voice/join`,
    {
      method: 'POST',
      token: bearerToken,
      body: JSON.stringify({}),
    }
  );
}

// ── Matchmaking ───────────────────────────────────────────────────────────────

export interface MatchmakingQueueEntry {
  /** "{playerCount}:{cardRemovalVariant}" */
  filterKey: string;
  playerCount: number;
  cardRemovalVariant: string;
  /** Current number of players waiting in this WebSocket queue. */
  queueSize: number;
}

export interface MatchmakingQueuesResponse {
  queues: MatchmakingQueueEntry[];
  totalWaiting: number;
}

/**
 * GET /api/matchmaking/queues
 *
 * Returns live WebSocket queue sizes per filter group.
 * Public endpoint — call before connecting to WebSocket to show "X waiting".
 *
 * @throws ApiError on server error.
 */
export async function getMatchmakingQueues(): Promise<MatchmakingQueuesResponse> {
  return apiFetch<MatchmakingQueuesResponse>('/api/matchmaking/queues', {
    method: 'GET',
  });
}

// ── Session validation ────────────────────────────────────────────────────────

/**
 * Public identity returned by GET /api/auth/me.
 *
 * Guest:
 *   { isGuest: true,  sessionId, displayName, avatarId }
 *
 * Registered:
 *   { isGuest: false, id, email, displayName, avatarId }
 */
export interface MeResponse {
  isGuest: boolean;
  /** Server-side session UUID (guests only). */
  sessionId?: string;
  /** Supabase user UUID (registered users only). */
  id?: string;
  /** Registered-user email (registered users only). */
  email?: string;
  displayName: string;
  avatarId: string | null;
}

/**
 * Validate a bearer token with the backend by calling GET /api/auth/me.
 *
 * Returns the public identity of the session on success.
 * Throws ApiError(401) if the token is invalid or has expired.
 *
 * Use this on page refresh to confirm that a locally-cached session
 * (guest bearer token from backendSession.ts, or Supabase JWT from
 * AuthContext) is still accepted by the backend before opening the
 * WebSocket connection.
 *
 * @param token  Bearer token (guest opaque token or Supabase JWT).
 * @throws ApiError(401) when the session has expired or is unknown to the server.
 * @throws ApiError(other) on unexpected server errors.
 * @throws Error on network failures.
 */
export async function validateSession(token: string): Promise<MeResponse> {
  return apiFetch<MeResponse>('/api/auth/me', {
    method: 'GET',
    token,
  });
}

// ── Stats / Leaderboard ───────────────────────────────────────────────────

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  avatarId: string | null;
  wins: number;
  losses: number;
  gamesCompleted: number;
  winRate: number;
}

export interface LeaderboardResponse {
  leaderboard: LeaderboardEntry[];
  total: number;
  limit: number;
  offset: number;
}

export async function getLeaderboard(
  limit = 20,
  offset = 0
): Promise<LeaderboardResponse> {
  return apiFetch<LeaderboardResponse>(
    `/api/stats/leaderboard?limit=${limit}&offset=${offset}`,
    { method: 'GET' }
  );
}

export interface PublicProfile {
  userId: string;
  displayName: string;
  avatarId: string | null;
  wins: number;
  losses: number;
  gamesCompleted: number;
  gamesPlayed: number;
  declarationsCorrect: number;
  declarationsIncorrect: number;
  /** Total declarations attempted (correct + incorrect + timer-expired). */
  declarationsAttempted: number;
  winRate: number;
}

export interface ProfileResponse {
  profile: PublicProfile;
}

export async function getPublicProfile(userId: string): Promise<ProfileResponse> {
  return apiFetch<ProfileResponse>(`/api/stats/profile/${encodeURIComponent(userId)}`, {
    method: 'GET',
  });
}

/**
 * GET /api/stats/profile/by-username/:username
 *
 * Looks up a player's public profile by their display name (case-insensitive).
 * Use this for public /profile/:username URLs.
 */
export async function getProfileByUsername(username: string): Promise<ProfileResponse> {
  return apiFetch<ProfileResponse>(
    `/api/stats/profile/by-username/${encodeURIComponent(username)}`,
    { method: 'GET' }
  );
}

export interface ActiveRoom {
  id: string;
  code: string;
  player_count: 6 | 8;
  card_removal_variant: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ActiveRoomsResponse {
  rooms: ActiveRoom[];
}

export async function getActiveRooms(): Promise<ActiveRoomsResponse> {
  return apiFetch<ActiveRoomsResponse>('/api/rooms/active', { method: 'GET' });
}

// ── Live Games ──────────────────────────────────────────────────────────────

/**
 * A live game entry returned by GET /api/live-games and the /ws/live-games
 * WebSocket feed.
 */
export interface LiveGame {
  roomCode: string;
  playerCount: number;
  currentPlayers: number;
  /** 'remove_2s' | 'remove_7s' | 'remove_8s' */
  cardVariant: string;
  /** Frontend path to open this game in spectator mode. */
  spectatorUrl?: string;
  scores: { team1: number; team2: number };
  /** 'waiting' | 'in_progress' */
  status: string;
  /** Unix ms when the room was created */
  createdAt: number;
  /** Unix ms when the game went in_progress (null if still waiting) */
  startedAt: number | null;
  /** Milliseconds since startedAt (in_progress) or createdAt (waiting) */
  elapsedMs: number;
}

export interface LiveGamesResponse {
  games: LiveGame[];
  total: number;
}

/**
 * GET /api/live-games
 *
 * Returns a snapshot of all currently active games with computed elapsedMs.
 * Public endpoint — no auth required.
 * Use the /ws/live-games WebSocket for real-time updates.
 */
export async function getLiveGames(): Promise<LiveGamesResponse> {
  return apiFetch<LiveGamesResponse>('/api/live-games', { method: 'GET' });
}
