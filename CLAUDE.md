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

Two hard product constraints, set by Roy and not negotiable:
- **Tier-1 sources only.** Anything not in `TIER1_DOMAIN_SET` is dropped, not downranked.
- **No paywalled content and nothing that isn't permitted.** `mayFetchBody()` reflects each
  outlet's robots.txt; never read a body it says no to.

## Migrations

Schema changes follow a graceful-degradation pattern: the code tries the new column or table,
and on failure logs the `CREATE TABLE` / `ALTER TABLE` SQL for Roy to run in Supabase by hand
rather than crashing. Keep that pattern — do not add a migration runner.
