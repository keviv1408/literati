/**
 * Tests for the oval/ellipse seat-position calculator (seatLayout.ts).
 *
 * Coverage goals
 * ──────────────
 * 1. Current player always lands at the 6 o'clock position (bottom-centre).
 * 2. All seats lie exactly on the ellipse — (x–cx)²/rx² + (y–cy)²/ry² ≈ 1.
 * 3. Angular step between consecutive visual seats equals 2π/N.
 * 4. Seats proceed clockwise (increasing angle in screen-coordinate space).
 * 5. seatIndex mapping wraps correctly for any currentPlayerSeatIndex.
 * 6. Both supported player counts (6 and 8) work.
 * 7. Custom ellipse geometry is respected.
 * 8. Out-of-range currentPlayerSeatIndex throws RangeError.
 * 9. Convenience helpers return correct values.
 */

import { describe, it, expect } from "vitest";
import {
  computeSeatPositions,
  getCurrentPlayerPosition,
  ellipsePoint,
  angleForVisualIndex,
  DEFAULT_ELLIPSE,
  type EllipseConfig,
  type SeatPosition,
} from "../seatLayout";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FLOAT_PRECISION = 10; // decimal places for toBeCloseTo

/** Verify that a point lies on the given ellipse. */
function isOnEllipse(
  x: number,
  y: number,
  ellipse: EllipseConfig
): boolean {
  const dx = (x - ellipse.cx) / ellipse.rx;
  const dy = (y - ellipse.cy) / ellipse.ry;
  // (x-cx)²/rx² + (y-cy)²/ry² should equal 1
  return Math.abs(dx * dx + dy * dy - 1) < 1e-9;
}

const SIX_OCLOCK = Math.PI / 2;

// ---------------------------------------------------------------------------
// computeSeatPositions — 6-seat game
// ---------------------------------------------------------------------------

describe("computeSeatPositions — 6 seats", () => {
  const N = 6 as const;
  const step = (2 * Math.PI) / N;

  it("returns exactly N seat positions", () => {
    const positions = computeSeatPositions(N, 0);
    expect(positions).toHaveLength(N);
  });

  it("current player (seatIndex 0) is at the 6 o'clock position", () => {
    const positions = computeSeatPositions(N, 0);
    const bottom = positions[0];
    expect(bottom.seatIndex).toBe(0);
    expect(bottom.visualIndex).toBe(0);
    expect(bottom.angle).toBeCloseTo(SIX_OCLOCK, FLOAT_PRECISION);
    // 6 o'clock → x = cx, y = cy + ry
    expect(bottom.x).toBeCloseTo(DEFAULT_ELLIPSE.cx, FLOAT_PRECISION);
    expect(bottom.y).toBeCloseTo(
      DEFAULT_ELLIPSE.cy + DEFAULT_ELLIPSE.ry,
      FLOAT_PRECISION
    );
  });

  it("all seat positions lie on the ellipse", () => {
    const positions = computeSeatPositions(N, 0);
    for (const pos of positions) {
      expect(isOnEllipse(pos.x, pos.y, DEFAULT_ELLIPSE)).toBe(true);
    }
  });

  it("angular step between consecutive seats equals 2π/6", () => {
    const positions = computeSeatPositions(N, 0);
    for (let i = 1; i < N; i++) {
      const delta = positions[i].angle - positions[i - 1].angle;
      expect(delta).toBeCloseTo(step, FLOAT_PRECISION);
    }
  });

  it("seats proceed clockwise (y increases, then x decreases, from 6 o'clock)", () => {
    const positions = computeSeatPositions(N, 0);
    // The seat immediately after 6 o'clock (clockwise) should be to the left
    // (x < cx) and above the midline (y < cy + ry) in screen coords.
    const first = positions[1];
    expect(first.x).toBeLessThan(DEFAULT_ELLIPSE.cx);
  });

  it("visualIndex equals the array index", () => {
    const positions = computeSeatPositions(N, 0);
    positions.forEach((pos, idx) => {
      expect(pos.visualIndex).toBe(idx);
    });
  });

  it("seatIndex wraps correctly when currentPlayerSeatIndex is not 0", () => {
    const currentSeat = 3;
    const positions = computeSeatPositions(N, currentSeat);
    // Visual seat 0 → game seat 3, visual seat 1 → 4, …, visual seat 3 → 0
    expect(positions[0].seatIndex).toBe(3);
    expect(positions[1].seatIndex).toBe(4);
    expect(positions[2].seatIndex).toBe(5);
    expect(positions[3].seatIndex).toBe(0);
    expect(positions[4].seatIndex).toBe(1);
    expect(positions[5].seatIndex).toBe(2);
  });

  it("current player is always at 6 o'clock regardless of which seat they occupy", () => {
    for (let s = 0; s < N; s++) {
      const positions = computeSeatPositions(N, s);
      expect(positions[0].seatIndex).toBe(s);
      expect(positions[0].angle).toBeCloseTo(SIX_OCLOCK, FLOAT_PRECISION);
    }
  });

  it("all N distinct seat indices appear exactly once", () => {
    const positions = computeSeatPositions(N, 2);
    const indices = positions.map((p) => p.seatIndex).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

// ---------------------------------------------------------------------------
// computeSeatPositions — 8-seat game
// ---------------------------------------------------------------------------

describe("computeSeatPositions — 8 seats", () => {
  const N = 8 as const;
  const step = (2 * Math.PI) / N;

  it("returns exactly 8 seat positions", () => {
    const positions = computeSeatPositions(N, 0);
    expect(positions).toHaveLength(8);
  });

  it("current player is at the 6 o'clock position", () => {
    const positions = computeSeatPositions(N, 0);
    expect(positions[0].angle).toBeCloseTo(SIX_OCLOCK, FLOAT_PRECISION);
  });

  it("all seat positions lie on the ellipse", () => {
    const positions = computeSeatPositions(N, 0);
    for (const pos of positions) {
      expect(isOnEllipse(pos.x, pos.y, DEFAULT_ELLIPSE)).toBe(true);
    }
  });

  it("angular step between consecutive seats equals 2π/8 = π/4", () => {
    const positions = computeSeatPositions(N, 0);
    for (let i = 1; i < N; i++) {
      const delta = positions[i].angle - positions[i - 1].angle;
      expect(delta).toBeCloseTo(step, FLOAT_PRECISION);
    }
  });

  it("seatIndex wraps correctly for currentPlayerSeatIndex = 7", () => {
    const positions = computeSeatPositions(N, 7);
    expect(positions[0].seatIndex).toBe(7);
    expect(positions[1].seatIndex).toBe(0);
    expect(positions[7].seatIndex).toBe(6);
  });

  it("all 8 distinct seat indices appear exactly once", () => {
    const positions = computeSeatPositions(N, 5);
    const indices = positions.map((p) => p.seatIndex).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

// ---------------------------------------------------------------------------
// Custom ellipse geometry
// ---------------------------------------------------------------------------

describe("computeSeatPositions — custom ellipse", () => {
  const customEllipse: EllipseConfig = {
    cx: 200,
    cy: 150,
    rx: 180,
    ry: 100,
  };

  it("uses the provided ellipse centre and radii", () => {
    const positions = computeSeatPositions(6, 0, customEllipse);
    // Current player at 6 o'clock → x = cx, y = cy + ry
    expect(positions[0].x).toBeCloseTo(customEllipse.cx, FLOAT_PRECISION);
    expect(positions[0].y).toBeCloseTo(
      customEllipse.cy + customEllipse.ry,
      FLOAT_PRECISION
    );
  });

  it("all positions lie on the custom ellipse", () => {
    const positions = computeSeatPositions(8, 0, customEllipse);
    for (const pos of positions) {
      expect(isOnEllipse(pos.x, pos.y, customEllipse)).toBe(true);
    }
  });

  it("honours a very small ellipse (unit circle degenerate case)", () => {
    const tiny: EllipseConfig = { cx: 0, cy: 0, rx: 1, ry: 1 };
    const positions = computeSeatPositions(6, 0, tiny);
    for (const pos of positions) {
      // Unit circle: x² + y² ≈ 1
      expect(pos.x * pos.x + pos.y * pos.y).toBeCloseTo(1, FLOAT_PRECISION);
    }
  });
});

// ---------------------------------------------------------------------------
// Guard / error conditions
// ---------------------------------------------------------------------------

describe("computeSeatPositions — invalid inputs", () => {
  it("throws RangeError when currentPlayerSeatIndex < 0", () => {
    expect(() => computeSeatPositions(6, -1)).toThrow(RangeError);
  });

  it("throws RangeError when currentPlayerSeatIndex >= totalSeats", () => {
    expect(() => computeSeatPositions(6, 6)).toThrow(RangeError);
    expect(() => computeSeatPositions(8, 8)).toThrow(RangeError);
  });

  it("error message includes the bad index", () => {
    expect(() => computeSeatPositions(6, 10)).toThrow(/10/);
  });
});

// ---------------------------------------------------------------------------
// Geometric invariants
// ---------------------------------------------------------------------------

describe("geometric invariants", () => {
  it("the top-most seat (12 o'clock) has the smallest y value", () => {
    // For 8 seats: visual index 4 lands at π/2 + 4*(2π/8) = π/2 + π = 3π/2 (top)
    const positions = computeSeatPositions(8, 0);
    const topSeat = positions.find(
      (p) =>
        Math.abs(p.angle % (2 * Math.PI) - (3 * Math.PI) / 2) < 1e-9 ||
        Math.abs(p.angle - (3 * Math.PI) / 2) < 1e-9
    );
    expect(topSeat).toBeDefined();
    // All other seats should have y ≥ topSeat.y
    for (const pos of positions) {
      if (pos !== topSeat) {
        expect(pos.y).toBeGreaterThanOrEqual(topSeat!.y - 1e-9);
      }
    }
  });

  it("the bottom-most seat (6 o'clock) has the largest y value", () => {
    const positions = computeSeatPositions(8, 0);
    const bottomSeat = positions[0]; // current player is always at 6 o'clock
    for (const pos of positions) {
      expect(pos.y).toBeLessThanOrEqual(bottomSeat.y + 1e-9);
    }
  });

  it("seats are symmetric around the vertical axis for even current-player index", () => {
    // 6-seat game with current player at seat 0:
    // visual positions 1 and 5 should be mirror images across the vertical axis
    const positions = computeSeatPositions(6, 0);
    const left = positions[1];
    const right = positions[5];
    // x values should be symmetric around cx
    expect(left.x + right.x).toBeCloseTo(
      2 * DEFAULT_ELLIPSE.cx,
      FLOAT_PRECISION
    );
    // y values should be equal
    expect(left.y).toBeCloseTo(right.y, FLOAT_PRECISION);
  });
});

// ---------------------------------------------------------------------------
// getCurrentPlayerPosition
// ---------------------------------------------------------------------------

describe("getCurrentPlayerPosition", () => {
  it("returns the 6 o'clock point on the default ellipse", () => {
    const pos = getCurrentPlayerPosition();
    expect(pos.angle).toBeCloseTo(SIX_OCLOCK, FLOAT_PRECISION);
    expect(pos.x).toBeCloseTo(DEFAULT_ELLIPSE.cx, FLOAT_PRECISION);
    expect(pos.y).toBeCloseTo(
      DEFAULT_ELLIPSE.cy + DEFAULT_ELLIPSE.ry,
      FLOAT_PRECISION
    );
  });

  it("respects a custom ellipse", () => {
    const e: EllipseConfig = { cx: 100, cy: 80, rx: 60, ry: 40 };
    const pos = getCurrentPlayerPosition(e);
    expect(pos.x).toBeCloseTo(100, FLOAT_PRECISION);
    expect(pos.y).toBeCloseTo(120, FLOAT_PRECISION); // cy + ry = 80 + 40
  });
});

// ---------------------------------------------------------------------------
// ellipsePoint
// ---------------------------------------------------------------------------

describe("ellipsePoint", () => {
  it("returns (cx+rx, cy) at angle 0 (3 o'clock)", () => {
    const pt = ellipsePoint(0);
    expect(pt.x).toBeCloseTo(DEFAULT_ELLIPSE.cx + DEFAULT_ELLIPSE.rx, FLOAT_PRECISION);
    expect(pt.y).toBeCloseTo(DEFAULT_ELLIPSE.cy, FLOAT_PRECISION);
  });

  it("returns (cx, cy+ry) at angle π/2 (6 o'clock)", () => {
    const pt = ellipsePoint(Math.PI / 2);
    expect(pt.x).toBeCloseTo(DEFAULT_ELLIPSE.cx, FLOAT_PRECISION);
    expect(pt.y).toBeCloseTo(DEFAULT_ELLIPSE.cy + DEFAULT_ELLIPSE.ry, FLOAT_PRECISION);
  });

  it("returns (cx-rx, cy) at angle π (9 o'clock)", () => {
    const pt = ellipsePoint(Math.PI);
    expect(pt.x).toBeCloseTo(DEFAULT_ELLIPSE.cx - DEFAULT_ELLIPSE.rx, FLOAT_PRECISION);
    expect(pt.y).toBeCloseTo(DEFAULT_ELLIPSE.cy, FLOAT_PRECISION);
  });

  it("returns (cx, cy-ry) at angle 3π/2 (12 o'clock)", () => {
    const pt = ellipsePoint((3 * Math.PI) / 2);
    expect(pt.x).toBeCloseTo(DEFAULT_ELLIPSE.cx, FLOAT_PRECISION);
    expect(pt.y).toBeCloseTo(DEFAULT_ELLIPSE.cy - DEFAULT_ELLIPSE.ry, FLOAT_PRECISION);
  });

  it("works with a custom ellipse", () => {
    const e: EllipseConfig = { cx: 10, cy: 20, rx: 5, ry: 3 };
    const pt = ellipsePoint(0, e);
    expect(pt.x).toBeCloseTo(15, FLOAT_PRECISION);
    expect(pt.y).toBeCloseTo(20, FLOAT_PRECISION);
  });
});

// ---------------------------------------------------------------------------
// angleForVisualIndex
// ---------------------------------------------------------------------------

describe("angleForVisualIndex", () => {
  it("returns π/2 for visual index 0 (always 6 o'clock)", () => {
    expect(angleForVisualIndex(0, 6)).toBeCloseTo(SIX_OCLOCK, FLOAT_PRECISION);
    expect(angleForVisualIndex(0, 8)).toBeCloseTo(SIX_OCLOCK, FLOAT_PRECISION);
  });

  it("returns correct angle for each index in a 6-seat game", () => {
    const step = (2 * Math.PI) / 6;
    for (let i = 0; i < 6; i++) {
      expect(angleForVisualIndex(i, 6)).toBeCloseTo(
        SIX_OCLOCK + i * step,
        FLOAT_PRECISION
      );
    }
  });

  it("returns correct angle for each index in an 8-seat game", () => {
    const step = (2 * Math.PI) / 8;
    for (let i = 0; i < 8; i++) {
      expect(angleForVisualIndex(i, 8)).toBeCloseTo(
        SIX_OCLOCK + i * step,
        FLOAT_PRECISION
      );
    }
  });

  it("is consistent with the angles in computeSeatPositions", () => {
    const N = 8 as const;
    const positions = computeSeatPositions(N, 0);
    for (let i = 0; i < N; i++) {
      expect(positions[i].angle).toBeCloseTo(
        angleForVisualIndex(i, N),
        FLOAT_PRECISION
      );
    }
  });
});
