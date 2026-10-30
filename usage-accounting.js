import { AsyncLocalStorage } from 'node:async_hooks';

export const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
// Standard, synchronous Haiku 4.5 requests. Web fetch has no additional tool fee.
// https://platform.claude.com/docs/en/about-claude/pricing
export const PRICES = { input: 1 / 1e6, output: 5 / 1e6, cache5m: 1.25 / 1e6,
  cache1h: 2 / 1e6, cacheRead: .1 / 1e6, anthropicSearch: .01, serperSearch: .001 };
const context = new AsyncLocalStorage();
export const withUsageContext = (details, work) => context.run({ ...context.getStore(), ...details }, work);
const number = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;

export const pricesForModel = model => /^claude-sonnet-4-[56]/.test(model || '') ? { ...PRICES, input:3/1e6, output:15/1e6, cache5m:3.75/1e6, cache1h:6/1e6, cacheRead:.3/1e6 } : PRICES;

export function anthropicCost(usage = {}, model = CLAUDE_MODEL) {
  const prices = pricesForModel(model);
  const writes = number(usage.cache_creation_input_tokens);
  const hour = number(usage.cache_creation?.ephemeral_1h_input_tokens);
  const five = Math.max(number(usage.cache_creation?.ephemeral_5m_input_tokens), writes - hour);
  const tokens = number(usage.input_tokens) * prices.input + number(usage.output_tokens) * prices.output
    + five * prices.cache5m + hour * prices.cache1h + number(usage.cache_read_input_tokens) * prices.cacheRead;
  const search = number(usage.server_tool_use?.web_search_requests) * prices.anthropicSearch;
  return { tokens, search, total: tokens + search };
}

export function addAnthropicUsage(total, usage = {}) {
  for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    total[key] = number(total[key]) + number(usage[key]);
  }
  for (const [key, fields] of Object.entries({
    cache_creation: ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'],
    server_tool_use: ['web_search_requests', 'web_fetch_requests'],
  })) {
    total[key] ||= {};
    for (const field of fields) total[key][field] = number(total[key][field]) + number(usage[key]?.[field]);
  }
  return total;
}

// New fields degrade gracefully until the accompanying SQL has been applied. Never let
// optional metadata prevent the base cost row from being stored.
export function createUsageWriter(supabase, logger = console) {
  const missing = new Set();
  return async function trackUsage(row) {
    for (;;) {
      const body = Object.fromEntries(Object.entries(row).filter(([key]) => !missing.has(key)));
      try {
        const query = supabase.from('api_usage');
        const { error } = body.provider_request_id
          ? await query.upsert(body, { onConflict: 'provider_request_id', ignoreDuplicates: true })
          : await query.insert(body);
        if (!error) return true;
        const field = ['language', 'usage_metadata', 'provider_request_id'].find(key =>
          !missing.has(key) && Object.hasOwn(body, key) && error.message?.includes(key));
        if (field && ['42703', 'PGRST204'].includes(error.code)) {
          missing.add(field);
          logger.warn(`Usage accounting: missing api_usage.${field}; storing cost without it. Apply usage-accounting.sql.`);
          continue;
        }
        logger.warn('Could not track API usage:', error.message);
        return false;
      } catch (error) {
        logger.warn('Could not track API usage:', error.message);
        return false;
      }
    }
  };
}

export function createTrackedAnthropicFetch({ trackUsage, fetchImpl = fetch, logger = console }) {
  return async function fetchAnthropic(init, details = {}) {
    const response = await fetchImpl('https://api.anthropic.com/v1/messages', init);
    // Read a clone so the caller receives precisely the original provider response. Record
    // before parsing/validation/continuation can fail, including NO_ARTICLE responses.
    try {
      const data = await response.clone().json();
      if (data.usage) {
        const { category = null, timeSlot = null, language = null, day = null,
          contentType = 'claude_other' } = { ...context.getStore(), ...details };
        const cost = anthropicCost(data.usage, data.model);
        await trackUsage({ service: 'anthropic', model: data.model || CLAUDE_MODEL,
          input_tokens: number(data.usage.input_tokens), output_tokens: number(data.usage.output_tokens),
          token_cost_usd: cost.tokens, search_cost_usd: cost.search, estimated_cost_usd: cost.total,
          web_searches: number(data.usage.server_tool_use?.web_search_requests),
          category, time_slot: timeSlot, language, content_type: contentType,
          provider_request_id: data.id || response.headers.get('request-id') || null,
          usage_metadata: { accounting_version: 2, usage: data.usage, day, prices: pricesForModel(data.model) },
          created_at: new Date().toISOString() });
      }
    } catch (error) {
      logger.warn('Could not read Anthropic accounting response:', error.message);
    }
    return response;
  };
}

export function searchUsageRow(details = {}) {
  const { category = null, timeSlot = null, language = null, day = null } = { ...context.getStore(), ...details };
  return { service: 'serper', model: 'search', input_tokens: 0, output_tokens: 0,
    token_cost_usd: 0, search_cost_usd: PRICES.serperSearch, estimated_cost_usd: PRICES.serperSearch,
    web_searches: 1, category, time_slot: timeSlot, language, content_type: 'search',
    usage_metadata: { accounting_version: 2, day, price_per_search: PRICES.serperSearch },
    created_at: new Date().toISOString() };
}

// Supabase limits each response to 1,000 rows. Page in a stable order; errors must not
// silently turn an incomplete result into a plausible-looking total.
export async function readAllUsage(supabase, pageSize = 1000) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from('api_usage').select('*')
      .order('created_at', { ascending: true }).order('id', { ascending: true }).range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}

export const uaeDay = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date(date));
const round = n => Math.round(n * 1e8) / 1e8;
function costs(row) {
  const toolSearch = row.service === 'anthropic' && row.usage_metadata?.usage
    ? number(row.usage_metadata.usage.server_tool_use?.web_search_requests) * PRICES.anthropicSearch : 0;
  const search = number(row.search_cost_usd);
  const base = row.token_cost_usd == null ? Math.max(0, number(row.estimated_cost_usd) - search) : number(row.token_cost_usd);
  // Historical Claude rows carried Serper search costs. Keep those dollars in Search.
  return { anthropic: row.service === 'anthropic' ? base + toolSearch : 0,
    narration: row.service === 'unrealspeech' ? base : 0, search: Math.max(0, search - toolSearch),
    other: ['anthropic', 'unrealspeech', 'serper'].includes(row.service) ? 0 : base };
}
export function summarizeUsage(rows, now = new Date()) {
  const today = uaeDay(now), month = today.slice(0, 7);
  const daily = {};
  for (let i = 13; i >= 0; i--) daily[uaeDay(new Date(now.getTime() - i * 86400000))] = { anthropic: 0, narration: 0, search: 0, other: 0 };
  const all = { anthropic: 0, narration: 0, search: 0, other: 0 };
  const monthly = { ...all };

  let calls = 0, searches = 0, allSearches = 0, input = 0, output = 0, cacheWrite = 0, cacheRead = 0, legacy = 0;
  for (const row of rows) {
    const date = uaeDay(row.created_at), inMonth = date.slice(0, 7) === month;
    const c = costs(row);
    for (const key of Object.keys(all)) {
      all[key] += c[key];
      if (inMonth) monthly[key] += c[key];
      if (daily[date]) daily[date][key] += c[key];
    }
    if (inMonth) { calls++; searches += number(row.web_searches); }
    allSearches += number(row.web_searches);
    if (row.service === 'anthropic') {
      const usage = row.usage_metadata?.usage;
      input += number(row.input_tokens);
      output += number(row.output_tokens);
      cacheWrite += number(usage?.cache_creation_input_tokens);
      cacheRead += number(usage?.cache_read_input_tokens);
      if (!usage) legacy++;
    }
  }
  const sum = obj => Object.values(obj).reduce((a, b) => a + b, 0);
  return {
    accounting_version: 2, timezone: 'Asia/Dubai', legacy_anthropic_rows: legacy,
    cost_all_time: round(sum(all)), cost_this_month: round(sum(monthly)),
    anthropic_cost_this_month: round(monthly.anthropic), narration_cost_this_month: round(monthly.narration),
    search_cost_this_month: round(monthly.search), other_cost_this_month: round(monthly.other),
    calls_this_month: calls, searches_this_month: searches, total_web_searches: allSearches,
    total_input_tokens: input, total_output_tokens: output,
    total_cache_creation_input_tokens: cacheWrite, total_cache_read_input_tokens: cacheRead,
    by_provider: Object.keys(all).map(service => ({ service, cost_all_time: round(all[service]), cost_this_month: round(monthly[service]) })),
    by_day: Object.entries(daily).map(([date, c]) => ({ date, ...Object.fromEntries(Object.entries(c).map(([k,v])=>[k,round(v)])), cost: round(sum(c)) })),
    recent_runs: [...rows].sort((a,b) => b.created_at.localeCompare(a.created_at)).slice(0,100),
  };
}
