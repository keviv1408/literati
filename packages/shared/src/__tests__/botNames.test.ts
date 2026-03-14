/**
 * Tests for the bot name generator.
 */

import { describe, it, expect } from "vitest";
import {
  generateBotName,
  formatBotName,
  isBotName,
  generateUniqueBotNames,
  createBotPlayer,
  BOT_ADJECTIVES,
  BOT_NOUNS,
} from "../botNames";

describe("generateBotName", () => {
  it("returns a string in adjective_noun format", () => {
    const name = generateBotName();
    expect(name).toMatch(/^[a-z_]+_[a-z_]+$/);
    const parts = name.split("_");
    expect(parts.length).toBeGreaterThanOrEqual(2);
  });

  it("uses known adjectives and nouns", () => {
    const name = generateBotName();
    const parts = name.split("_");
    const adjective = parts[0];
    const noun = parts.slice(1).join("_");
    expect(BOT_ADJECTIVES).toContain(adjective);
    expect(BOT_NOUNS).toContain(noun);
  });

  it("produces deterministic names given the same seed", () => {
    const seed = "test-bot-id-123";
    const name1 = generateBotName(seed);
    const name2 = generateBotName(seed);
    expect(name1).toBe(name2);
  });

  it("produces different names for different seeds", () => {
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      names.add(generateBotName(`seed-${i}`));
    }
    // Expect at least 10 unique names across 20 different seeds
    expect(names.size).toBeGreaterThan(10);
  });

  it("generates random names (no seed) that are valid", () => {
    for (let i = 0; i < 10; i++) {
      const name = generateBotName();
      expect(name).toBeTruthy();
      expect(typeof name).toBe("string");
    }
  });
});

describe("formatBotName", () => {
  it("capitalizes each word and replaces underscores with spaces", () => {
    expect(formatBotName("quirky_turing")).toBe("Quirky Turing");
  });

  it("handles multi-part nouns", () => {
    expect(formatBotName("elegant_von_neumann")).toBe("Elegant Von Neumann");
  });

  it("handles single-word names gracefully", () => {
    expect(formatBotName("zen")).toBe("Zen");
  });
});

describe("isBotName", () => {
  it("returns true for valid bot names", () => {
    // Generate a valid bot name and check it
    const name = generateBotName("deterministic-seed");
    expect(isBotName(name)).toBe(true);
  });

  it("returns false for regular user names", () => {
    expect(isBotName("Alice")).toBe(false);
    expect(isBotName("john_doe")).toBe(false);
    expect(isBotName("")).toBe(false);
    expect(isBotName("super_mario")).toBe(false);
  });

  it("returns false for names without underscore", () => {
    expect(isBotName("quirkyturing")).toBe(false);
  });

  it("returns true for multi-part nouns like von_neumann", () => {
    expect(isBotName("elegant_von_neumann")).toBe(true);
  });
});

describe("generateUniqueBotNames", () => {
  it("generates the requested number of names", () => {
    const names = generateUniqueBotNames(4);
    expect(names.length).toBe(4);
  });

  it("generates all unique names", () => {
    const names = generateUniqueBotNames(6);
    const nameSet = new Set(names);
    expect(nameSet.size).toBe(6);
  });

  it("avoids collision with existing names", () => {
    const existing = [generateBotName("seed-1"), generateBotName("seed-2")];
    const newNames = generateUniqueBotNames(3, existing);
    for (const name of newNames) {
      expect(existing).not.toContain(name);
    }
  });

  it("generates names for maximum game size (8 bots)", () => {
    const names = generateUniqueBotNames(8);
    expect(names.length).toBe(8);
    const nameSet = new Set(names);
    expect(nameSet.size).toBe(8);
  });
});

describe("createBotPlayer", () => {
  it("creates a bot player with correct shape", () => {
    const bot = createBotPlayer("bot-1", 1, 0);
    expect(bot.isBot).toBe(true);
    expect(bot.id).toBe("bot-1");
    expect(bot.teamId).toBe(1);
    expect(bot.seatIndex).toBe(0);
    expect(typeof bot.name).toBe("string");
    expect(typeof bot.displayName).toBe("string");
  });

  it("uses seed to deterministically name bots", () => {
    const bot1 = createBotPlayer("bot-abc", 1, 0, "fixed-seed");
    const bot2 = createBotPlayer("bot-xyz", 2, 1, "fixed-seed");
    // Same seed → same name
    expect(bot1.name).toBe(bot2.name);
  });

  it("uses the bot id as seed when no seed provided", () => {
    const bot1 = createBotPlayer("bot-123", 1, 0);
    const bot2 = createBotPlayer("bot-123", 1, 0);
    expect(bot1.name).toBe(bot2.name);
  });

  it("displayName is a human-readable formatted version of name", () => {
    const bot = createBotPlayer("bot-1", 1, 0, "quirky_turing");
    // Should be something like "Quirky Turing" not "quirky_turing"
    expect(bot.displayName).not.toContain("_");
    expect(bot.displayName[0]).toBe(bot.displayName[0].toUpperCase());
  });

  it("word lists have no duplicate entries", () => {
    const adjSet = new Set(BOT_ADJECTIVES);
    expect(adjSet.size).toBe(BOT_ADJECTIVES.length);

    const nounSet = new Set(BOT_NOUNS);
    expect(nounSet.size).toBe(BOT_NOUNS.length);
  });
});
