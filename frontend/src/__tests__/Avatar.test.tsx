/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import Avatar from "@/components/Avatar";

describe("Avatar component", () => {
  it("renders the glyph for a valid avatarId", () => {
    render(<Avatar displayName="Alice Johnson" avatarId="avatar-2" />);
    expect(screen.getByText("🐼")).toBeDefined();
  });

  it("renders a bot's fixed glyph when avatarId is null", () => {
    render(<Avatar displayName="Mochi" avatarId={null} />);
    expect(screen.getByText("🍡")).toBeDefined();
  });

  it("renders a stable name-derived glyph for unknown names without an avatarId", () => {
    const first = render(<Avatar displayName="Carol Green" />).container.textContent;
    const second = render(<Avatar displayName="Carol Green" />).container.textContent;
    expect(first).toBe(second);
    expect(first).toMatch(/\S/);
  });

  it("has role='img' and an accessible aria-label", () => {
    render(<Avatar displayName="Bob Smith" />);
    const el = screen.getByRole("img");
    expect(el.getAttribute("aria-label")).toBe("Avatar for Bob Smith");
  });

  it("accepts a custom aria-label", () => {
    render(<Avatar displayName="Bob" aria-label="Custom label" />);
    const el = screen.getByRole("img");
    expect(el.getAttribute("aria-label")).toBe("Custom label");
  });

  it("renders without errors for an empty display name", () => {
    const { container } = render(<Avatar displayName="" />);
    expect(container.textContent).toMatch(/\S/);
  });

  it("shows a title tooltip when showTooltip is true", () => {
    const { container } = render(<Avatar displayName="Dana White" showTooltip />);
    const el = container.firstChild as HTMLElement;
    expect(el.title).toBe("Dana White");
  });

  it("does not show a title tooltip when showTooltip is false (default)", () => {
    const { container } = render(<Avatar displayName="Dana White" />);
    const el = container.firstChild as HTMLElement;
    expect(el.title).toBeFalsy();
  });

  it("forwards extra className to the outer element", () => {
    const { container } = render(<Avatar displayName="Eve" className="my-custom-class" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("my-custom-class");
  });
});
