# Simplified Property Manager View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide all technical agent/orchestration UI from property managers so they see a clean, light-mode interface focused on requesting changes, previewing them, and approving.

**Architecture:** Role-based conditional rendering within existing React pages. A single `useIsSimplifiedView()` hook checks the user's company membership role. When `true`, sidebar hides technical sections, issue creation strips to title+description, issue detail shows only chat and preview/approve actions, and dashboard becomes a request list. No new routes, pages, or API changes.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, TanStack Query, existing Paperclip UI component library.

**Design spec:** `docs/superpowers/specs/2026-05-27-simplified-pm-view-design.md`

---

### Task 1: Create `useIsSimplifiedView` hook

**Files:**
- Create: `ui/src/hooks/useIsSimplifiedView.ts`

- [ ] **Step 1: Create the hook file**

```typescript
// ui/src/hooks/useIsSimplifiedView.ts
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";

const ADMIN_ROLES = new Set(["owner", "admin", "operator", "manager"]);

export function useIsSimplifiedView(): boolean {
  const { selectedCompanyId } = useCompany();

  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });

  if (boardAccess?.isInstanceAdmin) return false;

  const membership = boardAccess?.memberships?.find(
    (m) => m.companyId === selectedCompanyId,
  );

  if (!membership?.membershipRole) return false;

  return !ADMIN_ROLES.has(membership.membershipRole);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ui && npx tsc --noEmit src/hooks/useIsSimplifiedView.ts 2>&1 | head -20`
Expected: No errors (or resolve any import path issues).

- [ ] **Step 3: Commit**

```bash
git add ui/src/hooks/useIsSimplifiedView.ts
git commit -m "feat(ui): add useIsSimplifiedView hook for role-based view switching"
```

---

### Task 2: Force light mode for simplified view

**Files:**
- Modify: `ui/src/context/ThemeContext.tsx`

- [ ] **Step 1: Import and use the hook in ThemeProvider**

In `ui/src/context/ThemeContext.tsx`, modify the `ThemeProvider` to force light mode when simplified view is active. Add the import and an effect after the existing theme effect:

```typescript
// At the top of the file, add import:
import { useIsSimplifiedView } from "../hooks/useIsSimplifiedView";
```

Inside `ThemeProvider`, after the existing `useState` for theme (line 42), add:

```typescript
const isSimplified = useIsSimplifiedView();

useEffect(() => {
  if (isSimplified) {
    applyTheme("light");
  }
}, [isSimplified]);
```

And modify the existing `useEffect` that applies theme (lines 52-59) to skip when simplified:

```typescript
useEffect(() => {
  if (isSimplified) return;
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore local storage write failures in restricted environments.
  }
}, [theme, isSimplified]);
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ui && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add ui/src/context/ThemeContext.tsx
git commit -m "feat(ui): force light mode for simplified property manager view"
```

---

### Task 3: Create friendly status label utility

**Files:**
- Create: `ui/src/lib/friendlyLabels.ts`

- [ ] **Step 1: Create the utility file**

```typescript
// ui/src/lib/friendlyLabels.ts

const STATUS_LABELS: Record<string, string> = {
  backlog: "Pending",
  todo: "Pending",
  in_progress: "In Progress",
  in_review: "Ready for Review",
  done: "Complete",
  blocked: "On Hold",
};

export function friendlyStatus(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function friendlyStatusColor(status: string): string {
  switch (status) {
    case "in_review":
      return "bg-amber-100 text-amber-800";
    case "in_progress":
      return "bg-blue-100 text-blue-800";
    case "done":
      return "bg-green-100 text-green-800";
    case "blocked":
      return "bg-red-100 text-red-800";
    default:
      return "bg-gray-100 text-gray-700";
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/lib/friendlyLabels.ts
git commit -m "feat(ui): add friendly status label utilities for property managers"
```

---

### Task 4: Simplify the Sidebar

**Files:**
- Modify: `ui/src/components/Sidebar.tsx`

- [ ] **Step 1: Add the hook import and conditional rendering**

At the top of `ui/src/components/Sidebar.tsx`, add:

```typescript
import { useIsSimplifiedView } from "../hooks/useIsSimplifiedView";
```

Inside the `Sidebar` function body (after line 48 `const showWorkspacesLink = ...`), add:

```typescript
const isSimplified = useIsSimplifiedView();
```

- [ ] **Step 2: Replace the "New Issue" button text conditionally**

Replace the existing button text (line 83) from:

```tsx
<span className="truncate">New Issue</span>
```

to:

```tsx
<span className="truncate">{isSimplified ? "Request a Change" : "New Issue"}</span>
```

- [ ] **Step 3: Conditionally render Dashboard link label**

Replace line 85:

```tsx
<SidebarNavItem to="/dashboard" label="Dashboard" icon={LayoutDashboard} liveCount={liveRunCount} />
```

with:

```tsx
<SidebarNavItem to="/dashboard" label={isSimplified ? "My Requests" : "Dashboard"} icon={LayoutDashboard} liveCount={isSimplified ? undefined : liveRunCount} />
```

- [ ] **Step 4: Hide the Search button for simplified view**

Wrap the search button (lines 60-72) with:

```tsx
{!isSimplified && (
  <Button
    asChild
    variant="ghost"
    size="icon-sm"
    className="text-muted-foreground shrink-0"
    aria-label="Open search"
    title="Open search"
  >
    <NavLink to="/search">
      <Search className="h-4 w-4" />
    </NavLink>
  </Button>
)}
```

- [ ] **Step 5: Hide Work section, Agents, Company section for simplified view**

Wrap the Work `SidebarSection` (lines 96-116), `SidebarAgents` (line 120), and Company `SidebarSection` (lines 122-128), and plugin panels (lines 130-136) with `{!isSimplified && ( ... )}`.

Keep `SidebarProjects` (line 118) and `Inbox` (lines 86-93) visible for both views.

- [ ] **Step 6: Verify it compiles**

Run: `cd ui && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/Sidebar.tsx
git commit -m "feat(ui): hide technical sidebar sections for property managers"
```

---

### Task 5: Simplify the NewIssueDialog

**Files:**
- Modify: `ui/src/components/NewIssueDialog.tsx`

- [ ] **Step 1: Add the hook import**

At the top of `ui/src/components/NewIssueDialog.tsx`, add:

```typescript
import { useIsSimplifiedView } from "../hooks/useIsSimplifiedView";
```

Inside the main dialog component function, add near the top:

```typescript
const isSimplified = useIsSimplifiedView();
```

- [ ] **Step 2: Change placeholder text conditionally**

Find the title textarea placeholder (search for `"Title"` or `placeholder`). Replace with:

```tsx
placeholder={isSimplified ? "What do you need changed?" : "Issue title"}
```

Find the description placeholder and replace with:

```tsx
placeholder={isSimplified ? "Describe the change you'd like to see..." : "Add description..."}
```

- [ ] **Step 3: Hide technical fields for simplified view**

Wrap these sections with `{!isSimplified && ( ... )}`:
- Status selector row (defaults to `todo` when hidden)
- Priority selector row (defaults to `medium` when hidden)
- Assignee selector (auto-filled via `baseCreateIssueDefaults`)
- Reviewer/Approver participant rows
- Advanced options popover (work mode, model lane, model override, chrome, thinking effort)
- Execution workspace config section

Keep visible:
- Title field
- Description field
- Project selector (needed if user manages multiple properties)
- File upload / drag-and-drop area

- [ ] **Step 4: Change submit button text**

Find the submit button (search for `"Create Issue"` or `"Create issue"`). Replace with:

```tsx
{isSimplified ? "Submit Request" : "Create Issue"}
```

- [ ] **Step 5: Verify it compiles**

Run: `cd ui && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/NewIssueDialog.tsx
git commit -m "feat(ui): simplify issue creation dialog for property managers"
```

---

### Task 6: Simplify the IssueDetail page

**Files:**
- Modify: `ui/src/pages/IssueDetail.tsx`

- [ ] **Step 1: Add imports**

At the top of `ui/src/pages/IssueDetail.tsx`, add:

```typescript
import { useIsSimplifiedView } from "../hooks/useIsSimplifiedView";
import { friendlyStatus, friendlyStatusColor } from "../lib/friendlyLabels";
```

Inside the main `IssueDetail` component, add near the top:

```typescript
const isSimplified = useIsSimplifiedView();
```

- [ ] **Step 2: Replace status labels with friendly versions**

In the status badge/selector area, when `isSimplified` is true, render a static badge instead of the dropdown:

```tsx
{isSimplified ? (
  <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${friendlyStatusColor(issue.status)}`}>
    {friendlyStatus(issue.status)}
  </span>
) : (
  // existing status dropdown
)}
```

- [ ] **Step 3: Hide tab bar for simplified view**

Find the tab bar that switches between Activity, Approvals, Documents, Related Work. Wrap with `{!isSimplified && ( ... )}`. When simplified, always render the activity/chat tab content.

- [ ] **Step 4: Hide sidebar properties for simplified view**

In the `IssueProperties` component or the properties sidebar panel, wrap technical fields with `{!isSimplified && ( ... )}`:
- Assignee selector
- Reviewer selector
- Approver selector
- Model overrides
- Execution workspace
- Costs
- Labels
- Blockers
- Documents
- Estimated time

Keep visible:
- Status (with friendly label)
- Project name
- Created date

- [ ] **Step 5: Add preview link detection and Approve/Request Changes buttons**

After the chat thread area, when `isSimplified && issue.status === "in_review"`, render action buttons:

```tsx
{isSimplified && issue.status === "in_review" && (
  <div className="flex gap-3 p-4 border-t border-border bg-background sticky bottom-0">
    <button
      onClick={handleApproveAndGoLive}
      className="flex-1 px-4 py-3 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors text-sm"
    >
      Approve & Go Live
    </button>
    <button
      onClick={() => setShowReplyBox(true)}
      className="flex-1 px-4 py-3 bg-white hover:bg-gray-50 text-gray-700 font-medium rounded-lg border border-gray-300 transition-colors text-sm"
    >
      Request Changes
    </button>
  </div>
)}
```

- [ ] **Step 6: Implement the handleApproveAndGoLive function**

This function should:
1. Post a comment "Approved — go live."
2. Reassign the issue to the Reviewer agent (find the Reviewer agent by role `qa` in the agents list)

```typescript
const handleApproveAndGoLive = useCallback(async () => {
  if (!issue) return;
  const reviewerAgent = agents?.find((a) => a.role === "qa");
  if (reviewerAgent) {
    await issuesApi.update(issue.id, { assigneeAgentId: reviewerAgent.id });
  }
  await issuesApi.addComment(issue.id, { body: "Approved — go live." });
  queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
}, [issue, agents, queryClient]);
```

- [ ] **Step 7: Add Vercel preview link detection in comments**

Create a helper to detect and render preview links prominently in the chat thread. In the comment rendering area, when `isSimplified`, scan comment body for `.vercel.app` URLs and render them as buttons:

```typescript
function extractPreviewUrl(body: string): string | null {
  const match = body.match(/https:\/\/[^\s)]+\.vercel\.app[^\s)]*/);
  return match ? match[0] : null;
}
```

In the comment render, when a preview URL is found and `isSimplified`:

```tsx
{isSimplified && previewUrl && (
  <a
    href={previewUrl}
    target="_blank"
    rel="noopener noreferrer"
    className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors text-sm mt-2"
  >
    <ExternalLink className="h-4 w-4" />
    View Preview
  </a>
)}
```

- [ ] **Step 8: Verify it compiles**

Run: `cd ui && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 9: Commit**

```bash
git add ui/src/pages/IssueDetail.tsx
git commit -m "feat(ui): simplify issue detail with friendly labels, preview buttons, and approve/reject actions"
```

---

### Task 7: Simplify the Dashboard

**Files:**
- Modify: `ui/src/pages/Dashboard.tsx`

- [ ] **Step 1: Add imports**

At the top of `ui/src/pages/Dashboard.tsx`, add:

```typescript
import { useIsSimplifiedView } from "../hooks/useIsSimplifiedView";
import { friendlyStatus, friendlyStatusColor } from "../lib/friendlyLabels";
```

Inside the `Dashboard` component, add near the top:

```typescript
const isSimplified = useIsSimplifiedView();
```

- [ ] **Step 2: Create a SimplifiedDashboard component in the same file**

Add before the `Dashboard` export:

```tsx
function SimplifiedDashboard({
  issues,
  projects,
  selectedCompanyId,
}: {
  issues: Issue[] | undefined;
  projects: Array<{ id: string; name: string; color?: string | null }> | undefined;
  selectedCompanyId: string | null;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const { openNewIssue } = useDialogActions();

  const activeProjects = projects?.filter((p) => p.name !== "Onboarding") ?? [];
  const effectiveProjectId = selectedProjectId ?? activeProjects[0]?.id ?? null;

  const filteredIssues = useMemo(() => {
    if (!issues || !effectiveProjectId) return [];
    return issues
      .filter((i) => i.projectId === effectiveProjectId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [issues, effectiveProjectId]);

  const needsAttention = filteredIssues.filter((i) => i.status === "in_review");
  const otherIssues = filteredIssues.filter((i) => i.status !== "in_review");

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">My Requests</h1>
        <button
          onClick={() => openNewIssue({ projectId: effectiveProjectId })}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors text-sm"
        >
          Request a Change
        </button>
      </div>

      {activeProjects.length > 1 && (
        <div className="flex gap-1 mb-6 border-b border-gray-200">
          {activeProjects.map((project) => (
            <button
              key={project.id}
              onClick={() => setSelectedProjectId(project.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                project.id === effectiveProjectId
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {project.name}
            </button>
          ))}
        </div>
      )}

      {needsAttention.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-amber-700 mb-3">Needs Your Review</h2>
          <div className="flex flex-col gap-2">
            {needsAttention.map((issue) => (
              <RequestCard key={issue.id} issue={issue} />
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {otherIssues.map((issue) => (
          <RequestCard key={issue.id} issue={issue} />
        ))}
      </div>

      {filteredIssues.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">No requests yet</p>
          <p className="text-sm mt-1">Click "Request a Change" to get started</p>
        </div>
      )}
    </div>
  );
}

function RequestCard({ issue }: { issue: Issue }) {
  return (
    <Link
      to={`/issues/${issue.identifier ?? issue.id}`}
      className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-gray-300 hover:shadow-sm transition-all"
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{issue.title}</p>
        <p className="text-xs text-gray-500 mt-1">{timeAgo(issue.updatedAt)}</p>
      </div>
      <span className={`ml-3 px-2.5 py-1 rounded-full text-xs font-medium shrink-0 ${friendlyStatusColor(issue.status)}`}>
        {friendlyStatus(issue.status)}
      </span>
    </Link>
  );
}
```

- [ ] **Step 3: Conditionally render simplified dashboard**

In the `Dashboard` component's return statement, add at the very top before any existing content:

```tsx
if (isSimplified) {
  return (
    <SimplifiedDashboard
      issues={issues}
      projects={projects}
      selectedCompanyId={selectedCompanyId}
    />
  );
}
```

The rest of the existing dashboard renders unchanged for admin users.

- [ ] **Step 4: Add missing imports if needed**

Ensure `Link` is imported from `@/lib/router`, `useState` from `react`, and `timeAgo` from `../lib/timeAgo`.

- [ ] **Step 5: Verify it compiles**

Run: `cd ui && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/Dashboard.tsx
git commit -m "feat(ui): add simplified request list dashboard for property managers"
```

---

### Task 8: Final integration test and deploy

**Files:**
- No new files — manual verification

- [ ] **Step 1: Run full typecheck**

Run: `pnpm -r typecheck`
Expected: All workspaces pass.

- [ ] **Step 2: Run tests**

Run: `pnpm test:run`
Expected: No regressions.

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: Builds successfully.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(ui): resolve any typecheck or build issues from PM view changes"
```

- [ ] **Step 5: Push and redeploy**

```bash
git push fork master
```

Then on the server:
```bash
ssh root@5.161.125.124 "cd /opt/paperclip && git pull origin master && cd docker && docker compose -f docker-compose.production.yml --env-file .env.production up -d --build server"
```

- [ ] **Step 6: Verify in browser**

1. Log in as admin — verify full technical UI is unchanged
2. Invite a test user as `editor` role — verify they see simplified view
3. Verify light mode is forced for simplified view
4. Create a request from simplified view — verify only title/description/project shown
5. Check issue detail — verify friendly status labels, preview button, approve/reject actions
