import { scoreChangeRequest, type SafetyScore, type ScoreInput } from "./safety-scorer.js";
// Type-only imports so the deps interface uses the REAL service signatures.
// This sidesteps strictFunctionTypes variance: the concrete services (which the
// route call sites pass) are exactly these types, so they assign without casts.
import type { issueService } from "./issues.js";
import type { approvalService } from "./approvals.js";
import type { issueApprovalService } from "./issue-approvals.js";

export interface GateIssue {
  id: string;
  status: string;
  assigneeAgentId: string | null;
  title?: string;
}

export interface SafetyGateDeps {
  issuesSvc: Pick<ReturnType<typeof issueService>, "addComment" | "update">;
  approvalsSvc: Pick<ReturnType<typeof approvalService>, "create">;
  issueApprovalsSvc: Pick<ReturnType<typeof issueApprovalService>, "linkManyForApproval">;
  scorer?: (input: ScoreInput) => Promise<SafetyScore>;
}

export interface GateInput {
  companyId: string;
  issue: GateIssue;
  requestText: string;
  requesterUserId: string | null;
  projectName?: string;
}

function cardBody(score: SafetyScore, gated: boolean): string {
  const lines = [`**Safety score: ${score.score}/10**`, "", score.reasoning];
  if (score.factors.length > 0) lines.push("", `Factors: ${score.factors.join(", ")}`);
  lines.push("", gated ? "_Needs admin approval to proceed._" : "_Cleared to proceed._");
  return lines.join("\n");
}

export async function evaluateAndGate(
  input: GateInput,
  deps: SafetyGateDeps,
): Promise<{ gated: boolean; score: SafetyScore; approvalId?: string }> {
  const scorer = deps.scorer ?? scoreChangeRequest;
  const score = await scorer({ title: input.issue.title, text: input.requestText, projectName: input.projectName });

  // Acknowledgements / approvals / questions: never gated, no card.
  if (!score.isChangeRequest) return { gated: false, score };

  const gated = score.degraded === true || score.score > 5;

  await deps.issuesSvc.addComment(
    input.issue.id,
    cardBody(score, gated),
    {},
    {
      authorType: "system",
      presentation: {
        kind: "system_notice",
        tone: gated ? "warning" : "success",
        title: `Safety ${score.score}/10`,
        detailsDefaultOpen: gated,
      },
    },
  );

  if (!gated) return { gated: false, score };

  // Create + link the approval BEFORE blocking the issue, so a failure here can
  // never leave the issue blocked with no approval to release it.
  const approval = await deps.approvalsSvc.create(input.companyId, {
    type: "safety_review_required",
    requestedByAgentId: input.issue.assigneeAgentId ?? null,
    requestedByUserId: input.requesterUserId,
    status: "pending",
    payload: {
      score: score.score,
      reasoning: score.reasoning,
      factors: score.factors,
      degraded: score.degraded ?? false,
      priorStatus: input.issue.status,
      issueId: input.issue.id,
    },
  });

  await deps.issueApprovalsSvc.linkManyForApproval(approval.id, [input.issue.id], {
    userId: input.requesterUserId,
  });

  await deps.issuesSvc.update(input.issue.id, { status: "blocked" });

  return { gated: true, score, approvalId: approval.id };
}
