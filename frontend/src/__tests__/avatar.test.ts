import {
  getInitials,
  getAvatarColor,
  getAvatarProps,
  hashString,
  AVATAR_PALETTE,
} from "@/utils/avatar";

// ---------------------------------------------------------------------------
// hashString
// ---------------------------------------------------------------------------
describe("hashString", () => {
  it("returns a non-negative integer", () => {
    const h = hashString("hello");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(h)).toBe(true);
  });

  it("is deterministic — same input → same output", () => {
    expect(hashString("Alice")).toBe(hashString("Alice"));
    expect(hashString("Bob")).toBe(hashString("Bob"));
  });

  it("produces different hashes for different strings", () => {
    expect(hashString("Alice")).not.toBe(hashString("Bob"));
  });

  it("handles empty string without error", () => {
    expect(() => hashString("")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getInitials
// ---------------------------------------------------------------------------
describe("getInitials", () => {
  it("returns first and last initials for a two-word name", () => {
    expect(getInitials("Alice Johnson")).toBe("AJ");
  });

  it("returns a single initial for a single-word name", () => {
    expect(getInitials("Alice")).toBe("A");
  });

  it("uses first and last word for names with three or more words", () => {
    expect(getInitials("Mary Jane Watson")).toBe("MW");
  });

  it("returns a single initial when first and last words share the same starting letter", () => {
    // "Anna Atkinson" → first="A", last="A" — same letter, collapse to one
    expect(getInitials("Anna Atkinson")).toBe("A");
  });

  it("is case-insensitive — always returns uppercase", () => {
    expect(getInitials("alice johnson")).toBe("AJ");
    expect(getInitials("ALICE JOHNSON")).toBe("AJ");
  });

  it("trims leading and trailing whitespace", () => {
    expect(getInitials("  Alice Johnson  ")).toBe("AJ");
  });

  it("returns '?' for an empty string", () => {
    expect(getInitials("")).toBe("?");
  });

  it("returns '?' for whitespace-only string", () => {
    expect(getInitials("   ")).toBe("?");
  });

  it("handles a numeric-only name gracefully", () => {
    const result = getInitials("42");
    // Should not throw; may return the digit or '?'
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles a single-character name", () => {
    expect(getInitials("Z")).toBe("Z");
  });
});

// ---------------------------------------------------------------------------
// getAvatarColor
// ---------------------------------------------------------------------------
describe("getAvatarColor", () => {
  it("returns a colour object with bg and fg strings", () => {
    const color = getAvatarColor("Alice Johnson");
    expect(typeof color.bg).toBe("string");
    expect(typeof color.fg).toBe("string");
    expect(color.bg.startsWith("#")).toBe(true);
    expect(color.fg.startsWith("#")).toBe(true);
  });

  it("is deterministic — same name always produces same colour", () => {
    const c1 = getAvatarColor("Alice Johnson");
    const c2 = getAvatarColor("Alice Johnson");
    expect(c1.bg).toBe(c2.bg);
    expect(c1.fg).toBe(c2.fg);
  });

  it("returns a colour from the palette", () => {
    const color = getAvatarColor("Bob Smith");
    const match = AVATAR_PALETTE.find((p) => p.bg === color.bg && p.fg === color.fg);
    expect(match).toBeDefined();
  });

  it("handles an empty string without throwing", () => {
    expect(() => getAvatarColor("")).not.toThrow();
  });

  it("is case-insensitive (same colour for different casing)", () => {
    const c1 = getAvatarColor("alice johnson");
    const c2 = getAvatarColor("ALICE JOHNSON");
    expect(c1.bg).toBe(c2.bg);
  });

  it("distributes colours across the palette (smoke test with 32 names)", () => {
    const names = Array.from({ length: 32 }, (_, i) => `Player${i}`);
    const colours = new Set(names.map((n) => getAvatarColor(n).bg));
    // Expect at least 4 distinct colours for 32 different names
    expect(colours.size).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// getAvatarProps
// ---------------------------------------------------------------------------
describe("getAvatarProps", () => {
  it("returns both initials and color", () => {
    const props = getAvatarProps("Alice Johnson");
    expect(props.initials).toBe("AJ");
    expect(props.color).toBeDefined();
    expect(props.color.bg).toBeTruthy();
    expect(props.color.fg).toBeTruthy();
  });

  it("is consistent with individual helpers", () => {
    const name = "Bob Smith";
    const props = getAvatarProps(name);
    expect(props.initials).toBe(getInitials(name));
    expect(props.color.bg).toBe(getAvatarColor(name).bg);
  });
});
