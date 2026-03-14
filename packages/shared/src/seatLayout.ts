/**
 * Oval/ellipse seat-position calculator for the Literature game table.
 *
 * Computes (x, y) screen-coordinate positions for 6 or 8 seats arranged
 * evenly around an ellipse.  The current player's seat is always anchored
 * at the 6 o'clock position (bottom-centre), and the remaining seats are
 * distributed clockwise.
 *
 * Coordinate convention: standard screen/SVG space where x increases to the
 * right and y increases downward.  This means that increasing the parametric
 * angle θ in the formula (x = cx + rx·cos θ, y = cy + ry·sin θ) moves
 * clockwise on screen — which matches a real clock face.
 *
 *   θ = 0      → 3 o'clock (right)
 *   θ = π/2    → 6 o'clock (bottom)  ← current player always here
 *   θ = π      → 9 o'clock (left)
 *   θ = 3π/2   → 12 o'clock (top)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters that describe the ellipse drawn on the game table. */
export interface EllipseConfig {
  /** Horizontal centre of the ellipse (pixels from left edge). */
  cx: number;
  /** Vertical centre of the ellipse (pixels from top edge). */
  cy: number;
  /** Horizontal semi-axis radius (pixels). */
  rx: number;
  /** Vertical semi-axis radius (pixels). */
  ry: number;
}

/** A single seat's resolved position on the game table. */
export interface SeatPosition {
  /** Pixel x-coordinate of the seat anchor point. */
  x: number;
  /** Pixel y-coordinate of the seat anchor point. */
  y: number;
  /**
   * Original seat index in the game (0-based, 0 = host, alternating teams).
   * seatIndex % 2 === 0 → Team 1; seatIndex % 2 === 1 → Team 2.
   */
  seatIndex: number;
  /**
   * Visual position index (0 = current player at bottom, 1 = first seat
   * clockwise, etc.).
   */
  visualIndex: number;
  /**
   * Parametric angle in radians at which this seat sits on the ellipse.
   * 0 = rightmost (3 o'clock), π/2 = bottom (6 o'clock), etc.
   */
  angle: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Sensible default ellipse for a 1 000 × 700 pixel game-table canvas.
 * Consumers can override every field via the optional `ellipse` parameter.
 */
export const DEFAULT_ELLIPSE: EllipseConfig = {
  cx: 500,
  cy: 350,
  rx: 420,
  ry: 260,
} as const;

/** Parametric angle for the 6 o'clock position (bottom-centre). */
const SIX_OCLOCK_ANGLE = Math.PI / 2;

// ---------------------------------------------------------------------------
// Core utility
// ---------------------------------------------------------------------------

/**
 * Compute pixel (x, y) positions for all seats around an oval game table.
 *
 * @param totalSeats              - Number of players/seats (6 or 8).
 * @param currentPlayerSeatIndex  - The seat index that belongs to the
 *                                  viewing player (0-based).  This seat is
 *                                  placed at the 6 o'clock position.
 * @param ellipse                 - Ellipse geometry; defaults to
 *                                  {@link DEFAULT_ELLIPSE}.
 * @returns An array of {@link SeatPosition} objects, one per seat, ordered
 *          by visual position starting at the current player (index 0).
 *
 * @example
 * const positions = computeSeatPositions(6, 0);
 * // positions[0] is always at the 6 o'clock anchor
 * // positions[1..5] continue clockwise
 */
export function computeSeatPositions(
  totalSeats: 6 | 8,
  currentPlayerSeatIndex: number,
  ellipse: EllipseConfig = DEFAULT_ELLIPSE
): SeatPosition[] {
  if (
    currentPlayerSeatIndex < 0 ||
    currentPlayerSeatIndex >= totalSeats
  ) {
    throw new RangeError(
      `currentPlayerSeatIndex (${currentPlayerSeatIndex}) must be in [0, ${totalSeats - 1}]`
    );
  }

  const { cx, cy, rx, ry } = ellipse;
  const angularStep = (2 * Math.PI) / totalSeats;

  return Array.from({ length: totalSeats }, (_, visualIndex) => {
    // Map each visual position (0 = bottom, 1 = first clockwise, …) back to
    // the original seat index in the game.
    const seatIndex = (currentPlayerSeatIndex + visualIndex) % totalSeats;

    // Clockwise from 6 o'clock: add visualIndex × step to the base angle.
    const angle = SIX_OCLOCK_ANGLE + visualIndex * angularStep;

    return {
      x: cx + rx * Math.cos(angle),
      y: cy + ry * Math.sin(angle),
      seatIndex,
      visualIndex,
      angle,
    };
  });
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Returns only the position for the current player (always 6 o'clock).
 * Useful for rendering the local player's hand without computing all seats.
 */
export function getCurrentPlayerPosition(
  ellipse: EllipseConfig = DEFAULT_ELLIPSE
): Pick<SeatPosition, "x" | "y" | "angle"> {
  return {
    x: ellipse.cx + ellipse.rx * Math.cos(SIX_OCLOCK_ANGLE),
    y: ellipse.cy + ellipse.ry * Math.sin(SIX_OCLOCK_ANGLE),
    angle: SIX_OCLOCK_ANGLE,
  };
}

/**
 * Returns the (x, y) point on the ellipse for an arbitrary angle.
 * Useful for custom label or avatar placement.
 *
 * @param angle   - Parametric angle in radians.
 * @param ellipse - Ellipse geometry; defaults to {@link DEFAULT_ELLIPSE}.
 */
export function ellipsePoint(
  angle: number,
  ellipse: EllipseConfig = DEFAULT_ELLIPSE
): { x: number; y: number } {
  return {
    x: ellipse.cx + ellipse.rx * Math.cos(angle),
    y: ellipse.cy + ellipse.ry * Math.sin(angle),
  };
}

/**
 * Given a visual-position index and total seat count, returns the angular
 * step size and the exact angle for that position relative to 6 o'clock.
 *
 * Useful for positioning UI labels or computing rotation angles.
 */
export function angleForVisualIndex(
  visualIndex: number,
  totalSeats: 6 | 8
): number {
  const step = (2 * Math.PI) / totalSeats;
  return SIX_OCLOCK_ANGLE + visualIndex * step;
}
