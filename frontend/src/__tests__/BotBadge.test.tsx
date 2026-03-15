/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { BotBadge, BotNameTag } from "@/components/BotBadge";

// ---------------------------------------------------------------------------
// BotBadge tests
// ---------------------------------------------------------------------------

describe("BotBadge component", () => {
  it("renders the display name", () => {
    render(<BotBadge displayName="Quirky Turing" />);
    expect(screen.getByText("Quirky Turing")).toBeDefined();
  });

  it("has an aria-label with '(Bot)' suffix by default", () => {
    render(<BotBadge displayName="Elegant Curie" />);
    const el = screen.getByLabelText("Elegant Curie (Bot)");
    expect(el).toBeDefined();
  });

  it("accepts a custom title/tooltip", () => {
    const { container } = render(
      <BotBadge displayName="Zen Einstein" title="Custom tooltip" />
    );
    const span = container.querySelector("[title='Custom tooltip']");
    expect(span).not.toBeNull();
  });

  it("renders the robot SVG icon", () => {
    const { container } = render(<BotBadge displayName="Bold Feynman" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
  });

  it("hides the name when showName=false", () => {
    render(<BotBadge displayName="Clever Darwin" showName={false} />);
    expect(screen.queryByText("Clever Darwin")).toBeNull();
  });

  it("renders all four size variants without errors", () => {
    const sizes = ["xs", "sm", "md", "lg"] as const;
    for (const size of sizes) {
      const { container } = render(
        <BotBadge displayName="Happy Newton" size={size} />
      );
      expect(container.firstChild).not.toBeNull();
    }
  });

  it("forwards extra className to the outer span", () => {
    const { container } = render(
      <BotBadge displayName="Stoic Gauss" className="test-class" />
    );
    const el = container.querySelector(".test-class");
    expect(el).not.toBeNull();
  });

  it("defaults to size 'md' when no size prop is supplied", () => {
    // Just verifies no crash; size='md' is the default
    const { container } = render(<BotBadge displayName="Jolly Lovelace" />);
    expect(container.firstChild).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BotNameTag tests
// ---------------------------------------------------------------------------

describe("BotNameTag component", () => {
  it("renders a plain span for human players", () => {
    render(<BotNameTag name="Alice" isBot={false} />);
    const el = screen.getByText("Alice");
    expect(el.tagName).toBe("SPAN");
    // No robot SVG for humans
    const svg = el.querySelector("svg");
    expect(svg).toBeNull();
  });

  it("renders a BotBadge for bot players", () => {
    const { container } = render(
      <BotNameTag name="Quirky Turing" isBot={true} />
    );
    // Name should appear
    expect(screen.getByText("Quirky Turing")).toBeDefined();
    // Robot SVG should be present
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
  });

  it("passes aria-label for bots", () => {
    render(<BotNameTag name="Eager Hawking" isBot={true} />);
    const el = screen.getByLabelText("Eager Hawking (Bot)");
    expect(el).toBeDefined();
  });

  it("does not add (Bot) to human player aria-label", () => {
    render(<BotNameTag name="Bob" isBot={false} />);
    expect(screen.queryByLabelText("Bob (Bot)")).toBeNull();
  });

  it("forwards className for both bot and human variants", () => {
    const { container: humanContainer } = render(
      <BotNameTag name="Alice" isBot={false} className="human-class" />
    );
    expect(humanContainer.querySelector(".human-class")).not.toBeNull();

    const { container: botContainer } = render(
      <BotNameTag name="Quirky Turing" isBot={true} className="bot-class" />
    );
    expect(botContainer.querySelector(".bot-class")).not.toBeNull();
  });
});
