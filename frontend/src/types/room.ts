/**
 * Room type definitions — mirroring the backend's Supabase schema.
 *
 * Backend column names are snake_case (Supabase convention); the API
 * response contains the raw row so field names here use snake_case too.
 */

/** The three host-selectable removal variants (48-card deck). */
export type CardRemovalVariant = 'remove_2s' | 'remove_7s' | 'remove_8s';

/** Team number — 1 or 2. */
export type Team = 1 | 2;

/** Lifecycle states a room passes through. */
export type RoomStatus =
  | 'waiting'
  | 'starting'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

/** A game room record as returned by the backend API. */
export interface Room {
  id: string;
  /** 6-character human-readable room code for verbal / keyboard sharing. */
  code: string;
  /**
   * 16-char hex token used in the player invite link (/join/:invite_code).
   * Present on all GET /api/rooms/:code responses and the POST 201 response.
   */
  invite_code: string;
  /**
   * 32-char hex spectator view token (/spectate/:spectator_token).
   * Only returned in the POST /api/rooms 201 response (creation time).
   * Not exposed in public GET responses — keep it out of the URL bar.
   */
  spectator_token?: string;
  host_user_id: string;
  player_count: 6 | 8;
  card_removal_variant: CardRemovalVariant;
  status: RoomStatus;
  /**
   * True for rooms created by the matchmaking queue (no host controls,
   * auto-start when all matched players join or the 30-second timer fires).
   * False (default) for private rooms created by a specific host.
   */
  is_matchmaking?: boolean;
  created_at: string;
  updated_at: string;
}

// ── Request / response shapes ────────────────────────────────────────────────

/** Body for POST /api/rooms */
export interface CreateRoomPayload {
  playerCount: 6 | 8;
  cardRemovalVariant: CardRemovalVariant;
}

/** Response from POST /api/rooms (201) */
export interface CreateRoomResponse {
  room: Room;
}

/** Response from GET /api/rooms/invite/:inviteCode */
export interface InviteCodeResponse {
  room: Room;
}

// ── UI helper constants ──────────────────────────────────────────────────────

export const PLAYER_COUNT_OPTIONS = [6, 8] as const;

export const VARIANT_OPTIONS: Array<{
  value: CardRemovalVariant;
  label: string;
  description: string;
}> = [
  {
    value: 'remove_7s',
    label: 'Remove 7s',
    description: 'Classic Literature — 7s removed, low half: A–6, high half: 8–K',
  },
  {
    value: 'remove_2s',
    label: 'Remove 2s',
    description: '2s removed — low half: A,3–7, high half: 8–K',
  },
  {
    value: 'remove_8s',
    label: 'Remove 8s',
    description: '8s removed — low half: A–7, high half: 9–K',
  },
];
