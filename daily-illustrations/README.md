# World editorial artwork

English World News only. Hooks run after checked briefing sources are saved; startup queues only the latest checked shared edition within seven days. Consumer lookups never create paid work.

- GPT Image 2, low, 896×736; exact short story summary as sole source.
- GPT-6.1 Terra inspects image, reports material unsupported claims and proposes reveal bands. Any flagged concern withholds publication; no automatic paid repair.
- Quick and Full text aliases share content-hashed artwork, including across unchanged editions. Narration remains the existing audio engine; reveals follow its progress (approximate for Full, rather than forced word-level alignment).
- Two workers, 24 attempted images/day, $0.03 reserved per job ($0.72/day maximum reservation). Actual token-based estimates and usage are recorded separately. This is a conservative application reservation, not a provider-enforced billing limit.
- Global exclusive claims prevent re-spend after restarts and ambiguous timeouts. Failed/withheld requests need explicit review before a new policy/version can retry.
- `WORLD_ILLUSTRATIONS_ENABLED=false` stops queueing and serving the new art. LOCAL_PREVIEW=1 disables generation.
- Non-World generation behavior remains unchanged. Old World React/SVG paid generation is skipped; existing artifacts remain readable as fallback.
- Private Supabase bucket daily-news-illustrations stores image, asset manifests, queue/claims, token usage and estimated cost. Only approved public-news images are served.

Read-only status: /api/world-illustrations/status. Artwork manifests are returned through /api/daily-motion/lookup with type illustration.
