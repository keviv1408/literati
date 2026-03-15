/**
 * @jest-environment jsdom
 */

/**
 * Unit tests for LobbyTeamColumns component.
 *
 * Verifies that the correct number of seat cards is rendered in each team
 * column, that team headers are present and accessible, and that the
 * seat-count badges update correctly.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import LobbyTeamColumns from "@/components/LobbyTeamColumns";
import { buildEmptySeats } from "@/types/lobby";
import type { LobbyPlayer } from "@/types/lobby";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePlayer(seatIndex: number, overrides: Partial<LobbyPlayer> = {}): LobbyPlayer {
  return {
    seatIndex,
    displayName: `Player ${seatIndex}`,
    isBot: false,
    isHost: seatIndex === 0,
    isCurrentUser: false,
    ...overrides,
  };
}

// ── Team headers ──────────────────────────────────────────────────────────────

describe("LobbyTeamColumns — team headers", () => {
  it("renders 'Team 1' heading", () => {
    render(<LobbyTeamColumns playerCount={6} seats={buildEmptySeats(6)} />);
    expect(screen.getByText("Team 1")).toBeDefined();
  });

  it("renders 'Team 2' heading", () => {
    render(<LobbyTeamColumns playerCount={6} seats={buildEmptySeats(6)} />);
    expect(screen.getByText("Team 2")).toBeDefined();
  });

  it("has accessible section labels for each team column", () => {
    render(<LobbyTeamColumns playerCount={6} seats={buildEmptySeats(6)} />);
    expect(screen.getByRole("region", { name: "Team 1 column" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Team 2 column" })).toBeDefined();
  });
});

// ── 6-player room ─────────────────────────────────────────────────────────────

describe("LobbyTeamColumns — 6-player room, all empty", () => {
  beforeEach(() => {
    render(<LobbyTeamColumns playerCount={6} seats={buildEmptySeats(6)} />);
  });

  it("renders 6 'Waiting…' cards in total", () => {
    const waitingCards = screen.getAllByText("Waiting…");
    expect(waitingCards).toHaveLength(6);
  });

  it("shows seat count '0/3' for Team 1", () => {
    expect(screen.getAllByText("0/3")).toHaveLength(2); // both teams
  });
});

describe("LobbyTeamColumns — 6-player room, partially filled", () => {
  const seats: Array<LobbyPlayer | null> = [
    makePlayer(0, { isHost: true, isCurrentUser: true, displayName: "Alice" }), // T1
    makePlayer(1, { displayName: "Bob" }),   // T2
    null,  // T1 empty
    null,  // T2 empty
    makePlayer(4, { isBot: true, displayName: "Quirky Turing" }), // T1
    null,  // T2 empty
  ];

  it("renders 3 'Waiting…' placeholders (seats 2, 3, 5)", () => {
    render(<LobbyTeamColumns playerCount={6} seats={seats} />);
    const waiting = screen.getAllByText("Waiting…");
    expect(waiting).toHaveLength(3);
  });

  it("shows Team 1 count '2/3'", () => {
    render(<LobbyTeamColumns playerCount={6} seats={seats} />);
    // T1: seats 0 + 4 filled = 2; T2: seat 1 filled = 1
    expect(screen.getByLabelText("2 of 3 seats filled")).toBeDefined();
    expect(screen.getByLabelText("1 of 3 seats filled")).toBeDefined();
  });

  it("renders 'Alice' in Team 1 column", () => {
    render(<LobbyTeamColumns playerCount={6} seats={seats} />);
    expect(screen.getByText("Alice")).toBeDefined();
  });

  it("renders 'Bob' in Team 2 column", () => {
    render(<LobbyTeamColumns playerCount={6} seats={seats} />);
    expect(screen.getByText("Bob")).toBeDefined();
  });

  it("renders BotBadge for the bot player in Team 1", () => {
    const { container } = render(<LobbyTeamColumns playerCount={6} seats={seats} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
  });
});

// ── 8-player room ─────────────────────────────────────────────────────────────

describe("LobbyTeamColumns — 8-player room, all empty", () => {
  it("renders 8 'Waiting…' cards", () => {
    render(<LobbyTeamColumns playerCount={8} seats={buildEmptySeats(8)} />);
    const waitingCards = screen.getAllByText("Waiting…");
    expect(waitingCards).toHaveLength(8);
  });

  it("shows seat count '0/4' for each team", () => {
    render(<LobbyTeamColumns playerCount={8} seats={buildEmptySeats(8)} />);
    const counts = screen.getAllByText("0/4");
    expect(counts).toHaveLength(2); // one for each team
  });
});

describe("LobbyTeamColumns — 8-player room, fully filled", () => {
  const seats8: Array<LobbyPlayer | null> = Array.from({ length: 8 }, (_, i) =>
    makePlayer(i),
  );

  it("renders no 'Waiting…' cards when all seats are filled", () => {
    render(<LobbyTeamColumns playerCount={8} seats={seats8} />);
    expect(screen.queryByText("Waiting…")).toBeNull();
  });

  it("shows seat count '4/4' for each team", () => {
    render(<LobbyTeamColumns playerCount={8} seats={seats8} />);
    const counts = screen.getAllByText("4/4");
    expect(counts).toHaveLength(2);
  });
});

// ── Seat padding (fewer entries than playerCount) ─────────────────────────────

describe("LobbyTeamColumns — seat array padding", () => {
  it("pads a short array with empty seats up to playerCount", () => {
    // Only pass 2 entries for a 6-player room
    const shortSeats: Array<LobbyPlayer | null> = [
      makePlayer(0),
      makePlayer(1),
    ];
    render(<LobbyTeamColumns playerCount={6} seats={shortSeats} />);
    // Should still show 4 empty (Waiting…) cards
    const waiting = screen.getAllByText("Waiting…");
    expect(waiting).toHaveLength(4);
  });
});

// ── Outer wrapper ─────────────────────────────────────────────────────────────

describe("LobbyTeamColumns — outer wrapper", () => {
  it("has aria-label='Lobby teams'", () => {
    render(<LobbyTeamColumns playerCount={6} seats={buildEmptySeats(6)} />);
    expect(screen.getByLabelText("Lobby teams")).toBeDefined();
  });

  it("forwards className to the outer wrapper", () => {
    const { container } = render(
      <LobbyTeamColumns
        playerCount={6}
        seats={buildEmptySeats(6)}
        className="custom-test-class"
      />,
    );
    const wrapper = container.querySelector(".custom-test-class");
    expect(wrapper).not.toBeNull();
  });
});
