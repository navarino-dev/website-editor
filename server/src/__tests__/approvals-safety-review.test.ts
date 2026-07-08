import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  update: vi.fn(),
  addComment: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));
}

async function createApp(actorOverrides: Record<string, unknown> = {}) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const pendingSafetyApproval = {
  id: "approval-safety-1",
  companyId: "company-1",
  type: "safety_review_required",
  status: "pending",
  payload: { priorStatus: "todo", score: 8 },
  requestedByAgentId: "agent-1",
};

const blockedIssue = {
  id: "issue-blocked-1",
  status: "blocked",
  assigneeAgentId: "agent-1",
};

describe("safety-review approval routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();

    mockApprovalService.getById.mockResolvedValue(pendingSafetyApproval);
    mockApprovalService.approve.mockResolvedValue({
      approval: { ...pendingSafetyApproval, status: "approved" },
      applied: true,
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: { ...pendingSafetyApproval, status: "rejected" },
      applied: true,
    });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([blockedIssue]);
    mockIssueService.update.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockLogActivity.mockResolvedValue(undefined);
  });

  describe("operator actor (role: operator, not instance admin)", () => {
    const operatorOverrides = {
      source: "session",
      isInstanceAdmin: false,
      memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
    };

    it("returns 403 on approve", async () => {
      const app = await createApp(operatorOverrides);
      const res = await request(app).post("/api/approvals/approval-safety-1/approve").send({});
      expect(res.status).toBe(403);
      expect(mockApprovalService.approve).not.toHaveBeenCalled();
    });

    it("returns 403 on reject", async () => {
      const app = await createApp(operatorOverrides);
      const res = await request(app).post("/api/approvals/approval-safety-1/reject").send({});
      expect(res.status).toBe(403);
      expect(mockApprovalService.reject).not.toHaveBeenCalled();
    });
  });

  describe("admin actor (role: admin) — approve", () => {
    const adminOverrides = {
      source: "session",
      isInstanceAdmin: false,
      memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }],
    };

    it("returns 200 and restores issue status to priorStatus", async () => {
      const app = await createApp(adminOverrides);
      const res = await request(app).post("/api/approvals/approval-safety-1/approve").send({});
      expect(res.status).toBe(200);
      expect(mockApprovalService.approve).toHaveBeenCalledOnce();
      expect(mockIssueService.update).toHaveBeenCalledWith(blockedIssue.id, { status: "todo" });
    });

    it("posts a system_notice success card on the issue", async () => {
      const app = await createApp(adminOverrides);
      await request(app).post("/api/approvals/approval-safety-1/approve").send({});
      expect(mockIssueService.addComment).toHaveBeenCalledWith(
        blockedIssue.id,
        expect.stringContaining("Safety review approved"),
        {},
        expect.objectContaining({
          authorType: "system",
          presentation: expect.objectContaining({
            kind: "system_notice",
            tone: "success",
            title: "Safety review approved",
          }),
        }),
      );
    });

    it("does not update status if issue is not blocked", async () => {
      mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
        { ...blockedIssue, status: "in_progress" },
      ]);
      const app = await createApp(adminOverrides);
      await request(app).post("/api/approvals/approval-safety-1/approve").send({});
      expect(mockIssueService.update).not.toHaveBeenCalled();
      expect(mockIssueService.addComment).toHaveBeenCalled();
    });
  });

  describe("admin actor (role: admin) — reject", () => {
    const adminOverrides = {
      source: "session",
      isInstanceAdmin: false,
      memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }],
    };

    it("returns 200 and does NOT change issue status", async () => {
      const app = await createApp(adminOverrides);
      const res = await request(app).post("/api/approvals/approval-safety-1/reject").send({});
      expect(res.status).toBe(200);
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("posts a system_notice danger card on the issue", async () => {
      const app = await createApp(adminOverrides);
      await request(app).post("/api/approvals/approval-safety-1/reject").send({});
      expect(mockIssueService.addComment).toHaveBeenCalledWith(
        blockedIssue.id,
        expect.stringContaining("Safety review declined"),
        {},
        expect.objectContaining({
          authorType: "system",
          presentation: expect.objectContaining({
            kind: "system_notice",
            tone: "danger",
            title: "Safety review declined",
          }),
        }),
      );
    });
  });

  describe("instance admin actor — approve", () => {
    const instanceAdminOverrides = {
      source: "session",
      isInstanceAdmin: true,
    };

    it("returns 200 and restores issue status", async () => {
      const app = await createApp(instanceAdminOverrides);
      const res = await request(app).post("/api/approvals/approval-safety-1/approve").send({});
      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(blockedIssue.id, { status: "todo" });
    });
  });

  describe("deploy_failed_review approval routes", () => {
    const pendingDeployFailedApproval = {
      id: "approval-deploy-1",
      companyId: "company-1",
      type: "deploy_failed_review",
      status: "pending",
      payload: { issueId: "issue-blocked-1", propertyName: "Test Property", reason: "the deploy kept failing", attempts: 8 },
      requestedByAgentId: null,
    };

    const blockedIssueWithAssignee = {
      id: "issue-blocked-1",
      status: "blocked",
      assigneeAgentId: "editor-agent-1",
    };

    beforeEach(() => {
      mockApprovalService.getById.mockResolvedValue(pendingDeployFailedApproval);
      mockApprovalService.approve.mockResolvedValue({
        approval: { ...pendingDeployFailedApproval, status: "approved" },
        applied: true,
      });
      mockApprovalService.reject.mockResolvedValue({
        approval: { ...pendingDeployFailedApproval, status: "rejected" },
        applied: true,
      });
      mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([blockedIssueWithAssignee]);
    });

    it("approving a blocked issue sets it to in_progress", async () => {
      const app = await createApp();
      const res = await request(app).post("/api/approvals/approval-deploy-1/approve").send({});
      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(blockedIssueWithAssignee.id, { status: "in_progress" });
    });

    it("approving posts a success system comment on the issue", async () => {
      const app = await createApp();
      await request(app).post("/api/approvals/approval-deploy-1/approve").send({});
      expect(mockIssueService.addComment).toHaveBeenCalledWith(
        blockedIssueWithAssignee.id,
        expect.stringContaining("Republishing approved"),
        {},
        expect.objectContaining({
          authorType: "system",
          presentation: expect.objectContaining({
            kind: "system_notice",
            tone: "success",
            title: "Republishing approved",
          }),
        }),
      );
    });

    it("approving wakes the assignee agent with reason deploy_failed and the issueId", async () => {
      const app = await createApp();
      await request(app).post("/api/approvals/approval-deploy-1/approve").send({});
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        "editor-agent-1",
        expect.objectContaining({
          reason: "deploy_failed",
          payload: expect.objectContaining({ issueId: blockedIssueWithAssignee.id }),
        }),
      );
    });

    it("rejecting leaves the issue blocked (update not called)", async () => {
      const app = await createApp();
      const res = await request(app).post("/api/approvals/approval-deploy-1/reject").send({});
      expect(res.status).toBe(200);
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("rejecting posts a set-aside warning comment on the issue", async () => {
      const app = await createApp();
      await request(app).post("/api/approvals/approval-deploy-1/reject").send({});
      expect(mockIssueService.addComment).toHaveBeenCalledWith(
        blockedIssueWithAssignee.id,
        expect.stringContaining("Republishing set aside"),
        {},
        expect.objectContaining({
          authorType: "system",
          presentation: expect.objectContaining({
            kind: "system_notice",
            tone: "warning",
            title: "Republishing set aside",
          }),
        }),
      );
    });

    it("rejecting does not wake any agent", async () => {
      const app = await createApp();
      await request(app).post("/api/approvals/approval-deploy-1/reject").send({});
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });
  });

  describe("non-safety approval type — not gated", () => {
    it("allows operator to approve a hire_agent approval without 403", async () => {
      mockApprovalService.getById.mockResolvedValue({
        id: "approval-hire-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "pending",
        payload: {},
        requestedByAgentId: null,
      });
      mockApprovalService.approve.mockResolvedValue({
        approval: {
          id: "approval-hire-1",
          companyId: "company-1",
          type: "hire_agent",
          status: "approved",
          payload: {},
          requestedByAgentId: null,
        },
        applied: true,
      });
      mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);

      const app = await createApp({
        source: "session",
        isInstanceAdmin: false,
        memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
      });
      const res = await request(app).post("/api/approvals/approval-hire-1/approve").send({});
      expect(res.status).toBe(200);
      expect(mockIssueService.update).not.toHaveBeenCalled();
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
    });
  });
});
