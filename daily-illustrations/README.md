# World illustration families

English World News only. Generation starts after checked shared daily summaries/source links are saved. Startup catches up only the latest checked edition within seven days. Read-only viewer requests never create paid work.

## Approved art direction

Three reference images under references/ are the user's approved simplified examples: editorial-cartoon, character-led, data-process. Runtime reference PNGs are resized non-destructively to 512px to reduce image-input cost; full originals remain in the local visual-families preview.

A small GPT-6.1 Terra direction call chooses treatment from story meaning, not category or a number alone. It produces one central concept, at most 3 source-anchored elements/labels, and a tone. Sensitive death/violence/suffering stories cannot use character-led or playful treatment. Quotes must occur in the source summary. The image editor receives only the selected reference as visual style, plus the short summary and validated direction.

GPT Image 2 edits API: low, 896x736. Quality/model never auto-escalate. Reference-input cost is additional and recorded separately using image/text token rates. These settings do not guarantee identical output quality to the built-in preview generator.

A separate vision call sees output + style reference. It checks facts AND style, composition, clutter, label readability and source qualifiers. Any factual or material visual-quality finding withholds publication. No automatic paid repairs. Single-scene artwork stays whole; safe section reveals are optional rather than forcing cuts through subjects. Existing narration/seek drives reveal progress; Full timing remains approximate, not exact phrase alignment.

## Reuse, limits and deployment

Quick and Full share artwork. Keys include policy/model/quality/size and reference hashes; unchanged editions reuse images. Prior accepted v1 artwork remains fallback while v2 is pending or withheld. Status reports policy, treatment, review findings, counts and actual token-based cost estimates.

Two workers; maximum 24 reservations/day, $0.03 reserved per job (application reservation, not provider billing enforcement). Quota-only jobs with no paid calls may resume the next day. A paid or ambiguous failed request never auto-retries. One-time historical regeneration is no longer called at startup. Dubai-day rollover reconciles latest pending edition.

WORLD_ILLUSTRATIONS_ENABLED=false disables serving and generation; LOCAL_PREVIEW=1 disables generation. Other topics unchanged.

Private bucket daily-news-illustrations holds images, manifests, aliases, queues, claims and usage. Only approved public-news images are served at /api/world-illustrations/image/:id. Lookups remain /api/daily-motion/lookup; diagnostics /api/world-illustrations/status.
