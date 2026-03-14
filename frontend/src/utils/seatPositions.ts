/**
 * seatPositions — utility for computing (x, y) coordinates of player seats
 * around an elliptical game table.
 *
 * Seats alternate Team 1–Team 2 clockwise, starting from seat 0 (host) at
 * the bottom centre (6 o'clock).  All coordinates are expressed in the shared
 * SVG viewBox coordinate space so they can be used both by the SVG table
 * graphic and by absolute-positioned HTML seat cards.
 *
 * @example
 * // Get positions for a 6-player game
 * const positions = getSeatPositions(6);
 * // positions[0] → { seatIndex: 0, x: 400, y: 430, angleDeg: 180 }
 *
 * @example
 * // Convert to CSS percentage
 * const left = toCssPercent(positions[0].x, 'width'); // "50.0000%"
 */

// ── SVG viewport constants ────────────────────────────────────────────────────

/** Width of the SVG viewBox in virtual pixels. */
export const VIEWBOX_WIDTH = 800;

/** Height of the SVG viewBox in virtual pixels. */
export const VIEWBOX_HEIGHT = 480;

// ── Table ellipse ─────────────────────────────────────────────────────────────

/** Horizontal centre of the oval table in viewBox units. */
export const TABLE_CX = 400;

/** Vertical centre of the oval table in viewBox units. */
export const TABLE_CY = 240;

/** Horizontal semi-axis of the visible table felt ellipse. */
export const TABLE_RX = 235;

/** Vertical semi-axis of the visible table felt ellipse. */
export const TABLE_RY = 140;

// ── Seat placement ellipse ────────────────────────────────────────────────────

/**
 * Horizontal semi-axis of the ellipse used for *placing* seat cards.
 * Larger than TABLE_RX so cards sit just outside / on the table edge.
 */
export const SEAT_RX = 305;

/**
 * Vertical semi-axis of the ellipse used for *placing* seat cards.
 * Larger than TABLE_RY so cards sit just outside / on the table edge.
 */
export const SEAT_RY = 190;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SeatPosition {
  /** Zero-based seat index (0 = host). */
  seatIndex: number;

  /**
   * X coordinate in SVG viewBox units.
   * Origin is top-left; increases to the right.
   */
  x: number;

  /**
   * Y coordinate in SVG viewBox units.
   * Origin is top-left; increases downward.
   */
  y: number;

  /**
   * Angle in degrees, measured clockwise from the top of the ellipse
   * (i.e. 0° = 12 o'clock, 90° = 3 o'clock, 180° = 6 o'clock).
   *
   * Seat 0 is at 180° (bottom centre / host position).
   */
  angleDeg: number;
}

// ── getSeatPositions ──────────────────────────────────────────────────────────

/**
 * Compute SVG-coordinate positions for every seat around the game table.
 *
 * Seats are evenly distributed around an ellipse.  Seat 0 (host) starts at
 * the bottom (180°) and subsequent seats proceed **clockwise**, so that
 * Team 1 (even indices) and Team 2 (odd indices) alternate around the table.
 *
 * Formula (clockwise-from-top, SVG coordinate space):
 * ```
 *   x = TABLE_CX + SEAT_RX × sin(angleRad)
 *   y = TABLE_CY − SEAT_RY × cos(angleRad)
 * ```
 *
 * @param playerCount  6 or 8 — the total number of seats to place.
 * @returns            An ordered array of {@link SeatPosition} objects,
 *                     one per seat index.
 */
export function getSeatPositions(playerCount: 6 | 8): SeatPosition[] {
  const step = 360 / playerCount;
  const positions: SeatPosition[] = [];

  for (let i = 0; i < playerCount; i++) {
    // Start at 180° (bottom) and advance clockwise by `step` each seat.
    const angleDeg = (180 + i * step) % 360;
    const angleRad = (angleDeg * Math.PI) / 180;

    // Convert clockwise-from-top angle to SVG (x, y) on the seat ellipse.
    const x = TABLE_CX + SEAT_RX * Math.sin(angleRad);
    const y = TABLE_CY - SEAT_RY * Math.cos(angleRad);

    positions.push({ seatIndex: i, x, y, angleDeg });
  }

  return positions;
}

// ── toCssPercent ─────────────────────────────────────────────────────────────

/**
 * Convert a raw viewBox coordinate into a CSS `left` / `top` percentage
 * string suitable for absolute positioning inside a container whose
 * intrinsic size matches the viewBox aspect ratio.
 *
 * @param viewBoxValue  Coordinate in viewBox units.
 * @param dimension     `'width'` for an x-axis value, `'height'` for y-axis.
 * @returns             String like `"50.0000%"`.
 *
 * @example
 * toCssPercent(400, 'width')  // "50.0000%" (centre of an 800-wide viewBox)
 * toCssPercent(240, 'height') // "50.0000%" (centre of a 480-tall viewBox)
 */
export function toCssPercent(
  viewBoxValue: number,
  dimension: "width" | "height",
): string {
  const total = dimension === "width" ? VIEWBOX_WIDTH : VIEWBOX_HEIGHT;
  return `${((viewBoxValue / total) * 100).toFixed(4)}%`;
}
