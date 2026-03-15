"use client";

/**
 * LobbyTeamColumns — the main waiting-room layout for a Literati game room.
 *
 * Displays two labelled team columns (Team 1 – Emerald, Team 2 – Blue) with
 * a player card for every seat. Seats alternate T1-T2-T1-T2 clockwise around
 * the oval table:
 *
 *   Seat 0, 2, 4[, 6] → Team 1 (left column)
 *   Seat 1, 3, 5[, 7] → Team 2 (right column)
 *
 * For a 6-player room each column has 3 cards; for 8-player, 4 cards.
 *
 * @example
 * // All-empty lobby (just opened the room)
 * <LobbyTeamColumns
 *   playerCount={6}
 *   seats={[null, null, null, null, null, null]}
 * />
 *
 * @example
 * // Partially filled lobby
 * <LobbyTeamColumns
 *   playerCount={6}
 *   seats={[
 *     { seatIndex: 0, displayName: "Alice", isBot: false, isHost: true, isCurrentUser: true },
 *     null,
 *     { seatIndex: 2, displayName: "Quirky Turing", isBot: true, isHost: false, isCurrentUser: false },
 *     null,
 *     null,
 *     null,
 *   ]}
 * />
 */

import React from "react";
import PlayerCard from "@/components/PlayerCard";
import { splitSeatsByTeam } from "@/types/lobby";
import type { LobbyPlayer } from "@/types/lobby";
import { TEAM_STYLES } from "@/lib/teamTheme";

// ── Props ─────────────────────────────────────────────────────────────────────

export interface LobbyTeamColumnsProps {
  /**
   * Total number of players this room supports (6 or 8).
   * Used to validate / pad the `seats` array.
   */
  playerCount: 6 | 8;

  /**
   * Ordered array of `playerCount` entries. Index = seat index.
   * `null` means the seat is unoccupied (shows "Waiting…" card).
   */
  seats: Array<LobbyPlayer | null>;

  /** Extra Tailwind classes forwarded to the outer wrapper. */
  className?: string;
}

// ── Sub-component: one team column ────────────────────────────────────────────

interface TeamColumnProps {
  team: 1 | 2;
  entries: Array<{ seatIndex: number; player: LobbyPlayer | null }>;
  seatsPerTeam: number;
}

const TeamColumn: React.FC<TeamColumnProps> = ({
  team,
  entries,
  seatsPerTeam,
}) => {
  const style = TEAM_STYLES[team];
  const occupied = entries.filter((e) => e.player !== null).length;

  return (
    <section
      aria-label={style.aria}
      className="flex flex-col gap-3 flex-1 min-w-0"
    >
      {/* ── Column header ────────────────────────────────────────── */}
      <div
        className={[
          "flex items-center justify-between",
          "px-3 py-2 rounded-xl",
          "border",
          style.headerBorder,
          style.headerBg,
        ].join(" ")}
      >
        <div className="flex items-center gap-2">
          {/* Colour dot */}
          <span
            className={["w-2 h-2 rounded-full flex-shrink-0", style.dot].join(
              " ",
            )}
            aria-hidden="true"
          />
          <h3
            className={[
              "text-sm font-semibold uppercase tracking-widest",
              style.headerText,
            ].join(" ")}
          >
            {style.label}
          </h3>
        </div>

        {/* Seat count badge  */}
        <span
          className={["text-xs tabular-nums font-mono", style.countText].join(
            " ",
          )}
          aria-label={`${occupied} of ${seatsPerTeam} seats filled`}
        >
          {occupied}/{seatsPerTeam}
        </span>
      </div>

      {/* ── Player cards ─────────────────────────────────────────── */}
      <ol
        className="flex flex-col gap-2 list-none m-0 p-0"
        aria-label={`${style.label} player seats`}
      >
        {entries.map(({ seatIndex, player }) => (
          <li key={seatIndex} className="list-none">
            <PlayerCard seatIndex={seatIndex} player={player} team={team} />
          </li>
        ))}
      </ol>
    </section>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

/**
 * LobbyTeamColumns renders the two-column team layout for the game lobby.
 *
 * The component is purely presentational — it accepts `seats` as a prop and
 * does not manage any WebSocket state. Real-time updates (Sub-AC 4) will
 * update the `seats` array from above.
 */
const LobbyTeamColumns: React.FC<LobbyTeamColumnsProps> = ({
  playerCount,
  seats,
  className = "",
}) => {
  // Ensure we always have exactly `playerCount` entries (pad with null if
  // fewer are supplied, e.g. during initial load).
  const normalizedSeats: Array<LobbyPlayer | null> = Array.from(
    { length: playerCount },
    (_, i) => seats[i] ?? null,
  );

  const { team1, team2 } = splitSeatsByTeam(normalizedSeats);
  const seatsPerTeam = playerCount / 2;

  return (
    <div
      className={[
        "flex flex-row gap-3",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label="Lobby teams"
    >
      <TeamColumn team={1} entries={team1} seatsPerTeam={seatsPerTeam} />
      <TeamColumn team={2} entries={team2} seatsPerTeam={seatsPerTeam} />
    </div>
  );
};

export default LobbyTeamColumns;
