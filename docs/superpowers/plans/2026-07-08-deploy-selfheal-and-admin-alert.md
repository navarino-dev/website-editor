# Deploy Self-Heal + In-App Admin Escalation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make failed production deploys self-heal for as long as they're making progress (~30-min budget instead of 3 quick tries), and when they genuinely can't recover, raise a real, actionable **in-app admin alert** (never a silent give-up). Harden the Editor→Reviewer→redeploy handoff so the loop runs autonomously.

**Architecture:** The deploy watcher already re-engages the Editor on a failed production deploy (dedup via advancing `startedAt`, paced re-checks). This change (1) replaces the flat 3-attempt cap with a time-budget: keep retrying while within a 30-min window from the first failure (bounded by a hard wake cap), then escalate; (2) on escalate, in addition to the terminal PM comment, creates a linked `deploy_failed_review` approval (so it lands in the admin Inbox with a badge), sets the issue `blocked`, and posts the failure reason — guaranteeing the admin is alerted; (3) tightens the agent instructions so the Editor reliably hands to the Reviewer to re-merge (the only path that produces a new production deploy).

**Tech stack:** TS ESM monorepo; reuses the existing approvals infrastructure (no schema change — `fix_attempts` already exists); Vitest.

## Global Constraints

- **No new DB migration.** Reuse `deployment_watches.fix_attempts` (already added) + `approvals`/`issue_approvals` (existing).
- **Budget:** `FIX_BUDGET_MS = 30 * 60_000` from the FIRST failure; hard cap `MAX_FIX_WAKES = 8`. Escalate when `now >= <fix-deadline>` (with ≥1 failure) OR `fixAttempts >= MAX_FIX_WAKES`.
- **Escalation is guaranteed visible:** create + link a `deploy_failed_review` approval (admin Inbox), set the issue `blocked`, post the PM-friendly terminal comment. All three, wrapped so a failure of one doesn't crash the tick.
- **Reuse the safety-approval pattern** for the new type (constants → UI renderer → create/link) exactly as `safety_review_required` was done.
- **PM-facing copy stays plain** (no jargon); the admin alert can carry the technical reason in its payload (admins see it, not PMs).
- **Do not let the Editor merge** (the ABSOLUTE RULE stands); the Reviewer re-merges.
- Contracts synced db/shared ↔ server ↔ ui in the same change.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `packages/shared/src/constants.ts` | Add `"deploy_failed_review"` to `APPROVAL_TYPES` | 1 |
| `ui/src/components/ApprovalPayload.tsx` | Label/icon/`DeployFailedPayload` renderer | 1 |
| `server/src/services/deployment-watch.ts` | Budget retry + escalate-with-admin-alert; new deps | 2 |
| `server/src/index.ts` | Wire the new deps (`approvalsSvc`, `issueApprovalsSvc`, `issuesSvc.update`) | 2 |
| `agent-instructions/editor.md`, `reviewer.md` | Harden the deploy-fix → re-merge handoff | 3 |
| Tests alongside 1–2 | Vitest | 1–2 |

**Verified anchors:**
- `APPROVAL_TYPES` (`packages/shared/src/constants.ts:424`) currently ends with `"safety_review_required"`.
- `ApprovalPayload.tsx`: `typeLabel` record (~5–9), lucide icon map (~40–43, imports `UserPlus, Lightbulb, ShieldAlert, ShieldCheck`), payload dispatcher (`if (type === "...") return <XPayload .../>` chain ending in `CeoStrategyPayload` fallthrough ~241).
- `deployment-watch.ts`: `DeploymentWatchDeps` (25–49) has `db`, `issuesSvc.addComment`, `projectsSvc.getById`, `logActivity`, `getToken`, `getIssueAssignee(issueId, companyId)`, `wakeAgent(agentId, opts)`. Constants `POLL_MS=15_000`, `RETRY_POLL_MS=3*60_000`, `DEADLINE_MS=10*60_000`. Failure branch ~157–200: under-cap wakes + advances `startedAt` + increments `fixAttempts`; at-cap (`>=3`) escalates (FAILED_BODY + `deployment.failed` + `status:"failed"`). Per-watch `try/catch` wraps the branch.
- `approvalService(db).create(companyId, { type, requestedByAgentId, requestedByUserId, status, payload })` and `issueApprovalService(db).linkManyForApproval(approvalId, issueIds, actor)` — the safety gate uses these (`server/src/services/safety-gate.ts`). `issueService(db).update(id, { status })`.
- `index.ts:726` `heartbeat`; `createDeploymentWatch({...})` ~727.

---

## Task 1: `deploy_failed_review` approval type + UI renderer

**Files:** `packages/shared/src/constants.ts`; `ui/src/components/ApprovalPayload.tsx`. Tests: `packages/shared/src/__tests__/constants.test.ts` (extend), `ui/src/components/ApprovalPayload.test.tsx` (extend).

**Interfaces:** Produces the literal `"deploy_failed_review"` as a valid `ApprovalType`, consumed by Task 2 (create) and the admin Inbox rendering.

- [ ] **Step 1: Failing tests.** Add to `constants.test.ts`: `expect(APPROVAL_TYPES).toContain("deploy_failed_review")`. Add to `ApprovalPayload.test.tsx`: `approvalLabel("deploy_failed_review")` === `"Publishing Issue"`, and rendering `<ApprovalPayload type="deploy_failed_review" payload={{ propertyName: "Seaside Website", reason: "Build failed: missing import", attempts: 3 }} />` outputs text containing `"Seaside Website"` and `"Build failed: missing import"`.
- [ ] **Step 2: Run → fail.** `pnpm --filter @paperclipai/shared exec vitest run src/__tests__/constants.test.ts` and `pnpm --filter @paperclipai/ui exec vitest run src/components/ApprovalPayload.test.tsx`.
- [ ] **Step 3: Implement.**
  - `constants.ts`: append `"deploy_failed_review",` to `APPROVAL_TYPES`.
  - `ApprovalPayload.tsx`: add `deploy_failed_review: "Publishing Issue"` to `typeLabel`; add `deploy_failed_review: ShieldAlert` (already imported) to the icon map; add a `DeployFailedPayload` component reading `payload.propertyName` (string), `payload.reason` (string), `payload.attempts` (number) defensively, rendering the property, a short "Publishing failed — needs your attention" line, the reason, and the attempt count; wire `if (type === "deploy_failed_review") return <DeployFailedPayload payload={payload} />;` before the fallthrough. Match the neighboring components' Tailwind conventions.
  - Build shared: `pnpm --filter @paperclipai/shared build` (so server/ui see the new type).
- [ ] **Step 4: Run → pass.** Both test files. `pnpm --filter @paperclipai/ui typecheck`.
- [ ] **Step 5: Commit.** `git commit -m "feat: add deploy_failed_review approval type + admin renderer"`

---

## Task 2: Budget-based retry + escalate-with-admin-alert in the deploy watcher

**Files:** `server/src/services/deployment-watch.ts`, `server/src/index.ts`. Test: `server/src/services/deployment-watch.test.ts` (extend).

**Interfaces:**
- Adds to `DeploymentWatchDeps`: `issuesSvc.update(issueId, data): Promise<unknown>`; `approvalsSvc.create(companyId, data): Promise<{ id: string }>`; `issueApprovalsSvc.linkManyForApproval(approvalId, issueIds, actor?): Promise<unknown>`; and a way to get the property name for the alert payload — reuse `projectsSvc.getById` (already a dep) to read the project name (add `name` to its return type) OR pass the issue's project name via a new `getProjectName` — prefer extending `projectsSvc.getById`'s typed return with `name: string | null`.
- Constants: `FIX_BUDGET_MS = 30 * 60_000`, `MAX_FIX_WAKES = 8`.

- [ ] **Step 1: Failing tests** (extend `deployment-watch.test.ts`, mirror its fakes; add fakes for the new deps):
  - **First failure sets the fix budget:** state `"failure"`, watch `fixAttempts:0`, `deadlineAt` = the initial (short) value. Assert: assignee woken; watch updated with `fixAttempts:1`, `startedAt` advanced, `deadlineAt` = now+FIX_BUDGET_MS (≈30 min), `nextCheckAt` = now+RETRY_POLL_MS; NOT escalated (no approval created, issue not blocked).
  - **Subsequent failure within budget keeps retrying:** `fixAttempts:2`, `deadlineAt` in the future. Assert: woken, `fixAttempts:3`, still watching, `deadlineAt` unchanged (not refreshed), no escalation.
  - **Budget exceeded → escalate:** `fixAttempts:2`, `deadlineAt` in the PAST (now >= deadline). Assert: NO further wake; `approvalsSvc.create` called with `type:"deploy_failed_review"` (payload has propertyName/reason/attempts); `issueApprovalsSvc.linkManyForApproval` called; `issuesSvc.update(issueId, { status: "blocked" })`; terminal PM comment posted; `logActivity(deployment.failed)`; watch `status:"failed"`.
  - **Wake cap → escalate:** `fixAttempts: MAX_FIX_WAKES`, `deadlineAt` in the future. Assert: escalates (same as above), no wake.
  - **Success unchanged:** `"success"` → LIVE + `status:"live"`, no approval.
- [ ] **Step 2: Run → fail.** `pnpm --filter @paperclipai/server exec vitest run src/services/deployment-watch.test.ts`.
- [ ] **Step 3: Implement.**
  - Add the deps + constants. Extract an `async function escalate(w, reason)` helper: create the `deploy_failed_review` approval (`approvalsSvc.create(w.companyId, { type: "deploy_failed_review", requestedByAgentId: null, requestedByUserId: null, status: "pending", payload: { issueId: w.issueId, propertyName, reason, attempts: w.fixAttempts } })`), link it (`issueApprovalsSvc.linkManyForApproval(approval.id, [w.issueId])`), `issuesSvc.update(w.issueId, { status: "blocked" })`, post the terminal `FAILED_BODY`, `logActivity({ action: "deployment.failed", ... })`, set watch `status:"failed"`. Each sub-step in its own try/catch (or the whole helper is inside the existing per-watch try/catch — ensure a partial failure still marks the watch failed).
  - Rework the `state === "failure"` branch:
    - Compute `const overBudget = w.fixAttempts >= 1 && now >= w.deadlineAt;` and `const overCap = w.fixAttempts >= MAX_FIX_WAKES;`.
    - If `overBudget || overCap` → `await escalate(w, "<reason: build failed / retries exhausted>")`. (Fetch the latest failure reason if cheaply available; else a generic "the deploy kept failing".)
    - Else (retry): wake assignee (existing), post the warning comment (existing), `logActivity(deployment.retry_requested)` (existing), and update the watch: `fixAttempts: w.fixAttempts + 1`, `startedAt: now` (dedup), `nextCheckAt: now + RETRY_POLL_MS`, `updatedAt: now`, AND set the fix budget ONCE: `deadlineAt: w.fixAttempts === 0 ? new Date(now.getTime() + FIX_BUDGET_MS) : w.deadlineAt` (extend to 30 min on the first failure; keep it thereafter).
  - Also: on a no-result poll (the `else` reschedule branch and the deadline/`delayed` branch), if `w.fixAttempts >= 1 && now >= w.deadlineAt` → `await escalate(w, "the deploy never came back")` instead of marking `delayed` (a failure that then stalls must escalate, not silently delay). Keep the pure "publishing slow, never failed" (`fixAttempts === 0`) path as `delayed` (unchanged).
  - `index.ts`: wire `issuesSvc: { update: (id, data) => issueService(db).update(id, data), addComment: ... }` (extend the existing issuesSvc dep), `approvalsSvc: { create: (companyId, data) => approvalService(db).create(companyId, data) }`, `issueApprovalsSvc: { linkManyForApproval: (id, ids, actor) => issueApprovalService(db).linkManyForApproval(id, ids, actor) }`, and extend `projectsSvc.getById` usage/type to include `name`.
- [ ] **Step 4: Run → pass.** The deployment-watch test file. `pnpm --filter @paperclipai/server typecheck` (pre-existing plugin-sdk/plugin-workspace-diff errors are not yours).
- [ ] **Step 5: Commit.** `git commit -m "feat(server): budget-based deploy self-heal; raise an admin alert when it can't recover"`

---

## Task 3: Harden the autonomous Editor→Reviewer→redeploy handoff

**Files:** `agent-instructions/editor.md`, `agent-instructions/reviewer.md`.

- [ ] **Step 1: Editor.** In `editor.md`'s `## When Woken With Reason "deploy_failed"` section, make the handoff explicit and reliable: read the error → fix on the branch → commit → push → **reassign the issue to the Reviewer agent to re-merge** (this is what triggers a fresh production deploy) → STOP. State clearly it must always reassign to the Reviewer after pushing a fix (do NOT stop without handing off), and must NOT merge.
- [ ] **Step 2: Reviewer.** In `reviewer.md`, add/clarify: when an issue is reassigned back for a **failed deploy** (a `deploy_failed` fix from the Editor), re-run the checks and re-merge to `main` (re-trigger the production deploy) so the system can re-check — treat a returned deploy-fix as a re-merge request, not a fresh review from scratch.
- [ ] **Step 3: Re-read both files** for consistency/tone (plain PM-facing copy unchanged). Commit: `git commit -m "docs(agents): make the deploy-failure fix→re-merge handoff explicit and autonomous"`

---

## Final Verification + Deploy

- [ ] `pnpm -r typecheck` clean (modulo pre-existing plugin pkgs); targeted suites (constants, ApprovalPayload, deployment-watch) pass; `pnpm test:run` green except the pre-existing `server-startup-feedback-export.test.ts`.
- [ ] No new migration (reuses `fix_attempts` + approvals).
- [ ] **Watch for the stray-docker-files re-add** (a subagent's broad `git add`): before deploy, `git diff --name-only <merge-base> HEAD | grep docker/` must be empty (untrack `docker/docker-compose.production.yml` + `docker/Caddyfile` if re-added).
- [ ] Deploy: merge → `gh auth switch --user navarino-dev` → push fork → box `git pull --ff-only` (docker config stays untracked) → `cd docker && docker compose --env-file .env.production -f docker-compose.production.yml up -d --build`. No migration to apply this time.
- [ ] **Smoke:** a deploy that fails now retries for up to 30 min (paced) and, if it can't recover, appears as a **"Publishing Issue"** item in the admin Inbox with the property + reason, and the issue is `blocked`. A normal deploy still goes live with the ✨ card.
