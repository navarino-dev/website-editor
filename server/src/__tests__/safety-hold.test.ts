import { describe, expect, it, vi } from "vitest";
import { hasPendingSafetyApproval } from "../services/safety-hold.js";

/**
 * Builds a minimal fake db that returns the given rows from a
 * select → innerJoin → where → limit chain.
 */
function makeFakeDb(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return {
    select: vi.fn(() => chain),
  } as unknown as Parameters<typeof hasPendingSafetyApproval>[0];
}

describe("hasPendingSafetyApproval", () => {
  it("returns true when a pending safety_review_required approval exists", async () => {
    const db = makeFakeDb([{ id: "approval-1" }]);
    const result = await hasPendingSafetyApproval(db, "company-1", "issue-1");
    expect(result).toBe(true);
  });

  it("returns false when no approval rows exist", async () => {
    const db = makeFakeDb([]);
    const result = await hasPendingSafetyApproval(db, "company-1", "issue-1");
    expect(result).toBe(false);
  });

  // Note: The following two tests exercise boolean handling in the caller;
  // the fake db cannot fully exercise the SQL WHERE filter itself.
  it("returns false when the approval exists but is not pending (e.g. approved)", async () => {
    // The SQL filter handles this, but we ensure the function treats zero rows as false.
    const db = makeFakeDb([]);
    const result = await hasPendingSafetyApproval(db, "company-1", "issue-2");
    expect(result).toBe(false);
  });

  it("returns false when the approval type is different (not safety_review_required)", async () => {
    // The SQL filter handles this; zero rows → false.
    const db = makeFakeDb([]);
    const result = await hasPendingSafetyApproval(db, "company-1", "issue-3");
    expect(result).toBe(false);
  });

  it("passes companyId and issueId into the where clause via the chain", async () => {
    const rows = [{ id: "approval-x" }];
    const chain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(rows),
    };
    const db = { select: vi.fn(() => chain) } as unknown as Parameters<typeof hasPendingSafetyApproval>[0];

    await hasPendingSafetyApproval(db, "company-abc", "issue-xyz");

    // The query is built via chaining; we just verify select was called once
    // and the chain was consumed (where + limit were called).
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(chain.where).toHaveBeenCalledTimes(1);
    expect(chain.where.mock.calls[0][0]).toBeTruthy();
    expect(chain.limit).toHaveBeenCalledWith(1);
  });
});
