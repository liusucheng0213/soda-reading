import { describe, expect, it } from "vitest";
import { duplicatePercent, editionTrackCounts, rejectionReasonLabel, rejectionReasonRows } from "./admin-content.js";

describe("admin content observability", () => {
  it("keeps an empty run honest and readable", () => {
    expect(duplicatePercent(null)).toBe("0%");
    expect(editionTrackCounts(null)).toEqual({ general: 0, high_school: 0 });
    expect(rejectionReasonRows(null)).toEqual([]);
  });

  it("maps duplicate rate, track coverage, and sorted rejection reasons", () => {
    const run = {
      duplicateRate: 0.125,
      editionCoverage: { tracks: { general: 4, high_school: 2 } },
      moderationStats: {
        reasons: { quality_below_65: 2, dangerous_instruction: 5, unknown_reason: 1 },
      },
    };
    expect(duplicatePercent(run)).toBe("13%");
    expect(editionTrackCounts(run)).toEqual({ general: 4, high_school: 2 });
    expect(rejectionReasonRows(run).map(([code, count]) => [code, count])).toEqual([
      ["dangerous_instruction", 5],
      ["quality_below_65", 2],
      ["unknown_reason", 1],
    ]);
    expect(rejectionReasonLabel("dangerous_instruction")).toBe("危险指导");
    expect(rejectionReasonLabel("unknown_reason")).toBe("unknown_reason");
  });
});
