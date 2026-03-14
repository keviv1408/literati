"use client";

/**
 * OvalTable — visual oval card table showing all seats for an in-progress or
 * lobby game.
 *
 * Seat positions
 * ──────────────
 * Players sit clockwise around an ellipse.  Seat 0 (host) is at the bottom
 * (6 o'clock) and subsequent seats proceed clockwise:
 *
 *   6-player  (60° apart):  0=bottom, 1=lower-left, 2=upper-left,
 *                           3=top, 4=upper-right, 5=lower-right
 *   8-player  (45° apart):  0=bottom, 1=lower-left, 2=left, 3=upper-left,
 *                           4=top, 5=upper-right, 6=right, 7=lower-right
 *
 * Even-indexed seats → Team 1 (emerald)
 * Odd-indexed seats  → Team 2 (blue)
 *
 * Seat coordinates are provided by {@link getSeatPositions} in
 * `@/utils/seatPositions` (SVG-viewBox units) and converted to CSS
 * percentages via {@link toCssPercent}.
 *
 * Responsive behaviour
 * ────────────────────
 * • ≥ 640 px (sm):  Oval layout — SVG elliptical table graphic + absolute-
 *                   positioned {@link PlayerSeat} chips.
 * • < 640 px:       Two-column fallback rendered by LobbyTeamColumns.
 *
 * @example
 * <OvalTable
 *   playerCount={6}
 *   seats={[
 *     { seatIndex: 0, displayName: "Alice", isBot: false, isHost: true, isCurrentUser: true },
 *     null, null, null, null, null,
 *   ]}
 * />
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

// ── SVG table visual constants ────────────────────────────────────────────────

/** Casino-green felt surface. */
const FELT_COLOR = "#0d4d2d";

/** Lighter inner highlight to give the felt a subtle domed appearance. */
const FELT_HIGHLIGHT = "#0f5c35";

/** Wooden rail surrounding the felt. */
const RAIL_COLOR = "#7c4f24";

/** Extra radius (in viewBox px) added to TABLE_R* to form the rail. */
const RAIL_EXTRA = 10;

/** Colour of the dashed centre line dividing the two teams. */
const CENTER_LINE_COLOR = "rgba(255,255,255,0.07)";

// ── Sub-component: TableGraphic ───────────────────────────────────────────────

interface TableGraphicProps {
  label: string;
}

/**
 * TableGraphic renders the SVG elliptical table (felt + wooden rail + logo).
 * Positioned absolutely to fill the outer container; pointer-events are
 * disabled so seat chips above it remain interactive.
 */
const TableGraphic: React.FC<TableGraphicProps> = ({ label }) => (
  <svg
    viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
    className="absolute inset-0 w-full h-full pointer-events-none"
    aria-hidden="true"
    focusable="false"
    data-testid="table-graphic"
  >
    {/* Drop shadow */}
    <ellipse
      cx={TABLE_CX}
      cy={TABLE_CY + 10}
      rx={TABLE_RX + RAIL_EXTRA + 6}
      ry={TABLE_RY + RAIL_EXTRA + 6}
      fill="rgba(0,0,0,0.40)"
    />

    {/* Wooden rail */}
    <ellipse
      cx={TABLE_CX}
      cy={TABLE_CY}
      rx={TABLE_RX + RAIL_EXTRA}
      ry={TABLE_RY + RAIL_EXTRA}
      fill={RAIL_COLOR}
    />

    {/* Rail sheen */}
    <ellipse
      cx={TABLE_CX}
      cy={TABLE_CY - 4}
      rx={TABLE_RX + RAIL_EXTRA - 2}
      ry={TABLE_RY + RAIL_EXTRA - 2}
      fill="none"
      stroke="rgba(255,255,255,0.08)"
      strokeWidth={2}
    />

    {/* Felt surface */}
    <ellipse
      cx={TABLE_CX}
      cy={TABLE_CY}
      rx={TABLE_RX}
      ry={TABLE_RY}
      fill={FELT_COLOR}
    />

    {/* Inner dome highlight */}
    <ellipse
      cx={TABLE_CX}
      cy={TABLE_CY - 12}
      rx={TABLE_RX - 50}
      ry={TABLE_RY - 35}
      fill={FELT_HIGHLIGHT}
      opacity={0.3}
    />

    {/* Dashed centre line between teams */}
    <line
      x1={TABLE_CX - TABLE_RX + 24}
      y1={TABLE_CY}
      x2={TABLE_CX + TABLE_RX - 24}
      y2={TABLE_CY}
      stroke={CENTER_LINE_COLOR}
      strokeWidth={1.5}
      strokeDasharray="7 5"
    />

    {/* Table name */}
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

// ── Props ─────────────────────────────────────────────────────────────────────

export interface OvalTableProps {
  /** Total number of players (6 or 8). */
  playerCount: 6 | 8;

  /**
   * Ordered array of length `playerCount`.
   * `null` = empty seat.  Index = seat index (0 = host seat, clockwise).
   */
  seats: Array<LobbyPlayer | null>;

  /**
   * Text displayed at the centre of the table surface.
   * @default "Literati"
   */
  tableLabel?: string;

  /**
   * The seat index of the player who currently holds the turn.
   * When provided, the matching `PlayerSeat` will receive `isActiveTurn={true}`
   * and display the animated amber glow ring.
   * Pass `undefined` (or omit) during lobby / pre-game phases.
   */
  activeTurnSeatIndex?: number;

  /**
   * Per-seat card counts keyed by seat index.
   * When provided, each occupied `PlayerSeat` receives a `cardCount` badge
   * showing how many cards that player holds.
   * Omit during lobby where hand sizes are unknown.
   *
   * @example
   * // All six players start with 8 cards each (48-card deck ÷ 6)
   * { 0: 8, 1: 8, 2: 8, 3: 8, 4: 8, 5: 8 }
   */
  cardCounts?: Record<number, number>;

  /** Extra Tailwind classes applied to the outermost wrapper. */
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
