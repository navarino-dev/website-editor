# PM "Go Live" experience: live-URL on approve + de-jargoned responses

Date: 2026-06-29
Status: Approved (design)
Scope: property-manager (simplified) view only — the admin/full board is unchanged.

## Context

Property managers use the simplified view to request website changes and approve
them. Today, when a PM clicks **Approve & Go Live**:

- The Reviewer agent merges the PR, which triggers a Vercel production deploy, but
  nothing waits for that deploy or surfaces the **live** site URL. The PM is only
  ever shown the muted "View your preview" card (any `*.vercel.app`).
- Agent comments leak technical detail into the PM view (PR/GitHub links, branch
  names, status jargon like `in_review` / `request_confirmation`, and internal
  "heartbeat" status-narration comments).

## Goals

1. After approval, Paperclip waits until the production deploy is live and then
   shows the PM the property's **real custom domain** in a visually prominent
   (glowing/highlighted) card.
2. The PM view never shows technical information.

## Non-goals

- No change to the admin/full board (admins still see PRs, branches, statuses,
  every comment).
- No Vercel API integration / Vercel token. Deploy completion is detected via the
  existing GitHub deployment statuses (Vercel's GitHub app posts them) using the
  existing `GITHUB_TOKEN`.
- We do not auto-detect the custom domain; it is configured per property.

## Decisions (from brainstorming)

- **Main URL** = each property's custom domain (e.g. `https://seasidehoa.com`).
- **Logic runs in Paperclip** (a deploy-watcher in the scheduler), not the agent.
- **Domain source** = a per-property "Live website URL" setting an admin sets once.
- **De-jargon** = both agent guidance *and* a PM-view UI filter (safety net).

---

## Part A — Approve → wait for live → show the live URL

### A1. Per-property "Live website URL" setting

- Add `productionUrl text` (nullable) to the `projects` table
  (`packages/db/src/schema/projects.ts`), exported from the schema index, with a
  generated migration.
- Thread the field through the contract layers: `@paperclipai/shared` Project
  type/validator → server project routes/services (read + update) → UI project
  settings form (a labelled "Live website URL" input, admin-only).
- Validation: must be empty or a valid `http(s)` URL; normalized (trimmed, scheme
  required). Stored verbatim; displayed as-is.

### A2. Deploy-watcher (scheduler job)

- **Trigger:** when an issue transitions to `done` (the Reviewer's squash-merge is
  what flips it to done) AND the issue's project has a non-empty `productionUrl`,
  enqueue a `deploy_watch` job for that issue. Resolve the GitHub repo from the
  project's `project_workspaces.repoUrl` (fallback: the issue's execution
  workspace `repoUrl`).
- **Pending state:** on enqueue, post a `system` comment with a
  `deployment_publishing` presentation ("Publishing your change…").
- **Polling:** the job polls the repo's GitHub **production** deployment status on
  the default branch (Deployments API → latest production deployment → statuses)
  using `GITHUB_TOKEN`, every ~15s, up to a ~10 min budget. Reuses the in-process
  scheduler/wakeup infrastructure (no external queue).
- **Success:** when a production deployment reports `success`, update/replace the
  pending comment with a `deployment_live` presentation carrying the project's
  `productionUrl`. Stop.
- **Timeout (~10 min):** replace with a friendly `deployment_delayed` presentation
  ("This is taking a little longer than usual — it should be live shortly.").
  Stop. (No technical error shown to the PM.)
- **Failure** (deployment status `failure`/`error`): replace with a friendly
  `deployment_failed` presentation ("We hit a snag publishing this — the team has
  been notified.") and write an activity-log entry for admins. Stop.
- **No `productionUrl` configured:** do nothing (no live card). Admin should set
  the Live website URL; until then the PM flow is unchanged.
- **Re-merges / multiple deploys:** watch the most recent production deployment;
  one active watch per issue (re-enqueue cancels/replaces the prior).

All comments written by the watcher are `authorType: "system"` with a structured
`presentation` (the same mechanism heartbeat system notices already use), so the
UI can render them as cards rather than raw text.

### A3. Live card presentation + UI

- New presentation kinds (in `@paperclipai/shared`, alongside the existing
  `system_notice` / `message`): `deployment_publishing`, `deployment_live`,
  `deployment_delayed`, `deployment_failed`. `deployment_live` includes
  `{ url, label }`.
- **PM (simplified) view:** render `deployment_live` as a prominent **glowing**
  card — "✨ Your change is live" + the domain — visually distinct from the muted
  "View your preview" card (accent background, subtle glow/animation, opens the
  domain in a new tab). `deployment_publishing` renders an in-progress state;
  `deployment_delayed`/`deployment_failed` render calm status messages.
- **Admin/full view:** render the same presentations as plain, non-animated rows
  (no behavioral change to existing cards).

---

## Part B — No technical information in PM responses

### B1. Agent guidance (source-level)

Update `agent-instructions/editor.md` and `agent-instructions/reviewer.md`:

- Write short, friendly updates for a non-technical property manager.
- Do **not** include PR/GitHub links, branch names, or status jargon
  (`in_review`, `request_confirmation`, "heartbeat", etc.) in comments.
- Do **not** post internal status-only / "narrating my run" comments.
- (Editor still includes the preview link as today — the UI turns it into the
  preview card.)

These instruction files are deployed to the server at
`/opt/paperclip/agent-instructions/` and referenced by the agents' config.

### B2. PM-view UI filter (safety net)

Applied only when `isSimplified` is true, to agent-authored text comments:

- **Hide whole comments** classified as internal status noise — conservative
  heuristic keyed on internal markers (e.g. "this wake", "Nothing to action",
  "remains in_review", "request_confirmation interaction", "heartbeat") and/or
  comments that contain no PM-relevant content after cleaning. Bias toward
  *showing*: only hide when confident it is pure noise.
- **Clean** the comments that are shown: strip GitHub/PR URLs and `PR:` /
  branch-name lines, and soften residual status tokens. Preview/live URLs continue
  to be lifted into their cards (existing `extractPreviewUrl` + the new live card).
- Admin/full view is untouched (sees raw comments).

The filter lives in a small, unit-testable pure helper (input: comment text →
output: `{ hidden: boolean, cleanedText: string }`), consumed by the simplified
render path in `IssueChatThread`.

---

## Contracts to keep in sync (per change)

`packages/db` (projects.productionUrl + migration) → `packages/shared`
(Project type/validator, presentation kinds) → `server` (project read/update
routes/services, deploy-watcher job, system-comment posting) → `ui` (project
settings input, live/publishing/delayed/failed cards, PM-view de-jargon filter).
Mutating actions write activity-log entries.

## Error handling & edge cases

- Repo not on GitHub / Vercel GitHub app not connected → no production deployment
  statuses appear → watcher hits the timeout path (friendly "taking longer").
- `productionUrl` set but malformed → rejected at save time (validation).
- Issue reopened after done, then re-merged → new watch supersedes the old.
- Watcher must be idempotent and survive server restart (recovered like other
  scheduled work).

## Testing

- **Server:** deploy-watcher unit tests — success posts `deployment_live` with the
  configured URL; timeout posts `deployment_delayed`; failure posts
  `deployment_failed` + activity log; no `productionUrl` ⇒ no card; repo
  resolution from project/execution workspace.
- **Shared:** project validator accepts/normalizes/rejects URLs; presentation
  types.
- **UI:** live card renders glowing in simplified view and plain in admin view;
  de-jargon helper hides known noise, keeps real updates, strips links/branch
  names/status tokens; existing IssueChatThread suites stay green.

## Rollout

- Standard: typecheck + tests + build, commit on `master`, push to the
  `navarino-dev` fork, redeploy the server on the Hetzner box (rebuild + restart;
  swap is permanent). DB migration applies on deploy.
- After deploy: admin sets each property's "Live website URL", then PM verifies an
  approve → live flow on a real issue.
