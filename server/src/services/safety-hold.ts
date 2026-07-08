/**
 * safety-hold.ts
 *
 * Defense-in-depth guard: checks whether an issue has a pending
 * `safety_review_required` approval that should block agent run-start.
 *
 * Kept as a focused, independently testable module so unit tests can pass a
 * fake db without pulling in the full heartbeat service.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals } from "@paperclipai/db";

/**
 * Returns `true` if there is at least one `safety_review_required` approval
 * in `pending` status linked to the given issue.
 */
export async function hasPendingSafetyApproval(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: issueApprovals.approvalId })
    .from(issueApprovals)
    .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
    .where(
      and(
        eq(issueApprovals.companyId, companyId),
        eq(issueApprovals.issueId, issueId),
        eq(approvals.type, "safety_review_required"),
        eq(approvals.status, "pending"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
