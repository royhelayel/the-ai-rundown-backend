CREATE TABLE IF NOT EXISTS public.user_audio_progress (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content_key text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, content_key)
);
ALTER TABLE public.user_audio_progress ENABLE ROW LEVEL SECURITY;
-- No public policies: only the backend service role accesses rows after verifying
-- the caller's Supabase session. Client-supplied user ids are never used.
CREATE INDEX IF NOT EXISTS user_audio_progress_recent ON public.user_audio_progress(user_id, updated_at DESC);
