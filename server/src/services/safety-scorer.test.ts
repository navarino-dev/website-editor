import { describe, it, expect } from "vitest";
import { scoreChangeRequest, type RawScorerCall } from "./safety-scorer.js";

const ok =
  (raw: { score: unknown; isChangeRequest: unknown; reasoning: unknown; factors: unknown }): RawScorerCall =>
  async () =>
    raw;

describe("scoreChangeRequest", () => {
  it("returns a validated low score for a simple change", async () => {
    const r = await scoreChangeRequest(
      { text: "Change the hero headline" },
      ok({ score: 2, isChangeRequest: true, reasoning: "Simple copy tweak", factors: ["copy"] }),
    );
    expect(r).toEqual({ score: 2, isChangeRequest: true, reasoning: "Simple copy tweak", factors: ["copy"] });
  });

  it("clamps an out-of-range score into 0..10", async () => {
    const hi = await scoreChangeRequest({ text: "x" }, ok({ score: 42, isChangeRequest: true, reasoning: "r", factors: [] }));
    expect(hi.score).toBe(10);
    const lo = await scoreChangeRequest({ text: "x" }, ok({ score: -3, isChangeRequest: true, reasoning: "r", factors: [] }));
    expect(lo.score).toBe(0);
  });

  it("passes through isChangeRequest:false", async () => {
    const r = await scoreChangeRequest({ text: "looks good, go live" }, ok({ score: 0, isChangeRequest: false, reasoning: "ack", factors: [] }));
    expect(r.isChangeRequest).toBe(false);
    expect(r.degraded).toBeUndefined();
  });

  it("fails closed when the call throws", async () => {
    const r = await scoreChangeRequest({ text: "x" }, async () => {
      throw new Error("timeout");
    });
    expect(r).toEqual({
      score: 7,
      isChangeRequest: true,
      reasoning: "Automatic assessment unavailable — routed for admin review.",
      factors: [],
      degraded: true,
    });
  });

  it("fails closed when the score is not a number", async () => {
    const r = await scoreChangeRequest({ text: "x" }, ok({ score: "high", isChangeRequest: true, reasoning: "r", factors: [] }));
    expect(r.degraded).toBe(true);
    expect(r.score).toBe(7);
  });
});
