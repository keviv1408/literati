/** Shared team color tokens for the lobby and game UI. */

import type { Team } from "@/types/room";

export interface TeamStyleTokens {
  label: string;
  headerBorder: string;
  headerText: string;
  headerBg: string;
  dot: string;
  countText: string;
  dropActiveBg: string;
  dropActiveBorder: string;
  playerBorder: string;
  playerBg: string;
  playerText: string;
  youPillBg: string;
  youPillText: string;
  aria: string;
  cssVar: string;
}
export const TEAM_STYLES: Record<Team, TeamStyleTokens> = {
  1: {
    label: "Team 1",
    headerBorder: "border-emerald-600/40",
    headerText: "text-emerald-400",
    headerBg: "bg-emerald-900/20",
    dot: "bg-emerald-500",
    countText: "text-emerald-500/70",
    dropActiveBg: "bg-emerald-900/40",
    dropActiveBorder: "border-emerald-500/60",
    playerBorder: "border-emerald-600/60",
    playerBg: "bg-emerald-900/30",
    playerText: "text-emerald-300",
    youPillBg: "bg-emerald-600/40",
    youPillText: "text-emerald-300",
    aria: "Team 1 column",
    cssVar: "team-a",
  },
  2: {
    label: "Team 2",
    headerBorder: "border-blue-600/40",
    headerText: "text-blue-400",
    headerBg: "bg-blue-900/20",
    dot: "bg-blue-500",
    countText: "text-blue-500/70",
    dropActiveBg: "bg-blue-900/40",
    dropActiveBorder: "border-blue-500/60",
    playerBorder: "border-blue-600/60",
    playerBg: "bg-blue-900/30",
    playerText: "text-blue-300",
    youPillBg: "bg-blue-600/40",
    youPillText: "text-blue-300",
    aria: "Team 2 column",
    cssVar: "team-b",
  },
} as const;
export function getTeamStyles(team: Team): TeamStyleTokens {
  return TEAM_STYLES[team];
}
