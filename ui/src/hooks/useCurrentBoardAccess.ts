import {
  useQuery,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import { accessApi, type CurrentBoardAccess } from "../api/access";
import { queryKeys } from "../lib/queryKeys";

type BoardAccessQueryOverrides = Omit<
  UseQueryOptions<CurrentBoardAccess>,
  "queryKey" | "queryFn"
>;

/**
 * Shared, resilient query for the current board actor's access snapshot
 * (`GET /cli-auth/me`): the instance-admin flag plus company memberships/roles.
 *
 * This snapshot drives role-based UI gating — most importantly the simplified
 * property-manager view (see {@link useIsSimplifiedView}). A transient 401 from a
 * session-refresh blip must NOT leave this query stuck with no data, otherwise a
 * non-admin operator gets stranded in the full admin UI. So we retry through
 * transient failures and refetch on focus/reconnect. Once it has succeeded,
 * React Query keeps the last good snapshot even if a later background refetch
 * errors, so the gate keeps working.
 *
 * Callers that need different semantics (e.g. gate on an existing session, or
 * disable retries) can pass `overrides`.
 */
export function useCurrentBoardAccess(
  overrides?: BoardAccessQueryOverrides,
): UseQueryResult<CurrentBoardAccess> {
  return useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    // Ride out short-lived session blips rather than giving up after the
    // default 3 attempts; exponential backoff caps at 15s (~30s total window).
    retry: 5,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 15_000),
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    staleTime: 30_000,
    ...overrides,
  });
}
