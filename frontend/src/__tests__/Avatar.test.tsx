/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import Avatar from "@/components/Avatar";

describe("Avatar component", () => {
  it("renders initials derived from the display name", () => {
    render(<Avatar displayName="Alice Johnson" />);
    expect(screen.getByText("AJ")).toBeDefined();
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

  it("shows an <img> tag when imageUrl is supplied", () => {
    const { container } = render(
      <Avatar displayName="Alice" imageUrl="https://example.com/avatar.png" />
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://example.com/avatar.png");
  });

  it("falls back to initials layout when imageUrl is null", () => {
    render(<Avatar displayName="Carol Green" imageUrl={null} />);
    expect(screen.getByText("CG")).toBeDefined();
  });

  it("renders without errors for an empty display name", () => {
    render(<Avatar displayName="" />);
    // Should show the '?' fallback
    expect(screen.getByText("?")).toBeDefined();
  });

  it("supports the 'sm' size variant without error", () => {
    const { container } = render(<Avatar displayName="Alice" size="sm" />);
    expect(container.firstChild).not.toBeNull();
  });

  it("supports the 'xl' size variant without error", () => {
    const { container } = render(<Avatar displayName="Alice" size="xl" />);
    expect(container.firstChild).not.toBeNull();
  });

  it("shows a title tooltip when showTooltip is true", () => {
    const { container } = render(
      <Avatar displayName="Dana White" showTooltip />
    );
    const el = container.firstChild as HTMLElement;
    expect(el.title).toBe("Dana White");
  });

  it("does not show a title tooltip when showTooltip is false (default)", () => {
    const { container } = render(<Avatar displayName="Dana White" />);
    const el = container.firstChild as HTMLElement;
    expect(el.title).toBeFalsy();
  });

  it("forwards extra className to the outer element", () => {
    const { container } = render(
      <Avatar displayName="Eve" className="my-custom-class" />
    );
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("my-custom-class");
  });
});
