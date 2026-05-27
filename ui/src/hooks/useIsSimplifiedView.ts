import { useQuery } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";

const ADMIN_ROLES = new Set(["owner", "admin", "operator", "manager"]);

export function useIsSimplifiedView(): boolean {
  const { selectedCompanyId } = useCompany();

  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });

  if (boardAccess?.isInstanceAdmin) return false;

  const membership = boardAccess?.memberships?.find(
    (m) => m.companyId === selectedCompanyId,
  );

  if (!membership?.membershipRole) return false;

  return !ADMIN_ROLES.has(membership.membershipRole);
}
