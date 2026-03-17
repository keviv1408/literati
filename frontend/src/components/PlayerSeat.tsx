"use client";

/**
 * PlayerSeat — a compact seat slot for the OvalTable game view.
 *
 * Functionally similar to PlayerCard but styled for placement around an
 * elliptical table graphic: fixed width (~104 px), minimal vertical padding,
 * and a subtle team-coloured border accent.
 *
 * Renders two states:
 * • Occupied: avatar, display name (or BotBadge), host crown, "You" pill,
 * team-colour dot, card-count badge, active-turn glow ring.
 * • Empty: pulsing hourglass with "Waiting…" and a dashed border.
 *
 * New in * • `cardCount` — renders a small amber badge overlaid on the avatar showing
 * how many cards this player holds. Hidden when undefined.
 * • `isActiveTurn` — applies an animated amber glow / ring to the outer
 * container so the current-turn player is immediately visible at a glance.
 *
 * @example
 * // Occupied — host seat (Team 1, bottom of table), active turn, 6 cards
 * <PlayerSeat
 * seatIndex={0}
 * player={{ displayName: "Alice", isBot: false, isHost: true, isCurrentUser: true, seatIndex: 0 }}
 * cardCount={6}
 * isActiveTurn={true}
 * />
 *
 * @example
 * // Empty seat
 * <PlayerSeat seatIndex={3} player={null} />
 */

import React from "react";
import Avatar from "@/components/Avatar";
import { BotBadge } from "@/components/BotBadge";
import { getTeamForSeat } from "@/types/lobby";
import type { LobbyPlayer } from "@/types/lobby";

// ── Props ─────────────────────────────────────────────────────────────────────

export interface PlayerSeatProps {
  /** Zero-based seat index (determines team colour). */
  seatIndex: number;

  /** The occupying player, or `null` for an empty seat. */
  player: LobbyPlayer | null;

  /**
   * Number of cards remaining in this player's hand.
   * Rendered as a small badge overlay on the avatar when provided.
   * Pass `undefined` (or omit) to hide the badge (e.g. during lobby).
   */
  cardCount?: number;

  /**
   * When `true`, an animated amber glow ring is applied to the seat container
   * to indicate that this player currently has the turn.
   * @default false
   */
  isActiveTurn?: boolean;

  /** Extra Tailwind classes forwarded to the outer element. */
  className?: string;
}

// ── Team style map ────────────────────────────────────────────────────────────

const TEAM_STYLES = {
  1: {
    dot: "bg-emerald-500",
    border: "border-emerald-600/50",
    bg: "bg-emerald-900/30",
    emptyBorder: "border-emerald-900/50",
  },
  2: {
    dot: "bg-blue-500",
    border: "border-blue-600/50",
    bg: "bg-blue-900/30",
    emptyBorder: "border-blue-900/50",
  },
} as const;

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * PlayerSeat renders a compact seat chip suitable for the oval table layout.
 */
const PlayerSeat: React.FC<PlayerSeatProps> = ({
  seatIndex,
  player,
  cardCount,
  isActiveTurn = false,
  className = "",
}) => {
  const team = getTeamForSeat(seatIndex);
  const style = TEAM_STYLES[team];

  // ── Empty seat ──────────────────────────────────────────────────────────
  if (!player) {
    return (
      <div
        className={[
          // Fixed width so all seats are the same size around the table
          "w-[6.5rem] flex flex-col items-center gap-1",
          "py-2 px-2 rounded-xl",
          // Dashed border in the team colour signals "open slot"
          "border border-dashed",
          team === 1
            ? "border-emerald-900/60 bg-slate-900/60"
            : "border-blue-900/60 bg-slate-900/60",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        aria-label={`Seat ${seatIndex + 1} — waiting for player`}
        role="listitem"
        data-seat-index={seatIndex}
        data-team={team}
      >
        <span
          className="text-base text-slate-700 animate-pulse"
          aria-hidden="true"
        >
          ⌛
        </span>
        <span className="text-[0.6rem] text-slate-700 font-medium">
          Waiting…
        </span>
      </div>
    );
  }

  // ── Occupied seat ────────────────────────────────────────────────────────
  const { displayName, isBot, isHost, isCurrentUser, avatarUrl } = player;

  return (
    <div
      className={[
        "w-[6.5rem] flex flex-col items-center gap-1",
        "py-2 px-2 rounded-xl",
        "border",
        // Current user gets an emerald highlight regardless of team
        isCurrentUser
          ? "border-emerald-500/70 bg-emerald-900/40"
          : [style.border, style.bg].join(" "),
        // Active-turn amber ring (ring utility — layout layer)
        isActiveTurn ? "ring-2 ring-amber-400/80 ring-offset-1 ring-offset-slate-950" : "",
        // Active-turn glow animation (keyframe from globals.css)
        isActiveTurn ? "animate-seat-glow" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={[
        displayName,
        isHost ? "host" : null,
        isCurrentUser ? "you" : null,
        isBot ? "bot" : null,
        isActiveTurn ? "active turn" : null,
        cardCount !== undefined ? `${cardCount} cards` : null,
      ]
        .filter(Boolean)
        .join(", ")}
      role="listitem"
      data-seat-index={seatIndex}
      data-team={team}
      data-active-turn={isActiveTurn ? "true" : undefined}
    >
      {/* ── Avatar with optional host crown + card-count badge ────────── */}
      <div className="relative">
        <Avatar
          displayName={displayName}
          imageUrl={avatarUrl}
          size="sm"
          aria-label={undefined}
        />

        {isHost && (
          <span
            className="absolute -top-1 -right-1 text-[0.65rem] leading-none"
            aria-hidden="true"
            title="Room host"
          >
            👑
          </span>
        )}

        {/* Card count badge — bottom-left of avatar circle */}
        {cardCount !== undefined && (
          <span
            className={[
              // Pill badge anchored to bottom-left of the avatar wrapper
              "absolute -bottom-1 -left-1",
              "min-w-[1.1rem] h-[1.1rem] px-0.5",
              "flex items-center justify-center",
              "rounded-full text-[0.55rem] font-bold leading-none",
              // Colour: amber so it reads well on both team backgrounds
              "bg-amber-500 text-slate-900",
              "ring-1 ring-slate-950/70",
            ].join(" ")}
            aria-hidden="true"
            data-testid="card-count-badge"
          >
            {cardCount}
          </span>
        )}
      </div>

      {/* ── Name / bot badge ─────────────────────────────────────── */}
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
            "text-[0.65rem] font-medium truncate w-full text-center",
            isCurrentUser ? "text-emerald-300" : "text-slate-300",
          ].join(" ")}
          title={displayName}
        >
          {displayName}
        </span>
      )}

      {/* ── Team dot + "You" pill ─────────────────────────────────── */}
      <div className="flex items-center gap-1 flex-wrap justify-center min-h-[1rem]">
        <span
          className={[
            "w-1.5 h-1.5 rounded-full flex-shrink-0",
            style.dot,
          ].join(" ")}
          aria-hidden="true"
        />
        {isCurrentUser && (
          <span
            className="
              text-[0.55rem] font-semibold uppercase tracking-wider
              bg-emerald-600/40 text-emerald-300
              px-1 py-0.5 rounded-full leading-none
            "
            aria-hidden="true"
          >
            You
          </span>
        )}
      </div>
    </div>
  );
};

export default PlayerSeat;
