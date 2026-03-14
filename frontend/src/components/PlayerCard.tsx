"use client";

/**
 * PlayerCard — a single seat card in the lobby team columns.
 *
 * Renders one of two states:
 *  • Occupied: avatar circle, display name (with bot badge), host crown,
 *              "You" pill if it's the current user.
 *  • Empty:    animated hourglass with "Waiting…" label and a dashed border.
 *
 * @example
 * // Occupied seat
 * <PlayerCard
 *   seatIndex={0}
 *   player={{ displayName: "Alice", isBot: false, isHost: true, isCurrentUser: true, seatIndex: 0 }}
 * />
 *
 * @example
 * // Empty seat
 * <PlayerCard seatIndex={2} player={null} />
 */

import React from "react";
import Avatar from "@/components/Avatar";
import { BotBadge } from "@/components/BotBadge";
import type { LobbyPlayer } from "@/types/lobby";
import { getTeamForSeat } from "@/types/lobby";
import type { Team } from "@/types/room";
import { TEAM_STYLES } from "@/lib/teamTheme";

// ── Props ────────────────────────────────────────────────────────────────────

export interface PlayerCardProps {
  /** Zero-based seat index (used for aria labels). */
  seatIndex: number;
  /**
   * The player occupying this seat, or `null` if the seat is empty.
   */
  player: LobbyPlayer | null;
  /**
   * The effective team for this seat (1 or 2).
   * Drives the colour-coding of the current-user highlight.
   * When omitted the team is derived from `seatIndex` via `getTeamForSeat`.
   */
  team?: Team;
  /** Extra Tailwind classes forwarded to the outer card element. */
  className?: string;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * PlayerCard renders the content of a single lobby seat.
 */
const PlayerCard: React.FC<PlayerCardProps> = ({
  seatIndex,
  player,
  team,
  className = "",
}) => {
  // Resolve team for colour tokens: use explicit prop, fall back to natural seat team.
  const effectiveTeam: Team = team ?? getTeamForSeat(seatIndex);
  const teamStyle = TEAM_STYLES[effectiveTeam];

  // ── Empty seat ─────────────────────────────────────────────────────────
  if (!player) {
    return (
      <div
        className={[
          // Layout
          "flex flex-col items-center justify-center gap-1.5",
          "min-h-[4.5rem] px-3 py-3 rounded-xl",
          // Border — dashed to signal "open"
          "border border-dashed border-slate-700",
          "bg-slate-800/30",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        aria-label={`Seat ${seatIndex + 1} — waiting for player`}
        role="listitem"
      >
        {/* Hourglass icon */}
        <span
          className="text-xl text-slate-600 animate-pulse"
          aria-hidden="true"
        >
          ⌛
        </span>
        <span className="text-xs text-slate-600 font-medium">Waiting…</span>
      </div>
    );
  }

  // ── Occupied seat ───────────────────────────────────────────────────────
  const { displayName, isBot, isHost, isCurrentUser, avatarUrl } = player;

  return (
    <div
      className={[
        // Layout
        "flex flex-col items-center justify-center gap-1.5",
        "min-h-[4.5rem] px-3 py-3 rounded-xl",
        // Background — current user gets team-coloured highlight; others get neutral
        isCurrentUser
          ? `border ${teamStyle.playerBorder} ${teamStyle.playerBg}`
          : "border border-slate-700/60 bg-slate-800/40",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={`${displayName}${isHost ? ", host" : ""}${isCurrentUser ? ", you" : ""}${isBot ? " (bot)" : ""}`}
      role="listitem"
    >
      {/* Avatar row */}
      <div className="relative">
        <Avatar
          displayName={displayName}
          imageUrl={avatarUrl}
          size="sm"
          aria-label={undefined}
        />

        {/* Host crown badge — top-right corner */}
        {isHost && (
          <span
            className="absolute -top-1 -right-1 text-[0.7rem] leading-none"
            aria-hidden="true"
            title="Room host"
          >
            👑
          </span>
        )}
      </div>

      {/* Name / bot badge */}
      {isBot ? (
        <BotBadge
          displayName={displayName}
          size="xs"
          showName={true}
          className="max-w-full"
        />
      ) : (
        <span
          className={[
            "text-xs font-medium truncate max-w-[6rem] text-center",
            isCurrentUser ? teamStyle.playerText : "text-slate-300",
          ].join(" ")}
          title={displayName}
        >
          {displayName}
        </span>
      )}

      {/* "You" pill — coloured with team palette */}
      {isCurrentUser && (
        <span
          className={[
            "text-[0.6rem] font-semibold uppercase tracking-wider",
            teamStyle.youPillBg,
            teamStyle.youPillText,
            "px-1.5 py-0.5 rounded-full leading-none",
          ].join(" ")}
          aria-hidden="true"
        >
          You
        </span>
      )}
    </div>
  );
};

export default PlayerCard;
