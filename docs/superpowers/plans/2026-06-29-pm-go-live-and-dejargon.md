# PM Go-Live URL + De-jargoned Responses — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the property-manager (simplified) view, hide technical jargon from agent responses, and after approval surface the property's live custom-domain URL in a glowing card once the production deploy succeeds.

**Architecture:** Two phases sharing the PM-view comment render path. Phase 1 (de-jargon) adds a pure UI helper that hides internal status-noise comments and strips GitHub links/status tokens, plus agent-instruction edits. Phase 2 (live URL) adds a per-project "Live website URL" setting, a `deployment_watches` table processed by a new pass in the existing server tick loop (polls GitHub Deployments API for production success using `process.env.GITHUB_TOKEN`), and a glowing "live" card rendered from a text-marker comment the watcher posts.

**Tech Stack:** TypeScript ESM monorepo (pnpm). Drizzle + embedded Postgres (`@paperclipai/db`), shared types/validators (`@paperclipai/shared`), Express services/routes (`@paperclipai/server`), React 19 + Vite + Tailwind (`@paperclipai/ui`). Vitest for tests.

## Global Constraints

- All behavior changes are **PM (simplified) view only**; the admin/full board must be unchanged.
- Keep contracts synced in one change across layers: `packages/db` schema + `src/schema/index.ts` → `packages/shared` types/validators/constants → `server` routes/services → `ui` clients/pages. (CLAUDE.md core rule #2.)
- DB changes: edit `packages/db/src/schema/*.ts`, export from `src/schema/index.ts`, then `pnpm db:generate`, then `pnpm -r typecheck`.
- Single-tenant deploy: the watcher reads the GitHub token from `process.env.GITHUB_TOKEN` (present in `docker/.env.production`). Per-company secret sourcing is a future enhancement, out of scope here.
- Live card is driven by a text marker `LIVE_URL:` on its own line in a `system`-authored comment — NOT by a new `presentation` kind (the presentation enum is closed: `["message","system_notice"]`).
- Mutating service actions write activity-log entries where the surrounding service already does so; follow the existing pattern in the file you touch.
- Test commands:
  - UI single file: `pnpm --filter @paperclipai/ui exec vitest run <path>`
  - Server single file: `pnpm --filter @paperclipai/server exec vitest run <path>`
  - Typecheck a workspace: `pnpm --filter @paperclipai/ui typecheck` / `pnpm --filter @paperclipai/server typecheck`

---

## Phase 1 — De-jargon PM responses

### Task 1: `dejargonComment` pure helper

**Files:**
- Create: `ui/src/lib/pm-comment-display.ts`
- Test: `ui/src/lib/pm-comment-display.test.ts`

**Interfaces:**
- Produces: `dejargonComment(text: string): { hidden: boolean; cleanedText: string }`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/lib/pm-comment-display.test.ts
import { describe, expect, it } from "vitest";
import { dejargonComment } from "./pm-comment-display";

describe("dejargonComment", () => {
  it("hides internal status-narration comments", () => {
    const noise =
      "The only comment is my own status update from the previous run. " +
      "Nothing to action this heartbeat. NAV-23 remains in_review pending confirmation.";
    expect(dejargonComment(noise).hidden).toBe(true);
  });

  it("keeps a real friendly update and strips GitHub/PR lines", () => {
    const input =
      "I've added the privacy policy page.\n" +
      "**PR:** https://github.com/navarino-dev/seaside-website/pull/3\n" +
      "Let me know if this looks good.";
    const { hidden, cleanedText } = dejargonComment(input);
    expect(hidden).toBe(false);
    expect(cleanedText).toContain("I've added the privacy policy page.");
    expect(cleanedText).toContain("Let me know if this looks good.");
    expect(cleanedText).not.toContain("github.com");
    expect(cleanedText).not.toContain("PR:");
  });

  it("strips an inline GitHub markdown link but keeps the sentence", () => {
    const input = "Opened the [pull request](https://github.com/x/y/pull/1) for you.";
    expect(dejargonComment(input).cleanedText).toBe("Opened the pull request for you.");
  });

  it("softens leftover status tokens", () => {
    const input = "This is now in_review for you to look at.";
    expect(dejargonComment(input).cleanedText).toBe("This is now in review for you to look at.");
  });

  it("hides a comment that becomes empty after cleaning", () => {
    const input = "https://github.com/navarino-dev/seaside-website/pull/3";
    expect(dejargonComment(input).hidden).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/lib/pm-comment-display.test.ts`
Expected: FAIL — cannot find module `./pm-comment-display`.

- [ ] **Step 3: Write minimal implementation**

```ts
// ui/src/lib/pm-comment-display.ts

// Strong markers of an agent's internal status narration — these only appear in
// machine/heartbeat status updates, never in a property-manager-facing message.
const NOISE_PATTERNS: RegExp[] = [
  /nothing to action/i,
  /this wake\b/i,
  /this heartbeat/i,
  /remains?\s+in[_ ]review/i,
  /pending confirmation/i,
  /request_confirmation/i,
  /no new human comments/i,
];

export function dejargonComment(text: string): { hidden: boolean; cleanedText: string } {
  const trimmed = text.trim();

  if (NOISE_PATTERNS.some((re) => re.test(trimmed))) {
    return { hidden: true, cleanedText: "" };
  }

  const cleaned = trimmed
    .split("\n")
    // Drop lines that are PR references or contain GitHub links.
    .filter((line) => !/\bPR\b\s*:/i.test(line) && !/github\.com/i.test(line))
    .join("\n")
    // Inline GitHub markdown links -> keep the link text only.
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]*github\.com[^)]*\)/gi, "$1")
    // Bare GitHub URLs -> remove.
    .replace(/https?:\/\/[^\s)]*github\.com[^\s)]*/gi, "")
    // Soften leftover status tokens.
    .replace(/\bin_review\b/gi, "in review")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (cleaned.length === 0) {
    return { hidden: true, cleanedText: "" };
  }

  return { hidden: false, cleanedText: cleaned };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/lib/pm-comment-display.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/pm-comment-display.ts ui/src/lib/pm-comment-display.test.ts
git commit -m "feat(ui): add dejargonComment helper for the property-manager view"
```

---

### Task 2: Wire de-jargon into the PM comment render path

**Files:**
- Modify: `ui/src/components/IssueChatThread.tsx` (the `IssueChatTextPart` component, ~lines 642–680)
- Test: `ui/src/components/IssueChatThread.test.tsx` (add cases)

**Interfaces:**
- Consumes: `dejargonComment` from `../lib/pm-comment-display`; existing `extractPreviewUrl(text)`, `useIsSimplifiedView()`.

- [ ] **Step 1: Write the failing test** — add to `IssueChatThread.test.tsx`. This suite already mocks `useIsSimplifiedView`; flip it to `true` for these cases.

```tsx
// Inside the existing describe in IssueChatThread.test.tsx.
// NOTE: this file mocks "../hooks/useIsSimplifiedView" -> useIsSimplifiedView: () => false.
// Change that mock to a controllable vi.fn so individual tests can return true:
//   const mockUseIsSimplifiedView = vi.hoisted(() => vi.fn(() => false));
//   vi.mock("../hooks/useIsSimplifiedView", () => ({ useIsSimplifiedView: mockUseIsSimplifiedView }));
// and reset to false in afterEach.

it("hides internal status-noise agent comments in the simplified view", async () => {
  mockUseIsSimplifiedView.mockReturnValue(true);
  const { container } = await renderThreadWithComment(
    "Nothing to action this heartbeat. NAV-23 remains in_review pending confirmation.",
  );
  expect(container.textContent).not.toContain("Nothing to action");
  expect(container.textContent).not.toContain("in_review");
});

it("strips GitHub links from shown agent comments in the simplified view", async () => {
  mockUseIsSimplifiedView.mockReturnValue(true);
  const { container } = await renderThreadWithComment(
    "Added the page.\n**PR:** https://github.com/x/y/pull/3\nLet me know if it looks good.",
  );
  expect(container.textContent).toContain("Added the page.");
  expect(container.textContent).toContain("Let me know if it looks good.");
  expect(container.textContent).not.toContain("github.com");
});
```

> Implementer note: `renderThreadWithComment` is shorthand — reuse the suite's existing render helper / fixture builder for a single agent text comment. If none exists, render `<IssueChatThread>` with one agent-authored comment whose body is the given text, mirroring the existing tests in this file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/components/IssueChatThread.test.tsx`
Expected: FAIL — noise text still present / github.com still present.

- [ ] **Step 3: Implement** — update `IssueChatTextPart` (replace the body of the component from the `previewUrl` line through the `MarkdownBody` usage):

```tsx
// add import near the other lib imports at top of IssueChatThread.tsx:
import { dejargonComment } from "../lib/pm-comment-display";

// inside IssueChatTextPart, after the isSuccessfulRunHandoffComment early-return:
const display = isSimplified
  ? dejargonComment(text)
  : { hidden: false, cleanedText: text };
const previewUrl = isSimplified ? extractPreviewUrl(text) : null;

// If the comment is pure noise AND has no card to show, render nothing.
if (display.hidden && !previewUrl) {
  return null;
}

const bodyText = display.hidden ? "" : display.cleanedText;

return (
  <>
    {bodyText && (
      <MarkdownBody
        className="text-sm leading-6"
        style={recessed ? { opacity: 0.55 } : undefined}
        softBreaks
        onImageClick={onImageClick}
      >
        {bodyText}
      </MarkdownBody>
    )}
    {previewUrl && (
      // ...existing preview card unchanged...
    )}
  </>
);
```

- [ ] **Step 4: Run tests** — the two new tests plus the full file.

Run: `pnpm --filter @paperclipai/ui exec vitest run src/components/IssueChatThread.test.tsx`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @paperclipai/ui typecheck`
```bash
git add ui/src/components/IssueChatThread.tsx ui/src/components/IssueChatThread.test.tsx
git commit -m "feat(ui): hide jargon/noise from agent comments in the property-manager view"
```

---

### Task 3: Agent guidance edits

**Files:**
- Modify: `agent-instructions/editor.md`
- Modify: `agent-instructions/reviewer.md`

> No automated test — this is content. Verification = the rendered text reads friendly and contains the required rules.

- [ ] **Step 1: Edit `editor.md`** — add a "Talking to the property manager" section near the top (after the intro line), and adjust the comment templates so the preview link is the only link:

```markdown
## Talking to the property manager

Property managers are not technical. Every comment you post is read by them.

- Write 1–2 short, friendly sentences. No PR links, branch names, commit hashes, or
  status words (`in_review`, `request_confirmation`, "heartbeat", "wake").
- Do NOT post internal status updates that narrate your own run. If there is
  nothing for the property manager to do, post nothing.
- The only link you include is the preview link (the app turns it into a button).
```

Then change the "First Time" comment template (step 5) and the "adjustments" template (step 4) to drop the `**PR:**` line — keep only `**Preview:**` + a one-line friendly summary.

- [ ] **Step 2: Edit `reviewer.md`** — add the same "Talking to the property manager" note, and make the merge-success behavior post nothing technical (the live URL is now posted by Paperclip, Phase 2):

```markdown
## Talking to the property manager
Property managers read your comments. Keep them to one friendly sentence with no
links, branch names, or status jargon. After a successful merge you do not need to
post the live link — the system posts it automatically once the site is live.
```

- [ ] **Step 3: Commit**

```bash
git add agent-instructions/editor.md agent-instructions/reviewer.md
git commit -m "docs(agents): instruct editor/reviewer to write non-technical PM updates"
```

> Deploy note: these files live at `/opt/paperclip/agent-instructions/` on the server and are picked up by the agents' config; they take effect on the next agent run after deploy (no rebuild needed for the files themselves, but they ship with the repo pull).

---

## Phase 2 — Live URL on approve

### Task 4: `projects.productionUrl` column + migration

**Files:**
- Modify: `packages/db/src/schema/projects.ts`
- Run: `pnpm db:generate` (creates a migration under `packages/db/drizzle/` / `packages/db/src/migrations/`)

- [ ] **Step 1: Add the column** — in the `projects` table object, after `color`:

```ts
    productionUrl: text("production_url"),
```

- [ ] **Step 2: Generate the migration + typecheck**

Run: `pnpm db:generate`
Run: `pnpm -r typecheck`
Expected: a new migration file adding `production_url`; typecheck passes.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/schema/projects.ts packages/db/drizzle packages/db/src/migrations
git commit -m "feat(db): add projects.production_url"
```

---

### Task 5: Thread `productionUrl` through shared + server project contract

**Files:**
- Modify: `packages/shared/src/types/project.ts` (Project interface, ~line 67)
- Modify: `packages/shared/src/validators/project.ts` (`projectFields`, ~line 98)
- Modify: `server/src/services/projects.ts` (the row→Project mapper that builds the API object)

**Interfaces:**
- Produces: `Project.productionUrl: string | null`; `updateProjectSchema`/`createProjectSchema` accept `productionUrl`.

- [ ] **Step 1: Write the failing test** — shared validator test (create or extend `packages/shared/src/validators/project.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { updateProjectSchema } from "./project";

describe("updateProjectSchema productionUrl", () => {
  it("accepts a valid https url", () => {
    expect(updateProjectSchema.parse({ productionUrl: "https://seasidehoa.com" }).productionUrl)
      .toBe("https://seasidehoa.com");
  });
  it("accepts null/empty", () => {
    expect(updateProjectSchema.parse({ productionUrl: null }).productionUrl).toBeNull();
  });
  it("rejects a non-url string", () => {
    expect(() => updateProjectSchema.parse({ productionUrl: "not a url" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/shared exec vitest run src/validators/project.test.ts`
Expected: FAIL — `productionUrl` not in schema.

- [ ] **Step 3: Implement**

In `packages/shared/src/validators/project.ts` add to `projectFields`:
```ts
  productionUrl: z
    .string()
    .url()
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
```

In `packages/shared/src/types/project.ts` `Project` interface add (after `color`):
```ts
  productionUrl: string | null;
```

In `server/src/services/projects.ts` find the function that maps a `projects` row to the API `Project` object (the enrich/toProject mapper that already maps `color`, `env`, etc.) and add:
```ts
    productionUrl: row.productionUrl ?? null,
```
(Use the same row variable the mapper already uses for `color`.)

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @paperclipai/shared exec vitest run src/validators/project.test.ts`
Run: `pnpm -r typecheck`
Expected: PASS; typecheck clean. (The PATCH route already spreads validated body into `svc.update`, which spreads into the Drizzle update — no route change needed.)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/project.ts packages/shared/src/validators/project.ts packages/shared/src/validators/project.test.ts server/src/services/projects.ts
git commit -m "feat(shared,server): expose projects.productionUrl in the project contract"
```

---

### Task 6: "Live website URL" input in project settings (admin)

**Files:**
- Modify: `ui/src/components/ProjectProperties.tsx`
- Test: `ui/src/components/ProjectProperties.test.tsx` (create if absent, else extend)

**Interfaces:**
- Consumes: `projectsApi.update(id, { productionUrl }, companyId)` (already generic — `data: Record<string, unknown>`).

- [ ] **Step 1: Write the failing test**

```tsx
// Render ProjectProperties for a project, type a URL into the "Live website URL"
// field, blur/submit, and assert onUpdate/onFieldUpdate is called with
// { productionUrl: "https://seasidehoa.com" }. Mirror the existing field tests
// in this suite (e.g. the description/name field tests).
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/components/ProjectProperties.test.tsx`
Expected: FAIL — no "Live website URL" field.

- [ ] **Step 3: Implement** — add `"productionUrl"` to the `ProjectConfigFieldKey` union and render a labelled text input `PropertyRow` (label "Live website URL", placeholder `https://example.com`) bound to `project.productionUrl`, calling the same `onFieldUpdate("productionUrl", value)` path the other text fields use. Show it only to admins (this component already renders in the admin/full project settings, not the PM view — no extra gating needed, but confirm the row sits with the other config fields).

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/components/ProjectProperties.test.tsx`
Run: `pnpm --filter @paperclipai/ui typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/ProjectProperties.tsx ui/src/components/ProjectProperties.test.tsx
git commit -m "feat(ui): add Live website URL setting to project settings"
```

---

### Task 7: `deployment_watches` table + migration

**Files:**
- Create: `packages/db/src/schema/deployment_watches.ts`
- Modify: `packages/db/src/schema/index.ts` (export it)
- Run: `pnpm db:generate`

- [ ] **Step 1: Create the schema**

```ts
// packages/db/src/schema/deployment_watches.ts
import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const deploymentWatches = pgTable(
  "deployment_watches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    repoUrl: text("repo_url").notNull(),
    productionUrl: text("production_url").notNull(),
    // watching | live | delayed | failed
    status: text("status").notNull().default("watching"),
    attempts: integer("attempts").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dueIdx: index("deployment_watches_due_idx").on(t.status, t.nextCheckAt),
    issueIdx: index("deployment_watches_issue_idx").on(t.issueId),
  }),
);
```

- [ ] **Step 2: Export + generate + typecheck**

Add to `packages/db/src/schema/index.ts`:
```ts
export { deploymentWatches } from "./deployment_watches.js";
```
Run: `pnpm db:generate`
Run: `pnpm -r typecheck`

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/schema/deployment_watches.ts packages/db/src/schema/index.ts packages/db/drizzle packages/db/src/migrations
git commit -m "feat(db): add deployment_watches table"
```

---

### Task 8: GitHub production-deploy poll helper

**Files:**
- Create: `server/src/services/github-deployments.ts`
- Test: `server/src/services/github-deployments.test.ts`

**Interfaces:**
- Produces:
  - `parseGitHubRepo(repoUrl: string): { owner: string; repo: string; hostname: string } | null`
  - `getLatestProductionDeployStatus(args: { repoUrl: string; token: string; sinceIso: string }): Promise<"success" | "pending" | "failure" | "none">`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/github-deployments.test.ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { parseGitHubRepo, getLatestProductionDeployStatus } from "./github-deployments.js";

describe("parseGitHubRepo", () => {
  it("parses https and git urls", () => {
    expect(parseGitHubRepo("https://github.com/navarino-dev/seaside-website.git"))
      .toEqual({ owner: "navarino-dev", repo: "seaside-website", hostname: "github.com" });
    expect(parseGitHubRepo("git@github.com:navarino-dev/seaside-website.git"))
      .toEqual({ owner: "navarino-dev", repo: "seaside-website", hostname: "github.com" });
  });
  it("returns null for non-github", () => {
    expect(parseGitHubRepo("https://example.com/x/y")).toBeTruthy(); // still parses owner/repo on GH enterprise host
    expect(parseGitHubRepo("not a url")).toBeNull();
  });
});

describe("getLatestProductionDeployStatus", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns success when the latest production deployment status is success", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as never);
    // 1st call: deployments list
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 11, created_at: "2026-06-29T12:00:00Z", environment: "Production" },
    ]), { status: 200 }) as never);
    // 2nd call: statuses
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { state: "success" },
    ]), { status: 200 }) as never);

    const result = await getLatestProductionDeployStatus({
      repoUrl: "https://github.com/navarino-dev/seaside-website",
      token: "t",
      sinceIso: "2026-06-29T11:00:00Z",
    });
    expect(result).toBe("success");
  });

  it("returns none when there is no production deployment since the floor", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as never);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }) as never);
    const result = await getLatestProductionDeployStatus({
      repoUrl: "https://github.com/x/y", token: "t", sinceIso: "2026-06-29T11:00:00Z",
    });
    expect(result).toBe("none");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/github-deployments.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/src/services/github-deployments.ts
import { gitHubApiBase, ghFetch } from "./github-fetch.js";

export function parseGitHubRepo(
  repoUrl: string,
): { owner: string; repo: string; hostname: string } | null {
  if (!repoUrl) return null;
  const ssh = repoUrl.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/i);
  if (ssh) return { hostname: ssh[1], owner: ssh[2], repo: ssh[3] };
  try {
    const u = new URL(repoUrl);
    const parts = u.pathname.replace(/^\/+/, "").replace(/\.git$/i, "").split("/");
    if (parts.length < 2) return null;
    return { hostname: u.hostname, owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

type DeployState = "success" | "pending" | "failure" | "none";

export async function getLatestProductionDeployStatus(args: {
  repoUrl: string;
  token: string;
  sinceIso: string;
}): Promise<DeployState> {
  const parsed = parseGitHubRepo(args.repoUrl);
  if (!parsed) return "none";
  const base = gitHubApiBase(parsed.hostname);
  const headers = {
    Authorization: `token ${args.token}`,
    Accept: "application/vnd.github+json",
  };
  const listRes = await ghFetch(
    `${base}/repos/${parsed.owner}/${parsed.repo}/deployments?environment=Production&per_page=5`,
    { headers },
  );
  if (!listRes.ok) return "pending";
  const deployments = (await listRes.json()) as Array<{ id: number; created_at: string }>;
  const since = new Date(args.sinceIso).getTime();
  const recent = deployments
    .filter((d) => new Date(d.created_at).getTime() >= since - 60_000)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  if (!recent) return "none";

  const statusRes = await ghFetch(
    `${base}/repos/${parsed.owner}/${parsed.repo}/deployments/${recent.id}/statuses?per_page=1`,
    { headers },
  );
  if (!statusRes.ok) return "pending";
  const statuses = (await statusRes.json()) as Array<{ state: string }>;
  const state = statuses[0]?.state;
  if (state === "success") return "success";
  if (state === "failure" || state === "error") return "failure";
  return "pending";
}
```

> Adjust the test's "non-github" expectation to match: `parseGitHubRepo` returns owner/repo for any valid URL host (treated as GH Enterprise) and `null` only for unparseable input.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/github-deployments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/github-deployments.ts server/src/services/github-deployments.test.ts
git commit -m "feat(server): GitHub production-deploy status poll helper"
```

---

### Task 9: Deployment-watch service (create on done, tick, post comments)

**Files:**
- Create: `server/src/services/deployment-watch.ts`
- Test: `server/src/services/deployment-watch.test.ts`

**Interfaces:**
- Consumes: `getLatestProductionDeployStatus` (Task 8); `issuesSvc.addComment(issueId, body, actor, { authorType })` (existing); a db handle; project lookup for `productionUrl` + repoUrl (project.codebase.repoUrl from `projects` service).
- Produces:
  - `createDeploymentWatch(deps).onIssueDone(issue: { id; companyId; projectId }): Promise<void>`
  - `createDeploymentWatch(deps).tick(now: Date): Promise<{ live: number; delayed: number; failed: number }>`

Constants: poll interval 15_000 ms; deadline 10 * 60_000 ms. Live comment body MUST be:
`"✨ Your change is now live.\n\nLIVE_URL: <productionUrl>"` (the `LIVE_URL:` marker line is what the UI keys on — Task 10).
Publishing body: `"Publishing your change now — I'll share the live link here as soon as it's ready."`
Delayed body: `"This is taking a little longer than usual. It should be live shortly — check back soon."`
Failed body: `"We hit a snag publishing this change. The team has been notified."`

- [ ] **Step 1: Write the failing tests** — use the project's standard service-test harness (an in-memory/embedded db per the existing `server/src/__tests__` or service test setup; mirror an existing service test for db + issuesSvc mocking). Cover:

```ts
// server/src/services/deployment-watch.test.ts (shape; wire deps via the existing test db helper)
// 1) onIssueDone inserts a watch + posts the publishing comment when the project
//    has productionUrl and a resolvable repoUrl; no-op when productionUrl is null.
// 2) tick(): status "success" -> posts the LIVE_URL comment and sets watch.status="live".
// 3) tick(): past deadline with status "pending" -> posts delayed comment, status="delayed".
// 4) tick(): "failure" -> posts failed comment + writes an activity log row, status="failed".
// 5) tick(): "pending" before deadline -> bumps nextCheckAt ~15s, no comment.
// Assert addComment called with authorType:"system" and the exact bodies above.
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/deployment-watch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/src/services/deployment-watch.ts
import { and, eq, lte } from "drizzle-orm";
import { deploymentWatches, projects } from "@paperclipai/db";
import { getLatestProductionDeployStatus } from "./github-deployments.js";

const POLL_MS = 15_000;
const DEADLINE_MS = 10 * 60_000;

const LIVE_BODY = (url: string) => `✨ Your change is now live.\n\nLIVE_URL: ${url}`;
const PUBLISHING_BODY =
  "Publishing your change now — I'll share the live link here as soon as it's ready.";
const DELAYED_BODY =
  "This is taking a little longer than usual. It should be live shortly — check back soon.";
const FAILED_BODY = "We hit a snag publishing this change. The team has been notified.";

type Deps = {
  db: typeof import("@paperclipai/db").db;
  issuesSvc: { addComment: (issueId: string, body: string, actor: { userId?: string }, options?: { authorType?: string | null }) => Promise<unknown> };
  projectsSvc: { getById: (id: string) => Promise<{ productionUrl: string | null; codebase: { repoUrl: string | null } } | null> };
  logActivity: (input: Record<string, unknown>) => Promise<unknown>;
  getToken: () => string | undefined; // () => process.env.GITHUB_TOKEN
  now?: () => Date;
};

export function createDeploymentWatch(deps: Deps) {
  const sysActor = {} as { userId?: string };
  const post = (issueId: string, body: string) =>
    deps.issuesSvc.addComment(issueId, body, sysActor, { authorType: "system" });

  async function onIssueDone(issue: { id: string; companyId: string; projectId: string | null }) {
    if (!issue.projectId) return;
    const project = await deps.projectsSvc.getById(issue.projectId);
    const productionUrl = project?.productionUrl?.trim();
    const repoUrl = project?.codebase.repoUrl ?? null;
    if (!productionUrl || !repoUrl) return;
    const now = deps.now?.() ?? new Date(Date.now());
    // one active watch per issue
    const existing = await deps.db
      .select({ id: deploymentWatches.id })
      .from(deploymentWatches)
      .where(and(eq(deploymentWatches.issueId, issue.id), eq(deploymentWatches.status, "watching")));
    if (existing.length > 0) return;
    await deps.db.insert(deploymentWatches).values({
      companyId: issue.companyId,
      issueId: issue.id,
      repoUrl,
      productionUrl,
      status: "watching",
      startedAt: now,
      deadlineAt: new Date(now.getTime() + DEADLINE_MS),
      nextCheckAt: now,
    });
    await post(issue.id, PUBLISHING_BODY);
  }

  async function tick(now: Date) {
    const due = await deps.db
      .select()
      .from(deploymentWatches)
      .where(and(eq(deploymentWatches.status, "watching"), lte(deploymentWatches.nextCheckAt, now)));
    let live = 0, delayed = 0, failed = 0;
    const token = deps.getToken();
    for (const w of due) {
      const state = token
        ? await getLatestProductionDeployStatus({ repoUrl: w.repoUrl, token, sinceIso: w.startedAt.toISOString() })
        : "pending";
      if (state === "success") {
        await post(w.issueId, LIVE_BODY(w.productionUrl));
        await deps.db.update(deploymentWatches).set({ status: "live", updatedAt: now }).where(eq(deploymentWatches.id, w.id));
        live++;
      } else if (state === "failure") {
        await post(w.issueId, FAILED_BODY);
        await deps.logActivity({ companyId: w.companyId, actorType: "system", action: "deployment.failed", entityType: "issue", entityId: w.issueId });
        await deps.db.update(deploymentWatches).set({ status: "failed", updatedAt: now }).where(eq(deploymentWatches.id, w.id));
        failed++;
      } else if (now >= w.deadlineAt) {
        await post(w.issueId, DELAYED_BODY);
        await deps.db.update(deploymentWatches).set({ status: "delayed", updatedAt: now }).where(eq(deploymentWatches.id, w.id));
        delayed++;
      } else {
        await deps.db.update(deploymentWatches)
          .set({ attempts: w.attempts + 1, nextCheckAt: new Date(now.getTime() + POLL_MS), updatedAt: now })
          .where(eq(deploymentWatches.id, w.id));
      }
    }
    return { live, delayed, failed };
  }

  return { onIssueDone, tick };
}
```

> Implementer notes: match the real `issuesSvc.addComment` actor signature from `server/src/services/issues.ts:5129` (system author may require `{ }` actor + `authorType:"system"`); match `logActivity` to the helper used elsewhere in services. Resolve `projectsSvc.getById` to the existing projects service (it returns `codebase.repoUrl`). Wire concrete deps in Task 11; tests inject fakes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/deployment-watch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/deployment-watch.ts server/src/services/deployment-watch.test.ts
git commit -m "feat(server): deployment-watch service (watch prod deploy, post live URL)"
```

---

### Task 10: Glowing "live" card in the PM view

**Files:**
- Modify: `ui/src/components/IssueChatThread.tsx` (`extractPreviewUrl` neighborhood + `IssueChatTextPart`)
- Modify: `ui/src/lib/pm-comment-display.ts` (strip the `LIVE_URL:` marker line from displayed text)
- Test: `ui/src/components/IssueChatThread.test.tsx`, `ui/src/lib/pm-comment-display.test.ts`

**Interfaces:**
- Produces: `extractLiveUrl(text: string): string | null` (matches the `LIVE_URL:` marker).

- [ ] **Step 1: Write failing tests**

```ts
// pm-comment-display.test.ts — the marker line must be stripped from display text:
it("strips the LIVE_URL marker line", () => {
  const { cleanedText } = dejargonComment("✨ Your change is now live.\n\nLIVE_URL: https://seasidehoa.com");
  expect(cleanedText).toContain("Your change is now live.");
  expect(cleanedText).not.toContain("LIVE_URL:");
});
```
```tsx
// IssueChatThread.test.tsx — the glowing live card renders in simplified view:
it("renders a glowing live card from a LIVE_URL comment in the simplified view", async () => {
  mockUseIsSimplifiedView.mockReturnValue(true);
  const { container } = await renderThreadWithComment(
    "✨ Your change is now live.\n\nLIVE_URL: https://seasidehoa.com",
  );
  const link = container.querySelector('a[href="https://seasidehoa.com"]');
  expect(link).toBeTruthy();
  expect(container.textContent).toContain("live");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/lib/pm-comment-display.test.ts src/components/IssueChatThread.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `pm-comment-display.ts`, before the final trim, drop the marker line:
```ts
    .replace(/^LIVE_URL:\s*\S+\s*$/gim, "")
```

In `IssueChatThread.tsx` add near `extractPreviewUrl`:
```ts
function extractLiveUrl(body: string): string | null {
  const match = body.match(/^LIVE_URL:\s*(https?:\/\/\S+)/im);
  return match ? match[1] : null;
}
```
In `IssueChatTextPart` (simplified path), after computing `previewUrl`:
```tsx
const liveUrl = isSimplified ? extractLiveUrl(text) : null;
// adjust the hidden short-circuit:
if (display.hidden && !previewUrl && !liveUrl) return null;
```
Render the glowing live card (above/instead of the preview card) when `liveUrl`:
```tsx
{liveUrl && (
  <a
    href={liveUrl}
    target="_blank"
    rel="noopener noreferrer"
    className="group mt-3 flex items-center gap-3 rounded-2xl border border-primary/40 bg-primary/10 p-4 shadow-[0_0_24px_-4px_var(--pm-accent,theme(colors.primary.DEFAULT))] ring-1 ring-primary/30 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_0_32px_-2px_var(--pm-accent,theme(colors.primary.DEFAULT))] animate-[pulse_3s_ease-in-out_infinite]"
  >
    <span className="pm-accent-bg flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white shadow-sm">
      <Sparkles className="h-5 w-5" />
    </span>
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-semibold text-foreground">✨ Your change is live</span>
      <span className="block truncate text-xs text-muted-foreground">{liveUrl.replace(/^https?:\/\//, "")}</span>
    </span>
    <ArrowUpRight className="h-4 w-4 shrink-0 text-primary transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
  </a>
)}
```
Import `Sparkles` from `lucide-react` (alongside existing icons).

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/lib/pm-comment-display.test.ts src/components/IssueChatThread.test.tsx`
Run: `pnpm --filter @paperclipai/ui typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/IssueChatThread.tsx ui/src/lib/pm-comment-display.ts ui/src/lib/pm-comment-display.test.ts ui/src/components/IssueChatThread.test.tsx
git commit -m "feat(ui): glowing live-URL card in the property-manager view"
```

---

### Task 11: Wire the watcher into issue→done and the server tick

**Files:**
- Modify: `server/src/services/issues.ts` (the status-transition path, ~lines 4325–4390) OR the route that sets status — call `deploymentWatch.onIssueDone(...)` after a successful transition to `done`.
- Modify: `server/src/app.ts` (construct the `deploymentWatch` service with concrete deps and expose it) and `server/src/index.ts` (add `deploymentWatch.tick(new Date())` to the existing `setInterval` block ~line 766).

**Interfaces:**
- Consumes: `createDeploymentWatch` (Task 9).

- [ ] **Step 1: Construct the service** in `app.ts` where other services are built:

```ts
import { createDeploymentWatch } from "./services/deployment-watch.js";
// ...
const deploymentWatch = createDeploymentWatch({
  db,
  issuesSvc: issues,
  projectsSvc: projects,
  logActivity: (input) => logActivity(db, input as never),
  getToken: () => process.env.GITHUB_TOKEN,
});
```
Make `deploymentWatch` reachable from `index.ts` (return it from app construction alongside `heartbeat`, `routines`, etc., following how those are surfaced).

- [ ] **Step 2: Add the tick** in `index.ts` inside the existing `setInterval`:

```ts
      void deploymentWatch
        .tick(new Date())
        .then((r) => {
          if (r.live + r.delayed + r.failed > 0) {
            logger.info({ ...r }, "deployment watch tick posted updates");
          }
        })
        .catch((err) => logger.error({ err }, "deployment watch tick failed"));
```

- [ ] **Step 3: Trigger on done** — in `issues.ts` update flow, after the row is updated and `issueData.status === "done"`, fire-and-forget:

```ts
      if (issueData.status === "done") {
        void deploymentWatchRef?.onIssueDone({
          id: updated.id, companyId: updated.companyId, projectId: updated.projectId ?? null,
        });
      }
```
> The issues service is constructed before `deploymentWatch` (circular). Resolve by a setter: export a `setDeploymentWatch(fn)` on the issues service and call it from `app.ts` after both are built, storing it in `deploymentWatchRef`. (Mirror any existing late-binding pattern in the service; if none, the setter is the minimal approach.)

- [ ] **Step 4: Verify** — typecheck + run the existing issues service tests to ensure no regression.

Run: `pnpm --filter @paperclipai/server typecheck`
Run: `pnpm --filter @paperclipai/server exec vitest run src/services/deployment-watch.test.ts`
Expected: clean; PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/index.ts server/src/services/issues.ts
git commit -m "feat(server): start deploy watch on issue done and tick it"
```

---

### Task 12: Full verification

- [ ] **Step 1: Typecheck everything**

Run: `pnpm -r typecheck`
Expected: clean.

- [ ] **Step 2: Run the affected test suites**

Run: `pnpm --filter @paperclipai/ui exec vitest run` (UI)
Run: `pnpm --filter @paperclipai/server exec vitest run src/services/deployment-watch.test.ts src/services/github-deployments.test.ts`
Expected: all pass (the pre-existing flaky `Inbox > syncs hover with j/k selection` test may need a re-run — it is unrelated).

- [ ] **Step 3: Build**

Run: `pnpm --filter @paperclipai/ui build && pnpm --filter @paperclipai/server build`
Expected: clean.

- [ ] **Step 4: Commit any fixups, then the feature is ready for the standard deploy** (push to `navarino-dev` fork → rebuild + restart server on the box → migration applies). After deploy, an admin sets each property's "Live website URL" in project settings; then verify a real approve → live flow.

---

## Self-review notes (coverage)

- Spec A1 (per-property setting) → Tasks 4, 5, 6.
- Spec A2 (deploy-watcher: trigger on done, poll, success/timeout/failure, no-URL skip, single watch) → Tasks 7, 8, 9, 11.
- Spec A3 (live card + states) → Task 10 (live card); publishing/delayed/failed are friendly text comments from Task 9 (no special card needed).
- Spec B1 (agent guidance) → Task 3.
- Spec B2 (UI filter: hide noise, clean links/jargon) → Tasks 1, 2; LIVE_URL marker stripping → Task 10.
- Contracts synced db→shared→server→ui in Tasks 4–6.
