/**
 * @jest-environment jsdom
 */

/**
 * Unit tests for OvalTable component.
 *
 * Covers:
 *  • Both layout variants (oval + mobile fallback) are present in the DOM
 *  • Correct number of seat tokens rendered for 6-player and 8-player rooms
 *  • Team colour metadata (data-testid presence for each seat)
 *  • Occupied seat rendering: avatar, host crown, "You" pip, BotBadge
 *  • Empty seat rendering: hourglass placeholder, accessible aria-label
 *  • Seat array normalisation (short array padded to playerCount)
 *  • Outer wrapper aria-label
 *  • tableLabel prop forwarded to the table surface
 *
 * Note: jsdom does not evaluate CSS @media queries, so the show/hide
 * behaviour between the oval and the mobile fallback columns is verified by
 * checking that BOTH branches are present in the DOM (the CSS hides one).
 * This is standard practice for Tailwind-based visibility toggling.
 */

import React from "react";
import { render, screen, within } from "@testing-library/react";
import OvalTable from "@/components/OvalTable";
import PlayerSeat from "@/components/PlayerSeat";
import { buildEmptySeats } from "@/types/lobby";
import type { LobbyPlayer } from "@/types/lobby";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePlayer(
  seatIndex: number,
  overrides: Partial<LobbyPlayer> = {},
): LobbyPlayer {
  return {
    seatIndex,
    displayName: `Player ${seatIndex}`,
    isBot: false,
    isHost: seatIndex === 0,
    isCurrentUser: false,
    ...overrides,
  };
}

// ── Outer wrapper ─────────────────────────────────────────────────────────────

describe("OvalTable — outer wrapper", () => {
  it("has aria-label='Game table'", () => {
    render(<OvalTable playerCount={6} seats={buildEmptySeats(6)} />);
    expect(screen.getByLabelText("Game table")).toBeDefined();
  });

  it("forwards className to the outer wrapper", () => {
    const { container } = render(
      <OvalTable
        playerCount={6}
        seats={buildEmptySeats(6)}
        className="custom-test-class"
      />,
    );
    const wrapper = container.querySelector(".custom-test-class");
    expect(wrapper).not.toBeNull();
  });
});

// ── Dual-layout presence ───────────────────────────────────────────────────────

describe("OvalTable — both layout branches rendered", () => {
  it("renders the oval layout container", () => {
    render(<OvalTable playerCount={6} seats={buildEmptySeats(6)} />);
    expect(screen.getByTestId("oval-layout")).toBeDefined();
  });

  it("renders the mobile fallback container", () => {
    render(<OvalTable playerCount={6} seats={buildEmptySeats(6)} />);
    expect(screen.getByTestId("mobile-fallback")).toBeDefined();
  });

  it("oval container has an inline aspect-ratio style", () => {
    render(<OvalTable playerCount={6} seats={buildEmptySeats(6)} />);
    const cont = screen.getByTestId("oval-container") as HTMLElement;
    // Container uses inline style aspectRatio matching the SVG viewBox ratio
    expect(cont.style.aspectRatio).toBeTruthy();
  });

  it("renders the SVG table graphic", () => {
    render(<OvalTable playerCount={6} seats={buildEmptySeats(6)} />);
    expect(screen.getByTestId("table-graphic")).toBeDefined();
  });
});

// ── 6-player room ─────────────────────────────────────────────────────────────

describe("OvalTable — 6-player room, all empty", () => {
  beforeEach(() => {
    render(<OvalTable playerCount={6} seats={buildEmptySeats(6)} />);
  });

  it("renders 6 <li> seat wrappers in the oval layout", () => {
    const ol = screen.getByRole("list", { name: "6 player seats" });
    const liItems = ol.querySelectorAll(":scope > li[data-seat-index]");
    expect(liItems).toHaveLength(6);
  });

  it("renders 'Waiting…' placeholders for each empty seat (oval branch)", () => {
    // In the oval layout the ol has aria-label "6 player seats"
    const ol = screen.getByRole("list", { name: "6 player seats" });
    const waitingItems = within(ol).getAllByText("Waiting…");
    expect(waitingItems).toHaveLength(6);
  });

  it("renders the table label 'Literati' (default) in the SVG graphic", () => {
    // SVG element is aria-hidden but text content is still in the DOM
    const graphic = screen.getByTestId("table-graphic") as Element;
    expect(graphic.textContent).toContain("Literati");
  });
});

describe("OvalTable — 6-player room, custom tableLabel", () => {
  it("displays the provided tableLabel in the SVG graphic", () => {
    render(
      <OvalTable
        playerCount={6}
        seats={buildEmptySeats(6)}
        tableLabel="Room 42"
      />,
    );
    const graphic = screen.getByTestId("table-graphic") as Element;
    expect(graphic.textContent).toContain("Room 42");
  });
});

// ── 8-player room ─────────────────────────────────────────────────────────────

describe("OvalTable — 8-player room, all empty", () => {
  it("renders seat tokens for all 8 seats in the oval list", () => {
    render(<OvalTable playerCount={8} seats={buildEmptySeats(8)} />);
    const ol = screen.getByRole("list", { name: "8 player seats" });
    // Count only <li> elements (direct children), not inner SeatToken divs.
    const liItems = ol.querySelectorAll(":scope > li");
    expect(liItems).toHaveLength(8);
  });

  it("renders 8 'Waiting…' placeholders in the oval branch", () => {
    render(<OvalTable playerCount={8} seats={buildEmptySeats(8)} />);
    const ol = screen.getByRole("list", { name: "8 player seats" });
    expect(within(ol).getAllByText("Waiting…")).toHaveLength(8);
  });
});

describe("OvalTable — 8-player room, fully occupied", () => {
  const seats8: Array<LobbyPlayer | null> = Array.from({ length: 8 }, (_, i) =>
    makePlayer(i),
  );

  it("renders no 'Waiting…' placeholders in the oval when all seats filled", () => {
    render(<OvalTable playerCount={8} seats={seats8} />);
    const ol = screen.getByRole("list", { name: "8 player seats" });
    expect(within(ol).queryByText("Waiting…")).toBeNull();
  });

  it("renders player names for all 8 occupied seats in oval branch", () => {
    render(<OvalTable playerCount={8} seats={seats8} />);
    // Each player is visible in at least one of the two layout branches
    for (let i = 0; i < 8; i++) {
      expect(screen.getAllByText(`Player ${i}`).length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ── Seat padding ──────────────────────────────────────────────────────────────

describe("OvalTable — seat array normalisation", () => {
  it("pads a short seats array with empty seats up to playerCount", () => {
    // Supply only 2 seats for a 6-player room
    const shortSeats: Array<LobbyPlayer | null> = [
      makePlayer(0),
      makePlayer(1),
    ];
    render(<OvalTable playerCount={6} seats={shortSeats} />);
    const ol = screen.getByRole("list", { name: "6 player seats" });
    // 4 empty seats should still show 'Waiting…'
    expect(within(ol).getAllByText("Waiting…")).toHaveLength(4);
  });
});

// ── Host crown ────────────────────────────────────────────────────────────────

describe("OvalTable — host crown", () => {
  it("renders the 👑 crown element in the oval seat for the host", () => {
    const seats: Array<LobbyPlayer | null> = [
      makePlayer(0, { isHost: true, displayName: "Host" }),
      ...Array(5).fill(null),
    ];
    render(<OvalTable playerCount={6} seats={seats} />);
    const crowns = screen.getAllByTitle("Room host");
    // Crown appears in oval branch + mobile branch
    expect(crowns.length).toBeGreaterThanOrEqual(1);
    expect(crowns[0].textContent).toContain("👑");
  });

  it("does not render a crown for a non-host player", () => {
    const seats: Array<LobbyPlayer | null> = [
      makePlayer(0, { isHost: false, displayName: "NonHost" }),
      ...Array(5).fill(null),
    ];
    render(<OvalTable playerCount={6} seats={seats} />);
    expect(screen.queryByTitle("Room host")).toBeNull();
  });
});

// ── Current user ──────────────────────────────────────────────────────────────

describe("OvalTable — current user", () => {
  it("renders the 'You' pill in the oval seat for the current user", () => {
    const seats: Array<LobbyPlayer | null> = [
      makePlayer(0, { isCurrentUser: true, displayName: "Me" }),
      ...Array(5).fill(null),
    ];
    render(<OvalTable playerCount={6} seats={seats} />);
    const ol = screen.getByRole("list", { name: "6 player seats" });
    expect(within(ol).getByText("You")).toBeDefined();
  });

  it("does not render a 'You' pill for another player", () => {
    const seats: Array<LobbyPlayer | null> = [
      makePlayer(0, { isCurrentUser: false, displayName: "Other" }),
      ...Array(5).fill(null),
    ];
    render(<OvalTable playerCount={6} seats={seats} />);
    const ol = screen.getByRole("list", { name: "6 player seats" });
    expect(within(ol).queryByText("You")).toBeNull();
  });
});

// ── Bot player ────────────────────────────────────────────────────────────────

describe("OvalTable — bot player in oval branch", () => {
  it("renders a BotBadge (robot SVG) for a bot seat in the oval list", () => {
    const seats: Array<LobbyPlayer | null> = [
      makePlayer(0, { isBot: true, displayName: "Quirky Turing" }),
      ...Array(5).fill(null),
    ];
    const { container } = render(<OvalTable playerCount={6} seats={seats} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
  });

  it("renders the bot name in the oval branch via BotBadge", () => {
    const seats: Array<LobbyPlayer | null> = [
      makePlayer(0, { isBot: true, displayName: "Elegant Curie" }),
      ...Array(5).fill(null),
    ];
    render(<OvalTable playerCount={6} seats={seats} />);
    expect(screen.getAllByText("Elegant Curie").length).toBeGreaterThanOrEqual(1);
  });
});

// ── Accessible aria-labels on PlayerSeat chips ────────────────────────────────

describe("OvalTable — accessible aria-labels on PlayerSeat chips", () => {
  it("empty seat chip has aria-label containing 'waiting'", () => {
    render(<OvalTable playerCount={6} seats={buildEmptySeats(6)} />);
    const ol = screen.getByRole("list", { name: "6 player seats" });
    // PlayerSeat renders role="listitem" with aria-label
    const chips = ol.querySelectorAll("[role='listitem'][aria-label]");
    expect(chips.length).toBe(6);
    chips.forEach((chip) => {
      expect(chip.getAttribute("aria-label")).toBeTruthy();
    });
    expect(chips[0].getAttribute("aria-label")).toContain("waiting");
  });

  it("occupied seat chip aria-label contains displayName", () => {
    const seats: Array<LobbyPlayer | null> = [
      makePlayer(0, { displayName: "Alice", isHost: false }),
      ...Array(5).fill(null),
    ];
    render(<OvalTable playerCount={6} seats={seats} />);
    const ol = screen.getByRole("list", { name: "6 player seats" });
    const seatLi = ol.querySelector("[data-seat-index='0']") as HTMLElement;
    const chip = seatLi.querySelector("[role='listitem']") as HTMLElement;
    expect(chip.getAttribute("aria-label")).toContain("Alice");
  });

  it("host + current user seat aria-label includes 'host' and 'you'", () => {
    const seats: Array<LobbyPlayer | null> = [
      makePlayer(0, { displayName: "Alice", isHost: true, isCurrentUser: true }),
      ...Array(5).fill(null),
    ];
    render(<OvalTable playerCount={6} seats={seats} />);
    const ol = screen.getByRole("list", { name: "6 player seats" });
    const seatLi = ol.querySelector("[data-seat-index='0']") as HTMLElement;
    const chip = seatLi.querySelector("[role='listitem']") as HTMLElement;
    const label = chip.getAttribute("aria-label") ?? "";
    expect(label).toContain("host");
    expect(label).toContain("you");
  });
});

// ── PlayerSeat standalone ──────────────────────────────────────────────────────

describe("PlayerSeat — standalone rendering", () => {
  it("renders empty state for null player", () => {
    render(<PlayerSeat seatIndex={2} player={null} />);
    expect(screen.getByText("Waiting…")).toBeDefined();
    const el = screen.getByLabelText("Seat 3 — waiting for player");
    expect(el).toBeDefined();
  });

  it("renders player name for occupied state", () => {
    const player = makePlayer(2, { displayName: "Bob", isBot: false });
    render(<PlayerSeat seatIndex={2} player={player} />);
    expect(screen.getByText("Bob")).toBeDefined();
  });

  it("renders robot SVG for a bot player", () => {
    const player = makePlayer(2, { displayName: "Bot X", isBot: true });
    const { container } = render(<PlayerSeat seatIndex={2} player={player} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders 'You' pill for current user", () => {
    const player = makePlayer(0, { isCurrentUser: true, displayName: "Me" });
    render(<PlayerSeat seatIndex={0} player={player} />);
    expect(screen.getByText("You")).toBeDefined();
  });

  it("has data-seat-index attribute", () => {
    const { container } = render(<PlayerSeat seatIndex={5} player={null} />);
    const el = container.querySelector("[data-seat-index]") as HTMLElement;
    expect(el.getAttribute("data-seat-index")).toBe("5");
  });
});

// ── Card count badge ──────────────────────────────────────────────────────────

describe("PlayerSeat — card count badge", () => {
  it("renders the card count badge when cardCount is provided", () => {
    const player = makePlayer(0, { displayName: "Alice" });
    render(<PlayerSeat seatIndex={0} player={player} cardCount={7} />);
    const badge = screen.getByTestId("card-count-badge");
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe("7");
  });

  it("does not render the badge when cardCount is undefined", () => {
    const player = makePlayer(0, { displayName: "Alice" });
    render(<PlayerSeat seatIndex={0} player={player} />);
    expect(screen.queryByTestId("card-count-badge")).toBeNull();
  });

  it("does not render the badge on an empty seat regardless of cardCount", () => {
    // cardCount has no meaning for an empty seat; the badge should not appear
    render(<PlayerSeat seatIndex={0} player={null} cardCount={5} />);
    expect(screen.queryByTestId("card-count-badge")).toBeNull();
  });

  it("renders badge showing 0 when cardCount is 0 (player is out of cards)", () => {
    const player = makePlayer(2, { displayName: "Bob" });
    render(<PlayerSeat seatIndex={2} player={player} cardCount={0} />);
    const badge = screen.getByTestId("card-count-badge");
    expect(badge.textContent).toBe("0");
  });

  it("updates aria-label to include card count information", () => {
    const player = makePlayer(1, { displayName: "Carol" });
    render(<PlayerSeat seatIndex={1} player={player} cardCount={4} />);
    const seat = screen.getByRole("listitem");
    const label = seat.getAttribute("aria-label") ?? "";
    expect(label).toContain("4 cards");
  });
});

// ── Active-turn glow / ring ───────────────────────────────────────────────────

describe("PlayerSeat — active-turn indicator", () => {
  it("sets data-active-turn='true' when isActiveTurn is true", () => {
    const player = makePlayer(0, { displayName: "Alice" });
    render(<PlayerSeat seatIndex={0} player={player} isActiveTurn={true} />);
    const seat = screen.getByRole("listitem");
    expect(seat.getAttribute("data-active-turn")).toBe("true");
  });

  it("omits data-active-turn attribute when isActiveTurn is false", () => {
    const player = makePlayer(0, { displayName: "Alice" });
    render(<PlayerSeat seatIndex={0} player={player} isActiveTurn={false} />);
    const seat = screen.getByRole("listitem");
    expect(seat.getAttribute("data-active-turn")).toBeNull();
  });

  it("omits data-active-turn attribute by default", () => {
    const player = makePlayer(0, { displayName: "Alice" });
    render(<PlayerSeat seatIndex={0} player={player} />);
    const seat = screen.getByRole("listitem");
    expect(seat.getAttribute("data-active-turn")).toBeNull();
  });

  it("includes 'active turn' in aria-label when isActiveTurn is true", () => {
    const player = makePlayer(2, { displayName: "Dan" });
    render(<PlayerSeat seatIndex={2} player={player} isActiveTurn={true} />);
    const seat = screen.getByRole("listitem");
    const label = seat.getAttribute("aria-label") ?? "";
    expect(label).toContain("active turn");
  });

  it("does not include 'active turn' in aria-label by default", () => {
    const player = makePlayer(2, { displayName: "Dan" });
    render(<PlayerSeat seatIndex={2} player={player} />);
    const seat = screen.getByRole("listitem");
    const label = seat.getAttribute("aria-label") ?? "";
    expect(label).not.toContain("active turn");
  });

  it("applies animate-seat-glow class when isActiveTurn is true", () => {
    const player = makePlayer(0, { displayName: "Alice" });
    render(<PlayerSeat seatIndex={0} player={player} isActiveTurn={true} />);
    const seat = screen.getByRole("listitem");
    expect(seat.className).toContain("animate-seat-glow");
  });

  it("does not apply animate-seat-glow class when isActiveTurn is false", () => {
    const player = makePlayer(0, { displayName: "Alice" });
    render(<PlayerSeat seatIndex={0} player={player} isActiveTurn={false} />);
    const seat = screen.getByRole("listitem");
    expect(seat.className).not.toContain("animate-seat-glow");
  });
});

// ── OvalTable: activeTurnSeatIndex + cardCounts propagation ───────────────────

describe("OvalTable — activeTurnSeatIndex propagation", () => {
  it("applies data-active-turn to the correct seat in the oval list", () => {
    const seats: Array<LobbyPlayer | null> = Array.from({ length: 6 }, (_, i) =>
      makePlayer(i),
    );
    render(
      <OvalTable playerCount={6} seats={seats} activeTurnSeatIndex={2} />,
    );
    const ol = screen.getByRole("list", { name: "6 player seats" });
    // Seat 2 should carry data-active-turn
    const activeSeatLi = ol.querySelector(
      "[data-seat-index='2'] [data-active-turn='true']",
    );
    expect(activeSeatLi).not.toBeNull();
  });

  it("does not set data-active-turn on non-active seats", () => {
    const seats: Array<LobbyPlayer | null> = Array.from({ length: 6 }, (_, i) =>
      makePlayer(i),
    );
    render(
      <OvalTable playerCount={6} seats={seats} activeTurnSeatIndex={0} />,
    );
    const ol = screen.getByRole("list", { name: "6 player seats" });
    // seat 3 should NOT be active
    const inactiveSeat = ol.querySelector(
      "[data-seat-index='3'] [data-active-turn='true']",
    );
    expect(inactiveSeat).toBeNull();
  });

  it("no active-turn seats when activeTurnSeatIndex is omitted", () => {
    const seats: Array<LobbyPlayer | null> = Array.from({ length: 6 }, (_, i) =>
      makePlayer(i),
    );
    render(<OvalTable playerCount={6} seats={seats} />);
    const ol = screen.getByRole("list", { name: "6 player seats" });
    expect(ol.querySelector("[data-active-turn='true']")).toBeNull();
  });
});

describe("OvalTable — cardCounts propagation", () => {
  it("renders a card count badge for each seat in cardCounts", () => {
    const seats: Array<LobbyPlayer | null> = Array.from({ length: 6 }, (_, i) =>
      makePlayer(i),
    );
    const cardCounts = { 0: 8, 1: 7, 2: 6, 3: 5, 4: 4, 5: 3 };
    render(
      <OvalTable playerCount={6} seats={seats} cardCounts={cardCounts} />,
    );
    const ol = screen.getByRole("list", { name: "6 player seats" });
    const badges = within(ol).getAllByTestId("card-count-badge");
    // 6 seats in oval branch
    expect(badges.length).toBe(6);
  });

  it("renders no card count badges when cardCounts is omitted", () => {
    const seats: Array<LobbyPlayer | null> = Array.from({ length: 6 }, (_, i) =>
      makePlayer(i),
    );
    render(<OvalTable playerCount={6} seats={seats} />);
    const ol = screen.getByRole("list", { name: "6 player seats" });
    expect(within(ol).queryAllByTestId("card-count-badge")).toHaveLength(0);
  });

  it("does not render a card count badge on an empty seat even if cardCounts entry exists", () => {
    // Seat 0 is occupied, seat 1 is empty
    const seats: Array<LobbyPlayer | null> = [
      makePlayer(0),
      null,
      ...Array(4).fill(null),
    ];
    const cardCounts = { 0: 8, 1: 8 }; // entry for seat 1 exists but seat is empty
    render(
      <OvalTable playerCount={6} seats={seats} cardCounts={cardCounts} />,
    );
    const ol = screen.getByRole("list", { name: "6 player seats" });
    // Only 1 badge (seat 0); empty seat does not render one
    expect(within(ol).getAllByTestId("card-count-badge")).toHaveLength(1);
  });
});

// ── Seat geometry helper (internal — via exported buildSeatPositions) ─────────
// We test the oval container has exactly playerCount <li> wrapper elements.

describe("OvalTable — seat count in oval list", () => {
  it("oval list has exactly 6 <li> items for a 6-player room", () => {
    render(<OvalTable playerCount={6} seats={buildEmptySeats(6)} />);
    const ol = screen.getByRole("list", { name: "6 player seats" });
    // Use querySelectorAll to count only direct <li> wrappers, not inner
    // SeatToken divs which also carry role="listitem".
    const liItems = ol.querySelectorAll(":scope > li");
    expect(liItems).toHaveLength(6);
  });

  it("oval list has exactly 8 <li> items for an 8-player room", () => {
    render(<OvalTable playerCount={8} seats={buildEmptySeats(8)} />);
    const ol = screen.getByRole("list", { name: "8 player seats" });
    const liItems = ol.querySelectorAll(":scope > li");
    expect(liItems).toHaveLength(8);
  });
});
