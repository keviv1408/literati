/**
 * Avatar utility
 *
 * Maps the backend's `avatar-1..12` ids to emoji glyphs and derives a
 * deterministic background colour from the display name's hash. Players
 * without a valid id (bots, legacy accounts) get a glyph from their name.
 */

export const AVATAR_IDS = Array.from({ length: 12 }, (_, i) => `avatar-${i + 1}`);

const AVATAR_EMOJI: Record<string, string> = {
  "avatar-1": "🦊",
  "avatar-2": "🐼",
  "avatar-3": "🐸",
  "avatar-4": "🐙",
  "avatar-5": "🦉",
  "avatar-6": "🐯",
  "avatar-7": "🦄",
  "avatar-8": "🐧",
  "avatar-9": "🦁",
  "avatar-10": "🐨",
  "avatar-11": "🐝",
  "avatar-12": "🦋",
};

// Bot name pool lives in backend/src/matchmaking/botFiller.js.
const BOT_EMOJI: Record<string, string> = {
  ziggy: "⚡",
  mochi: "🍡",
  nova: "🌟",
  tango: "💃",
  pebble: "🪨",
  echo: "🔊",
  jinx: "🃏",
  vega: "🔭",
};

/**
 * Glyph for a player: their chosen avatar when valid, otherwise one derived
 * from the display name (fixed for bot names, hashed for anything else).
 */
export function getAvatarEmoji(
  avatarId: string | null | undefined,
  displayName: string,
): string {
  if (avatarId && AVATAR_EMOJI[avatarId]) return AVATAR_EMOJI[avatarId];
  const key = (displayName ?? "").trim().toLowerCase().split(/\s+/)[0];
  return BOT_EMOJI[key] ?? AVATAR_EMOJI[AVATAR_IDS[hashString(key) % AVATAR_IDS.length]];
}

// ---------------------------------------------------------------------------
// Deterministic color palette
// ---------------------------------------------------------------------------

/**
 * A curated palette of accessible background colours paired with a
 * contrasting foreground (text) colour.
 *
 * All colours have been chosen so that white text passes WCAG AA at normal
 * text sizes when using the dark variants, and dark text (#1e293b) passes
 * AA on the lighter variants.
 */
export interface AvatarColor {
  /** CSS hex or hsl background colour */
  bg: string;
  /** CSS hex or hsl foreground (text) colour */
  fg: string;
}

export const AVATAR_PALETTE: AvatarColor[] = [
  { bg: "#ef4444", fg: "#ffffff" }, // red-500
  { bg: "#f97316", fg: "#ffffff" }, // orange-500
  { bg: "#eab308", fg: "#1e293b" }, // yellow-500  (dark text for contrast)
  { bg: "#22c55e", fg: "#ffffff" }, // green-500
  { bg: "#14b8a6", fg: "#ffffff" }, // teal-500
  { bg: "#06b6d4", fg: "#ffffff" }, // cyan-500
  { bg: "#3b82f6", fg: "#ffffff" }, // blue-500
  { bg: "#6366f1", fg: "#ffffff" }, // indigo-500
  { bg: "#8b5cf6", fg: "#ffffff" }, // violet-500
  { bg: "#a855f7", fg: "#ffffff" }, // purple-500
  { bg: "#ec4899", fg: "#ffffff" }, // pink-500
  { bg: "#f43f5e", fg: "#ffffff" }, // rose-500
  { bg: "#10b981", fg: "#ffffff" }, // emerald-500
  { bg: "#0ea5e9", fg: "#ffffff" }, // sky-500
  { bg: "#f59e0b", fg: "#1e293b" }, // amber-500 (dark text)
  { bg: "#84cc16", fg: "#1e293b" }, // lime-500  (dark text)
];

// ---------------------------------------------------------------------------
// Hash function (djb2 variant)
// ---------------------------------------------------------------------------

/**
 * Compute a non-negative 32-bit integer hash of `str` using a djb2-style
 * algorithm.  The result is *deterministic*: the same string always produces
 * the same number, regardless of platform or engine.
 */
export function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    // hash * 33 ^ charCode  (keep within 32-bit range with >>> 0)
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic `AvatarColor` for the given display name by
 * hashing the lowercased, trimmed name and indexing into the palette.
 */
export function getAvatarColor(displayName: string): AvatarColor {
  const key = (displayName ?? "").trim().toLowerCase();
  const index = hashString(key) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[index];
}
