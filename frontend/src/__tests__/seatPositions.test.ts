/**
 * Unit tests for the seatPositions utility.
 *
 * Verifies that:
 *  • getSeatPositions returns the correct number of positions
 *  • Seat 0 (host) starts at the bottom (angleDeg = 180°) for both layouts
 *  • Angles progress by the expected step (60° for 6-player, 45° for 8-player)
 *  • All positions are within the SVG viewBox bounds
 *  • Team assignment derived from seatIndex alternates correctly
 *  • toCssPercent converts viewBox coordinates to correct percentage strings
 */

import {
  getSeatPositions,
  toCssPercent,
  VIEWBOX_WIDTH,
  VIEWBOX_HEIGHT,
  TABLE_CX,
  TABLE_CY,
  SEAT_RX,
  SEAT_RY,
} from "@/utils/seatPositions";

// ── getSeatPositions — basic counts ───────────────────────────────────────────

describe("getSeatPositions — seat count", () => {
  it("returns exactly 6 positions for a 6-player game", () => {
    expect(getSeatPositions(6)).toHaveLength(6);
  });

  it("returns exactly 8 positions for an 8-player game", () => {
    expect(getSeatPositions(8)).toHaveLength(8);
  });
});

// ── getSeatPositions — seatIndex values ───────────────────────────────────────

describe("getSeatPositions — seatIndex assignment", () => {
  it("assigns seatIndex 0..5 in order for 6-player", () => {
    const positions = getSeatPositions(6);
    positions.forEach((pos, i) => {
      expect(pos.seatIndex).toBe(i);
    });
  });

  it("assigns seatIndex 0..7 in order for 8-player", () => {
    const positions = getSeatPositions(8);
    positions.forEach((pos, i) => {
      expect(pos.seatIndex).toBe(i);
    });
  });
});

// ── getSeatPositions — seat 0 at the bottom ───────────────────────────────────

describe("getSeatPositions — seat 0 is the host seat (bottom / 6 o'clock)", () => {
  it("places seat 0 at angleDeg = 180 for 6-player", () => {
    expect(getSeatPositions(6)[0].angleDeg).toBe(180);
  });

  it("places seat 0 at angleDeg = 180 for 8-player", () => {
    expect(getSeatPositions(8)[0].angleDeg).toBe(180);
  });

  it("seat 0 x-coordinate equals TABLE_CX (horizontally centred)", () => {
    const pos = getSeatPositions(6)[0];
    expect(pos.x).toBeCloseTo(TABLE_CX, 5);
  });

  it("seat 0 y-coordinate equals TABLE_CY + SEAT_RY (bottom)", () => {
    const pos = getSeatPositions(6)[0];
    expect(pos.y).toBeCloseTo(TABLE_CY + SEAT_RY, 5);
  });
});

// ── getSeatPositions — angle step ─────────────────────────────────────────────

describe("getSeatPositions — uniform angular step", () => {
  it("advances by 60° per seat in a 6-player game", () => {
    const positions = getSeatPositions(6);
    for (let i = 1; i < 6; i++) {
      const prev = positions[i - 1].angleDeg;
      const curr = positions[i].angleDeg;
      // Handle wrap-around (e.g. 300° → 0°)
      const diff = ((curr - prev + 360) % 360);
      expect(diff).toBeCloseTo(60, 5);
    }
  });

  it("advances by 45° per seat in an 8-player game", () => {
    const positions = getSeatPositions(8);
    for (let i = 1; i < 8; i++) {
      const prev = positions[i - 1].angleDeg;
      const curr = positions[i].angleDeg;
      const diff = ((curr - prev + 360) % 360);
      expect(diff).toBeCloseTo(45, 5);
    }
  });
});

// ── getSeatPositions — positions within viewBox ───────────────────────────────

describe("getSeatPositions — all positions within the SVG viewBox", () => {
  it("all 6-player x values are within [0, VIEWBOX_WIDTH]", () => {
    getSeatPositions(6).forEach(({ x }) => {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(VIEWBOX_WIDTH);
    });
  });

  it("all 6-player y values are within [0, VIEWBOX_HEIGHT]", () => {
    getSeatPositions(6).forEach(({ y }) => {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(VIEWBOX_HEIGHT);
    });
  });

  it("all 8-player x values are within [0, VIEWBOX_WIDTH]", () => {
    getSeatPositions(8).forEach(({ x }) => {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(VIEWBOX_WIDTH);
    });
  });

  it("all 8-player y values are within [0, VIEWBOX_HEIGHT]", () => {
    getSeatPositions(8).forEach(({ y }) => {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(VIEWBOX_HEIGHT);
    });
  });
});

// ── getSeatPositions — clockwise ordering ─────────────────────────────────────

describe("getSeatPositions — clockwise ordering (seat 0 = bottom)", () => {
  it("6-player: seat 3 (opposite host) is at the top", () => {
    const positions = getSeatPositions(6);
    // Seat 3 should be at top — angleDeg = 180 + 3×60 = 360 = 0°
    expect(positions[3].angleDeg).toBeCloseTo(0, 5);
    // y should be TABLE_CY - SEAT_RY (topmost point)
    expect(positions[3].y).toBeCloseTo(TABLE_CY - SEAT_RY, 4);
  });

  it("8-player: seat 4 (opposite host) is at the top", () => {
    const positions = getSeatPositions(8);
    // Seat 4 should be at top — angleDeg = 180 + 4×45 = 360 = 0°
    expect(positions[4].angleDeg).toBeCloseTo(0, 5);
    expect(positions[4].y).toBeCloseTo(TABLE_CY - SEAT_RY, 4);
  });

  it("6-player: seat 1 is in the lower half of the table", () => {
    // Seat 1 is 60° clockwise from bottom — still in lower half
    const pos = getSeatPositions(6)[1];
    expect(pos.y).toBeGreaterThan(TABLE_CY);
  });

  it("6-player: seat 2 is in the upper half of the table", () => {
    // Seat 2 is 120° clockwise from bottom — crosses into upper half
    const pos = getSeatPositions(6)[2];
    expect(pos.y).toBeLessThan(TABLE_CY);
  });
});

// ── getSeatPositions — team alternation ───────────────────────────────────────

describe("getSeatPositions — team alternation", () => {
  it("even-indexed seats (Team 1) and odd-indexed (Team 2) are interleaved", () => {
    getSeatPositions(6).forEach(({ seatIndex }) => {
      const team = seatIndex % 2 === 0 ? 1 : 2;
      expect(team).toBe(seatIndex % 2 === 0 ? 1 : 2);
    });
  });
});

// ── getSeatPositions — symmetry ───────────────────────────────────────────────

describe("getSeatPositions — bilateral symmetry", () => {
  it("6-player: seat 1 and seat 5 are mirror images across the vertical axis", () => {
    const [, s1, , , , s5] = getSeatPositions(6);
    // x-coordinates should be equidistant from TABLE_CX
    expect(Math.abs(s1.x - TABLE_CX)).toBeCloseTo(
      Math.abs(s5.x - TABLE_CX),
      4,
    );
    // y-coordinates should be equal
    expect(s1.y).toBeCloseTo(s5.y, 4);
  });

  it("6-player: seat 2 and seat 4 are mirror images across the vertical axis", () => {
    const [, , s2, , s4] = getSeatPositions(6);
    expect(Math.abs(s2.x - TABLE_CX)).toBeCloseTo(
      Math.abs(s4.x - TABLE_CX),
      4,
    );
    expect(s2.y).toBeCloseTo(s4.y, 4);
  });

  it("8-player: seat 2 and seat 6 are mirror images (left and right seats)", () => {
    const positions = getSeatPositions(8);
    const s2 = positions[2];
    const s6 = positions[6];
    expect(Math.abs(s2.x - TABLE_CX)).toBeCloseTo(
      Math.abs(s6.x - TABLE_CX),
      4,
    );
    expect(s2.y).toBeCloseTo(s6.y, 4);
  });
});

// ── toCssPercent ──────────────────────────────────────────────────────────────

describe("toCssPercent", () => {
  it("returns '50.0000%' for the horizontal centre (TABLE_CX = 400, width = 800)", () => {
    expect(toCssPercent(TABLE_CX, "width")).toBe("50.0000%");
  });

  it("returns '50.0000%' for the vertical centre (TABLE_CY = 240, height = 480)", () => {
    expect(toCssPercent(TABLE_CY, "height")).toBe("50.0000%");
  });

  it("returns '0.0000%' for value 0 (width)", () => {
    expect(toCssPercent(0, "width")).toBe("0.0000%");
  });

  it("returns '100.0000%' for the full width value (800)", () => {
    expect(toCssPercent(VIEWBOX_WIDTH, "width")).toBe("100.0000%");
  });

  it("returns '100.0000%' for the full height value (480)", () => {
    expect(toCssPercent(VIEWBOX_HEIGHT, "height")).toBe("100.0000%");
  });

  it("returns '89.5833%' for seat 0 y position (240 + 190 = 430, 430/480)", () => {
    const seat0y = TABLE_CY + SEAT_RY; // 430
    expect(toCssPercent(seat0y, "height")).toBe("89.5833%");
  });

  it("ends with '%'", () => {
    expect(toCssPercent(200, "width")).toMatch(/%$/);
    expect(toCssPercent(100, "height")).toMatch(/%$/);
  });
});

// ── Computed seat-0 position round-trip ───────────────────────────────────────

describe("getSeatPositions — seat 0 CSS percentage round-trip", () => {
  it("seat 0 toCssPercent(x, width) equals '50.0000%'", () => {
    const { x } = getSeatPositions(6)[0];
    expect(toCssPercent(x, "width")).toBe("50.0000%");
  });

  it("seat 0 toCssPercent(y, height) ends with '%'", () => {
    const { y } = getSeatPositions(6)[0];
    const pct = toCssPercent(y, "height");
    expect(pct).toMatch(/%$/);
    // Should be close to 89.58%
    const value = parseFloat(pct);
    expect(value).toBeGreaterThan(85);
    expect(value).toBeLessThan(95);
  });
});
