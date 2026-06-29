import { describe, it, expect } from "vitest";
import { APPROVAL_TYPES } from "../constants.js";

describe("APPROVAL_TYPES", () => {
  it("includes the safety_review_required gate type", () => {
    expect(APPROVAL_TYPES).toContain("safety_review_required");
  });
});
