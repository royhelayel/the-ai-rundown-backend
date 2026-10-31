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

## Shared headline summaries (2026-10-25)

The daily Listen programme uses the same verified Summary paragraphs as Read. The writer,
fallback card writer and grounding repair use `SPOKEN_SUMMARY_STYLE` from
`spoken-summary-style.js`; grounding takes precedence. Do not embed presenter introductions,
category transitions or sign-offs in a story: the frontend supplies these separate clips.
Daily category recaps are restored alongside Headlines, Weekly and Monthly. They target roughly 18 words per story, from a fully checked digest, and pass the same grounding and attribution gates. English recap audio is pre-generated. Weekly/monthly recaps
still use the checked source digests and retain their grounding and attribution gates.

## Narration delivery (2026-10-25)

All Unreal Speech synthesis paths use `unrealSpeechPayload`: Temperature 0.45, Speed
0.03, Pitch 1, with the existing configured voice. This moderately increases expressiveness
and pace for new recordings. Existing cached audio is deliberately retained to avoid
regenerating the library or increasing playback latency.

## Audio programme progress (2026-10-27)

`audio-progress.js` registers authenticated GET/POST `/api/audio-progress`. User identity comes
only from `auth.getUser(Bearer token)`, never a body/query user id. `user-audio-progress.sql`
creates a private RLS-enabled table (already applied to production); only the service role
accesses it through these routes. Merge unique played intervals across devices, derive recap
completion at 70%, and verify every queue recording before accepting a completed mix.
Per-user write serialization prevents concurrent device syncs losing intervals on this service.
The frontend sends batches of 20. Local progress remains usable when sync is unavailable.
Recap writer instructions now favor clear, naturally paced spoken sentences; grounding,
qualification and coverage checks remain unchanged. Existing cached recordings are retained.

## API usage accounting (2026-10-27)

`usage-accounting.js` records every Anthropic Messages response at the transport boundary,
including article fetches that yield no article, preflights, diagnostic calls and each continuation.
Do not add delayed usage inserts to digest/recap callers: that would double-count them.
`provider_request_id` is unique; provider response usage is retained in `usage_metadata`,
including uncached input, output, 5-minute/1-hour cache writes and cache reads. The SQL in
`usage-accounting.sql` has been applied to production; optional metadata degrades gracefully.
AsyncLocalStorage attributes concurrent categories/languages without a global mutable context.
Serper successful requests get their own cost row, even if subsequent generation fails.
Unreal Speech records characters in metadata, never as Claude tokens. The admin API pages
through all usage rows, groups dates in Asia/Dubai and reports provider costs separately;
recorded API calls must not be labelled generation runs. Older records are retained as-is.
Verify changes with `node --test usage-accounting.test.js` (mocked providers; no paid calls).

## Duplicate recap coverage (2026-10-29)

The recap writer covers each distinct development once, tagging duplicate reports together
(for example `[3,9]`). Separate developments sharing a company remain separate. The existing
grounding/coverage checks still run. `deduplicateRecapLines` also removes literal repeats
before each grounding audit, retaining the union of story IDs and every qualification. It
does not fuzzy-match or merge merely similar claims. This applies before recap storage and
audio pre-generation; existing recordings are not silently edited or regenerated.

## Per-update generated animations (2026-10-29)

`story-animations.js` generates unique declarative vector drawings from each exact published
update through the tracked Anthropic transport (`contentType: story_animation`). It does not
select story/topic templates. The schema permits only bounded numeric SVG primitives and
literal source-excerpt labels, with normalized audio-progress keyframes. No model HTML, JS,
CSS, URLs or arbitrary attributes execute in clients. Plans are validated and cached in the
private `story-animations` storage bucket by version and SHA-256 of the exact normalized text.

Startup backfills the seven accessible edition dates and recent period recaps. New publication
queues plans after recap attribution is saved. Recap updates are prioritised before full story
summaries. Consumer POST `/api/story-animations/lookup` is read-only and cannot incur provider
spend; `/api/story-animations/status` exposes progress counts without provider secrets/errors.
Provider credit/rate/storage failures stop the queue. `GENERATE_STORY_ANIMATIONS=0` disables
startup backfill. Missing/invalid plans must be disclosed, never replaced with a preset while
claiming it is a generated animation. Audio generation and news text are not changed.

## Anthropic animation spending disabled (2026-10-29)

Roy reserved the Anthropic top-up for later news generation. The reference-style animation
prototype will use the image-generation tool and Remotion instead. `createStoryAnimations`
defaults to disabled, and the production constructor explicitly passes `enabled:false`.
Startup, publication queues and manual drain cannot make animation provider calls while
disabled. A top-up or service restart must not enable it. Existing cached plans remain
readable. Do not re-enable paid Anthropic animation generation without Roy's authorization.

## Editorial basic animation edition (2026-10-29)

Roy chose to continue basic animation without paying a generation provider. The reviewed
`animation-editorial` bundle covers October 27 English: 162 quick updates and 183 full
summaries, 344 distinct exact-text records across 16 topics. Lookup serves these bundled
plans before storage, without model or database calls. Every element is schema-validated
and retains literal source evidence. This is a manually authored current edition; future
cycles are not automatically illustrated for free. Anthropic generation stays disabled.
The status endpoint reports editorial coverage separately from paid generation counters.

## Isolated World automation pilot (2026-10-30)

Roy explicitly requested a simulation of automatic storyboards/drawings for today's World
stories. `storyboard-pilot/` runs one fixed World News English edition (2026-10-30),
max12 full summaries, two workers, $1 conservative reserved budget, max one automatic
drawing repair. Separate tracked calls: storyboard, drawing, model audit. No manual
geometry edits counted as automation; generated is NOT equivalent to visually approved.
New bounded grouped SVG schema honors time-based movements rather than the live renderer's
generic entrance choreography. Model text/code/URLs never execute.

The pilot uses the configured backend Anthropic transport and accounting. A private
Supabase Storage claim at storyboard-pilots/world-2026-10-30-v1/claim.json is atomic and
permanent: restarts/deploys cannot re-spend. Never delete the claim or silently resume.
Local preview does not launch. This is a one-time isolated run, not a global generator
enablement. Existing storyAnimations remains disabled. No TTS/news generation and no
publication to consumer animation lookup. Read-only /api/storyboard-pilot/world-2026-10-30-v1
returns only public published summaries and pilot results. Review these before deciding
on a production rollout. Source paragraphs are not rewritten.
Run tests: node --test storyboard-pilot/pilot.test.js usage-accounting.test.js story-animations.test.js.

Pilot pass 1 completed with 0/12 valid drawings, $0.470606, 344.201 seconds.
Pass 2 retries only failed stories using the remaining budget ($1 minus pass1 spend),
with its own durable claim world-2026-10-30-v2. It will not start until pass1 is complete.
General schema compatibility supports polygon/polyline, full-turn rotations and held
endpoint poses; unsupported source labels are removed rather than published. Source
matching ignores only whitespace/case. No story-specific drawings were manually edited.
Pass2 preserves last rejected candidate for diagnosis; generated output still requires
an independent model audit and later human visual review. Public read report path is
/api/storyboard-pilot/world-2026-10-30-v2. Both passes' cost remains visible; do not
claim pass2 is the first run or hide failed attempts when discussing quality/latency.

Pilot closed: both passes finished, 0/12 drawings passed validation. Pass2 $0.434753,
342.630s; combined $0.905359, 686.831s batch wall time, 62 tracked API calls. No audits
were reached because drawing validation failed. Do not label this successful end-to-end
latency or use it to promise publication timing. Five rejected candidates have bounded
DIAGNOSTIC previews; these are not accepted/grounded publication assets. The startup
invocation has been removed. Report is read-only; no new generation occurs on deploy.

## Structured repair pilot v3 (2026-10-30)

Roy explicitly asked to fix the failed0/12 pilot. `contract-v3.js` uses provider JSON schema
via output_config.format, sentence IDs as evidence references, and explicit group-LOCAL
geometry placed at{x,y}. Negative local coordinates/zero starting scale are legitimate.
`repair-v3.js` uses Haiku4.5 for storyboard/audit and Sonnet4.6 for drawing, max9000 output
tokens, one automatic drawing repair, two workers and $2 total across sample/rest waves.
Sonnet input/output/cache rates are handled by model-aware usage accounting. News generation
still uses its original model. Semantic audit is independent and cannot be bypassed for a
successful record. Raw semantic references are not proof; visual review remains separate.

Sample wave is3 varied original World Oct30 stories (indices0,1,2), fixed private Storage
claim prevents repeated spend. Only after visual review should WAVE change to rest (9).
Rest requires sample3/3 and subtracts sample cost from $2 budget. Consumer lookups cannot
start a run. No live-feed publication; separate read-only route is
/api/storyboard-pilot/world-2026-10-30-v3. Remove startup invocation after completion.
Tests: node --test storyboard-pilot/*.test.js usage-accounting.test.js story-animations.test.js.
Provider schema reference: https://platform.claude.com/docs/en/build-with-claude/structured-outputs

Repair sample v3 completed at $0.314035. Format was fixed, but a mistaken dimension bound
rejected540px platforms, and Haiku audit incorrectly demanded death depiction, all quantities
encoded and decorative layout verified. Corrected bounds retain finite/safe numeric geometry;
source auditor now Sonnet4.6 with explicit factual-error-only criteria (not coverage/style).
V4 sample reuses v3 completed raw drawings and storyboards, auditing first and redrawing only
on a concrete failed audit. Its budget subtracts the prior repair sample's spend from $2.
Rest wave subtracts the whole sample repair total. Original rejected reports remain stored.
No success is created by ignoring a model rejection; the revised audit must return pass true.

V4 sample3/3 passed format+Sonnet factual audit; completed reusable drawings were re-audited
rather than redrawn. Re-audit7.497s,$0.037518; cumulative repair sample cost$0.351553
including the earlier$0.314035 repair sample. Phone preview checked actor/theatre-to-film,
crypto breach/freeze and rail-collision/mourning compositions and movement. No individual
geometry was manually changed. Artwork remains prototype quality; passing audit is not
editorial/polish approval. WAVE now rest for9 originals, budget$1.648447 remaining of$2.
Do not re-run sample or its private storage claim. Final startup call must be removed.

Rest wave finished6/9, cumulative repair$1.204223. The remaining3 (indices5,8,11) have
complete artwork but every object starts with opacity0. Universal opening normalization
now starts the earliest fully visible source-linked object at its settled pose; all other
objects and geometry are unchanged. This prevents a blank paused poster without accepting
an entirely invisible drawing. WAVE recovery reuses only these3 raw candidates, applies
normalization, then independently audits them. No drawing charges unless a real audit fails;
remaining budget is $2 minus rest.repairTotalCostUSD. All previous calls remain accounted.

Opening recovery passed2/3, cumulative repair$1.298705. Final original story(index11,
China expulsions) generated91 individual roster primitives, over the bounded75-shape
limit. No source audit was bypassed. WAVE final regenerates ONLY that story with the
universal instruction to explain large-count news using representative objects, rather
than one primitive per person/item. Shape-limit errors now name the actual count so
repairs are actionable. $2 cap still includes every prior repair wave; eleven completed
stories remain untouched. Remove startup invocation after final completion.

Repair pilot closed on October31: original October30 World edition now12/12 passes
format validation and independent Sonnet factual audit. Total repair$1.438460,51 API
calls,572.107s summed generation-wave wall time (9m32s); includes every failed repair
sample/retry/re-audit, excludes human development/deployment/review. Original failed
pilot$0.905359 remains separate in report history. All startup generation invocations
removed; durable claims retained. No live consumer artwork publication, news generation
or TTS generation. Standalone public storyboard-pilot.html is the review surface.
Do not describe audit success as final visual polish or a guaranteed production SLA.

## Staged visual/motion repair (October31)

Roy rejected the12/12 pilot as barely functional and specifically reported poor motion.
Those passes certified structure/source audit, NOT visual quality; do not cite them as
creative acceptance. `staged-contract`, `staged-render`, `render-gate`, `staged-run` replace
cumulative faded layers with2–4 separate source-timed shots,1–4 large custom actors, short
literal source labels and meaningful opaque movement/proportion change per shot. No
story-specific hand drawing or canned category scenes. Renderer is shared between browser
and backend frame rasterization. @resvg/resvg-js plus bundled Inter(OFL) renders real frames;
PNG pixel-change gate rejects visually unchanged geometry, and Sonnet vision sees a contact
sheet of setup/action/result for every shot before a result can pass. JSON/source proofs
alone are insufficient. Pause/resume/seek/background clock tests cover actual timing bugs.

Fixed bounded sample indices1,7,11 (Binance, Hong Kong, China) from original Oct30 edition;
staged-v1-sample durable claim prevents re-spend. $2 cap for sample+rest combined,2 workers,
max1 repair per story. Sample must pass image review AND browser human review before WAVE
rest. Provider transport includes actual PNG image content and uses model-aware usage.
All previous pilot startup calls remain off. Remove staged startup call when finished.
Read-only /api/storyboard-pilot/staged and /staged/sheet/:index expose report/rendered frames.
No live feed news/audio/artwork publication. Old12/12 is not the new readiness measure.

Staged-v1 sample provider schema compilation was rejected before generation ($0). The
polymorphic geometry union made the compiled grammar too large. Staged-v2 uses a compact
uniform shape record(type, numeric values[], d, paint) instead; local geometry validation
and renderer produce the identical safe shapes. All visual/motion/source checks remain.
The failed v1 claim/report remain preserved; do not silently delete/reuse a claim.

Staged-v2 compositions finished but all3 failed label length/placement rules ($0.327204).
The prompt omitted the numeric character limit and centre-anchor definition; this was a
contract/instruction defect. Staged-v3 reuses those exact objects and motion, asking only
for short literal labels and explicit centre-based placement, then runs the actual raster
and vision gates. Source labels remain grounded; no geometry is manually edited. New
prompt states maximum30 label chars and coordinate examples. The $2 cap subtracts v2's
spend; rest subtracts the full sample total including prior attempts. Old failed report is
retained. A pass requires rendered-image review, visible action and browser QA, not just
provider JSON conformance. Do not claim success before those happen.

Staged-v3 exposed a false syntactic label gate: concise grammatical rephrasing such as
"record33 expelled" and "compromised DevOps laptop" was rejected despite the same source
facts. Staged-v4 reuses those compositions directly; labels must use source vocabulary,
standard abbreviations/verb forms and source quantities, while independent rendered-image
source review checks roles/meaning. Missing numerical qualifiers are restored from the
source (e.g more than3%, not3%). Invented numbers/unsupported vocabulary still fail locally.
Multi-turn clock rotation1080deg is finite/safe; the image reviewer must still reject a
rotating whole clock/door frame when the stated action requires a moving hand/leaf. It
also checks that charts move the intended value rather than scaling all bars together.
No image pass is silently created. Budget subtracts all staged-v3 costs ($0.511212).

The first real rendered vision audit rejected the crypto sample for genuinely weak motion:
static coin stream, blank setup, a generic ice rectangle, both chart bars shrinking, and
unsourced relative bar heights. These were exactly the defects the earlier JSON/source
checks missed. The automatic repair generated revised assets, but a qualified percentage
label needed more wrapping room. Canvas/labels now allow a420px-high scene and up to3
readable26px lines; artwork region remains unchanged. Written source quantities(e.g seven)
match digit labels(7). Concise label semantics are verified by the rendered source reviewer,
not an inadequate word-membership heuristic; invented numbers still fail locally, numerical
qualifiers are restored. Native SVG line weight remains bounded0..16. Staged-v5 reuses latest
complete candidates and renders/audits them before any success. Budget includes all previous
staged attempts ($0.692940); no old twelve-story quality claim is carried forward.

## Daily Remotion generation validation (October 31)

World News/Business daily generation queues Haiku scene planning, JSX compilation and
independent grounding review in `daily-motion/`; other categories remain disabled.
The approved short script is bound directly, and plans/audits use deterministic source
sentence IDs to avoid false failures from retyping quotes. No malformed/failed review
is silently accepted. Invalid reviewer output gets one fresh review within the same
per-job cap. Consumer lookups never start generation. Public diagnostics are fixed
failure enums only; raw provider errors, plans and code stay in private storage.
One explicit durable validation-contract-v2 recovery may retry ONLY the original two
failed rollout samples once, retaining old claims/reservations. Remove its startup
invocation after verification. Never delete claims or reset accounting to retry.

The validation recovery produced one ready World asset; the original Business condensed
script failed factual review. No rejection was bypassed. Unmapped stories now bind the
exact first published sentence as illustration focus (max65words), not a model rewrite.
A one-time business-source-binding-v1 check tests only that original Business story with
the changed focus/key. Original claims/spend remain. Remove startup check after completion.

Daily-motion verification cleanup: all one-time rollout/recovery startup helpers removed.
World successfully generated; actual deployed sandboxed Remotion Player checked at four
seek positions, with Quick/Full sharing one artifact. This is a technical pass only;
small secondary labels remain a visual-quality concern. Business samples failed review
and remain withheld, not rubber-stamped. Private failures need inspection before claiming
both categories fully verified. Mutable storage uses cacheNonce/no-store downloads and
cacheControl0 uploads; assets/runtime remain immutable/cacheable. Re-publication must not
reset terminal unavailable/budget aliases to pending. Never silently clear old costs.

## Uploaded daily-motion failure diagnosis

Roy supplied private Business claim325380...-0.json. Reviewer confused18 representative
circles with17 wallet addresses and demanded Ether coverage outside the selected Bitcoin
sentence, causing repair scope drift. Review must evaluate the SELECTED short-script
coverage, with full source for contradictions/qualifications; it must still reject real
false labels, invented quantitative ratios or missing qualifications affecting that claim.
Do not waive model rejection; revised candidates require explicit new approval.
Real timing defect: frame/fps seconds were compared with normalized0..1 beat times, rushing
all action into the first second. validateScene rejects this pattern and literal fonts<30px.
Artist prompt now mandates normalized frame/(durationInFrames-1) through the useful timeline.
Generation policy focus-normalized-v2 participates in cache keys; old assets remain readable.
One durable check queues one original World/Business source under revised policy. Remove
startup check after QA; do not delete previous claims or silently reset spending.
