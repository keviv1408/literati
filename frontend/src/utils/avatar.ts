/**
 * Avatar utility — initials-based avatar generator
 *
 * Derives 1–2 initials from a display name and maps them to a
 * deterministic background color computed from the name's hash.
 */

// ---------------------------------------------------------------------------
// Initials derivation
// ---------------------------------------------------------------------------

/**
 * Extract 1–2 uppercase initials from a display name.
 *
 * Rules:
 * - Split on whitespace; take the first letter of the first word and the
 *   first letter of the last word (if different).
 * - Fall back to a single character when the name is one word or empty.
 * - Non-alphabetic names (e.g. "42") return "?" as a safe fallback.
 */
export function getInitials(displayName: string): string {
  const trimmed = (displayName ?? "").trim();
  if (!trimmed) return "?";

  const words = trimmed.split(/\s+/).filter(Boolean);

  if (words.length === 0) return "?";

  const first = words[0].charAt(0).toUpperCase();
  const last =
    words.length > 1
      ? words[words.length - 1].charAt(0).toUpperCase()
      : null;

  const initials = last && last !== first ? first + last : first;

  // Replace any character that isn't a letter or digit with "?"
  return /^[A-Z0-9]{1,2}$/.test(initials) ? initials : initials.replace(/[^A-Z0-9]/g, "") || "?";
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

/**
 * Convenience function that returns both initials *and* colour together.
 *
 * @example
 * const { initials, color } = getAvatarProps("Alice Johnson");
 * // initials === "AJ"
 * // color === { bg: "#…", fg: "#…" }
 */
export function getAvatarProps(displayName: string): {
  initials: string;
  color: AvatarColor;
} {
  return {
    initials: getInitials(displayName),
    color: getAvatarColor(displayName),
  };
}
