/**
 * Docker-style bot name generator for Literature card game bots.
 *
 * Names follow the pattern: {adjective}_{noun}
 * Similar to Docker's name generator (e.g., "quirky_torvalds", "elegant_wozniak").
 *
 * Adjectives and scientist/pioneer names sourced in the spirit of Docker's generator.
 */

export const BOT_ADJECTIVES: readonly string[] = [
  "admiring",
  "adoring",
  "affectionate",
  "agitated",
  "amazing",
  "angry",
  "awesome",
  "blissful",
  "bold",
  "boring",
  "brave",
  "busy",
  "charming",
  "clever",
  "compassionate",
  "competent",
  "condescending",
  "confident",
  "cool",
  "cranky",
  "crazy",
  "dazzling",
  "determined",
  "distracted",
  "dreamy",
  "eager",
  "ecstatic",
  "elastic",
  "elated",
  "elegant",
  "eloquent",
  "epic",
  "exciting",
  "fervent",
  "festive",
  "flamboyant",
  "focused",
  "friendly",
  "frosty",
  "funny",
  "gallant",
  "gifted",
  "goofy",
  "gracious",
  "great",
  "happy",
  "hardcore",
  "heuristic",
  "hopeful",
  "hungry",
  "infallible",
  "inspiring",
  "intelligent",
  "interesting",
  "jolly",
  "jovial",
  "keen",
  "kind",
  "laughing",
  "loving",
  "lucid",
  "magical",
  "mystifying",
  "naughty",
  "nervous",
  "nice",
  "nifty",
  "nostalgic",
  "objective",
  "optimistic",
  "peaceful",
  "pedantic",
  "pensive",
  "practical",
  "quirky",
  "quizzical",
  "recursing",
  "relaxed",
  "reverent",
  "romantic",
  "sad",
  "serene",
  "sharp",
  "silly",
  "sleepy",
  "stoic",
  "strange",
  "stupefied",
  "suspicious",
  "sweet",
  "tender",
  "thirsty",
  "trusting",
  "unruffled",
  "upbeat",
  "vibrant",
  "vigilant",
  "vigorous",
  "wizardly",
  "wonderful",
  "xenodochial",
  "youthful",
  "zealous",
  "zen",
] as const;

/**
 * Famous scientists, mathematicians, engineers, and computing pioneers.
 * Docker names bots after notable figures in science and technology.
 */
export const BOT_NOUNS: readonly string[] = [
  // Computing & Math
  "turing",
  "lovelace",
  "hopper",
  "dijkstra",
  "knuth",
  "torvalds",
  "wozniak",
  "ritchie",
  "thompson",
  "kernighan",
  "mccarthy",
  "minsky",
  "backus",
  "lamport",
  "liskov",
  "hamming",
  "shannon",
  "babbage",
  "boole",
  "von_neumann",
  "berners_lee",
  "cerf",
  "postel",
  "stallman",
  // Physics
  "curie",
  "einstein",
  "feynman",
  "hawking",
  "bohr",
  "heisenberg",
  "dirac",
  "tesla",
  "faraday",
  "maxwell",
  "newton",
  "galileo",
  "fermi",
  "planck",
  "schrodinger",
  "pauli",
  "noether",
  // Math
  "euler",
  "gauss",
  "ramanujan",
  "poincare",
  "riemann",
  "hilbert",
  "godel",
  "cantor",
  "fibonacci",
  "pascal",
  "archimedes",
  "pythagoras",
  "fermat",
  "leibniz",
  "cauchy",
  "galois",
  "laplace",
  // Biology & Chemistry
  "darwin",
  "pasteur",
  "mendel",
  "lavoisier",
  "mendeleev",
  "franklin",
  "crick",
  "watson",
  "mcclintock",
  // Explorers & Inventors
  "edison",
  "bell",
  "marconi",
  "wright",
  "morse",
  "nobel",
  "herschel",
  "hubble",
  "sagan",
  "tyson",
  // CS Pioneers
  "allen",
  "gates",
  "jobs",
  "brin",
  "page",
  "zuckerberg",
  "stroustrup",
  "gosling",
  "van_rossum",
  "hickey",
  "odersky",
  "kay",
] as const;

export type BotName = `${string}_${string}`;

/**
 * Generate a deterministic bot name from a seed string.
 * The same seed always produces the same name (useful for consistent bot identities).
 */
function seedHash(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Generate a Docker-style bot name.
 *
 * @param seed - Optional deterministic seed. If omitted, a random name is generated.
 * @returns A bot name like "quirky_turing" or "elegant_curie"
 */
export function generateBotName(seed?: string): BotName {
  let adjIndex: number;
  let nounIndex: number;

  if (seed !== undefined) {
    const hash = seedHash(seed);
    adjIndex = hash % BOT_ADJECTIVES.length;
    nounIndex = Math.floor(hash / BOT_ADJECTIVES.length) % BOT_NOUNS.length;
  } else {
    adjIndex = Math.floor(Math.random() * BOT_ADJECTIVES.length);
    nounIndex = Math.floor(Math.random() * BOT_NOUNS.length);
  }

  const adjective = BOT_ADJECTIVES[adjIndex];
  const noun = BOT_NOUNS[nounIndex];
  return `${adjective}_${noun}` as BotName;
}

/**
 * Generate a display-friendly version of a bot name.
 * Converts "quirky_turing" to "Quirky Turing"
 */
export function formatBotName(name: BotName | string): string {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Check whether a given player name belongs to a bot.
 * Bot names always follow the adjective_noun pattern from our word lists.
 */
export function isBotName(name: string): boolean {
  const parts = name.split("_");
  if (parts.length < 2) return false;
  const adjective = parts[0];
  const noun = parts.slice(1).join("_"); // Handle multi-part nouns like "von_neumann"
  return (
    (BOT_ADJECTIVES as readonly string[]).includes(adjective) &&
    (BOT_NOUNS as readonly string[]).includes(noun)
  );
}

/**
 * Generate a set of unique bot names for filling a game.
 *
 * @param count - Number of unique bot names to generate
 * @param existingNames - Names already taken (to avoid collisions)
 * @returns Array of unique bot names
 */
export function generateUniqueBotNames(
  count: number,
  existingNames: string[] = []
): BotName[] {
  const taken = new Set(existingNames);
  const names: BotName[] = [];
  let attempts = 0;
  const maxAttempts = count * 50;

  while (names.length < count && attempts < maxAttempts) {
    const name = generateBotName();
    if (!taken.has(name)) {
      taken.add(name);
      names.push(name);
    }
    attempts++;
  }

  // Fallback: append numeric suffix if we somehow exhaust combinations
  if (names.length < count) {
    let suffix = 2;
    while (names.length < count) {
      const base = generateBotName();
      const suffixed = `${base}_${suffix}` as BotName;
      if (!taken.has(suffixed)) {
        taken.add(suffixed);
        names.push(suffixed);
      }
      suffix++;
    }
  }

  return names;
}

/**
 * Bot player type — minimal interface shared between server and client.
 */
export interface BotPlayer {
  id: string;
  name: BotName;
  displayName: string;
  isBot: true;
  teamId: 1 | 2;
  seatIndex: number;
}

/**
 * Create a bot player object with an auto-generated name.
 */
export function createBotPlayer(
  id: string,
  teamId: 1 | 2,
  seatIndex: number,
  seed?: string
): BotPlayer {
  const name = generateBotName(seed ?? id);
  return {
    id,
    name,
    displayName: formatBotName(name),
    isBot: true,
    teamId,
    seatIndex,
  };
}
