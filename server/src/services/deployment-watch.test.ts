// server/src/services/deployment-watch.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createDeploymentWatch } from "./deployment-watch.js";

// Mock github-deployments so we control poll results without network calls
vi.mock("./github-deployments.js", () => ({
  getLatestProductionDeployStatus: vi.fn(),
}));

import { getLatestProductionDeployStatus } from "./github-deployments.js";
const mockPoll = vi.mocked(getLatestProductionDeployStatus);

// ---------------------------------------------------------------------------
// Fake db helpers
// ---------------------------------------------------------------------------
function createFakeDb(selectResultSets: unknown[][]) {
  const insertedRows: unknown[] = [];
  const updatedSets: Array<{ values: unknown }> = [];
  let selectIdx = 0;

  const db = {
    select: (_fields?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown): Promise<unknown[]> => {
          const rows = selectResultSets[selectIdx++] ?? [];
          return Promise.resolve(rows as unknown[]);
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: (row: unknown): Promise<void> => {
        insertedRows.push(row);
        return Promise.resolve();
      },
    }),
    update: (_table: unknown) => ({
      set: (values: unknown) => ({
        where: (_cond: unknown): Promise<void> => {
          updatedSets.push({ values });
          return Promise.resolve();
        },
      }),
    }),
  };

  return { db, insertedRows, updatedSets };
}

// ---------------------------------------------------------------------------
// Fake watch row factory
// ---------------------------------------------------------------------------
function makeWatch(overrides: Partial<{
  id: string;
  companyId: string;
  issueId: string;
  repoUrl: string;
  productionUrl: string;
  status: string;
  attempts: number;
  fixAttempts: number;
  startedAt: Date;
  deadlineAt: Date;
  nextCheckAt: Date;
}> = {}) {
  const now = new Date("2026-06-29T12:00:00Z");
  return {
    id: "watch-1",
    companyId: "company-1",
    issueId: "issue-1",
    repoUrl: "https://github.com/org/repo",
    productionUrl: "https://example.com",
    status: "watching",
    attempts: 0,
    fixAttempts: 0,
    startedAt: new Date(now.getTime() - 60_000),
    deadlineAt: new Date(now.getTime() + 10 * 60_000), // 10 min ahead = before deadline
    nextCheckAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake deps factory
// ---------------------------------------------------------------------------
function makeDeps(
  db: ReturnType<typeof createFakeDb>["db"],
  projectResult: { productionUrl: string | null; codebase: { repoUrl: string | null } } | null,
  options: {
    getIssueAssignee?: (issueId: string, companyId: string) => Promise<string | null>;
    wakeAgent?: (agentId: string, opts: { reason: string; payload?: Record<string, unknown>; contextSnapshot?: Record<string, unknown> }) => Promise<unknown>;
    approvalResult?: { id: string };
  } = {},
) {
  const addComment = vi.fn().mockResolvedValue(undefined);
  const updateIssue = vi.fn().mockResolvedValue(undefined);
  const logActivity = vi.fn().mockResolvedValue(undefined);
  const getToken = vi.fn().mockReturnValue("gh-token");
  const getIssueAssignee = options.getIssueAssignee ?? vi.fn().mockResolvedValue(null);
  const wakeAgent = options.wakeAgent ?? vi.fn().mockResolvedValue(undefined);
  const createApproval = vi.fn().mockResolvedValue(options.approvalResult ?? { id: "approval-1" });
  const linkManyForApproval = vi.fn().mockResolvedValue(undefined);
  const getIssueProjectName = vi.fn().mockResolvedValue("Test Property");

  const deps = {
    db: db as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    issuesSvc: { addComment, update: updateIssue },
    projectsSvc: {
      getById: vi.fn().mockResolvedValue(projectResult),
    },
    approvalsSvc: { create: createApproval },
    issueApprovalsSvc: { linkManyForApproval },
    logActivity,
    getToken,
    getIssueAssignee,
    wakeAgent,
    getIssueProjectName,
  };

  return { deps, addComment, updateIssue, logActivity, getIssueAssignee, wakeAgent, createApproval, linkManyForApproval, getIssueProjectName };
}

const PUBLISHING_BODY =
  "Publishing your change now — I'll share the live link here as soon as it's ready.";
const LIVE_BODY = (url: string) => `✨ Your change is now live.\n\nLIVE_URL: ${url}`;
const DELAYED_BODY =
  "This is taking a little longer than usual. It should be live shortly — check back soon.";
const FAILED_BODY =
  "We hit a snag publishing this change. The team has been notified.";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("createDeploymentWatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // onIssueDone
  // -------------------------------------------------------------------------
  describe("onIssueDone", () => {
    it("inserts a watch and posts the publishing comment when project has productionUrl + repoUrl", async () => {
      // First select (check for existing watch) returns []
      const { db, insertedRows } = createFakeDb([[]]);
      const project = {
        productionUrl: "https://example.com",
        codebase: { repoUrl: "https://github.com/org/repo" },
      };
      const { deps, addComment } = makeDeps(db, project);
      const svc = createDeploymentWatch(deps);

      await svc.onIssueDone({
        id: "issue-1",
        companyId: "company-1",
        projectId: "project-1",
      });

      expect(insertedRows).toHaveLength(1);
      expect(insertedRows[0]).toMatchObject({
        issueId: "issue-1",
        companyId: "company-1",
        repoUrl: "https://github.com/org/repo",
        productionUrl: "https://example.com",
        status: "watching",
      });

      expect(addComment).toHaveBeenCalledOnce();
      expect(addComment).toHaveBeenCalledWith(
        "issue-1",
        PUBLISHING_BODY,
        {},
        { authorType: "system", presentation: { kind: "system_notice", tone: "info", detailsDefaultOpen: false } },
      );
    });

    it("is a no-op when the project has no productionUrl", async () => {
      const { db, insertedRows } = createFakeDb([]);
      const project = {
        productionUrl: null,
        codebase: { repoUrl: "https://github.com/org/repo" },
      };
      const { deps, addComment } = makeDeps(db, project);
      const svc = createDeploymentWatch(deps);

      await svc.onIssueDone({
        id: "issue-1",
        companyId: "company-1",
        projectId: "project-1",
      });

      expect(insertedRows).toHaveLength(0);
      expect(addComment).not.toHaveBeenCalled();
    });

    it("is a no-op when the project has no repoUrl", async () => {
      const { db, insertedRows } = createFakeDb([]);
      const project = {
        productionUrl: "https://example.com",
        codebase: { repoUrl: null },
      };
      const { deps, addComment } = makeDeps(db, project);
      const svc = createDeploymentWatch(deps);

      await svc.onIssueDone({
        id: "issue-1",
        companyId: "company-1",
        projectId: "project-1",
      });

      expect(insertedRows).toHaveLength(0);
      expect(addComment).not.toHaveBeenCalled();
    });

    it("resolves (does not throw) when projectsSvc.getById rejects", async () => {
      const { db } = createFakeDb([]);
      const { deps } = makeDeps(db, null);
      const depsCopy = {
        ...deps,
        projectsSvc: {
          getById: vi.fn().mockRejectedValue(new Error("DB connection lost")),
        },
      };
      const svc = createDeploymentWatch(depsCopy as any); // eslint-disable-line @typescript-eslint/no-explicit-any

      await expect(
        svc.onIssueDone({ id: "issue-1", companyId: "company-1", projectId: "project-1" }),
      ).resolves.toBeUndefined();
    });

    it("resolves (does not throw) when issuesSvc.addComment rejects", async () => {
      // select returns [] (no existing watch), insert resolves, but addComment rejects
      const { db } = createFakeDb([[]]);
      const { deps } = makeDeps(db, {
        productionUrl: "https://example.com",
        codebase: { repoUrl: "https://github.com/org/repo" },
      });
      const depsCopy = {
        ...deps,
        issuesSvc: {
          ...deps.issuesSvc,
          addComment: vi.fn().mockRejectedValue(new Error("comment service unavailable")),
        },
      };
      const svc = createDeploymentWatch(depsCopy);

      await expect(
        svc.onIssueDone({ id: "issue-1", companyId: "company-1", projectId: "project-1" }),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // tick
  // -------------------------------------------------------------------------
  describe("tick", () => {
    it("posts the LIVE_URL comment and sets status=live when deploy succeeds", async () => {
      const now = new Date("2026-06-29T12:00:00Z");
      const watch = makeWatch({ deadlineAt: new Date(now.getTime() + 10 * 60_000) });
      const { db, updatedSets } = createFakeDb([[watch]]);
      const { deps, addComment, createApproval } = makeDeps(db, null);
      mockPoll.mockResolvedValue("success");

      const svc = createDeploymentWatch(deps);
      const result = await svc.tick(now);

      expect(result).toEqual({ live: 1, delayed: 0, failed: 0 });
      expect(addComment).toHaveBeenCalledOnce();
      expect(addComment).toHaveBeenCalledWith(
        "issue-1",
        LIVE_BODY("https://example.com"),
        {},
        { authorType: "system", presentation: { kind: "system_notice", tone: "success", detailsDefaultOpen: false } },
      );
      expect(updatedSets).toHaveLength(1);
      expect(updatedSets[0]?.values).toMatchObject({ status: "live" });
      // No approval created on success
      expect(createApproval).not.toHaveBeenCalled();
    });

    it("posts the delayed comment and sets status=delayed when past deadline with pending state and no prior fix attempts", async () => {
      const now = new Date("2026-06-29T12:00:00Z");
      // deadlineAt is in the past relative to now, fixAttempts=0 (never failed before)
      const watch = makeWatch({ deadlineAt: new Date(now.getTime() - 1), fixAttempts: 0 });
      const { db, updatedSets } = createFakeDb([[watch]]);
      const { deps, addComment, createApproval } = makeDeps(db, null);
      mockPoll.mockResolvedValue("pending");

      const svc = createDeploymentWatch(deps);
      const result = await svc.tick(now);

      expect(result).toEqual({ live: 0, delayed: 1, failed: 0 });
      expect(addComment).toHaveBeenCalledOnce();
      expect(addComment).toHaveBeenCalledWith(
        "issue-1",
        DELAYED_BODY,
        {},
        { authorType: "system", presentation: { kind: "system_notice", tone: "warning", detailsDefaultOpen: false } },
      );
      expect(updatedSets[0]?.values).toMatchObject({ status: "delayed" });
      expect(createApproval).not.toHaveBeenCalled();
    });

    it("escalates on deadline exceeded when there were prior fix attempts", async () => {
      const now = new Date("2026-06-29T12:00:00Z");
      // deadlineAt in the past, fixAttempts=2 (had failures before)
      const watch = makeWatch({ deadlineAt: new Date(now.getTime() - 1), fixAttempts: 2 });
      const { db, updatedSets } = createFakeDb([[watch]]);
      const { deps, addComment, logActivity, createApproval, linkManyForApproval, updateIssue, wakeAgent } = makeDeps(db, null);
      mockPoll.mockResolvedValue("pending");

      const svc = createDeploymentWatch(deps);
      const result = await svc.tick(now);

      expect(result).toEqual({ live: 0, delayed: 0, failed: 1 });
      // No wake – escalation, not retry
      expect(wakeAgent).not.toHaveBeenCalled();
      // Terminal FAILED comment
      expect(addComment).toHaveBeenCalledWith(
        "issue-1",
        FAILED_BODY,
        {},
        { authorType: "system", presentation: { kind: "system_notice", tone: "danger", detailsDefaultOpen: false } },
      );
      // Approval created
      expect(createApproval).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ type: "deploy_failed_review" }),
      );
      const approvalData = createApproval.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(approvalData).toMatchObject({
        type: "deploy_failed_review",
        requestedByAgentId: null,
        requestedByUserId: null,
        status: "pending",
      });
      expect((approvalData["payload"] as Record<string, unknown>)).toMatchObject({
        issueId: "issue-1",
        propertyName: "Test Property",
        reason: "the deploy never came back",
        attempts: 2,
      });
      // Issues linked
      expect(linkManyForApproval).toHaveBeenCalledWith("approval-1", ["issue-1"]);
      // Issue blocked
      expect(updateIssue).toHaveBeenCalledWith("issue-1", { status: "blocked" });
      // Activity logged
      expect(logActivity).toHaveBeenCalledWith(
        expect.objectContaining({ action: "deployment.failed", entityId: "issue-1" }),
      );
      // Watch marked failed
      expect(updatedSets[0]?.values).toMatchObject({ status: "failed" });
    });

    it("escalates when MAX_FIX_WAKES (8) reached even with future deadline", async () => {
      const now = new Date("2026-06-29T12:00:00Z");
      const watch = makeWatch({
        deadlineAt: new Date(now.getTime() + 60 * 60_000), // 1h in the future
        fixAttempts: 8,
      });
      const { db, updatedSets } = createFakeDb([[watch]]);
      const { deps, addComment, logActivity, createApproval, linkManyForApproval, updateIssue, wakeAgent } = makeDeps(db, null);
      mockPoll.mockResolvedValue("failure");

      const svc = createDeploymentWatch(deps);
      const result = await svc.tick(now);

      expect(result).toEqual({ live: 0, delayed: 0, failed: 1 });
      expect(wakeAgent).not.toHaveBeenCalled();
      expect(createApproval).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ type: "deploy_failed_review" }),
      );
      const approvalData = createApproval.mock.calls[0]?.[1] as Record<string, unknown>;
      expect((approvalData["payload"] as Record<string, unknown>)).toMatchObject({
        reason: "the deploy kept failing",
        attempts: 8,
      });
      expect(linkManyForApproval).toHaveBeenCalledWith("approval-1", ["issue-1"]);
      expect(updateIssue).toHaveBeenCalledWith("issue-1", { status: "blocked" });
      expect(addComment).toHaveBeenCalledWith(
        "issue-1",
        FAILED_BODY,
        {},
        { authorType: "system", presentation: { kind: "system_notice", tone: "danger", detailsDefaultOpen: false } },
      );
      expect(logActivity).toHaveBeenCalledWith(
        expect.objectContaining({ action: "deployment.failed", entityId: "issue-1" }),
      );
      expect(updatedSets[0]?.values).toMatchObject({ status: "failed" });
    });

    it("escalates when budget exceeded (fixAttempts >= 1 && now >= deadlineAt) on failure state", async () => {
      const now = new Date("2026-06-29T12:00:00Z");
      const watch = makeWatch({
        deadlineAt: new Date(now.getTime() - 1), // past deadline
        fixAttempts: 2,
      });
      const { db, updatedSets } = createFakeDb([[watch]]);
      const { deps, addComment, logActivity, createApproval, linkManyForApproval, updateIssue, wakeAgent } = makeDeps(db, null);
      mockPoll.mockResolvedValue("failure");

      const svc = createDeploymentWatch(deps);
      const result = await svc.tick(now);

      expect(result).toEqual({ live: 0, delayed: 0, failed: 1 });
      expect(wakeAgent).not.toHaveBeenCalled();
      expect(createApproval).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ type: "deploy_failed_review" }),
      );
      const approvalData = createApproval.mock.calls[0]?.[1] as Record<string, unknown>;
      expect((approvalData["payload"] as Record<string, unknown>)).toMatchObject({
        issueId: "issue-1",
        propertyName: "Test Property",
        reason: "the deploy kept failing",
        attempts: 2,
      });
      expect(linkManyForApproval).toHaveBeenCalledWith("approval-1", ["issue-1"]);
      expect(updateIssue).toHaveBeenCalledWith("issue-1", { status: "blocked" });
      expect(addComment).toHaveBeenCalledWith(
        "issue-1",
        FAILED_BODY,
        {},
        { authorType: "system", presentation: { kind: "system_notice", tone: "danger", detailsDefaultOpen: false } },
      );
      expect(logActivity).toHaveBeenCalledWith(
        expect.objectContaining({ action: "deployment.failed" }),
      );
      expect(updatedSets[0]?.values).toMatchObject({ status: "failed" });
    });

    it("first failure (fixAttempts=0) sets 30-min budget and retries without escalating", async () => {
      const now = new Date("2026-06-29T12:00:00Z");
      const watch = makeWatch({
        deadlineAt: new Date(now.getTime() + 10 * 60_000), // initial short deadline
        fixAttempts: 0,
      });
      const { db, updatedSets } = createFakeDb([[watch]]);
      const wakeAgent = vi.fn().mockResolvedValue(undefined);
      const getIssueAssignee = vi.fn().mockResolvedValue("agentA");
      const { deps, addComment, logActivity, createApproval, updateIssue } = makeDeps(db, null, { wakeAgent, getIssueAssignee });
      mockPoll.mockResolvedValue("failure");

      const svc = createDeploymentWatch(deps);
      const result = await svc.tick(now);

      expect(result).toEqual({ live: 0, delayed: 0, failed: 1 });

      // Woke assignee
      expect(wakeAgent).toHaveBeenCalledOnce();

      // No escalation
      expect(createApproval).not.toHaveBeenCalled();
      expect(updateIssue).not.toHaveBeenCalled();

      // Posted warning comment (not terminal FAILED_BODY)
      expect(addComment).toHaveBeenCalledWith(
        "issue-1",
        "That change ran into a snag while publishing. I'm fixing it and trying again.",
        {},
        { authorType: "system", presentation: { kind: "system_notice", tone: "warning", detailsDefaultOpen: false } },
      );

      // Logged retry_requested
      expect(logActivity).toHaveBeenCalledWith(
        expect.objectContaining({ action: "deployment.retry_requested", details: { fixAttempt: 1 } }),
      );

      // Watch updated: fixAttempts incremented, startedAt advanced, deadlineAt set to 30 min budget, nextCheckAt set to RETRY_POLL_MS
      const updated = updatedSets[0]?.values as Record<string, unknown>;
      expect(updated).toMatchObject({
        status: "watching",
        fixAttempts: 1,
        startedAt: now,
      });
      const nextCheck = updated?.["nextCheckAt"] as Date;
      expect(nextCheck instanceof Date).toBe(true);
      expect(nextCheck.getTime() - now.getTime()).toBeCloseTo(3 * 60_000, -2);
      // deadlineAt should be extended to ~30 minutes from now
      const newDeadline = updated?.["deadlineAt"] as Date;
      expect(newDeadline instanceof Date).toBe(true);
      expect(newDeadline.getTime() - now.getTime()).toBeCloseTo(30 * 60_000, -2);
    });

    it("within-budget subsequent failure (fixAttempts=2, future deadline) retries without escalating", async () => {
      const now = new Date("2026-06-29T12:00:00Z");
      const existingDeadline = new Date(now.getTime() + 20 * 60_000); // 20 min future
      const watch = makeWatch({
        deadlineAt: existingDeadline,
        fixAttempts: 2,
      });
      const { db, updatedSets } = createFakeDb([[watch]]);
      const wakeAgent = vi.fn().mockResolvedValue(undefined);
      const getIssueAssignee = vi.fn().mockResolvedValue("agentA");
      const { deps, createApproval, updateIssue, logActivity } = makeDeps(db, null, { wakeAgent, getIssueAssignee });
      mockPoll.mockResolvedValue("failure");

      const svc = createDeploymentWatch(deps);
      await svc.tick(now);

      // No escalation
      expect(createApproval).not.toHaveBeenCalled();
      expect(updateIssue).not.toHaveBeenCalled();

      // Woke assignee
      expect(wakeAgent).toHaveBeenCalledOnce();

      // Logged retry
      expect(logActivity).toHaveBeenCalledWith(
        expect.objectContaining({ action: "deployment.retry_requested", details: { fixAttempt: 3 } }),
      );

      // Watch updated: fixAttempts 2→3, deadlineAt UNCHANGED (not refreshed)
      const updated = updatedSets[0]?.values as Record<string, unknown>;
      expect(updated).toMatchObject({
        status: "watching",
        fixAttempts: 3,
        startedAt: now,
      });
      // deadlineAt stays the same (not reset on subsequent failures)
      expect((updated?.["deadlineAt"] as Date).getTime()).toBe(existingDeadline.getTime());
    });

    it("bumps nextCheckAt by ~15s and posts no comment when pending before deadline", async () => {
      const now = new Date("2026-06-29T12:00:00Z");
      const watch = makeWatch({ deadlineAt: new Date(now.getTime() + 10 * 60_000) });
      const { db, updatedSets } = createFakeDb([[watch]]);
      const { deps, addComment } = makeDeps(db, null);
      mockPoll.mockResolvedValue("pending");

      const svc = createDeploymentWatch(deps);
      const result = await svc.tick(now);

      expect(result).toEqual({ live: 0, delayed: 0, failed: 0 });
      expect(addComment).not.toHaveBeenCalled();
      const updated = updatedSets[0]?.values as Record<string, unknown>;
      expect(updated).toMatchObject({ attempts: 1 });
      const nextCheck = updated?.["nextCheckAt"] as Date;
      expect(nextCheck instanceof Date).toBe(true);
      expect(nextCheck.getTime() - now.getTime()).toBeCloseTo(15_000, -2);
    });

    it("on failure under cap: wakes the assignee, posts a warning comment, increments fixAttempts, keeps watching", async () => {
      const now = new Date("2026-06-29T12:00:00Z");
      const watch = makeWatch({ deadlineAt: new Date(now.getTime() + 10 * 60_000), fixAttempts: 0 });
      const { db, updatedSets } = createFakeDb([[watch]]);
      const wakeAgent = vi.fn().mockResolvedValue(undefined);
      const getIssueAssignee = vi.fn().mockResolvedValue("agentA");
      const { deps, addComment, logActivity } = makeDeps(db, null, { wakeAgent, getIssueAssignee });
      mockPoll.mockResolvedValue("failure");

      const svc = createDeploymentWatch(deps);
      const result = await svc.tick(now);

      // Counts as a failure event
      expect(result).toEqual({ live: 0, delayed: 0, failed: 1 });

      // Woke the assignee
      expect(wakeAgent).toHaveBeenCalledOnce();
      expect(wakeAgent).toHaveBeenCalledWith("agentA", {
        reason: "deploy_failed",
        payload: { issueId: "issue-1", fixAttempt: 1 },
        contextSnapshot: { issueId: "issue-1", source: "deployment.failed" },
      });

      // Posted a warning (actionable) comment, not the terminal FAILED_BODY
      expect(addComment).toHaveBeenCalledOnce();
      expect(addComment).toHaveBeenCalledWith(
        "issue-1",
        "That change ran into a snag while publishing. I'm fixing it and trying again.",
        {},
        { authorType: "system", presentation: { kind: "system_notice", tone: "warning", detailsDefaultOpen: false } },
      );

      // Logged deployment.retry_requested (not deployment.failed)
      expect(logActivity).toHaveBeenCalledOnce();
      expect(logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "company-1",
          actorType: "system",
          action: "deployment.retry_requested",
          entityType: "issue",
          entityId: "issue-1",
          details: { fixAttempt: 1 },
        }),
      );

      // Watch kept alive with fixAttempts incremented; startedAt advanced so next poll only sees NEW deploys
      const updated = updatedSets[0]?.values as Record<string, unknown>;
      expect(updated).toMatchObject({
        status: "watching",
        fixAttempts: 1,
        startedAt: now,
      });
      const nextCheck = updated?.["nextCheckAt"] as Date;
      expect(nextCheck instanceof Date).toBe(true);
      // nextCheckAt should be ~3 minutes (RETRY_POLL_MS), not 15s
      expect(nextCheck.getTime() - now.getTime()).toBeCloseTo(3 * 60_000, -2);
      // deadlineAt extended to 30-min budget on first failure
      const newDeadline = updated?.["deadlineAt"] as Date;
      expect(newDeadline instanceof Date).toBe(true);
      expect(newDeadline.getTime() - now.getTime()).toBeCloseTo(30 * 60_000, -2);
    });

    it("on failure under cap with no assignee: skips wake, still posts comment, increments fixAttempts, keeps watching", async () => {
      const now = new Date("2026-06-29T12:00:00Z");
      const watch = makeWatch({ deadlineAt: new Date(now.getTime() + 10 * 60_000), fixAttempts: 1 });
      const { db, updatedSets } = createFakeDb([[watch]]);
      const wakeAgent = vi.fn().mockResolvedValue(undefined);
      const getIssueAssignee = vi.fn().mockResolvedValue(null);
      const { deps, addComment, logActivity } = makeDeps(db, null, { wakeAgent, getIssueAssignee });
      mockPoll.mockResolvedValue("failure");

      const svc = createDeploymentWatch(deps);
      const result = await svc.tick(now);

      // Counts as a failure event
      expect(result).toEqual({ live: 0, delayed: 0, failed: 1 });

      // Did NOT wake anyone (no assignee)
      expect(wakeAgent).not.toHaveBeenCalled();

      // Posted comment regardless
      expect(addComment).toHaveBeenCalledOnce();
      expect(addComment).toHaveBeenCalledWith(
        "issue-1",
        "That change ran into a snag while publishing. I'm fixing it and trying again.",
        {},
        { authorType: "system", presentation: { kind: "system_notice", tone: "warning", detailsDefaultOpen: false } },
      );

      // Logged deployment.retry_requested (not deployment.failed)
      expect(logActivity).toHaveBeenCalledOnce();
      expect(logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "company-1",
          actorType: "system",
          action: "deployment.retry_requested",
          entityType: "issue",
          entityId: "issue-1",
          details: { fixAttempt: 2 },
        }),
      );

      // Still watching, fixAttempts incremented, startedAt advanced
      const updated = updatedSets[0]?.values as Record<string, unknown>;
      expect(updated).toMatchObject({
        status: "watching",
        fixAttempts: 2,
        startedAt: now,
      });
    });

    it("marks watch as failed even when approvalsSvc.create throws mid-escalation (no-respam guard)", async () => {
      // This tests the critical ordering fix: db.update({status:"failed"}) runs
      // BEFORE approvalsSvc.create so a partial failure leaves the watch terminal
      // rather than stuck in "watching" and re-entering escalation on the next tick.
      const now = new Date("2026-06-29T12:00:00Z");
      const watch = makeWatch({
        deadlineAt: new Date(now.getTime() + 60 * 60_000), // far future deadline
        fixAttempts: 8, // >= MAX_FIX_WAKES → escalation path
      });
      const { db, updatedSets } = createFakeDb([[watch]]);
      const { deps } = makeDeps(db, null);
      const depsCopy = {
        ...deps,
        approvalsSvc: {
          create: vi.fn().mockRejectedValue(new Error("approval service down")),
        },
      };
      mockPoll.mockResolvedValue("failure");

      const svc = createDeploymentWatch(depsCopy as any); // eslint-disable-line @typescript-eslint/no-explicit-any
      // The per-watch try/catch swallows the throw from escalate(); must not propagate
      await expect(svc.tick(now)).resolves.toBeDefined();

      // The watch MUST have been marked failed before approvalsSvc.create was invoked,
      // so even though the approval creation failed the watch is terminal (won't re-escalate).
      expect(updatedSets).toHaveLength(1);
      expect(updatedSets[0]?.values).toMatchObject({ status: "failed" });
    });

    it("escalates with propertyName:null when getIssueProjectName rejects — approval still created, issue blocked, watch terminal", async () => {
      const now = new Date("2026-06-29T12:00:00Z");
      const watch = makeWatch({
        deadlineAt: new Date(now.getTime() + 60 * 60_000), // far future deadline
        fixAttempts: 8, // >= MAX_FIX_WAKES → escalation path
      });
      const { db, updatedSets } = createFakeDb([[watch]]);
      const { deps, createApproval, linkManyForApproval, updateIssue } = makeDeps(db, null);
      const depsCopy = {
        ...deps,
        getIssueProjectName: vi.fn().mockRejectedValue(new Error("name lookup failed")),
      };
      mockPoll.mockResolvedValue("failure");

      const svc = createDeploymentWatch(depsCopy as any); // eslint-disable-line @typescript-eslint/no-explicit-any
      await expect(svc.tick(now)).resolves.toBeDefined();

      // Approval must still be created despite name lookup failure
      expect(createApproval).toHaveBeenCalledOnce();
      const approvalData = createApproval.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(approvalData).toMatchObject({ type: "deploy_failed_review", status: "pending" });
      expect((approvalData["payload"] as Record<string, unknown>)).toMatchObject({
        issueId: "issue-1",
        propertyName: null,
      });

      // Issue blocked
      expect(updateIssue).toHaveBeenCalledWith("issue-1", { status: "blocked" });
      // Issues linked
      expect(linkManyForApproval).toHaveBeenCalledWith("approval-1", ["issue-1"]);
      // Watch marked failed
      expect(updatedSets[0]?.values).toMatchObject({ status: "failed" });
    });

    it("does not throw when poll throws for one watch; leaves it watching; still processes other due watches", async () => {
      const now = new Date("2026-06-29T12:00:00Z");
      const watch1 = makeWatch({
        id: "watch-1",
        issueId: "issue-1",
        deadlineAt: new Date(now.getTime() + 10 * 60_000),
      });
      const watch2 = makeWatch({
        id: "watch-2",
        issueId: "issue-2",
        deadlineAt: new Date(now.getTime() + 10 * 60_000),
      });
      const { db, updatedSets } = createFakeDb([[watch1, watch2]]);
      const { deps, addComment } = makeDeps(db, null);

      // First watch throws; second succeeds
      mockPoll
        .mockRejectedValueOnce(new Error("GitHub unreachable"))
        .mockResolvedValueOnce("success");

      const svc = createDeploymentWatch(deps);
      // Must not throw
      const result = await expect(svc.tick(now)).resolves.toEqual({
        live: 1,
        delayed: 0,
        failed: 0,
      });

      // Only watch2 was updated (to live)
      expect(updatedSets).toHaveLength(1);
      expect(updatedSets[0]?.values).toMatchObject({ status: "live" });

      // addComment called once (for watch2), not for watch1
      expect(addComment).toHaveBeenCalledOnce();
      expect(addComment).toHaveBeenCalledWith(
        "issue-2",
        LIVE_BODY("https://example.com"),
        {},
        { authorType: "system", presentation: { kind: "system_notice", tone: "success", detailsDefaultOpen: false } },
      );
    });
  });
});
