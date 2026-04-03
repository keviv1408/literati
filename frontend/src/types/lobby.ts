/**
 * Lobby type definitions.
 *
 * These types describe the player data that the lobby UI needs to render
 * team columns and player cards. They are intentionally separate from the
 * backend `Room` type so the lobby can be driven by either static mock data
 * (for development) or real-time WebSocket updates.
 */

// ── Player in a lobby seat ───────────────────────────────────────────────────

/**
 * A single occupant of a lobby seat.
 *
 * Seat indices start at 0 (host) and alternate between teams:
 * seatIndex 0, 2, 4, 6 → Team 1
 * seatIndex 1, 3, 5, 7 → Team 2
 *
 * Empty seats are represented by `null` in the `LobbyState.seats` array.
 */
export interface LobbyPlayer {
  /** Zero-based seat index around the oval table (0 = host seat). */
  seatIndex: number;
  /**
   * Server-assigned player identity (Supabase userId or guest sessionId).
   * Present when the seat is populated from a live WebSocket room_players
   * snapshot; absent in empty-seat placeholders built by buildEmptySeats().
   */
  playerId?: string;
  /** Human-readable display name (or bot-generated memorable name). */
  displayName: string;
  /** Whether this player is an AI bot. */
  isBot: boolean;
  /** Whether this player is the room host (always seatIndex === 0). */
  isHost: boolean;
  /** Whether this player is the currently logged-in / guest user. */
  isCurrentUser: boolean;
  /** Optional avatar image URL (registered users with Google OAuth). */
  avatarUrl?: string | null;
}

// ── Team assignment helpers ──────────────────────────────────────────────────

/**
 * Return the team number (1 or 2) for a given seat index.
 *
 * Seats alternate: 0→T1, 1→T2, 2→T1, 3→T2, … (clockwise around the table).
 */
export function getTeamForSeat(seatIndex: number): 1 | 2 {
  return seatIndex % 2 === 0 ? 1 : 2;
}

/**
 * Split an array of nullable seat entries (indexed 0..playerCount-1) into
 * two team arrays preserving the relative order within each team.
 *
 * @param seats Sparse array of length `playerCount`. Null = empty seat.
 * @returns `{ team1, team2 }` where each entry is `{ seatIndex, player | null }`.
 */
export function splitSeatsByTeam(
  seats: Array<LobbyPlayer | null>,
): {
  team1: Array<{ seatIndex: number; player: LobbyPlayer | null }>;
  team2: Array<{ seatIndex: number; player: LobbyPlayer | null }>;
} {
  const team1: Array<{ seatIndex: number; player: LobbyPlayer | null }> = [];
  const team2: Array<{ seatIndex: number; player: LobbyPlayer | null }> = [];

  seats.forEach((player, idx) => {
    const entry = { seatIndex: idx, player };
    if (idx % 2 === 0) {
      team1.push(entry);
    } else {
      team2.push(entry);
    }
  });

  return { team1, team2 };
}

/**
 * Build an empty seat array of the given length (all null = waiting).
 * Useful for rendering an unpopulated lobby.
 */
export function buildEmptySeats(
  playerCount: 6 | 8,
): Array<LobbyPlayer | null> {
  return Array.from({ length: playerCount }, () => null);
}
