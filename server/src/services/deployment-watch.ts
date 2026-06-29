// server/src/services/deployment-watch.ts
import { and, eq, lte } from "drizzle-orm";
import { deploymentWatches } from "@paperclipai/db";
import type { IssueCommentAuthorType, IssueCommentPresentation } from "@paperclipai/shared";
import type { LogActivityInput } from "./activity-log.js";
import { getLatestProductionDeployStatus } from "./github-deployments.js";

const POLL_MS = 15_000;
const DEADLINE_MS = 10 * 60_000;

const LIVE_BODY = (url: string) =>
  `✨ Your change is now live.\n\nLIVE_URL: ${url}`;

const PUBLISHING_BODY =
  "Publishing your change now — I'll share the live link here as soon as it's ready.";

const DELAYED_BODY =
  "This is taking a little longer than usual. It should be live shortly — check back soon.";

const FAILED_BODY =
  "We hit a snag publishing this change. The team has been notified.";

type Actor = { agentId?: string; userId?: string; runId?: string | null };

export interface DeploymentWatchDeps {
  db: {
    select: (fields?: unknown) => unknown;
    insert: (table: unknown) => { values: (row: unknown) => Promise<unknown> };
    update: (table: unknown) => { set: (values: unknown) => { where: (cond: unknown) => Promise<unknown> } };
  };
  issuesSvc: {
    addComment: (
      issueId: string,
      body: string,
      actor: Actor,
      options?: { authorType?: IssueCommentAuthorType | null; presentation?: IssueCommentPresentation | null },
    ) => Promise<unknown>;
  };
  projectsSvc: {
    getById: (id: string) => Promise<{
      productionUrl: string | null;
      codebase: { repoUrl: string | null };
    } | null>;
  };
  logActivity: (input: LogActivityInput) => Promise<unknown>;
  getToken: () => string | undefined;
}

const SYS_ACTOR: Actor = {};

function makePresentation(tone: IssueCommentPresentation["tone"]): IssueCommentPresentation {
  return { kind: "system_notice", tone, detailsDefaultOpen: false };
}

export function createDeploymentWatch(deps: DeploymentWatchDeps) {
  const post = (issueId: string, body: string, tone: IssueCommentPresentation["tone"]) =>
    deps.issuesSvc.addComment(issueId, body, SYS_ACTOR, {
      authorType: "system",
      presentation: makePresentation(tone),
    });

  async function onIssueDone(issue: {
    id: string;
    companyId: string;
    projectId: string | null;
  }): Promise<void> {
    if (!issue.projectId) return;
    const project = await deps.projectsSvc.getById(issue.projectId);
    const productionUrl = project?.productionUrl?.trim() ?? null;
    const repoUrl = project?.codebase.repoUrl ?? null;
    if (!productionUrl || !repoUrl) return;

    const now = new Date();
    const db = deps.db as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    // one active watch per issue
    const existing = await db
      .select({ id: deploymentWatches.id })
      .from(deploymentWatches)
      .where(
        and(
          eq(deploymentWatches.issueId, issue.id),
          eq(deploymentWatches.status, "watching"),
        ),
      );
    if (existing.length > 0) return;

    await db.insert(deploymentWatches).values({
      companyId: issue.companyId,
      issueId: issue.id,
      repoUrl,
      productionUrl,
      status: "watching",
      startedAt: now,
      deadlineAt: new Date(now.getTime() + DEADLINE_MS),
      nextCheckAt: now,
    });

    await post(issue.id, PUBLISHING_BODY, "info");
  }

  async function tick(
    now: Date,
  ): Promise<{ live: number; delayed: number; failed: number }> {
    const db = deps.db as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    const due: Array<{
      id: string;
      companyId: string;
      issueId: string;
      repoUrl: string;
      productionUrl: string;
      status: string;
      attempts: number;
      startedAt: Date;
      deadlineAt: Date;
      nextCheckAt: Date;
    }> = await db
      .select()
      .from(deploymentWatches)
      .where(
        and(
          eq(deploymentWatches.status, "watching"),
          lte(deploymentWatches.nextCheckAt, now),
        ),
      );

    let live = 0;
    let delayed = 0;
    let failed = 0;
    const token = deps.getToken();

    for (const w of due) {
      try {
        const state = token
          ? await getLatestProductionDeployStatus({
              repoUrl: w.repoUrl,
              token,
              sinceIso: w.startedAt.toISOString(),
            })
          : "pending";

        if (state === "success") {
          await post(w.issueId, LIVE_BODY(w.productionUrl), "success");
          await db
            .update(deploymentWatches)
            .set({ status: "live", updatedAt: now })
            .where(eq(deploymentWatches.id, w.id));
          live++;
        } else if (state === "failure") {
          await post(w.issueId, FAILED_BODY, "danger");
          await deps.logActivity({
            companyId: w.companyId,
            actorType: "system",
            actorId: "system",
            action: "deployment.failed",
            entityType: "issue",
            entityId: w.issueId,
          });
          await db
            .update(deploymentWatches)
            .set({ status: "failed", updatedAt: now })
            .where(eq(deploymentWatches.id, w.id));
          failed++;
        } else if (now >= w.deadlineAt) {
          await post(w.issueId, DELAYED_BODY, "warning");
          await db
            .update(deploymentWatches)
            .set({ status: "delayed", updatedAt: now })
            .where(eq(deploymentWatches.id, w.id));
          delayed++;
        } else {
          await db
            .update(deploymentWatches)
            .set({
              attempts: w.attempts + 1,
              nextCheckAt: new Date(now.getTime() + POLL_MS),
              updatedAt: now,
            })
            .where(eq(deploymentWatches.id, w.id));
        }
      } catch {
        // If polling throws (e.g. GitHub unreachable), skip this watch
        // and leave it in 'watching' so the next tick retries it.
      }
    }

    return { live, delayed, failed };
  }

  return { onIssueDone, tick };
}
