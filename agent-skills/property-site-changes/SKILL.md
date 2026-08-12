---
name: property-site-changes
description: Use when editing a property website repository — changing availability, pricing, floor plans, copy, colors, popups, or components — and when starting a branch or opening a pull request for a property issue.
---

# Property site changes

One issue produces one fresh branch off the latest `main` and one pull request.
Branches are never reused, never continued, never stacked.

## Start every issue this way

```sh
git checkout main
git pull --ff-only
git checkout -b "$ISSUE_IDENTIFIER-short-slug"   # e.g. NAV-57-remove-unit-74
git rev-parse --abbrev-ref HEAD                  # must contain THIS issue's identifier
```

That last line is the check, not a formality. Run it before your first commit.
If the branch name carries a different issue's identifier, you are on the wrong
branch — go back to `main` and cut a new one.

**Why it matters:** an approved change can only be published by merging its PR
into `main`. If your change shares a branch with another issue's unapproved
work, publishing yours publishes theirs too — so it cannot be published at all.
Navarino PRs have already shipped under the wrong identifier this way (a
`NAV-49` change opened on the `nav-48` branch, a `NAV-35` change on the
`nav-24` branch).

## These repos are not the Next.js you know

Every property repo opens with the same warning in its `AGENTS.md`:

> This version has breaking changes — APIs, conventions, and file structure may
> all differ from your training data. Read the relevant guide in
> `node_modules/next/dist/docs/` before writing any code.

Take it literally. Next.js 16, React 19, Tailwind v4, shadcn components, Supabase.

## Layout differs per property — look before editing

| Repo | Source root |
|------|-------------|
| `stonemont-website` | `app/`, `components/`, `lib/` at repo root |
| `seaside-website`, `sanjose-website` | everything under `src/` |

Unit availability, pricing, and floor-plan content live in a data module (for
example `src/lib/data.ts`), not scattered through components. Find the file
that holds the current values and edit it there rather than hardcoding into JSX.

## npm, not pnpm

All three repos ship `package-lock.json`.

```sh
npm ci
npm run build     # run this before you push — it catches what Vercel would catch
```

`npm run build` locally is the cheapest way to avoid a failed preview. See
`vercel-build-checks` for reading a build that fails anyway.

## Scope

Make only the change this issue asks for. A request to update availability is
not an invitation to restyle the page. Unrequested changes end up in front of a
property manager who did not ask for them and cannot tell which part they are
approving.

## Then

Push, open one PR into `main` with `gh pr create`, confirm the preview build is
green, and report using `property-manager-updates`. You never merge — see
`publishing-a-property-change`.
