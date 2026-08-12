---
name: vercel-build-checks
description: Use when a pull request needs its Vercel preview URL or build result, when a preview build is still running or has failed, when a preview link must be confirmed good before a property manager sees it, or when a production deploy needs checking.
---

# Vercel build checks

Vercel is wired to these repos through GitHub. There is **no `vercel` CLI and no
Vercel token** in this environment — every build fact comes from `gh`.

## Get the preview URL and build state

```sh
gh pr view "$PR" --repo "$REPO" --json statusCheckRollup \
  -q '.statusCheckRollup[]
      | select((.context // .name // "") | test("vercel"; "i"))
      | "\(.state // .conclusion // "PENDING")\t\(.targetUrl // .detailsUrl // "")"'
```

Fallbacks, in order, if that comes back empty:

```sh
gh pr checks "$PR" --repo "$REPO"                      # human-readable roll-up
gh pr view "$PR" --repo "$REPO" --json comments \
  -q '.comments[].body' | grep -o 'https://[^ )]*\.vercel\.app'
gh api "repos/$REPO/commits/$(gh pr view "$PR" --repo "$REPO" --json headRefOid -q .headRefOid)/status" \
  -q '.statuses[] | select(.context | test("vercel";"i")) | "\(.state)\t\(.target_url)"'
```

A `.vercel.app` URL existing does **not** mean the build succeeded. The state
must be `SUCCESS` / `success` before that link is worth anything.

## You cannot wait for a build across runs

**Never end your turn intending to wait.** When your turn ends, the run ends.
There is no background monitor, no build notification, and nothing that wakes
you when Vercel finishes. The issue simply stops, and the property manager is
left holding a promise.

Poll inside the run instead, with a bounded loop:

```sh
for i in $(seq 1 15); do
  state=$(gh pr view "$PR" --repo "$REPO" --json statusCheckRollup \
    -q '.statusCheckRollup[] | select((.context // .name // "") | test("vercel";"i"))
        | (.state // .conclusion)' | head -1)
  case "$state" in
    SUCCESS|success)                 echo "ready";  break ;;
    FAILURE|failure|ERROR|error)     echo "failed"; break ;;
  esac
  sleep 20
done
```

Roughly five minutes of polling. If it is still building when the loop ends,
finish the work you can do now and leave the issue in a state a later wake can
pick up — but never sign off with "I'll wait" or "I'll post it once it's ready."

| Excuse | Reality |
|--------|---------|
| "I'll wait for the Vercel preview to become available." | The run is over the moment you say that. Nothing resumes it. |
| "I'll wait for the background task notification." | There is no background task and no notification. |
| "Monitoring the build; I'll post the link once it's ready." | You cannot monitor anything after your turn ends. |
| "Still building, so I'll prepare the comment meanwhile." | The comment never gets posted, because there is no "meanwhile". |

## When a build fails

Vercel's build log is not reachable through `gh` — reproduce it instead. These
are Next.js 16 / React 19 / Tailwind v4 repos on npm:

```sh
npm ci && npm run build
```

That surfaces the same TypeScript, lint, and build errors Vercel hit. Fix the
cause on the issue branch, push, and re-check. Repeat until the build passes.

**Never show a property manager a preview whose build has not succeeded.**

## Preview vs production

| | Trigger | What it proves |
|---|---|---|
| Preview | any push to the PR branch | the change renders |
| Production | squash-merge into `main` | the change is live |

A green preview says nothing about production. See
`publishing-a-property-change` for the chain that actually publishes.
