import {
  getAvatarColor,
  getAvatarEmoji,
  hashString,
  AVATAR_IDS,
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
// getAvatarEmoji
// ---------------------------------------------------------------------------
describe("getAvatarEmoji", () => {
  it("maps every avatar id to a distinct glyph", () => {
    const glyphs = AVATAR_IDS.map((id) => getAvatarEmoji(id, "whoever"));
    expect(new Set(glyphs).size).toBe(12);
  });

  it("prefers a valid avatarId over the name", () => {
    expect(getAvatarEmoji("avatar-1", "Mochi")).toBe(getAvatarEmoji("avatar-1", "Nova"));
  });

  it("gives known bot names a fixed glyph regardless of casing", () => {
    expect(getAvatarEmoji(null, "Mochi")).toBe("🍡");
    expect(getAvatarEmoji(undefined, "  mochi ")).toBe("🍡");
    expect(getAvatarEmoji("not-an-avatar", "Nova")).toBe("🌟");
  });

  it("falls back to a deterministic glyph from the avatar set for other names", () => {
    const glyph = getAvatarEmoji(null, "Kalven");
    expect(glyph).toBe(getAvatarEmoji(null, "kalven"));
    expect(AVATAR_IDS.map((id) => getAvatarEmoji(id, ""))).toContain(glyph);
  });
});
