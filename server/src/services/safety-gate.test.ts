import { describe, it, expect, vi } from "vitest";
import { evaluateAndGate, type SafetyGateDeps, type GateInput } from "./safety-gate.js";
import type { SafetyScore, ScoreInput } from "./safety-scorer.js";

// The dep types are the REAL service signatures (Pick<ReturnType<typeof ...>>),
// so build vi.fn() stubs and cast once. Assertions read through vi.mocked(...).
function makeDeps(scorer: (input: ScoreInput) => Promise<SafetyScore>): SafetyGateDeps {
  return {
    issuesSvc: { addComment: vi.fn(async () => ({ id: "c1" })), update: vi.fn(async () => ({ id: "i1" })) },
    approvalsSvc: { create: vi.fn(async () => ({ id: "appr1" })) },
    issueApprovalsSvc: { linkManyForApproval: vi.fn(async () => undefined) },
    scorer,
  } as unknown as SafetyGateDeps;
}

const input: GateInput = {
  companyId: "co1",
  issue: { id: "i1", status: "todo", assigneeAgentId: "agentA", title: "Hero copy" },
  requestText: "Change the headline",
  requesterUserId: "u1",
};

const scorerReturning = (score: SafetyScore) => async () => score;

describe("evaluateAndGate", () => {
  it("clears a low-risk change: no card, does not gate, no approval", async () => {
    const deps = makeDeps(scorerReturning({ score: 3, isChangeRequest: true, reasoning: "ok", factors: [] }));
    const out = await evaluateAndGate(input, deps);
    expect(out.gated).toBe(false);
    expect(vi.mocked(deps.issuesSvc.addComment)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.approvalsSvc.create)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.issuesSvc.update)).not.toHaveBeenCalled();
  });

  it("does not gate an ordinary front-end change scored 6 — only 7+ gates", async () => {
    const deps = makeDeps(scorerReturning({ score: 6, isChangeRequest: true, reasoning: "new page", factors: [] }));
    const out = await evaluateAndGate(input, deps);
    expect(out.gated).toBe(false);
    expect(vi.mocked(deps.issuesSvc.addComment)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.approvalsSvc.create)).not.toHaveBeenCalled();
  });

  it("gates a high-risk change: blocks the issue, creates+links the approval, posts a card", async () => {
    const deps = makeDeps(scorerReturning({ score: 8, isChangeRequest: true, reasoning: "backend", factors: ["backend"] }));
    const out = await evaluateAndGate(input, deps);
    expect(out.gated).toBe(true);
    expect(vi.mocked(deps.issuesSvc.update)).toHaveBeenCalledWith("i1", { status: "blocked" });
    expect(vi.mocked(deps.approvalsSvc.create)).toHaveBeenCalledTimes(1);
    const [companyArg, data] = vi.mocked(deps.approvalsSvc.create).mock.calls[0];
    expect(companyArg).toBe("co1");
    expect(data.type).toBe("safety_review_required");
    expect(data.status).toBe("pending");
    expect(data.requestedByAgentId).toBe("agentA");
    expect(data.payload).toMatchObject({ score: 8, priorStatus: "todo", issueId: "i1" });
    expect(vi.mocked(deps.issueApprovalsSvc.linkManyForApproval)).toHaveBeenCalledWith("appr1", ["i1"], { userId: "u1" });
    expect(vi.mocked(deps.issuesSvc.addComment)).toHaveBeenCalledTimes(1);
    // Approval is created+linked BEFORE the issue is blocked (Fix 2b); approvalId surfaced in result.
    expect(out.approvalId).toBe("appr1");
  });

  it("gates on degraded (fail-closed) scores", async () => {
    const deps = makeDeps(scorerReturning({ score: 6, isChangeRequest: true, reasoning: "unavailable", factors: [], degraded: true }));
    const out = await evaluateAndGate(input, deps);
    expect(out.gated).toBe(true);
    expect(vi.mocked(deps.approvalsSvc.create)).toHaveBeenCalledTimes(1);
  });

  it("never gates and posts no card when it is not a change request", async () => {
    const deps = makeDeps(scorerReturning({ score: 0, isChangeRequest: false, reasoning: "ack", factors: [] }));
    const out = await evaluateAndGate(input, deps);
    expect(out.gated).toBe(false);
    expect(vi.mocked(deps.issuesSvc.addComment)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.approvalsSvc.create)).not.toHaveBeenCalled();
  });
});
