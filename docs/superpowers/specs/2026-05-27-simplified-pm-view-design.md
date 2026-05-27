# Simplified Property Manager View

**Date:** 2026-05-27
**Status:** Approved
**Scope:** UI-only changes to existing Paperclip board (React/Vite/Tailwind)

## Problem

Paperclip's UI is built for technical operators managing AI agents. Property managers — the primary users of this deployment — are non-technical. They need a simple interface to request website changes, preview them, and approve or reject. All agent orchestration, run logs, adapter config, and technical details should be invisible to them.

## Approach

Role-based view switching within the existing UI. No new pages or routes. The current membership role system (`viewer`, `editor`, `manager`, `owner`) determines which view a user sees. Property managers are invited as `editor` role. Admins (`manager`, `owner`, `instance_admin`) see the full technical UI unchanged.

## Role Detection

A new React hook `useIsSimplifiedView()` checks the current user's membership role against the active company. Returns `true` for `viewer` and `editor` roles, `false` for `manager`, `owner`, and `instance_admin`. All conditional rendering in the UI keys off this single hook.

**File:** `ui/src/hooks/useIsSimplifiedView.ts`

## Changes

### 1. Sidebar (`ui/src/components/Sidebar.tsx`)

**Simplified view hides:**
- WORK section (Issues, Routines, Goals, Workspaces)
- AGENTS section (agent list)
- COMPANY section (Org, Skills, Costs, Activity, Settings)
- Admin Dev link
- Search button

**Simplified view shows:**
- Company name at top (display only)
- "Request a Change" button (replaces "New Issue")
- "My Requests" link (replaces Dashboard)
- Inbox (notifications)
- PROPERTIES section — list of assigned properties. Clicking one shows that property's request list.

### 2. Theme

Force light mode for simplified view users. The existing light mode CSS tokens in `ui/src/index.css` are already defined. Remove the `.dark` class from the root element when `useIsSimplifiedView()` returns `true`.

### 3. Issue Creation (`ui/src/components/NewIssueDialog.tsx`)

**Simplified view shows:**
- Title field — placeholder: "What do you need changed?"
- Description field — placeholder: "Describe the change you'd like to see..."
- Property selector — only if user manages multiple properties; auto-select if single property
- File upload — drag-and-drop for screenshots/reference images
- "Submit Request" button

**Simplified view hides:**
- Status selector (defaults to `todo`)
- Priority selector (defaults to `medium`)
- Assignee (auto-fills from project's `leadAgentId`)
- Reviewer/Approver participant rows
- Work mode, model lane, model override, thinking effort, chrome flag
- Execution workspace config
- All advanced options popover

### 4. Issue Detail (`ui/src/pages/IssueDetail.tsx`)

**Header:**
- Title (editable)
- Status badge with friendly labels:
  - `backlog` / `todo` → "Pending"
  - `in_progress` → "In Progress"
  - `in_review` → "Ready for Review"
  - `done` → "Complete"

**Main content — chat-style conversation:**
- Show comments only (user messages and agent responses)
- Hide: run ledger, tool calls, working spinners, heartbeat details, adapter logs
- Preview link detection: when a comment contains a `.vercel.app` URL, render it as a prominent "View Preview" button

**Sidebar properties — stripped down:**
- Status (friendly labels)
- Property name
- Created date
- Hide: assignee, reviewer, approver, model overrides, execution workspace, costs, labels, blockers, documents, estimated time

**Action buttons — visible when status is `in_review`:**
- "Approve & Go Live" — prominent green button. Creates an approval acceptance and reassigns the issue to the Reviewer agent.
- "Request Changes" — secondary button. Opens reply box for feedback.

**Tabs hidden entirely:**
- Approvals tab
- Documents tab
- Related Work tab
- Tab bar itself — only the chat/activity view renders

### 5. Dashboard (`ui/src/pages/Dashboard.tsx`)

**Simplified view replaces the full dashboard with a request list:**

- If user manages multiple properties: property switcher at top (tabs or dropdown)
- Request cards showing: title, status badge (friendly labels), relative time ("2 hours ago")
- "Ready for Review" requests highlighted to indicate action needed
- No charts, agent stats, run activity, or budget info

### 6. Terminology Mapping

| Technical Term | Friendly Term |
|---------------|---------------|
| Issue | Request |
| New Issue | Request a Change |
| in_review | Ready for Review |
| backlog / todo | Pending |
| in_progress | In Progress |
| done | Complete |
| Assignee | (hidden) |
| Agent | (hidden) |

## Files Modified

1. `ui/src/hooks/useIsSimplifiedView.ts` — new hook
2. `ui/src/components/Sidebar.tsx` — conditional section hiding
3. `ui/src/components/NewIssueDialog.tsx` — field stripping
4. `ui/src/pages/IssueDetail.tsx` — simplified detail view with action buttons
5. `ui/src/pages/Dashboard.tsx` — request list replacing full dashboard
6. `ui/src/index.css` — light mode enforcement (if needed beyond class toggling)

## Out of Scope

- New routes or pages
- Backend/API changes
- New database tables or fields
- Mobile app
- Email notifications
- Property manager onboarding wizard
