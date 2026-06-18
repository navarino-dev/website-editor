import { useCompany } from "../context/CompanyContext";
import { useCurrentBoardAccess } from "./useCurrentBoardAccess";

const ADMIN_ROLES = new Set(["owner", "admin", "manager"]);

/**
 * Whether the current user should see the simplified property-manager view
 * (operators / viewers) instead of the full board/admin UI.
 *
 * Fail-safe by design: the full admin view is shown ONLY when we can positively
 * confirm the user is privileged — an instance admin, or an owner/admin/manager
 * of the active company. Whenever the role is unknown (board access not yet
 * resolved or a transient `/cli-auth/me` failure, or the active company not yet
 * resolved) we return the simplified view, so a non-admin is never stranded in
 * the admin UI by a flaky request. Confirmed admins briefly see the simplified
 * view on a cold load and flip to the full board once access resolves.
 */
export function useIsSimplifiedView(): boolean {
  const { selectedCompanyId } = useCompany();
  const { data: boardAccess } = useCurrentBoardAccess();

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
