# CLAUDE.md

Guidance for Claude Code working in this repository. The companion repo is the frontend at
`/Users/royhelayel/the-ai-rundown-frontend`; changes often span both.

## Before you touch anything: sync

This repo is edited from **two places** — this local clone, and a Claude project with
GitHub access. Neither one knows about the other's work until git moves it. So at the
**start of every session, before reading or editing any file**:

```bash
git fetch --all --prune
git status -sb
git branch -r --sort=-committerdate | head
```

Then report to Roy, before doing the requested work:
- **Behind origin/main** → `git pull` (fast-forward only; see below) and say what arrived.
- **A remote branch newer than main** → the web project opens PRs rather than pushing to
  main, so work can be sitting on a branch while main looks clean. Name the branch and ask
  whether it should be merged first. Do not start work that might conflict with it.
- **Diverged, or local uncommitted changes on top of remote ones** → stop and say so. Do
  not improvise a merge.

`pull.ff = only` is set locally in this repo, so `git pull` **fails loudly** when the
histories have diverged instead of quietly creating a merge commit. That failure is the
signal to stop and ask, not something to work around with `--no-ff` or a rebase.

**The rule that prevents the mess:** leave this side clean — committed *and pushed* — at
the end of a session, so the other side always starts from the truth. Verify the push
landed (`git status -sb` showing no "ahead"); a commit is not a push.

## Commands

```bash
npm start   # node backend-server.js — port 3001 by default
npm run dev # same, with --watch
```

There is no test suite and no build step. This is ESM (`"type": "module"` in package.json) —
use `import`, never `require`.

## Deploy

Render auto-deploys on push to `main`. Pushing *is* deploying; there is no separate step and
no staging environment. The frontend deploys to Vercel the same way.

## Layout

- **`backend-server.js`** — ~4,700 lines, 56 Express routes, the entire service in one file:
  news retrieval, digest generation, TTS, metrics, scheduling, and the `/admin/api/*`
  endpoints. `app.listen` is at the bottom.
- **`tier1-sources.js`** — the outlet registry (~83 outlets). Each entry carries `domain`,
  `name`, `lang`, `gl`, `fetch` (whether robots.txt permits reading the body), `cats`
  (category → feed URL, or `null` meaning "no feed, use lane 2") and a `note`. Exports
  `sourcesFor()`, `mayFetchBody()`, `sourceForUrl()`, `GOOGLE_SECTIONS`, `TIER1_DOMAIN_SET`.
- **`admin/index.html`** — the back-office dashboard, plain HTML talking to `/admin/api/*`.
  Config, Compare, coverage-gap and completeness views live here.
- **`supabase-setup.sql`** — schema reference, not run automatically.

## Retrieval

`buildCorpusContext()` (line ~1309) is the production path, gated by the
`corpus_retrieval_enabled` setting (default on, togglable from the admin Config tab). It runs
four lanes — outlet feeds, Google News sections, Google News search, then body scraping for
articles no lane returned text for — then gates on tier-1 membership, freshness and language,
dedupes, and **groups** near-identical articles into single stories before handing them to the
model. The legacy Serper path is still in the file for comparison.

Google News links (lanes 2 and 3) are decoded to the publisher's own URL by
`decodeGoogleNewsUrl` — Google's own batchexecute call, free, capped per category — before
Serper's paid lookup is tried. Every page read also yields its meta description
(`metaDescription`), kept even when the article itself can't be read. Regional categories run
`regionFilter` on the ranked headlines before reading, because their outlets' listings carry
world news that the writer would otherwise discard after it had taken a slot.

Hard product constraints, set by Roy and not negotiable:
- **Tier-1 sources only.** Anything not in `TIER1_DOMAIN_SET` is dropped, not downranked.
- **No paywalled content and nothing that isn't permitted.** Paywalled outlets
  (`paywall: true` in the registry) are neither read nor cited; `mayFetchBody()` reflects each
  outlet's robots.txt.
- **Quick briefs, written from whatever we receive** (Roy, 2026-10-17). RadioNews is fast-paced
  quick briefs, not long reads, and the briefs are not all equally detailed. A story with a full
  article is summarised as before; one with only the outlet's one-or-two-sentence description is
  written from that; one with only its headline gets one plain sentence restating the headline.
  No story is dropped for want of an article — `readUntilFilled` labels each one `article`,
  `description` or `headline` (`st.material`), fills the feed richest-first (a story three or
  more outlets carried counts as top tier whatever we could read of it), and keeps the ranked
  order. The writer and the fact-check are told each story's material; a story's own headline
  counts as material. Only a story paywalled on every outlet is passed over.
- **Summaries say only what we retrieved.** The app tells people what the headlines are,
  explains them a little, and links out. No background, context, causes, consequences,
  predictions or significance unless an article states it; if the articles can't explain
  something, it stays unexplained. `GROUNDING_RULES` is the single statement of this and goes
  into every prompt that writes a summary — never add an instruction that asks the model for
  context it wasn't given.
- **Every published statement is checked.** `groundDigest` checks the digest *and* the cards
  against the retrieved articles, rewrites stories with untraceable statements, rechecks once,
  removes what's still untraceable, and drops a story left with nothing. A dropped story is
  replaced from the reserves (`readUntilFilled` keeps 12 + up to 4). The briefing is checked
  against the finished digest.
- **Recaps: prevent, prove, mend** (Roy, 2026-10-18). The recap writer copies numbers, names,
  titles, status words and attributions exactly — no rounding, no relabelling. The recap check
  (`groundBriefing`) is a logical check that must quote the exact recap and digest words behind
  every finding; `provenRecapIssues` confirms the quotes are really there and dismisses any
  finding that can't show conflicting words. Repairs rewrite only the flagged sentences, up to
  three times (`validateRecap`); a sentence still flagged after that comes out, and the recap is
  withheld only when nothing survives. Too long is mended the same way, by tightening the longest
  sentences — a whole rewrite of an over-length recap made it longer and dropped stories.
  `POST /admin/api/recap-redo` re-writes a slot's empty recaps under the same rules.
- **No "Why this matters" and no "Perspectives differ".** A story is its headline and its facts
  (Roy, 2026-10-15). `GROUNDING_RULES` says so; no prompt asks for either.
- **Recaps carry their sources.** After a recap passes its check, `attributeRecap` records which
  digest story each sentence came from (`briefing_sources`, validated by `attributionMap`). The
  app shows "Sources · N" per paragraph from it. A failed attribution publishes the recap
  without sources — never guessed ones.
- **Last week / Last month are built from checked stories**, not headlines: `generatePeriodRecap`
  picks the period's stories covered on the most days, then by the most outlets, from daily
  digests whose check passed, writes with the daily writer and checks with `groundBriefing`.
  A withheld recap clears the stored one.
- **Reads live on the server** (`user_reads`, keyed by headline, with `headline` and `day`), so
  every device shows the same Read badges and challenge progress.

The Anthropic balance is sometimes left empty on purpose to limit spend while Roy is building.
A generation failing with "credit balance is too low" in that period is expected, not an outage.

## Migrations

Schema changes follow a graceful-degradation pattern: the code tries the new column or table,
and on failure logs the `CREATE TABLE` / `ALTER TABLE` SQL for Roy to run in Supabase by hand
rather than crashing. Keep that pattern — do not add a migration runner.
