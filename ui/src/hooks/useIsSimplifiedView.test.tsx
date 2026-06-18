// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockUseCompany = vi.hoisted(() => vi.fn());
const mockUseCurrentBoardAccess = vi.hoisted(() => vi.fn());

vi.mock("../context/CompanyContext", () => ({ useCompany: mockUseCompany }));
vi.mock("./useCurrentBoardAccess", () => ({
  useCurrentBoardAccess: mockUseCurrentBoardAccess,
}));

import { useIsSimplifiedView } from "./useIsSimplifiedView";

const COMPANY_ID = "company-1";

function evaluate(): boolean {
  let captured: boolean | undefined;
  function Probe() {
    captured = useIsSimplifiedView();
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(<Probe />);
  });
  act(() => {
    root.unmount();
  });
  return captured as boolean;
}

function setup(opts: {
  selectedCompanyId?: string | null;
  boardAccess?: unknown;
}) {
  mockUseCompany.mockReturnValue({
    selectedCompanyId: opts.selectedCompanyId ?? null,
  });
  mockUseCurrentBoardAccess.mockReturnValue({ data: opts.boardAccess });
}

describe("useIsSimplifiedView", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the full board for instance admins", () => {
    setup({
      selectedCompanyId: COMPANY_ID,
      boardAccess: { isInstanceAdmin: true, memberships: [] },
    });
    expect(evaluate()).toBe(false);
  });

  it("shows the simplified view for operators of the active company", () => {
    setup({
      selectedCompanyId: COMPANY_ID,
      boardAccess: {
        isInstanceAdmin: false,
        memberships: [
          { companyId: COMPANY_ID, membershipRole: "operator", status: "active" },
        ],
      },
    });
    expect(evaluate()).toBe(true);
  });

  it("shows the simplified view for viewers", () => {
    setup({
      selectedCompanyId: COMPANY_ID,
      boardAccess: {
        isInstanceAdmin: false,
        memberships: [
          { companyId: COMPANY_ID, membershipRole: "viewer", status: "active" },
        ],
      },
    });
    expect(evaluate()).toBe(true);
  });

  it.each(["owner", "admin", "manager"])(
    "shows the full board for %s members",
    (role) => {
      setup({
        selectedCompanyId: COMPANY_ID,
        boardAccess: {
          isInstanceAdmin: false,
          memberships: [
            { companyId: COMPANY_ID, membershipRole: role, status: "active" },
          ],
        },
      });
      expect(evaluate()).toBe(false);
    },
  );

  // Regression: a transient /cli-auth/me failure leaves boardAccess undefined.
  // The gate must not strand a non-admin in the full admin view.
  it("fails safe to simplified when board access is not yet resolved", () => {
    setup({ selectedCompanyId: COMPANY_ID, boardAccess: undefined });
    expect(evaluate()).toBe(true);
  });

  // Regression: a failing company list leaves selectedCompanyId null even though
  // the user is a known operator.
  it("fails safe to simplified when the active company is unresolved", () => {
    setup({
      selectedCompanyId: null,
      boardAccess: {
        isInstanceAdmin: false,
        memberships: [
          { companyId: COMPANY_ID, membershipRole: "operator", status: "active" },
        ],
      },
    });
    expect(evaluate()).toBe(true);
  });

  it("fails safe to simplified when no membership matches the active company", () => {
    setup({
      selectedCompanyId: "other-company",
      boardAccess: {
        isInstanceAdmin: false,
        memberships: [
          { companyId: COMPANY_ID, membershipRole: "operator", status: "active" },
        ],
      },
    });
    expect(evaluate()).toBe(true);
  });
});
