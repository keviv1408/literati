"use client";

/**
 * Renders the lobby/game seats around the shared table graphic and falls back
 * to team columns on small screens.
 */

import React from "react";
import LobbyTeamColumns from "@/components/LobbyTeamColumns";
import PlayerSeat from "@/components/PlayerSeat";
import {
  getSeatPositions,
  toCssPercent,
  TABLE_CX,
  TABLE_CY,
  TABLE_RX,
  TABLE_RY,
  VIEWBOX_WIDTH,
  VIEWBOX_HEIGHT,
} from "@/utils/seatPositions";
import type { LobbyPlayer } from "@/types/lobby";

const FELT_COLOR = "#0d4d2d";
const FELT_HIGHLIGHT = "#0f5c35";
const RAIL_COLOR = "#7c4f24";
const RAIL_EXTRA = 10;
const CENTER_LINE_COLOR = "rgba(255,255,255,0.07)";

interface TableGraphicProps {
  label: string;
}

const TableGraphic: React.FC<TableGraphicProps> = ({ label }) => (
  <svg
    viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
    className="absolute inset-0 w-full h-full pointer-events-none"
    aria-hidden="true"
    focusable="false"
    data-testid="table-graphic"
  >
    <ellipse
      cx={TABLE_CX}
      cy={TABLE_CY + 10}
      rx={TABLE_RX + RAIL_EXTRA + 6}
      ry={TABLE_RY + RAIL_EXTRA + 6}
      fill="rgba(0,0,0,0.40)"
    />
    <ellipse
      cx={TABLE_CX}
      cy={TABLE_CY}
      rx={TABLE_RX + RAIL_EXTRA}
      ry={TABLE_RY + RAIL_EXTRA}
      fill={RAIL_COLOR}
    />
    <ellipse
      cx={TABLE_CX}
      cy={TABLE_CY - 4}
      rx={TABLE_RX + RAIL_EXTRA - 2}
      ry={TABLE_RY + RAIL_EXTRA - 2}
      fill="none"
      stroke="rgba(255,255,255,0.08)"
      strokeWidth={2}
    />
    <ellipse
      cx={TABLE_CX}
      cy={TABLE_CY}
      rx={TABLE_RX}
      ry={TABLE_RY}
      fill={FELT_COLOR}
    />
    <ellipse
      cx={TABLE_CX}
      cy={TABLE_CY - 12}
      rx={TABLE_RX - 50}
      ry={TABLE_RY - 35}
      fill={FELT_HIGHLIGHT}
      opacity={0.3}
    />
    <line
      x1={TABLE_CX - TABLE_RX + 24}
      y1={TABLE_CY}
      x2={TABLE_CX + TABLE_RX - 24}
      y2={TABLE_CY}
      stroke={CENTER_LINE_COLOR}
      strokeWidth={1.5}
      strokeDasharray="7 5"
    />
    <text
      x={TABLE_CX}
      y={TABLE_CY - 9}
      textAnchor="middle"
      dominantBaseline="middle"
      fill="rgba(255,255,255,0.14)"
      fontSize={28}
      fontWeight="bold"
      fontFamily="Georgia, serif"
      letterSpacing={4}
    >
      {label}
    </text>
    <text
      x={TABLE_CX}
      y={TABLE_CY + 14}
      textAnchor="middle"
      dominantBaseline="middle"
      fill="rgba(255,255,255,0.07)"
      fontSize={9}
      fontFamily="Arial, sans-serif"
      letterSpacing={5}
    >
      LITERATURE CARD GAME
    </text>
  </svg>
);

export interface OvalTableProps {
  playerCount: 6 | 8;
  seats: Array<LobbyPlayer | null>;
  tableLabel?: string;
  activeTurnSeatIndex?: number;
  cardCounts?: Record<number, number>;
  className?: string;
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * OvalTable renders the game table with all seats positioned around an oval.
 *
 * Seat coordinates come from {@link getSeatPositions} which places seat 0
 * at the bottom (6 o'clock) and proceeds clockwise.  Coordinates are
 * expressed in the SVG viewBox space (800 × 480) and converted to CSS
 * percentages via {@link toCssPercent} so the layout scales naturally.
 *
 * On narrow viewports (< 640 px) the oval is hidden and LobbyTeamColumns
 * renders the familiar two-column layout instead.
 */
const OvalTable: React.FC<OvalTableProps> = ({
  playerCount,
  seats,
  tableLabel = "Literati",
  activeTurnSeatIndex,
  cardCounts,
  className = "",
}) => {
  // Normalise the seats array to exactly `playerCount` entries.
  const normalizedSeats: Array<LobbyPlayer | null> = Array.from(
    { length: playerCount },
    (_, i) => seats[i] ?? null,
  );

  // Seat positions from the shared utility.
  const seatPositions = getSeatPositions(playerCount);

  return (
    <div
      className={["w-full", className].filter(Boolean).join(" ")}
      aria-label="Game table"
      data-testid="oval-table"
    >
      {/* ── Oval layout (sm and above) ───────────────────────────────────── */}
      <div
        className="hidden sm:block"
        aria-label="Oval table seating"
        data-testid="oval-layout"
      >
        {/*
         * Container locks aspect ratio to match the SVG viewBox (800:480 = 5:3)
         * so seat percentages land at the correct visual positions.
         * overflow-visible lets seat chips extend slightly beyond the container
         * edges (e.g. side seats in 8-player layout).
         */}
        <div
          className={[
            "relative w-full max-w-3xl mx-auto",
            "rounded-2xl overflow-visible",
            "bg-slate-950/60",
          ].join(" ")}
          style={{ aspectRatio: `${VIEWBOX_WIDTH} / ${VIEWBOX_HEIGHT}` }}
          data-testid="oval-container"
        >
          {/* SVG elliptical table graphic */}
          <TableGraphic label={tableLabel} />

          {/* PlayerSeat chips around the table */}
          <ol
            className="absolute inset-0 list-none m-0 p-0 overflow-visible"
            aria-label={`${playerCount} player seats`}
          >
            {seatPositions.map(({ seatIndex, x, y }) => {
              const player = normalizedSeats[seatIndex];
              return (
                <li
                  key={seatIndex}
                  className="absolute list-none"
                  style={{
                    left: toCssPercent(x, "width"),
                    top: toCssPercent(y, "height"),
                    transform: "translate(-50%, -50%)",
                    zIndex: 10,
                  }}
                  data-seat-index={seatIndex}
                >
                  <PlayerSeat
                    seatIndex={seatIndex}
                    player={player}
                    isActiveTurn={activeTurnSeatIndex === seatIndex}
                    cardCount={
                      cardCounts !== undefined
                        ? cardCounts[seatIndex]
                        : undefined
                    }
                  />
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      {/* ── Two-column fallback (below sm) ──────────────────────────────── */}
      {/*
       * On mobile (< 640 px) the oval becomes too small for legible seat chips.
       * LobbyTeamColumns renders the familiar two-column team layout instead.
       */}
      <div
        className="block sm:hidden"
        aria-label="Team columns seating (mobile)"
        data-testid="mobile-fallback"
      >
        <LobbyTeamColumns playerCount={playerCount} seats={normalizedSeats} />
      </div>
    </div>
  );
};

export default OvalTable;
