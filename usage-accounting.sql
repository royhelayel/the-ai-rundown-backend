-- Preserve provider usage (including cache tokens) without storing prompts or article text.
ALTER TABLE public.api_usage ADD COLUMN IF NOT EXISTS usage_metadata jsonb;
ALTER TABLE public.api_usage ADD COLUMN IF NOT EXISTS provider_request_id text;
CREATE UNIQUE INDEX IF NOT EXISTS api_usage_provider_request_id_key ON public.api_usage (provider_request_id);
NOTIFY pgrst, 'reload schema';
