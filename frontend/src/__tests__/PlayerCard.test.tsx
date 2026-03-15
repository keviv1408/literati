/**
 * @jest-environment jsdom
 */

/**
 * Unit tests for PlayerCard component.
 *
 * Tests both the empty-seat and occupied-seat states including host, current
 * user, and bot player variants.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import PlayerCard from "@/components/PlayerCard";
import type { LobbyPlayer } from "@/types/lobby";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePlayer(overrides: Partial<LobbyPlayer> = {}): LobbyPlayer {
  return {
    seatIndex: 2,
    displayName: "Alice",
    isBot: false,
    isHost: false,
    isCurrentUser: false,
    ...overrides,
  };
}

// ── Empty seat ────────────────────────────────────────────────────────────────

describe("PlayerCard — empty seat", () => {
  it("renders 'Waiting…' text for an empty seat", () => {
    render(<PlayerCard seatIndex={1} player={null} />);
    expect(screen.getByText("Waiting…")).toBeDefined();
  });

  it("has an accessible aria-label identifying the seat number", () => {
    render(<PlayerCard seatIndex={3} player={null} />);
    // seatIndex=3 → seat 4 in 1-based display
    const el = screen.getByRole("listitem");
    expect(el.getAttribute("aria-label")).toContain("Seat 4");
    expect(el.getAttribute("aria-label")).toContain("waiting");
  });

  it("does not render an Avatar for an empty seat", () => {
    const { container } = render(<PlayerCard seatIndex={0} player={null} />);
    // Avatar renders a div with role="img"; no such element should exist
    const avatarEl = container.querySelector('[role="img"]');
    expect(avatarEl).toBeNull();
  });
});

// ── Occupied seat — generic player ────────────────────────────────────────────

describe("PlayerCard — occupied seat", () => {
  it("renders the player's display name", () => {
    render(<PlayerCard seatIndex={0} player={makePlayer({ displayName: "Bob" })} />);
    expect(screen.getByText("Bob")).toBeDefined();
  });

  it("renders an avatar element", () => {
    const { container } = render(
      <PlayerCard seatIndex={0} player={makePlayer({ displayName: "Carol" })} />,
    );
    const avatarEl = container.querySelector('[role="img"]');
    expect(avatarEl).not.toBeNull();
  });

  it("has a descriptive aria-label on the card", () => {
    const player = makePlayer({ displayName: "Dave" });
    render(<PlayerCard seatIndex={0} player={player} />);
    const el = screen.getByRole("listitem");
    expect(el.getAttribute("aria-label")).toContain("Dave");
  });
});

// ── Host player ───────────────────────────────────────────────────────────────

describe("PlayerCard — host player", () => {
  it("includes 'host' in the aria-label", () => {
    const player = makePlayer({ displayName: "Eve", isHost: true });
    render(<PlayerCard seatIndex={0} player={player} />);
    const el = screen.getByRole("listitem");
    expect(el.getAttribute("aria-label")).toContain("host");
  });

  it("renders the host crown badge with title='Room host'", () => {
    const { container } = render(
      <PlayerCard seatIndex={0} player={makePlayer({ isHost: true })} />,
    );
    const crown = container.querySelector("[title='Room host']");
    expect(crown).not.toBeNull();
    expect(crown?.textContent).toContain("👑");
  });

  it("does not render the crown badge for a non-host", () => {
    const { container } = render(
      <PlayerCard seatIndex={0} player={makePlayer({ isHost: false })} />,
    );
    const crown = container.querySelector("[title='Room host']");
    expect(crown).toBeNull();
  });
});

// ── Current user ──────────────────────────────────────────────────────────────

describe("PlayerCard — current user", () => {
  it("renders a 'You' pill for the current user", () => {
    render(
      <PlayerCard seatIndex={0} player={makePlayer({ isCurrentUser: true })} />,
    );
    expect(screen.getByText("You")).toBeDefined();
  });

  it("does not render a 'You' pill for other players", () => {
    render(
      <PlayerCard seatIndex={2} player={makePlayer({ isCurrentUser: false })} />,
    );
    expect(screen.queryByText("You")).toBeNull();
  });

  it("includes 'you' in the aria-label for the current user", () => {
    const player = makePlayer({ displayName: "Frank", isCurrentUser: true });
    render(<PlayerCard seatIndex={0} player={player} />);
    const el = screen.getByRole("listitem");
    expect(el.getAttribute("aria-label")).toContain("you");
  });
});

// ── Bot player ────────────────────────────────────────────────────────────────

describe("PlayerCard — bot player", () => {
  it("renders the BotBadge (robot SVG) for a bot player", () => {
    const player = makePlayer({ displayName: "Quirky Turing", isBot: true });
    const { container } = render(<PlayerCard seatIndex={2} player={player} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
  });

  it("includes '(bot)' in the aria-label for a bot", () => {
    const player = makePlayer({ displayName: "Quirky Turing", isBot: true });
    render(<PlayerCard seatIndex={2} player={player} />);
    const el = screen.getByRole("listitem");
    expect(el.getAttribute("aria-label")).toContain("bot");
  });

  it("does not render a robot SVG for a human player", () => {
    const player = makePlayer({ displayName: "Grace", isBot: false });
    const { container } = render(<PlayerCard seatIndex={0} player={player} />);
    const svg = container.querySelector("svg");
    // Avatar renders a div, not an SVG — only BotBadge has an SVG
    expect(svg).toBeNull();
  });

  it("renders the bot's display name via BotBadge", () => {
    const player = makePlayer({ displayName: "Elegant Curie", isBot: true });
    render(<PlayerCard seatIndex={4} player={player} />);
    expect(screen.getByText("Elegant Curie")).toBeDefined();
  });
});

// ── Host + current user combo ─────────────────────────────────────────────────

describe("PlayerCard — host and current user", () => {
  it("shows both crown and 'You' pill when player is host and current user", () => {
    const player = makePlayer({ isHost: true, isCurrentUser: true, displayName: "Heidi" });
    const { container } = render(<PlayerCard seatIndex={0} player={player} />);
    expect(container.querySelector("[title='Room host']")).not.toBeNull();
    expect(screen.getByText("You")).toBeDefined();
  });
});
