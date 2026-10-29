# Basic vector edition — 27 October 2026, English

162 Quick brief updates and 183 Full brief summaries across 16 categories/subcategories
have explicit editorial scene compositions. One identical narration is shared, giving
344 distinct content-addressed records. Geometry is served by the existing read-only
lookup endpoint before consulting storage. No model calls, image generation or MP4
rendering are needed to build or serve this edition.

`source.json` contains only the already published English text and its public attribution
links. `edition-designs.mjs` assigns objects per individual development; no classifier
selects topic templates. `drawings.mjs` supplies reusable vector drawing vocabulary.
Every primitive and label retains an exact source excerpt. Numbers stay in context;
there are no invented charts, quantitative pictograms or quantitative object counts.
The drawings are conceptual illustrations, not documentary evidence.

Run `node animation-editorial/build.mjs`, then `node --test animation-editorial.test.js
story-animations.test.js`. The generated JSON is committed so Render can serve it without
generation credentials or a private storage write. Normalized text hashes prevent stale
drawings being applied after an editorial change.

This is an explicitly authored edition, not automatic free art creation for future news.
New publications, older editions, other languages, and period recaps need their own
reviewed designs or an explicitly authorized generation workflow. Paid Anthropic
generation remains disabled. The frontend retains its previous visuals for uncovered
updates while using these new records wherever the exact narration matches.
