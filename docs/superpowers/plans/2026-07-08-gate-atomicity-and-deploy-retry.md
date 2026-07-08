# Gate Atomicity + Deploy-Failure Retry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** (1) Make the safety gate atomic so a gated change request's issue is never worked by an agent until an admin approves; (2) when a Vercel deploy fails, re-engage the Editor to fix it and retry until it succeeds (production side) and have the Editor verify its own preview build before asking for review (preview side).

**Architecture:** Fix 1 closes a race: today the create route inserts the issue in an assignable state (`todo`) and *then* runs the ~2s safety scorer, so the Editor is dispatched during scoring and the `blocked` status lands too late. We instead create user-submitted change requests in a non-assignable **hold** state (`backlog`), score, then promote to the intended status on clear or leave `blocked` on gate — plus a defense-in-depth check at run-claim that refuses to start a run for an issue with a pending `safety_review_required` approval. Fix 2 wires the heartbeat into the deployment watcher so a failed production deploy wakes the assignee with the error and retries (capped), and updates the Editor instructions to verify/fix the preview build before review.

**Tech stack:** TypeScript ESM monorepo; Drizzle (one new column + migration); Vitest.

## Global Constraints

- **Hold status = `backlog`** for the gate — confirmed non-assignable by every dispatch path: `queueIssueAssignmentWakeup` early-returns for `backlog` (`server/src/services/issue-assignment-wakeup.ts:31`) and the issue-monitor query only selects `in_progress`/`in_review` (`server/src/services/heartbeat.ts:3295`).
- **Gate hold applies only to user-authored creates** (`actor.actorType === "user"`), the same condition that already guards the gate call. Agent/system creates are unchanged.
- **Never wake the Editor for a gated or held issue.** The wakeup fires only on the cleared path (after promotion) or on admin approval (existing approve handler).
- **Retry cap = 3** deploy-fix attempts; then escalate (terminal `failed` + a clear human-facing message). Preview build handled in the Editor's own run (editor.md).
- **Fail-safe:** all new gate/deploy paths must not crash the request/tick — wrap in try/catch consistent with existing code (the create gate already fail-closes to gated on error).
- **Plain-English PM copy** in any new comments (no jargon), consistent with `agent-instructions/editor.md` tone.
- **Contracts synced** across db → shared (if a type is touched) → server in the same change.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `server/src/routes/issues.ts` | Create route: hold-then-gate (create `backlog`, promote on clear) | 1 |
| `server/src/services/heartbeat.ts` | `claimQueuedRun`: refuse run-start when a pending safety approval is linked | 2 |
| `packages/db/src/schema/deployment_watches.ts` (+ migration) | Add `fixAttempts` column | 3 |
| `server/src/services/deployment-watch.ts` | Failure → wake assignee + retry cap + escalate | 4 |
| `server/src/index.ts` | Wire the new deploy-watch deps (assignee lookup + heartbeat wakeup) | 4 |
| `agent-instructions/editor.md` | Verify/fix preview build before review; handle `deploy_failed` wake | 5 |
| Tests alongside each | Vitest coverage | 1–4 |

**Verified anchors:**
- Create handler `server/src/routes/issues.ts:3506` (`router.post("/companies/:companyId/issues", applyCreateIssueStatusDefault, validate(createIssueSchema), ...)`); `svc.create` at ~3530; gate block ~3589–3616; `if (!safetyGated) queueIssueAssignmentWakeup(...)` ~3623–3633. `applyCreateIssueStatusDefault` (165) sets `req.body.status`.
- `queueIssueAssignmentWakeup(input)` (`server/src/services/issue-assignment-wakeup.ts:21`) — early-returns if `!assigneeAgentId || status === "backlog"`.
- `evaluateAndGate` (`server/src/services/safety-gate.ts:38`) — on gated: create approval → link → `issuesSvc.update(id,{status:"blocked"})`; returns `{ gated, score, approvalId? }`. (Unchanged by this plan; the route handles promotion on clear.)
- `claimQueuedRun` (`server/src/services/heartbeat.ts:5969-6104`) — atomic run checkout; already checks `treeControlSvc.getActivePauseHoldGate` (~5993) and staleness (~6033) before the atomic status update to `running` (~6045).
- `issueApprovalService` / `approvalService` are already instantiated in the relevant modules; a "pending safety approval for issue X" query joins `issue_approvals` → `approvals` (`type='safety_review_required'`, `status='pending'`).
- `deploymentWatches` schema (`packages/db/src/schema/deployment_watches.ts`) — statuses `watching|live|delayed|failed`, `attempts int default 0`, `startedAt/deadlineAt/nextCheckAt`.
- `deployment-watch.ts` failure branch (154–168): posts `FAILED_BODY`, logs `deployment.failed`, sets `status='failed'`. `DeploymentWatchDeps` (25–47) has NO heartbeat/assignee access. Tick wired in `server/src/index.ts:802` on `config.heartbeatSchedulerIntervalMs`.
- Editor instructions: `agent-instructions/editor.md` (repo root; deployed to `/opt/paperclip/agent-instructions/editor.md`, the Editor's `adapter_config.instructionsFilePath`).

---

## Task 1: Gate atomicity — hold-then-gate in the issue-create route

**Files:** Modify `server/src/routes/issues.ts` (create handler). Test: the create route suite (`server/src/__tests__/` — mirror an existing issue-create route test that already mocks `../services/safety-gate.js`).

**Interfaces:**
- Consumes: `evaluateAndGate` (returns `{ gated, score, approvalId? }`), `svc.create`, `svc.update`, `queueIssueAssignmentWakeup`, `getActorInfo`.
- Produces: user-authored change requests are created `backlog`; cleared → promoted to the intended status + woken; gated → `blocked` + approval, never woken.

- [ ] **Step 1: Write the failing tests**

In a create-route test that mocks `evaluateAndGate`, add cases (mirror the file's existing harness + the `vi.mock("../services/safety-gate.js", …)` pattern):
- **Gated:** mock `evaluateAndGate` → `{ gated: true, score: { score: 8 } }`. POST a user-authored issue. Assert: the created issue's final status is **not** `todo`/`backlog` that would be assignable — i.e. the response/db issue is `blocked` (the mock's gate sets blocked in real code; since the gate is mocked here, assert instead that `queueIssueAssignmentWakeup` was **not** called and `svc.update` was **not** asked to promote to `todo`). Assert `svc.create` was called with `status: "backlog"` for the user actor.
- **Cleared:** mock `evaluateAndGate` → `{ gated: false }`. POST a user-authored issue (no explicit status → default `todo`). Assert: `svc.update(issueId, { status: "todo" })` was called (promotion) and `queueIssueAssignmentWakeup` fired.
- **Agent-authored:** POST as an agent actor. Assert `svc.create` was **not** forced to `backlog` (created with the normal status) and the gate/promotion path is skipped.

(Use the existing test's mock of `services/index.js` / `svc`; assert via the mocked `svc.create`/`svc.update` and the mocked `queueIssueAssignmentWakeup` or the `heartbeat` wakeup mock the file already uses.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @paperclipai/server exec vitest run <the create-route test file>`
Expected: FAIL (no backlog hold / promotion yet).

- [ ] **Step 3: Implement the hold-then-gate**

In the create handler, capture the intended status and hold user creates in `backlog` before `svc.create`:

```ts
    const actor = getActorInfo(req);
    // Hold user-submitted change requests in a non-assignable state until the
    // safety gate decides, so no agent can be dispatched during scoring.
    const intendedStatus = typeof req.body.status === "string" ? req.body.status : "todo";
    const holdForSafety = actor.actorType === "user";
    // ... existing executionPolicy / assert lines ...
    const issue = await svc.create(companyId, {
      ...req.body,
      status: holdForSafety ? "backlog" : req.body.status,
      executionPolicy,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      // ...rest unchanged...
    });
```

Then, in the post-gate section, replace the `if (!safetyGated) { queueIssueAssignmentWakeup(...) }` block so the cleared path **promotes** the held issue and wakes with the promoted issue; the gated path leaves it blocked:

```ts
    let finalIssue = issue;
    if (!safetyGated) {
      // Cleared (or agent-authored): promote out of the safety hold, then wake.
      if (holdForSafety && issue.status === "backlog") {
        finalIssue = (await svc.update(issue.id, { status: intendedStatus })) ?? { ...issue, status: intendedStatus };
      }
      void queueIssueAssignmentWakeup({
        heartbeat,
        issue: finalIssue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "issue.create",
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
      });
    }
    // gated: the gate already set status "blocked" + created the approval; do not promote or wake.

    res.status(201).json({
      ...finalIssue,
      relatedWork: referenceSummary,
      referencedIssueIdentifiers: referenceSummary.outbound.map((item) => item.issue.identifier ?? item.issue.id),
    });
```

Notes for the implementer: confirm `svc.update` returns the updated issue (it does — used by Task 7 of the safety feature). Keep the `evaluateAndGate` call and its `logActivity("issue.safety_gated")` exactly as-is. The gate reads `issue.status` (now `backlog` for user creates) — that's fine; the gated path overwrites to `blocked`, the cleared path is promoted by the route.

- [ ] **Step 4: Run tests to verify they pass**

Run the create-route test file; expected PASS. Then run the broader create/comment route suites the safety feature touched and fix any that assumed immediate `todo` (they should still pass since promotion is synchronous). If an existing test breaks, adjust only its assertion to the new (correct) final status.

- [ ] **Step 5: Typecheck + commit**

`pnpm --filter @paperclipai/server typecheck` (pre-existing plugin-sdk dist errors are not yours).
```bash
git add server/src/routes/issues.ts server/src/__tests__/<test file>
git commit -m "fix(server): hold user issues in backlog until the safety gate clears (close dispatch race)"
```

---

## Task 2: Defense-in-depth — refuse run-start for issues with a pending safety approval

**Files:** Modify `server/src/services/heartbeat.ts` (`claimQueuedRun`, ~5969–6104). Test: a focused unit test for the new guard (extract a small pure helper if the function is hard to unit-test; otherwise a targeted heartbeat test mirroring existing ones).

**Interfaces:**
- Consumes: the DB + an approvals/issue-approvals lookup (a query: is there a `safety_review_required` approval with `status='pending'` linked to this issue?).
- Produces: `claimQueuedRun` does not transition a run to `running` for an issue that has a pending safety approval; it defers (same shape as the existing pause-hold-gate deferral at ~5993).

- [ ] **Step 1: Write the failing test**

Add a helper `hasPendingSafetyApproval(db, issueId): Promise<boolean>` (in a small testable module, e.g. `server/src/services/safety-gate.ts` or a new `safety-hold.ts`) that runs the join query. Write a unit test with a fake db/query returning a pending `safety_review_required` row → `true`; none → `false`; a non-pending (approved/rejected) row → `false`.

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @paperclipai/server exec vitest run <helper test>` → FAIL (helper not defined).

- [ ] **Step 3: Implement the helper + wire it into `claimQueuedRun`**

Implement `hasPendingSafetyApproval` (join `issue_approvals` → `approvals` where `type='safety_review_required' AND status='pending' AND issue_approvals.issue_id = :issueId`, `limit 1`). In `claimQueuedRun`, alongside the existing `getActivePauseHoldGate` check (~5993) and **before** the atomic status update to `running` (~6045), add: if `await hasPendingSafetyApproval(db, issueId)` → treat as a deferral exactly like an active pause-hold-gate (do not claim; reschedule/skip per the existing gate-deferral branch). Read the existing pause-hold-gate deferral to mirror its return/reschedule shape precisely.

- [ ] **Step 4: Run tests to verify pass.** Helper test + the existing heartbeat suites that cover `claimQueuedRun` (run the specific file(s), not the whole package). Expected PASS.

- [ ] **Step 5: Typecheck + commit**
```bash
git commit -m "fix(server): do not start an agent run while a safety review is pending (defense-in-depth)"
```

---

## Task 3: Add `fixAttempts` to deployment_watches (+ migration)

**Files:** Modify `packages/db/src/schema/deployment_watches.ts`; generate a migration. Test: none (schema-only; covered by Task 4).

- [ ] **Step 1: Add the column**

Add to the `deploymentWatches` table: `fixAttempts: integer("fix_attempts").notNull().default(0),` (import `integer` if not already). This tracks how many times the Editor has been re-engaged to fix a failed deploy (distinct from `attempts`, which counts polls).

- [ ] **Step 2: Generate + inspect the migration**

Run: `pnpm db:generate`. **Inspect the new `packages/db/src/migrations/00NN_*.sql`** — it must contain ONLY `ALTER TABLE "deployment_watches" ADD COLUMN "fix_attempts" integer DEFAULT 0 NOT NULL;` (trim any unrelated drift the generator sweeps in, as was necessary for migration 0092 previously).

- [ ] **Step 3: Typecheck + commit**

`pnpm -r typecheck` (db + server).
```bash
git add packages/db/src/schema/deployment_watches.ts packages/db/src/migrations/
git commit -m "feat(db): add deployment_watches.fix_attempts for deploy-retry tracking"
```

---

## Task 4: Deploy failure → wake the Editor + retry (cap 3), then escalate

**Files:** Modify `server/src/services/deployment-watch.ts` (deps + failure branch) and `server/src/index.ts` (wire the deps). Test: `server/src/services/deployment-watch.test.ts` (extend the existing test).

**Interfaces:**
- Adds to `DeploymentWatchDeps`: `getIssueAssignee: (issueId: string) => Promise<string | null>` and `wakeAgent: (agentId: string, opts: { reason: string; payload?: Record<string, unknown>; contextSnapshot?: Record<string, unknown> }) => Promise<unknown>`.
- Behavior: on `state === "failure"`, if `w.fixAttempts < 3` → wake the assignee to fix (reason `"deploy_failed"`, payload `{ issueId, fixAttempt: w.fixAttempts + 1 }`), post an actionable comment, increment `fixAttempts`, and **keep the watch alive** (`status: "watching"`, `nextCheckAt: now + POLL_MS`, refreshed deadline) so the re-pushed deploy is re-checked; if `w.fixAttempts >= 3` → escalate (post the terminal human-facing message, log `deployment.failed`, set `status: "failed"`).

- [ ] **Step 1: Write the failing tests**

Extend `deployment-watch.test.ts` (fakes for db/issuesSvc/logActivity/getToken + the new `getIssueAssignee`/`wakeAgent`). Cases:
- **Failure under cap:** `getLatestProductionDeployStatus` stub → `"failure"`, watch `fixAttempts: 0`, assignee `"agentA"`. Assert: `wakeAgent("agentA", { reason: "deploy_failed", ... })` called; an actionable comment posted; watch updated to `status: "watching"`, `fixAttempts: 1`, `nextCheckAt` rescheduled. Not terminal.
- **Failure at cap:** watch `fixAttempts: 3`, state `"failure"`. Assert: NO wake; terminal comment posted; `logActivity(deployment.failed)`; `status: "failed"`.
- **Success still works:** state `"success"` → LIVE_BODY + `status: "live"` (unchanged).
- **No assignee:** state `"failure"`, `getIssueAssignee` → null, under cap → no wake (can't), but still increments/keeps watching (or escalates — assert the chosen behavior; recommend: post the comment, keep watching, don't crash).

- [ ] **Step 2: Run to verify fail.** `pnpm --filter @paperclipai/server exec vitest run src/services/deployment-watch.test.ts` → FAIL.

- [ ] **Step 3: Implement**

Add the two deps to `DeploymentWatchDeps`. Replace the `else if (state === "failure")` branch (154–168) with the retry-or-escalate logic above (use `POLL_MS`/`DEADLINE_MS`, and a fresh `deadlineAt: now + DEADLINE_MS` when keeping it watching so the retry has its own window). Actionable under-cap comment (PM-friendly, no jargon): `"That change ran into a snag while publishing. I'm fixing it and trying again."`; terminal message keeps the existing `FAILED_BODY`. Wake payload/context mirror how the approve handler wakes agents (`heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "deploy_failed", payload: {...}, contextSnapshot: {...} })`).

Then wire the deps in `server/src/index.ts` where `createDeploymentWatch({...})` is constructed: `getIssueAssignee` = a small query (`issues.assigneeAgentId` by id via the issues svc/db); `wakeAgent` = `(agentId, opts) => heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", requestedByActorType: "system", requestedByActorId: "system", ...opts })`.

- [ ] **Step 4: Run tests to verify pass.** The deployment-watch test file → PASS. Typecheck server.

- [ ] **Step 5: Commit**
```bash
git commit -m "feat(server): re-engage the Editor to fix and retry failed deploys (cap 3, then escalate)"
```

---

## Task 5: Editor instructions — verify/fix the preview build before review; handle deploy_failed

**Files:** Modify `agent-instructions/editor.md`. Test: none (agent prompt; verified by review + the smoke test after deploy).

- [ ] **Step 1: Update the First-Time and Adjustments flows**

In `agent-instructions/editor.md`, after pushing and getting the Vercel preview URL, add a **verify-the-build** step before posting for review:
- Check the PR's Vercel deployment status (the Vercel bot comment / the deployment status check). **Do not post the preview for review until the preview build has succeeded.**
- If the preview build **failed**: read the build error (from the Vercel check / logs via `gh`), fix the cause in the same branch, commit, push, and re-check — repeat until the preview build succeeds. Only then post the preview for review.
- Keep all PM-facing copy plain and friendly (no build/jargon terms), per the existing tone rules.

Add a new section **"When woken with reason `deploy_failed`"**: the production deploy for an approved change failed — read the error, fix it on the branch, push, and let the retry re-check; keep going until it deploys. (This is the production-side counterpart to the preview verification; the server wakes you with the error context.)

Add to **Rules**: "Never post a preview for review unless its build has succeeded. If a build fails, fix it and retry until it succeeds."

- [ ] **Step 2: Commit**
```bash
git add agent-instructions/editor.md
git commit -m "docs(editor): verify/fix the preview build before review; handle deploy_failed retries"
```

---

## Final Verification (before deploy)

- [ ] `pnpm -r typecheck` passes (modulo the known pre-existing plugin-sdk dist artifact — resolve by building first if needed).
- [ ] Targeted suites pass: the create-route test, the claim-guard test, `deployment-watch.test.ts`.
- [ ] `pnpm test:run` — whole repo green except the known pre-existing `server-startup-feedback-export.test.ts` failure.
- [ ] Migration present under `packages/db/src/migrations/` and contains only the `fix_attempts` column add.

## Deploy (established pipeline)

- Merge to `master`, push to the `navarino-dev` fork (`gh auth switch --user navarino-dev` first — it reverts), then on the box (`root@5.161.125.124`): `cd /opt/paperclip && git pull --ff-only && cd docker && docker compose --env-file .env.production -f docker-compose.production.yml up -d --build`. The migration auto-applies on boot (`PAPERCLIP_MIGRATION_AUTO_APPLY=true`). **Also update the Editor instructions on the box** — `agent-instructions/editor.md` is tracked, so `git pull` updates it; confirm the box's copy isn't locally modified (there were `.prebak` files) and reconcile if so.
- **Smoke test:** submit a high-risk PM request → issue holds (never worked) with a pending admin approval; approve it → the Editor resumes. Submit a normal request → clears and the Editor works. (Deploy-retry is exercised naturally on the next failing build.)
