---
name: publishing-a-property-change
description: Use when a property manager approves a change (looks good, go live, ship it, publish), when an approval is accepted or a run wakes with reason approval_approved or deploy_failed, when an issue is handed over for publishing, or when an approved change is still not live on the production site.
---

# Publishing a property change

**A change goes live only when its pull request is squash-merged into `main`.**
Nothing else publishes. Pushing more commits to the issue branch rebuilds the
*preview* and never touches production.

## The publish chain

Every link must happen, in order, or the site never updates:

| # | Link | Who |
|---|---|---|
| 1 | Property manager approves | operator |
| 2 | Issue is reassigned to the Reviewer | Editor |
| 3 | Open PR is squash-merged into `main` | Reviewer |
| 4 | Vercel auto-deploys `main` to production | Vercel |
| 5 | Paperclip posts the live link | system |

Links 4 and 5 are automatic. Links 2 and 3 are the ones that get dropped, and
when they are dropped **nothing reports an error** — the deployment watcher
polls for about 40 minutes, then tells the property manager "We hit a snag
publishing this change."

This is not hypothetical. Two approved Navarino changes were lost exactly this
way: the work was done, the preview was approved, the PR was left open, and the
property manager got the snag message instead of their change.

## Before you end the run, verify the link you own

Do not reason about whether you did it. Check.

**Editor — after reassigning:** re-read the issue and confirm the assignee is
now the Reviewer. If it still shows you, the handoff did not happen. Redo it.

**Reviewer — after merging:** confirm the merge actually landed.

```sh
gh pr view <number> --repo <owner>/<repo> --json number,state,merged,mergedAt
```

`"merged": true` is the only acceptable result. `"state": "OPEN"` means
production was never updated, no matter what the merge command printed.

## Red flags — the change will silently never publish

- Ending a run with an open PR after approval
- "The PR is ready to merge" / "ready for the Reviewer" as a final statement
- Marking the issue done while its PR is open
- Assuming approval alone triggers a deploy
- Assuming a push to the issue branch updated the live site

**All of these mean: the property manager's approved change is not live.
Complete your link of the chain, then verify it.**

## Rationalizations

| Excuse | Reality |
|--------|---------|
| "The work is done, the PR just needs merging" | An unmerged PR has changed nothing the property manager can see. |
| "I'll pick it back up on the next wake" | There is no next wake. Nothing re-triggers a dropped handoff. |
| "Publishing already started, so it's in flight" | The publish message fires on approval, not on merge. It is a promise you still have to keep. |
| "The preview looks right, so we're good" | Preview and production are separate deployments. |
| "I shouldn't merge without re-reviewing" (Reviewer, after a failed publish) | Reassignment to you *is* the approval. Confirm it merges cleanly and merge. |

## When a production deploy fails

The original PR is usually already squash-merged and closed, and its branch is
gone. Do not try to reopen it.

1. Branch off the latest `main`, commit the fix, open a fresh PR.
2. Reassign to the Reviewer — a merge is what re-triggers production.
3. Say nothing to the property manager. This is an internal fix.

Use `vercel-build-checks` to read the failure, and `property-manager-updates`
for anything you do post.
