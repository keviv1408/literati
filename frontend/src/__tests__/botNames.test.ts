/**
 * Tests for the bot name generator utility.
 */

import {
  generateBotName,
  formatBotName,
  isBotName,
  generateUniqueBotNames,
  BOT_NAME_KEYS,
} from "@/utils/botNames";

describe("generateBotName", () => {
  it("returns a string from the configured bot name pool", () => {
    const name = generateBotName();
    expect(typeof name).toBe("string");
    expect(BOT_NAME_KEYS).toContain(name);
  });

  it("uses known bot names", () => {
    const name = generateBotName();
    expect(BOT_NAME_KEYS).toContain(name);
  });

  it("produces deterministic output for the same seed", () => {
    const seed = "consistent-bot-id";
    expect(generateBotName(seed)).toBe(generateBotName(seed));
  });

  it("produces varied output for different seeds", () => {
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      names.add(generateBotName(`seed-${i}`));
    }
    expect(names.size).toBeGreaterThan(1);
    expect(names.size).toBeLessThanOrEqual(BOT_NAME_KEYS.length);
  });
});

describe("formatBotName", () => {
  it("capitalises a single-word bot key", () => {
    expect(formatBotName("ziggy")).toBe("Ziggy");
  });

  it("handles suffixed fallback names correctly", () => {
    expect(formatBotName("nova_2")).toBe("Nova 2");
  });

  it("handles single-word input", () => {
    expect(formatBotName("zen")).toBe("Zen");
  });
});

describe("isBotName", () => {
  it("returns true for auto-generated bot names", () => {
    const name = generateBotName("deterministic-seed");
    expect(isBotName(name)).toBe(true);
  });

  it("returns false for arbitrary human-like names", () => {
    expect(isBotName("Alice")).toBe(false);
    expect(isBotName("john_doe")).toBe(false);
    expect(isBotName("")).toBe(false);
    expect(isBotName("super_mario")).toBe(false);
  });

  it("returns false for unknown single-word names", () => {
    expect(isBotName("apollo")).toBe(false);
  });
});

describe("generateUniqueBotNames", () => {
  it("returns the requested count", () => {
    expect(generateUniqueBotNames(4).length).toBe(4);
  });

  it("returns all unique names", () => {
    const names = generateUniqueBotNames(6);
    expect(new Set(names).size).toBe(6);
  });

  it("avoids collision with existing names", () => {
    const existing = [generateBotName("s1"), generateBotName("s2")];
    const fresh = generateUniqueBotNames(3, existing);
    for (const n of fresh) {
      expect(existing).not.toContain(n);
    }
  });

  it("generates 8 unique names for a full bot game", () => {
    const names = generateUniqueBotNames(8);
    expect(names.length).toBe(8);
    expect(new Set(names).size).toBe(8);
  });
});

describe("word list integrity", () => {
  it("name list has no duplicates", () => {
    expect(new Set(BOT_NAME_KEYS).size).toBe(BOT_NAME_KEYS.length);
  });

  it("includes the full configured eight-bot set", () => {
    expect(BOT_NAME_KEYS).toHaveLength(8);
  });
});
