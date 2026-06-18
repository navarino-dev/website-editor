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

import {
  useIsSimplifiedView,
  useSimplifiedViewState,
  type SimplifiedViewState,
} from "./useIsSimplifiedView";

const COMPANY_ID = "company-1";

function render<T>(hook: () => T): T {
  let captured: T | undefined;
  function Probe() {
    captured = hook();
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
  return captured as T;
}

function evaluate(): boolean {
  return render(useIsSimplifiedView);
}

function evaluateState(): SimplifiedViewState {
  return render(useSimplifiedViewState);
}

function setup(opts: {
  selectedCompanyId?: string | null;
  boardAccess?: unknown;
  isSuccess?: boolean;
  failureCount?: number;
}) {
  mockUseCompany.mockReturnValue({
    selectedCompanyId: opts.selectedCompanyId ?? null,
  });
  mockUseCurrentBoardAccess.mockReturnValue({
    data: opts.boardAccess,
    isSuccess: opts.isSuccess ?? opts.boardAccess !== undefined,
    failureCount: opts.failureCount ?? 0,
  });
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

  describe("isReady", () => {
    it("is not ready while board access is still loading (first attempt in flight)", () => {
      setup({
        selectedCompanyId: COMPANY_ID,
        boardAccess: undefined,
        isSuccess: false,
        failureCount: 0,
      });
      expect(evaluateState().isReady).toBe(false);
    });

    it("is ready once board access has loaded", () => {
      setup({
        selectedCompanyId: COMPANY_ID,
        boardAccess: {
          isInstanceAdmin: false,
          memberships: [
            { companyId: COMPANY_ID, membershipRole: "operator", status: "active" },
          ],
        },
        isSuccess: true,
      });
      expect(evaluateState().isReady).toBe(true);
    });

    it("is ready after a failed attempt so it commits to the fail-safe default", () => {
      setup({
        selectedCompanyId: COMPANY_ID,
        boardAccess: undefined,
        isSuccess: false,
        failureCount: 1,
      });
      const state = evaluateState();
      expect(state.isReady).toBe(true);
      expect(state.isSimplified).toBe(true);
    });
  });
});
