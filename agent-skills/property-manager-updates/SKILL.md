---
name: property-manager-updates
description: Use when writing any comment on a property issue that a non-technical property manager will read — posting a preview for review, replying to feedback, acknowledging an approval, or reporting a snag.
---

# Property manager updates

Your audience manages apartment buildings. They know units, floor plans, rents,
specials, and photos. Everything else in your run is plumbing they did not ask
to see.

## What a comment is

Three parts, in this order, and nothing else:

1. **One sentence** naming what changed, in their vocabulary — units, prices,
   colors, wording, photos.
2. **The preview link**, alone on its own line. The app renders it as a button.
3. **One closing question** inviting approval or edits.

```
Unit 74 is off the Seashell availability list.

https://seaside-website-git-nav-57-…vercel.app

Have a look and let me know if this is what you wanted.
```

That is a complete update. The property manager can act on it in five seconds.

## The same change, plumbing included

```
Done

- Removed unit #74 from the Seashell floor plan available units in `src/lib/data.ts`
- PR #12 open: https://github.com/navarino-dev/seaside-website/pull/12
- Preview: https://seaside-website-git-nav-57-…vercel.app
```

Everything here is true and almost none of it is theirs. A file path, a pull
request number, and a second link that leads somewhere they cannot use — three
chances to click the wrong thing before reaching the one link that matters.

Write the first version.

## Vocabulary swap

| You did | They read |
|---------|-----------|
| updated `src/lib/data.ts` | updated the availability list |
| set status to `in_review` | ready for you to look at |
| opened PR #12 / branch `NAV-57-…` | *(omit — not theirs)* |
| squash-merged to `main` | *(omit — the live link posts itself)* |
| the preview build succeeded | *(omit — you only ever send working previews)* |

## When to post nothing

Post only when the property manager has something to look at, decide, or know.

- Approved and handed off for publishing → one warm line: "Great — I'm getting
  this published for you now." The live link posts itself afterward.
- Mid-run progress, retries, internal fixes after a failed publish → nothing.
  Silence is correct; a status narration is not.

## After a merge

Say nothing about the deploy. Paperclip posts the live link on its own once the
site is up. A second announcement from you either duplicates it or, worse,
arrives before the site is actually live.

Related: `property-site-changes` for the work itself,
`publishing-a-property-change` for what happens after approval.
