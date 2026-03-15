/**
 * Tests for the bot name generator utility.
 */

import {
  generateBotName,
  formatBotName,
  isBotName,
  generateUniqueBotNames,
  BOT_ADJECTIVES,
  BOT_NOUNS,
} from "@/utils/botNames";

describe("generateBotName", () => {
  it("returns a string in adjective_noun format", () => {
    const name = generateBotName();
    expect(typeof name).toBe("string");
    expect(name.includes("_")).toBe(true);
  });

  it("uses known adjectives", () => {
    const name = generateBotName();
    const adjective = name.split("_")[0];
    expect(BOT_ADJECTIVES).toContain(adjective);
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
    expect(names.size).toBeGreaterThan(10);
  });
});

describe("formatBotName", () => {
  it("capitalises each word", () => {
    expect(formatBotName("quirky_turing")).toBe("Quirky Turing");
  });

  it("handles multi-part nouns correctly", () => {
    expect(formatBotName("elegant_von_neumann")).toBe("Elegant Von Neumann");
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

  it("returns false for names without underscore", () => {
    expect(isBotName("quirkyturing")).toBe(false);
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
  it("adjective list has no duplicates", () => {
    expect(new Set(BOT_ADJECTIVES).size).toBe(BOT_ADJECTIVES.length);
  });

  it("noun list has no duplicates", () => {
    expect(new Set(BOT_NOUNS).size).toBe(BOT_NOUNS.length);
  });

  it("both lists are non-empty", () => {
    expect(BOT_ADJECTIVES.length).toBeGreaterThan(50);
    expect(BOT_NOUNS.length).toBeGreaterThan(50);
  });
});
