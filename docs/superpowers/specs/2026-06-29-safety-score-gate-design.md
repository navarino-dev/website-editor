# Safety-score gate for change requests

Date: 2026-06-29
Status: Approved (design)

## Context

Property managers submit change requests (issues, and follow-up replies) that wake
a work agent (the Editor). Today nothing assesses how risky/complex a request is
before the agent starts. We want a built-in safety check: every new ask is scored
0–10 by a server-side scorer the instant it's submitted; high-risk asks (>5) are
held until an admin approves; the score is always shown.

## Goals

1. Every new change request (initial issue **and** each follow-up reply) is scored
   0–10 by a server-side step **before** the work agent is woken.
2. A score **> 5** holds the work and **requires admin/owner approval** to proceed.
3. The score (and reasoning) is **always shown** on the issue, regardless of the
   outcome (cleared / awaiting approval / approved / declined).

## Non-goals

- Not a visible org-chart agent. The scorer is a control-plane governance step
  (like the existing budget/approval checks), not a `claude_local` company agent.
- No change to the existing "Approve & Go Live" flow (that's *review*-time, after
  work; this gate is *request*-time, before work). Both can apply to one issue.
- No new approvals UI framework — reuse the existing approvals system.

## Decisions (from brainstorming)

- **Scorer = built-in server step** (one Claude call), can't be bypassed.
- **Scores every new ask**: issue creation + each PM follow-up reply.
- **Threshold > 5 → admin approval.** Criteria that push the score up: massive
  overhaul, complex change, touching a backend, touching repo settings.
- **Approver = admin/owner** (instance admin, or company owner/admin/manager).
  Operators/viewers cannot approve at all → an operator can never self-approve.
  An admin/owner *can* approve (including their own request) — avoids deadlock in a
  single-admin org.
- **Hold = issue `status: "blocked"`** + an approval record.
- **Scorer model = Claude Haiku 4.5** (`claude-haiku-4-5-20251001`), fast/cheap.
- **Fail-closed**: if the Claude call fails/times out, treat as "needs review"
  (hold + approval), card says "Couldn't auto-assess — sent for admin review."

## Architecture

```
Change request submitted (issue create OR PM reply)
        │
        ▼
  safety-scorer  ──► Claude Haiku 4.5 ──► { score, isChangeRequest, reasoning, factors }
        │
        ├─ post "Safety review" system_notice card (score + reasoning)  ── always
        │
        ├─ isChangeRequest=false OR score ≤ 5 ──► wake the work agent (normal flow)
        │
        └─ score > 5 (or scorer error → fail-closed) ──►
               • issue.status = "blocked"
               • create approval (type "safety_review_required", payload {score, reasoning, factors})
               • link approval ↔ issue (issue_approvals)
               • DO NOT wake the work agent
                        │
            admin/owner decides (existing approvals routes, restricted)
                        ├─ approve ──► issue back to its prior status, wake the work agent
                        └─ reject  ──► issue stays blocked/closed, card → "Declined by {admin}"
```

### Components

**1. `server/src/services/safety-scorer.ts` (new)**
- `scoreChangeRequest(input: { title?: string; text: string; projectName?: string }):
  Promise<SafetyScore>` where
  `SafetyScore = { score: number /*0–10*/; isChangeRequest: boolean; reasoning: string; factors: string[]; degraded?: boolean }`.
- One Anthropic API call (Claude Haiku 4.5) using the Anthropic SDK with
  `process.env.ANTHROPIC_API_KEY` (present in prod). Use structured output (tool
  call / strict JSON) and parse-validate. **Consult the `claude-api` skill for the
  exact current SDK call + structured-output pattern + model id.**
- System prompt: a property-manager website-change-request risk rater. Score 0–10;
  push the score up for: massive overhaul, complex/multi-page change, anything
  touching a backend/server/database, or touching repo/CI/deploy/settings; keep it
  low for simple copy/image/styling tweaks. Also classify `isChangeRequest`
  (false for approvals/acknowledgements like "looks good", "go live", questions).
- **Fail-closed:** on any error/timeout/parse failure, return
  `{ score: 6, isChangeRequest: true, reasoning: "Automatic assessment unavailable — routed for admin review.", factors: [], degraded: true }` so it lands in the >5 gate.
- Injectable deps for testing (the Anthropic client / a `call` fn) — no real network in tests.

**2. Gate integration (server)**
- New approval type constant `"safety_review_required"` added to
  `APPROVAL_TYPES` (`packages/shared/src/constants.ts`) + the shared type.
- A small `server/src/services/safety-gate.ts` orchestrator:
  `evaluateAndGate({ companyId, issue, requestText, requesterUserId }) ->
   { gated: boolean }` that: calls the scorer → posts the system_notice card →
   if gated, sets issue `blocked` + creates+links the approval; returns whether it
   gated (so the caller skips the wakeup).
- **Hook points** (run the gate *before* `queueIssueAssignmentWakeup`):
  - Issue create: `server/src/routes/issues.ts` POST `/companies/:companyId/issues`
    (~line 3528–3594) — after `svc.create`, before `queueIssueAssignmentWakeup`.
  - PM reply: the comment-post path that wakes the assignee (the `addComment`
    route + its wakeup). Score the reply text; gate the same way. (Find the
    comment→wakeup site in `server/src/routes/issues.ts`; gate before the wake.)
  - Only score requests from **operator/PM** principals and other human change
    requests; do not score agent-authored comments or system comments. (Scoring an
    admin's own request is fine — they can approve it.)

**3. Resume / decline on decision**
- The existing approve path (`server/src/routes/approvals.ts` POST
  `/approvals/:id/approve`) already wakes the requesting/assignee agent on approve.
  Extend the safety case: on approve, restore the issue from `blocked` to its
  pre-hold status and wake the assignee. On reject, leave it blocked and update the
  card to "Declined."
- Store the pre-hold status (in the approval payload or issue metadata) so approve
  can restore it.

**4. Display (UI)**
- The "Safety review" card is a `system_notice` comment (authorType `system`,
  presentation `system_notice`), rendered by the existing `SystemNoticeCommentRow`
  in both the simplified (PM) and admin views.
- Body shows `Safety score: X/10` + the reasoning. Tone by state: ≤5 → `success`
  ("Cleared to proceed"); >5 pending → `warning` ("Needs admin approval");
  approved → `success` ("Approved by {admin}"); declined → `danger`
  ("Declined by {admin}"); degraded → `warning`.
- The score value should be visually prominent (e.g. a `Safety X/10` badge in the
  card title). Reuse `ApprovalCard` / the "Pending Approvals" dashboard stat for
  admins to find waiting items — no new approvals framework.

### Authorization

- Approve/reject of a `safety_review_required` approval is restricted to
  **admin/owner**: instance admin (`req.actor.isInstanceAdmin` / `local_implicit`)
  OR an active company membership role in `{owner, admin, manager}`. Operators and
  viewers get 403. (The generic approvals routes use `assertBoard`; this type needs
  the stricter check — add it in the approve/reject handlers for this type, or a
  shared `assertCanApproveSafety` helper.)

## Data model

- `packages/shared/src/constants.ts`: add `"safety_review_required"` to
  `APPROVAL_TYPES` (+ regenerate any dependent type).
- No new tables. Reuse `approvals` + `issue_approvals`. The score/reasoning/factors
  live in the approval `payload`; the score is also embedded in the posted card
  body so it shows even for ≤5 (no approval record in that case).
- The pre-hold issue status is stored in the approval payload
  (`payload.priorStatus`) for restore-on-approve.

## Contracts to keep in sync

`packages/shared` (APPROVAL_TYPES + type) → `server` (safety-scorer, safety-gate,
issue-create + reply hooks, approvals approve/reject restriction + resume/decline)
→ `ui` (the score card rendering tweaks + any approval-type label). Mutating
actions write activity-log entries per the surrounding code.

## Error handling & edge cases

- **Scorer failure** → fail-closed (score treated as >5, `degraded` card).
- **`isChangeRequest: false`** (approvals/acks/questions) → never gated, and the
  card is suppressed or minimal (don't spam a score on "looks good").
- **Follow-up reply >5 mid-flow** → holds again with its own approval; resumes on
  approve.
- **Scorer must not block the HTTP response unduly** — the Claude call is ~1–2s;
  acceptable on submit. If it ever needs to be async, gate before wake via the
  tick; out of scope for v1 (keep it inline + awaited).
- **Admin self-submitted >5** → allowed to self-approve (they hold approve perms).
- **Never crash the request path** — the gate is wrapped so a thrown scorer error
  becomes the fail-closed path, never a 500 on issue creation.

## Testing

- **safety-scorer** (unit, mocked Claude): parses a valid structured response;
  clamps score to 0–10; `isChangeRequest:false` path; **fail-closed** on
  error/timeout/invalid JSON returns score 6 + degraded.
- **safety-gate** (unit, fakes): ≤5 → no approval, returns `gated:false` (caller
  wakes); >5 → sets blocked + creates+links approval + posts card, returns
  `gated:true`; degraded → gated; `isChangeRequest:false` → not gated, no card.
- **approvals**: approve a `safety_review_required` → issue restored from blocked +
  assignee woken; reject → stays blocked + card declined; **operator gets 403** on
  approve/reject; admin/owner allowed.
- **UI**: the safety card renders `Safety score: X/10` + reasoning in simplified
  and admin views; the >5 state shows "Needs admin approval".

## Rollout

- Standard pipeline: typecheck + tests + Docker build chain, commit on master,
  push to fork, rebuild + restart the server (no DB migration — reuses existing
  tables; only a shared constant + code). `ANTHROPIC_API_KEY` is already in the
  server container.
- After deploy: submit a low-risk request (should clear with a score card) and a
  high-risk one (should hold + require the Admin Dev account to approve).
