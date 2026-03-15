/**
 * teamTheme.ts — Centralised team colour token definitions for Literati.
 *
 * This file is the **single source of truth** for all team colour palettes.
 * Import `TEAM_STYLES` (or `getTeamStyles`) from here instead of duplicating
 * Tailwind utility-class strings across component files.
 *
 * Design tokens
 * ─────────────
 * • Team A (Team 1) — Emerald green  (#10b981 family)
 * • Team B (Team 2) — Royal blue     (#3b82f6 family)
 *
 * Each token set covers every usage site in the lobby and game UI:
 *   • Column header:  border, background tint, text colour, colour dot
 *   • Seat count badge text
 *   • DnD drop-zone active state
 *   • Occupied seat card for the current user (border, bg, name text)
 *   • "You" identification pill (background, text)
 *
 * CSS custom properties
 * ─────────────────────
 * Raw colour values are also exposed as CSS custom properties in
 * `globals.css` under `--team-a-*` / `--team-b-*` so non-Tailwind
 * contexts (SVG, canvas, inline styles) can reference them without
 * hard-coding hex values.
 *
 * @example
 * import { getTeamStyles } from "@/lib/teamTheme";
 *
 * const style = getTeamStyles(1);
 * // style.headerText  → "text-emerald-400"
 * // style.dot         → "bg-emerald-500"
 * // style.cssVar      → "team-a"   (maps to --team-a-* CSS vars)
 */

import type { Team } from "@/types/room";

// ── Token shape ───────────────────────────────────────────────────────────────

export interface TeamStyleTokens {
  /** Human-readable label rendered in column headers ("Team 1" / "Team 2"). */
  label: string;

  // ── Column header ──────────────────────────────────────────────────────
  /** Tailwind class for the header wrapper border. */
  headerBorder: string;
  /** Tailwind class for the header label text. */
  headerText: string;
  /** Tailwind class for the header wrapper background tint. */
  headerBg: string;

  // ── Colour dot ─────────────────────────────────────────────────────────
  /** Tailwind class for the small team colour indicator dot. */
  dot: string;

  // ── Seat count badge ───────────────────────────────────────────────────
  /** Tailwind class for the "x/y seats" count text. */
  countText: string;

  // ── DnD drop-zone active state ─────────────────────────────────────────
  /** Tailwind class for the drop-zone background when a card is dragged over. */
  dropActiveBg: string;
  /** Tailwind class for the drop-zone ring/border when a card is dragged over. */
  dropActiveBorder: string;

  // ── Occupied seat — current user highlight ────────────────────────────
  /** Tailwind class for the current-user card border. */
  playerBorder: string;
  /** Tailwind class for the current-user card background tint. */
  playerBg: string;
  /** Tailwind class for the current-user name text. */
  playerText: string;

  // ── "You" identification pill ──────────────────────────────────────────
  /** Tailwind class for the "You" pill background. */
  youPillBg: string;
  /** Tailwind class for the "You" pill text. */
  youPillText: string;

  // ── ARIA ───────────────────────────────────────────────────────────────
  /** Accessible label for the column section element. */
  aria: string;

  /**
   * CSS custom-property prefix (without dashes).
   * Resolves to `--{cssVar}-*` variables defined in globals.css.
   * e.g. "team-a" → `var(--team-a-dot)`, `var(--team-a-text)`, …
   */
  cssVar: string;
}

// ── Token definitions ─────────────────────────────────────────────────────────

/**
 * Complete colour token map for both teams.
 *
 * Team 1 / Team A  →  Emerald (#10b981 family, Tailwind `emerald-*`)
 * Team 2 / Team B  →  Blue    (#3b82f6 family, Tailwind `blue-*`)
 */
export const TEAM_STYLES: Record<Team, TeamStyleTokens> = {
  1: {
    label: "Team 1",
    // Header
    headerBorder: "border-emerald-600/40",
    headerText: "text-emerald-400",
    headerBg: "bg-emerald-900/20",
    // Dot
    dot: "bg-emerald-500",
    // Count badge
    countText: "text-emerald-500/70",
    // DnD drop-zone
    dropActiveBg: "bg-emerald-900/40",
    dropActiveBorder: "border-emerald-500/60",
    // Current-user seat card
    playerBorder: "border-emerald-600/60",
    playerBg: "bg-emerald-900/30",
    playerText: "text-emerald-300",
    // "You" pill
    youPillBg: "bg-emerald-600/40",
    youPillText: "text-emerald-300",
    // ARIA / CSS var
    aria: "Team 1 column",
    cssVar: "team-a",
  },
  2: {
    label: "Team 2",
    // Header
    headerBorder: "border-blue-600/40",
    headerText: "text-blue-400",
    headerBg: "bg-blue-900/20",
    // Dot
    dot: "bg-blue-500",
    // Count badge
    countText: "text-blue-500/70",
    // DnD drop-zone
    dropActiveBg: "bg-blue-900/40",
    dropActiveBorder: "border-blue-500/60",
    // Current-user seat card
    playerBorder: "border-blue-600/60",
    playerBg: "bg-blue-900/30",
    playerText: "text-blue-300",
    // "You" pill
    youPillBg: "bg-blue-600/40",
    youPillText: "text-blue-300",
    // ARIA / CSS var
    aria: "Team 2 column",
    cssVar: "team-b",
  },
} as const;

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Return the full style token set for the given team.
 *
 * @param team  1 (Team A / Emerald) or 2 (Team B / Blue)
 */
export function getTeamStyles(team: Team): TeamStyleTokens {
  return TEAM_STYLES[team];
}
