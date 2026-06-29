# Safety-Score Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score every new change request (issue create + each PM follow-up reply) 0–10 with a server-side Claude call before the work agent is woken; hold any score > 5 (or scorer failure) as a `blocked` issue + admin-only approval; always show the score on the issue.

**Architecture:** A built-in scorer service (`safety-scorer.ts`) makes one Claude Haiku 4.5 call and returns a validated `SafetyScore` (fail-closed to score 6 on any error). A `safety-gate.ts` orchestrator scores the request, always posts a `system_notice` "Safety X/10" comment, and — when gated — sets the issue `blocked`, creates a `safety_review_required` approval, and links it to the issue. Two route hooks (issue-create, PM-reply) run the gate *before* the existing wakeup and skip the wakeup when gated. The approvals approve/reject handlers gain an admin-only authorization gate for this type and resume the issue (restore prior status → existing agent wakeup) on approve / post a "Declined" card on reject. The score card renders through the existing `SystemNoticeCommentRow` in both PM and admin views; the new approval type gets a label + payload renderer.

**Tech Stack:** TypeScript (ESM) pnpm monorepo — `@paperclipai/{shared,server,ui}`; `@anthropic-ai/sdk` (new server dep); Drizzle (no schema change — reuses `approvals` + `issue_approvals`); Vitest; React 19.

## Global Constraints

- **Model:** `claude-haiku-4-5` (alias; do not append a date suffix). No `thinking`, no `effort`, no `temperature` — Haiku 4.5 rejects `effort` and the scorer needs none.
- **Structured output:** use `messages.create` with `output_config: { format: { type: "json_schema", name: "safety_score", schema: SAFETY_SCORE_SCHEMA } }`. JSON-schema structured outputs do **not** support numeric `minimum`/`maximum` — clamp the score to 0–10 in code. Parse the returned text block with `JSON.parse`; do not raw-string-match.
- **Fail-closed:** any scorer error/timeout/invalid output ⇒ `{ score: 6, isChangeRequest: true, reasoning: "Automatic assessment unavailable — routed for admin review.", factors: [], degraded: true }` (lands in the > 5 gate).
- **Threshold:** gated ⇔ `result.degraded === true || result.score > 5`. `isChangeRequest === false` is **never** gated and posts **no** card.
- **New approval type string is exactly** `"safety_review_required"`.
- **Approver set** mirrors the admin-view set: instance admin OR `req.actor.source === "local_implicit"` OR an **active** company membership whose `membershipRole ∈ {owner, admin, manager}`. (`manager` is in the UI's `ADMIN_ROLES` superset but absent from `COMPANY_MEMBERSHIP_ROLES`; include it so the server gate stays identical to "who sees the admin view".) Operators and viewers get 403.
- **Never crash the request path:** route hooks wrap the gate in try/catch; a thrown gate error logs a warning and proceeds un-gated (the scorer's internal fail-closed already covers the common "Claude down" case by gating).
- **Activity logging:** the approve/reject handlers already write activity-log entries — preserve them; do not remove.
- **Contracts in sync (same change):** `packages/shared` (`APPROVAL_TYPES`) → `server` (scorer, gate, route hooks, approvals auth+resume) → `ui` (label/icon/payload renderer).

---

## File Structure

| File | Responsibility | Create / Modify |
| --- | --- | --- |
| `packages/shared/src/constants.ts` | Add `"safety_review_required"` to `APPROVAL_TYPES` | Modify (~line 424–430) |
| `server/src/services/safety-scorer.ts` | One Claude call → validated `SafetyScore`; fail-closed; injectable `call` | Create |
| `server/src/services/safety-gate.ts` | `evaluateAndGate`: score → post card → (if gated) block+create+link approval | Create |
| `server/src/routes/issues.ts` | Hook gate into issue-create (~3527/3580) and PM-reply (~5602/5680); skip wake when gated; instantiate `approvalService` | Modify |
| `server/src/routes/authz.ts` | `canApproveSafety(actor, companyId)` + `assertCanApproveSafety` | Modify |
| `server/src/routes/approvals.ts` | Admin-only gate for `safety_review_required`; resume-on-approve; decline card | Modify |
| `ui/src/components/ApprovalPayload.tsx` | Label + icon + `SafetyReviewPayload` renderer for the new type | Modify |
| `server/src/services/safety-scorer.test.ts` | Scorer unit tests | Create |
| `server/src/services/safety-gate.test.ts` | Gate unit tests | Create |
| `server/src/routes/authz.test.ts` (or add to existing) | `canApproveSafety` unit tests | Create/Modify |

**Reference facts (verified, with exact locations):**

- Issue-create route: `server/src/routes/issues.ts` — `const companyId = req.params.companyId` (3504); `const actor = getActorInfo(req)` (3521); `const issue = await svc.create(companyId, {...})` (3527); `void queueIssueAssignmentWakeup({ heartbeat, issue, reason: "issue_assigned", mutation: "create", contextSource: "issue.create", requestedByActorType: actor.actorType, requestedByActorId: actor.actorId })` (3580–3588).
- PM-reply route: same file — `router.post("/issues/:id/comments", ...)` (5462); `const actor = getActorInfo(req)` (5481); `const comment = await svc.addComment(id, req.body.body, {...}, {...})` (5602); wakeup block follows at ~5680–5769 (`heartbeat.wakeup(agentId, wakeup).catch(...)`). `currentIssue` is the in-handler issue var (may have been reopened to `todo`).
- `getActorInfo(req)` → `{ actorType: "user"|"agent", actorId: string, agentId: string|null, runId: string|null }` (user → `actorId = req.actor.userId ?? "board"`). Defined `server/src/routes/authz.ts:66`.
- `queueIssueAssignmentWakeup(input)` (`server/src/services/issue-assignment-wakeup.ts:21`) — early-returns if `!issue.assigneeAgentId || issue.status === "backlog"`; `issue` shape `{ id, assigneeAgentId, status }`.
- `issueService(db)` factory (`server/src/services/issues.ts:2775`): `addComment(issueId, body, actor: {agentId?, userId?, runId?}, options?: { authorType?, presentation?, metadata?, createdAt? })` (5152); `update(id, data: Partial<typeof issues.$inferInsert> & {...}, dbOrTx?)` (4309) — validates status against `ALL_ISSUE_STATUSES = ["backlog","todo","in_progress","in_review","blocked","done","cancelled"]`.
- `IssueCommentPresentation = { kind: "message"|"system_notice"; tone: "neutral"|"info"|"success"|"warning"|"danger"; title?: string|null; detailsDefaultOpen: boolean }` (`packages/shared/src/types/issue.ts`).
- `approvalService(db)` (`server/src/services/approvals.ts:11`): `create(companyId, data: Omit<typeof approvals.$inferInsert, "companyId">) => Promise<ApprovalRecord>` (data fields: `type, requestedByAgentId, requestedByUserId, status, payload, decisionNote?, decidedByUserId?, decidedAt?, updatedAt?`); `getById(id)` (88); `approve(id, decidedByUserId, decisionNote?) => {approval, applied}` (102); `reject(...)` (171). `payload` column is JSONB `Record<string, unknown>` (notNull).
- `issueApprovalService(db)` (`server/src/services/issue-approvals.ts`): `linkManyForApproval(approvalId, issueIds: string[], actor?: {agentId?, userId?})`; `listIssuesForApproval(approvalId) => issues[]`.
- Approvals route (`server/src/routes/approvals.ts`): approve handler 136–230 (`assertBoard(req)`, `requireApprovalAccess(req,id)` 139, `decidedByUserId = req.actor.userId ?? "board"`, `svc.approve(...)`, then `if (applied)` → `issueApprovalsSvc.listIssuesForApproval(approval.id)` + `heartbeat.wakeup(approval.requestedByAgentId, {...})`). reject handler 232–255. Already imports `approvalService`? No — imports `issueApprovalService` (15) and instantiates `issueApprovalsSvc = issueApprovalService(db)` (39); `svc = approvalService(db)` exists in-file. `assertBoard, assertCompanyAccess, getActorInfo` from `./authz.js` (19). `forbidden` lives in `server/src/errors.ts:20` (not yet imported here).
- `req.actor` (`server/src/types/express.d.ts`): `{ type, userId?, userName?, userEmail?, isInstanceAdmin?, source?, memberships?: Array<{companyId, membershipRole?, status?}>, ... }`.
- `COMPANY_MEMBERSHIP_ROLES = ["owner","admin","operator","viewer","member"]` (`packages/shared/src/constants.ts:631`); UI `ADMIN_ROLES = new Set(["owner","admin","manager"])` (`ui/src/hooks/useIsSimplifiedView.ts:5`).
- `@anthropic-ai/sdk` is **not** a server dependency yet; `ANTHROPIC_API_KEY` is already present in the prod server container.
- `SystemNoticeCommentRow` renders `system_notice` comments in both views: `ui/src/components/IssueChatThread.tsx`.
- UI approval label/icon/payload maps: `ui/src/components/ApprovalPayload.tsx` (labels 5–8, icons 40–43, dispatcher 241–243).

---

## Task 1: Add `safety_review_required` to APPROVAL_TYPES

**Files:**
- Modify: `packages/shared/src/constants.ts:424-430`
- Test: `packages/shared/src/__tests__/constants.test.ts` (create if absent; otherwise add a case)

**Interfaces:**
- Produces: the string literal `"safety_review_required"` is now a valid `ApprovalType` consumed by the gate (Task 3), approvals routes (Task 7), and UI (Task 8).

- [ ] **Step 1: Write the failing test**

Create/append `packages/shared/src/__tests__/constants.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { APPROVAL_TYPES } from "../constants.js";

describe("APPROVAL_TYPES", () => {
  it("includes the safety_review_required gate type", () => {
    expect(APPROVAL_TYPES).toContain("safety_review_required");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/shared exec vitest run src/__tests__/constants.test.ts`
Expected: FAIL — array does not contain `"safety_review_required"`.

- [ ] **Step 3: Add the constant**

In `packages/shared/src/constants.ts`, change the `APPROVAL_TYPES` array (lines 424–430) to:

```typescript
export const APPROVAL_TYPES = [
  "hire_agent",
  "approve_ceo_strategy",
  "budget_override_required",
  "request_board_approval",
  "safety_review_required",
] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @paperclipai/shared exec vitest run src/__tests__/constants.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck shared + build (downstream packages read compiled dist)**

Run: `pnpm --filter @paperclipai/shared build && pnpm --filter @paperclipai/shared typecheck`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/__tests__/constants.test.ts
git commit -m "feat(shared): add safety_review_required approval type"
```

---

## Task 2: Safety scorer service

**Files:**
- Create: `server/src/services/safety-scorer.ts`
- Test: `server/src/services/safety-scorer.test.ts`
- Modify: `server/package.json` (add `@anthropic-ai/sdk`)

**Interfaces:**
- Produces:
  - `interface ScoreInput { title?: string; text: string; projectName?: string }`
  - `interface SafetyScore { score: number; isChangeRequest: boolean; reasoning: string; factors: string[]; degraded?: boolean }`
  - `type RawScorerCall = (input: ScoreInput) => Promise<{ score: unknown; isChangeRequest: unknown; reasoning: unknown; factors: unknown }>`
  - `async function scoreChangeRequest(input: ScoreInput, call?: RawScorerCall): Promise<SafetyScore>` (default `call` = real Anthropic call; tests inject a fake).
- Consumes: `@anthropic-ai/sdk` (`Anthropic`), `process.env.ANTHROPIC_API_KEY`.

- [ ] **Step 1: Add the SDK dependency**

Run: `pnpm --filter @paperclipai/server add @anthropic-ai/sdk`
Expected: `@anthropic-ai/sdk` appears in `server/package.json` dependencies; lockfile updates.

- [ ] **Step 2: Write the failing tests**

Create `server/src/services/safety-scorer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { scoreChangeRequest, type RawScorerCall } from "./safety-scorer.js";

const ok =
  (raw: { score: unknown; isChangeRequest: unknown; reasoning: unknown; factors: unknown }): RawScorerCall =>
  async () =>
    raw;

describe("scoreChangeRequest", () => {
  it("returns a validated low score for a simple change", async () => {
    const r = await scoreChangeRequest(
      { text: "Change the hero headline" },
      ok({ score: 2, isChangeRequest: true, reasoning: "Simple copy tweak", factors: ["copy"] }),
    );
    expect(r).toEqual({ score: 2, isChangeRequest: true, reasoning: "Simple copy tweak", factors: ["copy"] });
  });

  it("clamps an out-of-range score into 0..10", async () => {
    const hi = await scoreChangeRequest({ text: "x" }, ok({ score: 42, isChangeRequest: true, reasoning: "r", factors: [] }));
    expect(hi.score).toBe(10);
    const lo = await scoreChangeRequest({ text: "x" }, ok({ score: -3, isChangeRequest: true, reasoning: "r", factors: [] }));
    expect(lo.score).toBe(0);
  });

  it("passes through isChangeRequest:false", async () => {
    const r = await scoreChangeRequest({ text: "looks good, go live" }, ok({ score: 0, isChangeRequest: false, reasoning: "ack", factors: [] }));
    expect(r.isChangeRequest).toBe(false);
    expect(r.degraded).toBeUndefined();
  });

  it("fails closed when the call throws", async () => {
    const r = await scoreChangeRequest({ text: "x" }, async () => {
      throw new Error("timeout");
    });
    expect(r).toEqual({
      score: 6,
      isChangeRequest: true,
      reasoning: "Automatic assessment unavailable — routed for admin review.",
      factors: [],
      degraded: true,
    });
  });

  it("fails closed when the score is not a number", async () => {
    const r = await scoreChangeRequest({ text: "x" }, ok({ score: "high", isChangeRequest: true, reasoning: "r", factors: [] }));
    expect(r.degraded).toBe(true);
    expect(r.score).toBe(6);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/safety-scorer.test.ts`
Expected: FAIL — module `./safety-scorer.js` not found.

- [ ] **Step 4: Implement the scorer**

Create `server/src/services/safety-scorer.ts`:

```typescript
import Anthropic from "@anthropic-ai/sdk";

export interface ScoreInput {
  title?: string;
  text: string;
  projectName?: string;
}

export interface SafetyScore {
  /** 0–10 risk/complexity rating. */
  score: number;
  /** false for acknowledgements/approvals/questions (e.g. "looks good", "go live"). */
  isChangeRequest: boolean;
  reasoning: string;
  factors: string[];
  /** true when the score is a fail-closed fallback (Claude unavailable). */
  degraded?: boolean;
}

export type RawScorerCall = (input: ScoreInput) => Promise<{
  score: unknown;
  isChangeRequest: unknown;
  reasoning: unknown;
  factors: unknown;
}>;

const FAIL_CLOSED: SafetyScore = {
  score: 6,
  isChangeRequest: true,
  reasoning: "Automatic assessment unavailable — routed for admin review.",
  factors: [],
  degraded: true,
};

const SAFETY_SCORE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    score: { type: "integer", description: "Risk/complexity 0 (trivial) to 10 (massive/dangerous)." },
    isChangeRequest: {
      type: "boolean",
      description: "true if this asks to change the website; false for acknowledgements, approvals, or questions.",
    },
    reasoning: { type: "string", description: "One or two sentences explaining the score, in plain language." },
    factors: { type: "array", items: { type: "string" }, description: "Short risk factors that pushed the score." },
  },
  required: ["score", "isChangeRequest", "reasoning", "factors"],
} as const;

const SYSTEM_PROMPT = [
  "You rate website change requests submitted by property managers for risk and complexity.",
  "Return a score from 0 to 10:",
  "- 0–3: simple copy, image, or styling tweaks on existing pages.",
  "- 4–5: moderate multi-element changes that are still front-end only.",
  "- 6–10: massive overhauls, complex or multi-page restructures, anything that touches a backend / server / database / API, or anything that touches repository, CI, deploy, or project settings.",
  "Push the score ABOVE 5 for any of: massive overhaul, complex change, touching a backend, or touching repo/CI/deploy/settings.",
  'Also set isChangeRequest=false when the message is not a change request — e.g. approvals or acknowledgements ("looks good", "go live", "approved") or questions. In that case score 0 and leave factors empty.',
  "Be concise. Output only the structured fields.",
].join("\n");

function toScore(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error("scorer returned a non-numeric score");
  }
  return Math.max(0, Math.min(10, Math.round(raw)));
}

const defaultAnthropicCall: RawScorerCall = async (input) => {
  const client = new Anthropic({ maxRetries: 1 });
  const userText = [
    input.projectName ? `Project: ${input.projectName}` : null,
    input.title ? `Title: ${input.title}` : null,
    `Request: ${input.text}`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await client.messages.create(
    {
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userText }],
      output_config: { format: { type: "json_schema", name: "safety_score", schema: SAFETY_SCORE_SCHEMA } },
    },
    { timeout: 10_000 },
  );

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error("scorer returned no text block");
  return JSON.parse(textBlock.text) as {
    score: unknown;
    isChangeRequest: unknown;
    reasoning: unknown;
    factors: unknown;
  };
};

export async function scoreChangeRequest(
  input: ScoreInput,
  call: RawScorerCall = defaultAnthropicCall,
): Promise<SafetyScore> {
  try {
    const raw = await call(input);
    const score = toScore(raw.score);
    return {
      score,
      isChangeRequest: Boolean(raw.isChangeRequest),
      reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
      factors: Array.isArray(raw.factors) ? raw.factors.map((f) => String(f)) : [],
    };
  } catch {
    return { ...FAIL_CLOSED };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/safety-scorer.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck server**

Run: `pnpm --filter @paperclipai/server typecheck`
Expected: succeeds (confirms `output_config`/`json_schema`/`TextBlock` types resolve against the installed SDK; if `output_config` is not yet typed by this SDK version, cast the params object to `Anthropic.MessageCreateParams & { output_config: unknown }` rather than changing the wire shape).

- [ ] **Step 7: Commit**

```bash
git add server/src/services/safety-scorer.ts server/src/services/safety-scorer.test.ts server/package.json pnpm-lock.yaml
git commit -m "feat(server): add Claude-backed safety scorer (fail-closed)"
```

---

## Task 3: Safety gate orchestrator

**Files:**
- Create: `server/src/services/safety-gate.ts`
- Test: `server/src/services/safety-gate.test.ts`

**Interfaces:**
- Consumes: `scoreChangeRequest`, `SafetyScore`, `ScoreInput` from Task 2; `APPROVAL_TYPES`/`"safety_review_required"` from Task 1.
- Produces:
  - `interface GateIssue { id: string; status: string; assigneeAgentId: string | null; title?: string }`
  - `interface SafetyGateDeps { issuesSvc: { addComment: Fn; update: Fn }; approvalsSvc: { create: Fn }; issueApprovalsSvc: { linkManyForApproval: Fn }; scorer?: (input: ScoreInput) => Promise<SafetyScore> }`
  - `interface GateInput { companyId: string; issue: GateIssue; requestText: string; requesterUserId: string | null; projectName?: string }`
  - `async function evaluateAndGate(input: GateInput, deps: SafetyGateDeps): Promise<{ gated: boolean; score: SafetyScore }>`
- The exact dep method shapes match the real services: `issuesSvc.addComment(issueId, body, actor, options)`, `issuesSvc.update(id, data)`, `approvalsSvc.create(companyId, data)`, `issueApprovalsSvc.linkManyForApproval(approvalId, issueIds, actor)`.

- [ ] **Step 1: Write the failing tests**

Create `server/src/services/safety-gate.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { evaluateAndGate, type SafetyGateDeps, type GateInput } from "./safety-gate.js";
import type { SafetyScore, ScoreInput } from "./safety-scorer.js";

// The dep types are the REAL service signatures (Pick<ReturnType<typeof ...>>),
// so build vi.fn() stubs and cast once. Assertions read through vi.mocked(...).
function makeDeps(scorer: (input: ScoreInput) => Promise<SafetyScore>): SafetyGateDeps {
  return {
    issuesSvc: { addComment: vi.fn(async () => ({ id: "c1" })), update: vi.fn(async () => ({ id: "i1" })) },
    approvalsSvc: { create: vi.fn(async () => ({ id: "appr1" })) },
    issueApprovalsSvc: { linkManyForApproval: vi.fn(async () => undefined) },
    scorer,
  } as unknown as SafetyGateDeps;
}

const input: GateInput = {
  companyId: "co1",
  issue: { id: "i1", status: "todo", assigneeAgentId: "agentA", title: "Hero copy" },
  requestText: "Change the headline",
  requesterUserId: "u1",
};

const scorerReturning = (score: SafetyScore) => async () => score;

describe("evaluateAndGate", () => {
  it("clears a low-risk change: posts a card, does not gate, no approval", async () => {
    const deps = makeDeps(scorerReturning({ score: 3, isChangeRequest: true, reasoning: "ok", factors: [] }));
    const out = await evaluateAndGate(input, deps);
    expect(out.gated).toBe(false);
    expect(vi.mocked(deps.issuesSvc.addComment)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.approvalsSvc.create)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.issuesSvc.update)).not.toHaveBeenCalled();
  });

  it("gates a high-risk change: blocks the issue, creates+links the approval, posts a card", async () => {
    const deps = makeDeps(scorerReturning({ score: 8, isChangeRequest: true, reasoning: "backend", factors: ["backend"] }));
    const out = await evaluateAndGate(input, deps);
    expect(out.gated).toBe(true);
    expect(vi.mocked(deps.issuesSvc.update)).toHaveBeenCalledWith("i1", { status: "blocked" });
    expect(vi.mocked(deps.approvalsSvc.create)).toHaveBeenCalledTimes(1);
    const [companyArg, data] = vi.mocked(deps.approvalsSvc.create).mock.calls[0];
    expect(companyArg).toBe("co1");
    expect(data.type).toBe("safety_review_required");
    expect(data.status).toBe("pending");
    expect(data.requestedByAgentId).toBe("agentA");
    expect(data.payload).toMatchObject({ score: 8, priorStatus: "todo", issueId: "i1" });
    expect(vi.mocked(deps.issueApprovalsSvc.linkManyForApproval)).toHaveBeenCalledWith("appr1", ["i1"], { userId: "u1" });
    expect(vi.mocked(deps.issuesSvc.addComment)).toHaveBeenCalledTimes(1);
  });

  it("gates on degraded (fail-closed) scores", async () => {
    const deps = makeDeps(scorerReturning({ score: 6, isChangeRequest: true, reasoning: "unavailable", factors: [], degraded: true }));
    const out = await evaluateAndGate(input, deps);
    expect(out.gated).toBe(true);
    expect(vi.mocked(deps.approvalsSvc.create)).toHaveBeenCalledTimes(1);
  });

  it("never gates and posts no card when it is not a change request", async () => {
    const deps = makeDeps(scorerReturning({ score: 0, isChangeRequest: false, reasoning: "ack", factors: [] }));
    const out = await evaluateAndGate(input, deps);
    expect(out.gated).toBe(false);
    expect(vi.mocked(deps.issuesSvc.addComment)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.approvalsSvc.create)).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/safety-gate.test.ts`
Expected: FAIL — module `./safety-gate.js` not found.

- [ ] **Step 3: Implement the gate**

Create `server/src/services/safety-gate.ts`:

```typescript
import { scoreChangeRequest, type SafetyScore, type ScoreInput } from "./safety-scorer.js";
// Type-only imports so the deps interface uses the REAL service signatures.
// This sidesteps strictFunctionTypes variance: the concrete services (which the
// route call sites pass) are exactly these types, so they assign without casts.
import type { issueService } from "./issues.js";
import type { approvalService } from "./approvals.js";
import type { issueApprovalService } from "./issue-approvals.js";

export interface GateIssue {
  id: string;
  status: string;
  assigneeAgentId: string | null;
  title?: string;
}

export interface SafetyGateDeps {
  issuesSvc: Pick<ReturnType<typeof issueService>, "addComment" | "update">;
  approvalsSvc: Pick<ReturnType<typeof approvalService>, "create">;
  issueApprovalsSvc: Pick<ReturnType<typeof issueApprovalService>, "linkManyForApproval">;
  scorer?: (input: ScoreInput) => Promise<SafetyScore>;
}

export interface GateInput {
  companyId: string;
  issue: GateIssue;
  requestText: string;
  requesterUserId: string | null;
  projectName?: string;
}

function cardBody(score: SafetyScore, gated: boolean): string {
  const lines = [`**Safety score: ${score.score}/10**`, "", score.reasoning];
  if (score.factors.length > 0) lines.push("", `Factors: ${score.factors.join(", ")}`);
  lines.push("", gated ? "_Needs admin approval to proceed._" : "_Cleared to proceed._");
  return lines.join("\n");
}

export async function evaluateAndGate(
  input: GateInput,
  deps: SafetyGateDeps,
): Promise<{ gated: boolean; score: SafetyScore }> {
  const scorer = deps.scorer ?? scoreChangeRequest;
  const score = await scorer({ title: input.issue.title, text: input.requestText, projectName: input.projectName });

  // Acknowledgements / approvals / questions: never gated, no card.
  if (!score.isChangeRequest) return { gated: false, score };

  const gated = score.degraded === true || score.score > 5;

  await deps.issuesSvc.addComment(
    input.issue.id,
    cardBody(score, gated),
    {},
    {
      authorType: "system",
      presentation: {
        kind: "system_notice",
        tone: gated ? "warning" : "success",
        title: `Safety ${score.score}/10`,
        detailsDefaultOpen: gated,
      },
    },
  );

  if (!gated) return { gated: false, score };

  await deps.issuesSvc.update(input.issue.id, { status: "blocked" });

  const approval = await deps.approvalsSvc.create(input.companyId, {
    type: "safety_review_required",
    requestedByAgentId: input.issue.assigneeAgentId ?? null,
    requestedByUserId: input.requesterUserId,
    status: "pending",
    payload: {
      score: score.score,
      reasoning: score.reasoning,
      factors: score.factors,
      degraded: score.degraded ?? false,
      priorStatus: input.issue.status,
      issueId: input.issue.id,
    },
  });

  await deps.issueApprovalsSvc.linkManyForApproval(approval.id, [input.issue.id], {
    userId: input.requesterUserId,
  });

  return { gated: true, score };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/safety-gate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @paperclipai/server typecheck`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/safety-gate.ts server/src/services/safety-gate.test.ts
git commit -m "feat(server): add safety gate orchestrator (score, card, block+approval)"
```

---

## Task 4: Hook the gate into issue creation

**Files:**
- Modify: `server/src/routes/issues.ts` — imports (~67), service instantiation (~870), create handler (~3527–3588)

**Interfaces:**
- Consumes: `evaluateAndGate` (Task 3), `approvalService` (existing), `issueApprovalsSvc`/`svc`/`heartbeat` (already in scope).
- The gate runs **after** `svc.create` and **before** `queueIssueAssignmentWakeup`; the wakeup is skipped when `gated`.

- [ ] **Step 1: Add imports + instantiate the approvals service**

In `server/src/routes/issues.ts`, add `approvalService` to the existing service import group (the block that already imports `issueApprovalService` at line ~68):

```typescript
  issueApprovalService,
  approvalService,
```

Add the gate import near the other service imports at the top of the file:

```typescript
import { evaluateAndGate } from "../services/safety-gate.js";
```

After `const issueApprovalsSvc = issueApprovalService(db);` (~line 870), add:

```typescript
  const approvalsSvc = approvalService(db);
```

- [ ] **Step 2: Insert the gate in the create handler**

In the `POST /companies/:companyId/issues` handler, replace the existing wakeup call (lines ~3580–3588):

```typescript
    void queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });
```

with a gated version (only score human/user-submitted requests):

```typescript
    let safetyGated = false;
    if (actor.actorType === "user") {
      try {
        const gateResult = await evaluateAndGate(
          {
            companyId,
            issue: { id: issue.id, status: issue.status, assigneeAgentId: issue.assigneeAgentId, title: issue.title },
            requestText: [issue.title, req.body.description].filter(Boolean).join("\n"),
            requesterUserId: actor.actorType === "user" ? actor.actorId : null,
          },
          { issuesSvc: svc, approvalsSvc, issueApprovalsSvc },
        );
        safetyGated = gateResult.gated;
      } catch (err) {
        logger.warn({ err, issueId: issue.id }, "safety gate failed on issue create; proceeding un-gated");
      }
    }

    if (!safetyGated) {
      void queueIssueAssignmentWakeup({
        heartbeat,
        issue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "issue.create",
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
      });
    }
```

> Note: `req.body.description` is the issue body field on `createIssueSchema`. If the validated field name differs in this codebase, use the same field the create payload uses for the issue body; `issue.title` is always present. Confirm by reading `createIssueSchema` near the top of `issues.ts` before finalizing.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @paperclipai/server typecheck`
Expected: succeeds.

- [ ] **Step 4: Run the issue route suite (serialized)**

Run: `pnpm --filter @paperclipai/server exec vitest run src/routes/issues.test.ts`
Expected: PASS — existing issue-create tests still green. (Their `actor` is typically a board/local_implicit user, so the gate runs with the real scorer. If these tests have no `ANTHROPIC_API_KEY`, the scorer fail-closes and the issue is gated — which would change create-flow expectations. If any existing test breaks because of this, inject a stub scorer for the route in test setup, or set `actor.actorType` paths so the gate is exercised deterministically; see Task 4 Step 5.)

- [ ] **Step 5: Guard the route suite against live Claude calls**

To keep route tests hermetic, the gate must not hit the network in CI. Confirm the test harness for `issues.test.ts` does not set `ANTHROPIC_API_KEY`; the scorer then throws (no key) → fail-closed → gated. If existing create tests assert a wakeup/assignment that the gate now suppresses, update those specific tests to either (a) assert the safety card + blocked status for the gated path, or (b) post the create as an agent (`actor.actorType === "agent"`), which the gate skips. Make the minimal change that keeps each test's original intent.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/issues.ts server/src/routes/issues.test.ts
git commit -m "feat(server): gate issue creation through the safety scorer"
```

---

## Task 5: Hook the gate into PM follow-up replies

**Files:**
- Modify: `server/src/routes/issues.ts` — comment handler (~5602–5769)

**Interfaces:**
- Consumes: `evaluateAndGate`, `approvalsSvc`, `svc`, `issueApprovalsSvc`, `currentIssue`, `actor` (all in scope from Task 4 / existing handler).
- The gate runs **after** `svc.addComment` and **before** the comment wakeup block; the wakeup block is skipped when gated.

- [ ] **Step 1: Wrap the comment wakeup in a gate check**

In `router.post("/issues/:id/comments", ...)`, immediately after the `const comment = await svc.addComment(...)` call (~5602) and before the existing wakeup block (~5680), insert:

```typescript
    let safetyGated = false;
    const commentAuthorType = req.body.authorType ?? (actor.actorType === "agent" ? "agent" : "user");
    if (actor.actorType === "user" && commentAuthorType === "user") {
      try {
        const gateResult = await evaluateAndGate(
          {
            companyId: currentIssue.companyId,
            issue: {
              id: currentIssue.id,
              status: currentIssue.status,
              assigneeAgentId: currentIssue.assigneeAgentId,
              title: currentIssue.title,
            },
            requestText: req.body.body,
            requesterUserId: actor.actorId,
          },
          { issuesSvc: svc, approvalsSvc, issueApprovalsSvc },
        );
        safetyGated = gateResult.gated;
      } catch (err) {
        logger.warn({ err, issueId: currentIssue.id }, "safety gate failed on issue reply; proceeding un-gated");
      }
    }
```

Then wrap the **entire** existing comment-wakeup block (the `heartbeat.wakeup(...)` calls for `issue_commented` / `issue_reopened_via_comment` / `issue_comment_mentioned`, lines ~5680–5769) in:

```typescript
    if (!safetyGated) {
      // ... existing wakeup block unchanged ...
    }
```

> Note: `currentIssue.companyId` must be available in this handler. If the handler's issue variable does not expose `companyId`, read it from the loaded issue (the comment handler loads the issue before posting — use that record). Confirm the in-scope variable name (`currentIssue` per the route map) and its fields before editing.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @paperclipai/server typecheck`
Expected: succeeds.

- [ ] **Step 3: Run the comment/reopen route suites (serialized)**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/issue-comment-reopen-routes.test.ts`
Expected: PASS. Apply the same hermetic-test guidance as Task 4 Step 5: user-authored comment tests now route through the gate (fail-closed → gated → wakeup suppressed). Update only the specific assertions that depended on the now-suppressed wakeup, preserving each test's intent (e.g. assert the safety card + `blocked` status, or post the comment as an agent to bypass the gate).

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/issues.ts server/src/__tests__/issue-comment-reopen-routes.test.ts
git commit -m "feat(server): gate PM follow-up replies through the safety scorer"
```

---

## Task 6: Admin-only authorization helper for safety approvals

**Files:**
- Modify: `server/src/routes/authz.ts`
- Test: `server/src/routes/authz.test.ts` (create; if one exists, append)

**Interfaces:**
- Produces:
  - `function canApproveSafety(actor: Request["actor"], companyId: string): boolean`
  - `function assertCanApproveSafety(req: Request, companyId: string): void` (throws `forbidden(...)` when `!canApproveSafety`).
- Consumes: `forbidden` from `../errors.js`.

- [ ] **Step 1: Write the failing tests**

Create `server/src/routes/authz.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { canApproveSafety } from "./authz.js";

const base = { type: "board" as const };

describe("canApproveSafety", () => {
  it("allows an instance admin", () => {
    expect(canApproveSafety({ ...base, isInstanceAdmin: true }, "co1")).toBe(true);
  });

  it("allows the local trusted operator (local_implicit)", () => {
    expect(canApproveSafety({ ...base, source: "local_implicit" }, "co1")).toBe(true);
  });

  it("allows an active owner/admin/manager membership", () => {
    for (const role of ["owner", "admin", "manager"]) {
      expect(
        canApproveSafety({ ...base, memberships: [{ companyId: "co1", membershipRole: role, status: "active" }] }, "co1"),
      ).toBe(true);
    }
  });

  it("rejects operators and viewers", () => {
    for (const role of ["operator", "viewer", "member"]) {
      expect(
        canApproveSafety({ ...base, memberships: [{ companyId: "co1", membershipRole: role, status: "active" }] }, "co1"),
      ).toBe(false);
    }
  });

  it("rejects an admin membership for a different company", () => {
    expect(
      canApproveSafety({ ...base, memberships: [{ companyId: "other", membershipRole: "admin", status: "active" }] }, "co1"),
    ).toBe(false);
  });

  it("rejects a non-active admin membership", () => {
    expect(
      canApproveSafety({ ...base, memberships: [{ companyId: "co1", membershipRole: "admin", status: "suspended" }] }, "co1"),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @paperclipai/server exec vitest run src/routes/authz.test.ts`
Expected: FAIL — `canApproveSafety` is not exported.

- [ ] **Step 3: Implement the helper**

In `server/src/routes/authz.ts`, add the `forbidden` import (alongside existing error imports) and append:

```typescript
import { forbidden } from "../errors.js";

const SAFETY_APPROVER_ROLES = new Set(["owner", "admin", "manager"]);

export function canApproveSafety(actor: Request["actor"], companyId: string): boolean {
  if (actor.isInstanceAdmin) return true;
  if (actor.source === "local_implicit") return true;
  const memberships = actor.memberships ?? [];
  return memberships.some(
    (m) => m.companyId === companyId && m.status === "active" && SAFETY_APPROVER_ROLES.has(m.membershipRole ?? ""),
  );
}

export function assertCanApproveSafety(req: Request, companyId: string): void {
  if (!canApproveSafety(req.actor, companyId)) {
    throw forbidden("Admin or owner approval required for safety review");
  }
}
```

> If `forbidden` is already imported in `authz.ts`, don't duplicate the import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @paperclipai/server exec vitest run src/routes/authz.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/authz.ts server/src/routes/authz.test.ts
git commit -m "feat(server): add admin-only authorization helper for safety reviews"
```

---

## Task 7: Approvals approve/reject — restrict + resume/decline

**Files:**
- Modify: `server/src/routes/approvals.ts` — imports (~1–21), approve handler (136–230), reject handler (232–255)
- Test: extend the existing approvals route test (search `server/src/__tests__/` for the approvals route test, e.g. `approvals*.test.ts`) or create `server/src/__tests__/approvals-safety-review.test.ts`

**Interfaces:**
- Consumes: `assertCanApproveSafety` (Task 6), `issueService` (for status restore + cards), `svc.getById`/`svc.approve`/`svc.reject`, `issueApprovalsSvc.listIssuesForApproval`, the existing `heartbeat.wakeup` resume path.
- Behavior: for `type === "safety_review_required"` — both handlers require an admin/owner approver; approve restores each linked `blocked` issue to its `payload.priorStatus` and posts a success card (the existing `requestedByAgentId` wakeup then wakes the assignee); reject posts a danger "Declined" card and leaves the issue blocked.

- [ ] **Step 1: Add imports + instantiate the issues service**

In `server/src/routes/approvals.ts`, import the helper and issues service:

```typescript
import { assertBoard, assertCompanyAccess, getActorInfo, assertCanApproveSafety } from "./authz.js";
import { issueService } from "../services/issues.js";
```

Near `const issueApprovalsSvc = issueApprovalService(db);` (~line 39), add:

```typescript
  const issuesSvc = issueService(db);
```

- [ ] **Step 2: Restrict + resume in the approve handler**

In `POST /approvals/:id/approve`, after the `requireApprovalAccess` check (line ~139) and before `svc.approve` (~144), fetch the approval and enforce the admin gate for the safety type:

```typescript
    const existing = await svc.getById(id);
    if (existing?.type === "safety_review_required") {
      assertCanApproveSafety(req, existing.companyId);
    }
```

Then, inside the existing `if (applied) {` block, **before** the existing `if (approval.requestedByAgentId) {` wakeup, insert the resume logic:

```typescript
      if (approval.type === "safety_review_required") {
        const priorStatus =
          typeof approval.payload?.priorStatus === "string" ? (approval.payload.priorStatus as string) : "todo";
        const approverName = req.actor.userName ?? req.actor.userEmail ?? "an admin";
        const linked = await issueApprovalsSvc.listIssuesForApproval(approval.id);
        for (const iss of linked) {
          if (iss.status === "blocked") {
            await issuesSvc.update(iss.id, { status: priorStatus });
          }
          await issuesSvc.addComment(
            iss.id,
            `**Safety review approved by ${approverName}.** Work resumed.`,
            {},
            {
              authorType: "system",
              presentation: { kind: "system_notice", tone: "success", title: "Safety review approved", detailsDefaultOpen: false },
            },
          );
        }
      }
```

> The existing `heartbeat.wakeup(approval.requestedByAgentId, ...)` block that follows already wakes the assignee (the gate set `requestedByAgentId = issue.assigneeAgentId`). Restoring the status *before* that wakeup ensures the agent picks up an actionable issue. Do not add a second wakeup.

- [ ] **Step 3: Restrict + decline card in the reject handler**

In `POST /approvals/:id/reject`, after `requireApprovalAccess` (line ~235) and before `svc.reject` (~239), add the same admin gate:

```typescript
    const existing = await svc.getById(id);
    if (existing?.type === "safety_review_required") {
      assertCanApproveSafety(req, existing.companyId);
    }
```

Inside the existing `if (applied) {` block (after the `logActivity` call), add the decline card:

```typescript
      if (approval.type === "safety_review_required") {
        const approverName = req.actor.userName ?? req.actor.userEmail ?? "an admin";
        const linked = await issueApprovalsSvc.listIssuesForApproval(approval.id);
        for (const iss of linked) {
          await issuesSvc.addComment(
            iss.id,
            `**Safety review declined by ${approverName}.** This change will not proceed.`,
            {},
            {
              authorType: "system",
              presentation: { kind: "system_notice", tone: "danger", title: "Safety review declined", detailsDefaultOpen: false },
            },
          );
        }
      }
```

- [ ] **Step 4: Write the route test**

Create `server/src/__tests__/approvals-safety-review.test.ts`, mirroring the harness used by the existing approvals route test (same app-builder / seed helpers). Cover:

```typescript
// Pseudocode shape — fill in with the existing approvals-route test harness helpers:
// 1. Seed a company, an Editor agent, an issue assigned to that agent, and a
//    pending `safety_review_required` approval linked to the issue, with the issue blocked
//    and payload.priorStatus = "todo".
// 2. As an OPERATOR membership (board actor, membershipRole "operator"): POST approve → expect 403; POST reject → expect 403.
// 3. As an ADMIN membership (or instance admin / local_implicit): POST approve → expect 200;
//    reload the issue → status === "todo"; expect a system_notice "Safety review approved" comment.
// 4. As an ADMIN: on a fresh blocked+pending fixture, POST reject → expect 200;
//    reload the issue → status === "blocked"; expect a system_notice "Safety review declined" comment.
```

Use the concrete request/seed helpers from the existing approvals test file (do not invent new ones). Assert HTTP status codes and the resulting issue status + the presence of the system-notice comment.

- [ ] **Step 5: Run the approvals route suite (serialized)**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/approvals-safety-review.test.ts`
Expected: PASS. Also re-run the existing approvals route suite to confirm non-safety types are unaffected:
`pnpm --filter @paperclipai/server exec vitest run src/__tests__/approvals.test.ts` (use the actual existing filename).

- [ ] **Step 6: Typecheck + commit**

```bash
git add server/src/routes/approvals.ts server/src/__tests__/approvals-safety-review.test.ts
git commit -m "feat(server): admin-gate and resume/decline safety-review approvals"
```

---

## Task 8: UI — approval-type label, icon, and payload renderer

**Files:**
- Modify: `ui/src/components/ApprovalPayload.tsx` (labels ~5–8, icons ~40–43, dispatcher ~241–243)
- Test: `ui/src/components/ApprovalPayload.test.tsx` (extend existing)

**Interfaces:**
- Consumes: `ApprovalType` (now includes `"safety_review_required"` from Task 1); the approval `payload` shape `{ score, reasoning, factors, degraded, priorStatus, issueId }` written by the gate (Task 3).
- The score card itself (the `system_notice` comment) already renders via `SystemNoticeCommentRow` in both views — no change needed there. This task only adds the label/icon/payload for the **approval** surfaces (ApprovalCard / ApprovalDetail / Inbox).

- [ ] **Step 1: Write the failing test**

Append to `ui/src/components/ApprovalPayload.test.tsx`:

```typescript
it("labels and renders a safety_review_required payload with the score and reasoning", () => {
  expect(approvalLabel("safety_review_required")).toBe("Safety Review");
  const { container } = render(
    <ApprovalPayload
      type="safety_review_required"
      payload={{ score: 8, reasoning: "Touches a backend service", factors: ["backend", "multi-page"], priorStatus: "todo" }}
    />,
  );
  expect(container.textContent).toContain("8/10");
  expect(container.textContent).toContain("Touches a backend service");
  expect(container.textContent).toContain("backend");
});
```

> Match the existing test's import names for `approvalLabel` / `ApprovalPayload` / `render` (the file already imports them for the `request_board_approval` cases).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/components/ApprovalPayload.test.tsx`
Expected: FAIL — no `"Safety Review"` label / no `safety_review_required` renderer.

- [ ] **Step 3: Add the label, icon, and renderer**

In `ui/src/components/ApprovalPayload.tsx`:

Add to the label map (near line 5–8):

```typescript
  safety_review_required: "Safety Review",
```

Add to the icon map (near line 40–43; import an existing lucide icon already used in the file, e.g. `ShieldAlert`):

```typescript
  safety_review_required: ShieldAlert,
```

Add a payload component and wire it into the dispatcher (near line 241–243):

```tsx
function SafetyReviewPayload({ payload }: { payload: Record<string, unknown> }) {
  const score = typeof payload.score === "number" ? payload.score : null;
  const reasoning = typeof payload.reasoning === "string" ? payload.reasoning : "";
  const factors = Array.isArray(payload.factors) ? (payload.factors as unknown[]).map(String) : [];
  return (
    <div className="space-y-2">
      {score !== null && <div className="text-lg font-semibold">Safety score: {score}/10</div>}
      {reasoning && <p className="text-sm">{reasoning}</p>}
      {factors.length > 0 && (
        <ul className="list-disc pl-5 text-sm">
          {factors.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

In the dispatcher (the `if (type === "...")` chain near 241–243), add:

```tsx
  if (type === "safety_review_required") return <SafetyReviewPayload payload={payload} />;
```

> Use the file's existing Tailwind class conventions; match the styling of the neighboring payload components rather than the placeholder classes above if they differ.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/components/ApprovalPayload.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck UI + commit**

```bash
pnpm --filter @paperclipai/ui typecheck
git add ui/src/components/ApprovalPayload.tsx ui/src/components/ApprovalPayload.test.tsx
git commit -m "feat(ui): label and render safety_review_required approvals"
```

---

## Final Verification (before handoff / deploy)

- [ ] **Whole-repo typecheck:** `pnpm -r typecheck` — passes.
- [ ] **Targeted test run:** the new/affected suites pass —
  `pnpm --filter @paperclipai/shared exec vitest run src/__tests__/constants.test.ts` and
  `pnpm --filter @paperclipai/server exec vitest run src/services/safety-scorer.test.ts src/services/safety-gate.test.ts src/routes/authz.test.ts src/__tests__/approvals-safety-review.test.ts` and
  `pnpm --filter @paperclipai/ui exec vitest run src/components/ApprovalPayload.test.tsx`.
- [ ] **Full test + build (PR-ready):** `pnpm test:run && pnpm build` — passes (Docker build chain must succeed; recall the plugin-sdk fixture / build pitfalls noted in prior deploys).
- [ ] **No migration:** confirm `git status` shows no new file under `packages/db/src/migrations/` — this feature reuses `approvals` + `issue_approvals` and adds only a shared constant + code.

## Deploy (per established pipeline)

- Commit on `master`, push to the fork via the `navarino-dev` gh account, rebuild + restart the server container (Hetzner docker-compose). `ANTHROPIC_API_KEY` is already in the server container; no env change needed.
- **Smoke test after deploy:**
  1. Submit a low-risk PM request ("change the hero headline") → expect a green **Safety X/10 — Cleared to proceed** card and the Editor agent to start work.
  2. Submit a high-risk PM request ("rebuild the booking system with a new backend database") → expect a **Safety X/10 — Needs admin approval** card, the issue `blocked`, and a pending approval; the Editor does **not** start.
  3. As an operator/PM account: confirm approve/reject of that approval returns 403.
  4. As the Admin Dev account: approve it → the issue resumes (status restored, Editor woken) and an **approved** card appears.
```
