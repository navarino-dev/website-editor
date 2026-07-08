import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateAndGate } from "../services/safety-gate.js";

const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  createChild: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/safety-gate.js", () => ({
  evaluateAndGate: vi.fn(async () => ({ gated: false })),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
  }),
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  approvalService: () => ({}),
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

function makeIssue(id: string, status: string, assigneeAgentId: string | null = null) {
  return {
    id,
    companyId: "company-1",
    identifier: "PAP-100",
    title: "Test issue",
    description: null,
    status,
    priority: "medium",
    parentId: null,
    assigneeAgentId,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
  };
}

async function createUserApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

async function createAgentApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId: "company-1",
      companyIds: ["company-1"],
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue create gate atomicity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(evaluateAndGate).mockResolvedValue({ gated: false } as any);

    mockIssueService.getById.mockResolvedValue(null);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);

    mockIssueService.create.mockImplementation(async (_companyId: string, data: Record<string, unknown>) =>
      makeIssue("issue-1", String(data.status ?? "backlog"), (data.assigneeAgentId as string | null) ?? null));

    mockIssueService.update.mockImplementation(async (_id: string, data: Record<string, unknown>) =>
      makeIssue("issue-1", String(data.status ?? "todo"), null));
  });

  describe("gated user-authored issue", () => {
    it("creates issue as backlog, does not promote, does not wake, returns blocked status", async () => {
      vi.mocked(evaluateAndGate).mockResolvedValueOnce({
        gated: true,
        score: { score: 8, degraded: false },
        approvalId: "approval-1",
      } as any);

      // Simulate the gate having written "blocked" to the DB; the re-fetch should pick this up.
      mockIssueService.getById.mockResolvedValueOnce(makeIssue("issue-1", "blocked"));

      const app = await createUserApp();
      const res = await request(app)
        .post("/api/companies/company-1/issues")
        .send({ title: "Gated work", status: "todo" });

      expect(res.status).toBe(201);

      // svc.create must be called with backlog (the safety hold)
      expect(mockIssueService.create).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ status: "backlog" }),
      );

      // must NOT promote (svc.update must not be called at all)
      expect(mockIssueService.update).not.toHaveBeenCalled();

      // evaluateAndGate must receive the INTENDED status ("todo"), not the safety-hold "backlog",
      // so that on admin approval the gate restores priorStatus = "todo" (not "backlog").
      expect(evaluateAndGate).toHaveBeenCalledWith(
        expect.objectContaining({
          issue: expect.objectContaining({ status: "todo" }),
        }),
        expect.anything(),
      );

      // must NOT wake the agent
      expect(mockWakeup).not.toHaveBeenCalled();

      // response must reflect the real DB status set by the gate, not the stale in-memory "backlog"
      expect(res.body.status).toBe("blocked");
    });
  });

  describe("cleared user-authored issue", () => {
    it("creates as backlog, promotes to intended status, then wakes", async () => {
      vi.mocked(evaluateAndGate).mockResolvedValueOnce({ gated: false } as any);

      const assigneeAgentId = "22222222-2222-4222-8222-222222222222";
      mockIssueService.create.mockImplementationOnce(async (_cid: string, data: Record<string, unknown>) =>
        makeIssue("issue-1", String(data.status ?? "backlog"), assigneeAgentId));
      mockIssueService.update.mockImplementationOnce(async (_id: string, data: Record<string, unknown>) =>
        makeIssue("issue-1", String(data.status ?? "todo"), assigneeAgentId));

      const app = await createUserApp();
      const res = await request(app)
        .post("/api/companies/company-1/issues")
        .send({ title: "Cleared work", status: "todo" });

      expect(res.status).toBe(201);

      // svc.create called with backlog hold
      expect(mockIssueService.create).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ status: "backlog" }),
      );

      // svc.update called to promote to intended status
      expect(mockIssueService.update).toHaveBeenCalledWith(
        "issue-1",
        expect.objectContaining({ status: "todo" }),
      );

      // wakeup fired (with promoted issue that has assignee)
      expect(mockWakeup).toHaveBeenCalledWith(
        assigneeAgentId,
        expect.objectContaining({
          source: "assignment",
          reason: "issue_assigned",
        }),
      );

      // response reflects final promoted status
      expect(res.body).toMatchObject({ status: "todo" });
    });
  });

  describe("agent-authored issue", () => {
    it("creates with normal status, skips safety hold and promotion", async () => {
      const app = await createAgentApp();
      const res = await request(app)
        .post("/api/companies/company-1/issues")
        .send({ title: "Agent work", status: "todo" });

      expect(res.status).toBe(201);

      // svc.create must NOT be forced to backlog for agent actors
      expect(mockIssueService.create).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ status: "todo" }),
      );

      // evaluateAndGate must NOT be called for agent actors
      expect(evaluateAndGate).not.toHaveBeenCalled();

      // svc.update must NOT be called for promotion
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });
  });
});
