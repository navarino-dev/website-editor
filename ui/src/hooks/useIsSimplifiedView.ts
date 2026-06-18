import type { CurrentBoardAccess } from "../api/access";
import { useCompany } from "../context/CompanyContext";
import { useCurrentBoardAccess } from "./useCurrentBoardAccess";

const ADMIN_ROLES = new Set(["owner", "admin", "manager"]);

export type SimplifiedViewState = {
  /** Whether to render the simplified property-manager view. */
  isSimplified: boolean;
  /**
   * Whether the role decision has settled enough to commit to a view: board
   * access has either loaded or failed at least one attempt (after which we
   * fall back to the fail-safe default while it keeps retrying). Use this to
   * hold role-specific chrome on first load so the view doesn't visibly flip
   * once access resolves — e.g. an admin briefly seeing the simplified theme.
   */
  isReady: boolean;
};

function resolveSimplified(
  boardAccess: CurrentBoardAccess | undefined,
  selectedCompanyId: string | null,
): boolean {
  // Confirmed instance admins always get the full board.
  if (boardAccess?.isInstanceAdmin) return false;

  // Role unknown: board access not resolved yet (or a transient failure), or no
  // active company selected yet. Fail safe to the simplified view rather than
  // exposing admin controls to a possibly non-admin user.
  if (!boardAccess || !selectedCompanyId) return true;

  const membership = boardAccess.memberships?.find(
    (m) => m.companyId === selectedCompanyId,
  );

  // No membership for the active company (unexpected for a board member) →
  // fail safe to simplified. Otherwise owner/admin/manager get the full board
  // and operator/viewer get the simplified view.
  if (!membership?.membershipRole) return true;

  return !ADMIN_ROLES.has(membership.membershipRole);
}

/**
 * Role-based view state for the current user, with a readiness flag so callers
 * can avoid flashing the wrong chrome before board access resolves.
 *
 * Fail-safe by design: the full admin view is shown ONLY when we can positively
 * confirm the user is privileged — an instance admin, or an owner/admin/manager
 * of the active company. Whenever the role is unknown (board access not yet
 * resolved or a transient `/cli-auth/me` failure, or the active company not yet
 * resolved) the simplified view is returned, so a non-admin is never stranded
 * in the admin UI by a flaky request.
 */
export function useSimplifiedViewState(): SimplifiedViewState {
  const { selectedCompanyId } = useCompany();
  const query = useCurrentBoardAccess();

  return {
    isSimplified: resolveSimplified(query.data, selectedCompanyId),
    // Settled once we have a snapshot, or once at least one fetch attempt has
    // failed (we then commit to the fail-safe default rather than spinning for
    // the full retry window).
    isReady: query.isSuccess || query.failureCount > 0,
  };
}

/**
 * Whether the current user should see the simplified property-manager view
 * (operators / viewers) instead of the full board/admin UI. See
 * {@link useSimplifiedViewState} for the fail-safe semantics.
 */
export function useIsSimplifiedView(): boolean {
  return useSimplifiedViewState().isSimplified;
}
