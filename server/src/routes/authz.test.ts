import { describe, it, expect } from "vitest";
import { canApproveSafety } from "./authz.js";

const base = { type: "board" as const };

describe("canApproveSafety", () => {
  it("allows an instance admin", () => {
    expect(canApproveSafety({ ...base, isInstanceAdmin: true }, "co1")).toBe(true);
  });

  it("allows the local trusted operator (local_implicit)", () => {
    expect(canApproveSafety({ ...base, source: "local_implicit" }, "co1")).toBe(true);
  });

  it("allows an active owner/admin/manager membership", () => {
    for (const role of ["owner", "admin", "manager"]) {
      expect(
        canApproveSafety({ ...base, memberships: [{ companyId: "co1", membershipRole: role, status: "active" }] }, "co1"),
      ).toBe(true);
    }
  });

  it("rejects operators and viewers", () => {
    for (const role of ["operator", "viewer", "member"]) {
      expect(
        canApproveSafety({ ...base, memberships: [{ companyId: "co1", membershipRole: role, status: "active" }] }, "co1"),
      ).toBe(false);
    }
  });

  it("rejects an admin membership for a different company", () => {
    expect(
      canApproveSafety({ ...base, memberships: [{ companyId: "other", membershipRole: "admin", status: "active" }] }, "co1"),
    ).toBe(false);
  });

  it("rejects a non-active admin membership", () => {
    expect(
      canApproveSafety({ ...base, memberships: [{ companyId: "co1", membershipRole: "admin", status: "suspended" }] }, "co1"),
    ).toBe(false);
  });
});
