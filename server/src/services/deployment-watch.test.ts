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
  } = {},
) {
  const addComment = vi.fn().mockResolvedValue(undefined);
  const logActivity = vi.fn().mockResolvedValue(undefined);
  const getToken = vi.fn().mockReturnValue("gh-token");
  const getIssueAssignee = options.getIssueAssignee ?? vi.fn().mockResolvedValue(null);
  const wakeAgent = options.wakeAgent ?? vi.fn().mockResolvedValue(undefined);

  const deps = {
    db: db as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    issuesSvc: { addComment },
    projectsSvc: {
      getById: vi.fn().mockResolvedValue(projectResult),
    },
    logActivity,
    getToken,
    getIssueAssignee,
    wakeAgent,
  };

  return { deps, addComment, logActivity, getIssueAssignee, wakeAgent };
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
      const deps = {
        db: db as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        issuesSvc: { addComment: vi.fn().mockResolvedValue(undefined) },
        projectsSvc: {
          getById: vi.fn().mockRejectedValue(new Error("DB connection lost")),
        },
        logActivity: vi.fn().mockResolvedValue(undefined),
        getToken: vi.fn().mockReturnValue("gh-token"),
        getIssueAssignee: vi.fn().mockResolvedValue(null),
        wakeAgent: vi.fn().mockResolvedValue(undefined),
      };
      const svc = createDeploymentWatch(deps);

      await expect(
        svc.onIssueDone({ id: "issue-1", companyId: "company-1", projectId: "project-1" }),
      ).resolves.toBeUndefined();
    });

    it("resolves (does not throw) when issuesSvc.addComment rejects", async () => {
      // select returns [] (no existing watch), insert resolves, but addComment rejects
      const { db } = createFakeDb([[]]);
      const deps = {
        db: db as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        issuesSvc: {
          addComment: vi.fn().mockRejectedValue(new Error("comment service unavailable")),
        },
        projectsSvc: {
          getById: vi.fn().mockResolvedValue({
            productionUrl: "https://example.com",
            codebase: { repoUrl: "https://github.com/org/repo" },
          }),
        },
        logActivity: vi.fn().mockResolvedValue(undefined),
        getToken: vi.fn().mockReturnValue("gh-token"),
        getIssueAssignee: vi.fn().mockResolvedValue(null),
        wakeAgent: vi.fn().mockResolvedValue(undefined),
      };
      const svc = createDeploymentWatch(deps);

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
      const { deps, addComment } = makeDeps(db, null);
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
    });

    it("posts the delayed comment and sets status=delayed when past deadline with pending state", async () => {
      const now = new Date("2026-06-29T12:00:00Z");
      // deadlineAt is in the past relative to now
      const watch = makeWatch({ deadlineAt: new Date(now.getTime() - 1) });
      const { db, updatedSets } = createFakeDb([[watch]]);
      const { deps, addComment } = makeDeps(db, null);
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
    });

    it("posts the failed comment, calls logActivity, and sets status=failed on deploy failure at cap (fixAttempts >= 3)", async () => {
      const now = new Date("2026-06-29T12:00:00Z");
      const watch = makeWatch({ deadlineAt: new Date(now.getTime() + 10 * 60_000), fixAttempts: 3 });
      const { db, updatedSets } = createFakeDb([[watch]]);
      const { deps, addComment, logActivity, wakeAgent } = makeDeps(db, null);
      mockPoll.mockResolvedValue("failure");

      const svc = createDeploymentWatch(deps);
      const result = await svc.tick(now);

      expect(result).toEqual({ live: 0, delayed: 0, failed: 1 });
      expect(wakeAgent).not.toHaveBeenCalled();
      expect(addComment).toHaveBeenCalledOnce();
      expect(addComment).toHaveBeenCalledWith(
        "issue-1",
        FAILED_BODY,
        {},
        { authorType: "system", presentation: { kind: "system_notice", tone: "danger", detailsDefaultOpen: false } },
      );
      expect(logActivity).toHaveBeenCalledOnce();
      expect(logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "company-1",
          actorType: "system",
          action: "deployment.failed",
          entityType: "issue",
          entityId: "issue-1",
        }),
      );
      expect(updatedSets[0]?.values).toMatchObject({ status: "failed" });
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
