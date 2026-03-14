/**
 * Unit tests for lobby type helpers.
 *
 * Tests getTeamForSeat, splitSeatsByTeam, and buildEmptySeats.
 */

import { getTeamForSeat, splitSeatsByTeam, buildEmptySeats } from "@/types/lobby";
import type { LobbyPlayer } from "@/types/lobby";

// ── getTeamForSeat ────────────────────────────────────────────────────────────

describe("getTeamForSeat", () => {
  it("assigns even seat indices to Team 1", () => {
    expect(getTeamForSeat(0)).toBe(1);
    expect(getTeamForSeat(2)).toBe(1);
    expect(getTeamForSeat(4)).toBe(1);
    expect(getTeamForSeat(6)).toBe(1);
  });

  it("assigns odd seat indices to Team 2", () => {
    expect(getTeamForSeat(1)).toBe(2);
    expect(getTeamForSeat(3)).toBe(2);
    expect(getTeamForSeat(5)).toBe(2);
    expect(getTeamForSeat(7)).toBe(2);
  });
});

// ── buildEmptySeats ───────────────────────────────────────────────────────────

describe("buildEmptySeats", () => {
  it("builds an array of 6 nulls for a 6-player room", () => {
    const seats = buildEmptySeats(6);
    expect(seats).toHaveLength(6);
    expect(seats.every((s) => s === null)).toBe(true);
  });

  it("builds an array of 8 nulls for an 8-player room", () => {
    const seats = buildEmptySeats(8);
    expect(seats).toHaveLength(8);
    expect(seats.every((s) => s === null)).toBe(true);
  });
});

// ── splitSeatsByTeam ──────────────────────────────────────────────────────────

function makePlayer(seatIndex: number, partial: Partial<LobbyPlayer> = {}): LobbyPlayer {
  return {
    seatIndex,
    displayName: `Player ${seatIndex}`,
    isBot: false,
    isHost: seatIndex === 0,
    isCurrentUser: false,
    ...partial,
  };
}

describe("splitSeatsByTeam — 6-player room", () => {
  const seats6: Array<LobbyPlayer | null> = [
    makePlayer(0),  // T1
    makePlayer(1),  // T2
    makePlayer(2),  // T1
    null,           // T2 — empty
    makePlayer(4),  // T1
    null,           // T2 — empty
  ];

  it("Team 1 gets 3 entries (seats 0, 2, 4)", () => {
    const { team1 } = splitSeatsByTeam(seats6);
    expect(team1).toHaveLength(3);
    expect(team1.map((e) => e.seatIndex)).toEqual([0, 2, 4]);
  });

  it("Team 2 gets 3 entries (seats 1, 3, 5)", () => {
    const { team2 } = splitSeatsByTeam(seats6);
    expect(team2).toHaveLength(3);
    expect(team2.map((e) => e.seatIndex)).toEqual([1, 3, 5]);
  });

  it("preserves player data in Team 1", () => {
    const { team1 } = splitSeatsByTeam(seats6);
    expect(team1[0].player?.displayName).toBe("Player 0");
    expect(team1[1].player?.displayName).toBe("Player 2");
    expect(team1[2].player?.displayName).toBe("Player 4");
  });

  it("preserves null for empty seats in Team 2", () => {
    const { team2 } = splitSeatsByTeam(seats6);
    expect(team2[1].player).toBeNull(); // seat 3
    expect(team2[2].player).toBeNull(); // seat 5
  });
});

describe("splitSeatsByTeam — 8-player room", () => {
  const seats8: Array<LobbyPlayer | null> = Array.from({ length: 8 }, (_, i) =>
    i % 2 === 0 ? makePlayer(i) : null,
  );

  it("Team 1 gets 4 entries (seats 0, 2, 4, 6)", () => {
    const { team1 } = splitSeatsByTeam(seats8);
    expect(team1).toHaveLength(4);
    expect(team1.map((e) => e.seatIndex)).toEqual([0, 2, 4, 6]);
  });

  it("Team 2 gets 4 entries (seats 1, 3, 5, 7) and all empty", () => {
    const { team2 } = splitSeatsByTeam(seats8);
    expect(team2).toHaveLength(4);
    expect(team2.every((e) => e.player === null)).toBe(true);
  });
});

describe("splitSeatsByTeam — all-empty lobby", () => {
  it("returns all nulls in both teams for a 6-player room", () => {
    const { team1, team2 } = splitSeatsByTeam(buildEmptySeats(6));
    expect(team1.every((e) => e.player === null)).toBe(true);
    expect(team2.every((e) => e.player === null)).toBe(true);
  });
});
