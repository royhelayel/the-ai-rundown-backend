import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicCost, addAnthropicUsage, createUsageWriter, createTrackedAnthropicFetch,
  withUsageContext, searchUsageRow, readAllUsage, summarizeUsage } from './usage-accounting.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const quiet = { warn() {} };
const response = (id, usage, extra = {}) => new Response(JSON.stringify({ id, model: 'claude-haiku-4-5-20251001', usage, ...extra }), { headers: { 'content-type': 'application/json' } });

test('prices uncached, cache-write durations, cache hits and output without counting cache twice', () => {
  const cost = anthropicCost({ input_tokens: 1000, output_tokens: 1000, cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 }, cache_read_input_tokens: 1000,
    server_tool_use: { web_fetch_requests: 8, web_search_requests: 1 } });
  near(cost.tokens, .00765);
  near(cost.search, .01);
  near(cost.total, .01765);
  near(anthropicCost({ cache_creation_input_tokens: 1000 }).tokens, .00125);
});

test('continuations preserve all cache and tool usage fields', () => {
  const usage = {};
  addAnthropicUsage(usage, { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 30 } });
  addAnthropicUsage(usage, { input_tokens: 15, output_tokens: 25, cache_read_input_tokens: 30, server_tool_use: { web_fetch_requests: 1 } });
  assert.equal(usage.input_tokens, 25);
  assert.equal(usage.output_tokens, 45);
  assert.equal(usage.cache_creation_input_tokens, 30);
  assert.equal(usage.cache_creation.ephemeral_5m_input_tokens, 30);
  assert.equal(usage.cache_read_input_tokens, 30);
  assert.equal(usage.server_tool_use.web_fetch_requests, 1);
});

test('a billed NO_ARTICLE response is recorded before the caller rejects its content', async () => {
  const rows = [];
  const request = createTrackedAnthropicFetch({ trackUsage: async row => rows.push(row), logger: quiet,
    fetchImpl: async () => response('msg_no_article', { input_tokens: 200, output_tokens: 10, cache_read_input_tokens: 500 }, { content: [{ type: 'text', text: 'NO_ARTICLE' }] }) });
  const res = await withUsageContext({ category: 'UAE', language: 'ar', timeSlot: 'Morning', day: '2026-10-27' }, () => request({}, { contentType: 'article_fetch' }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider_request_id, 'msg_no_article');
  assert.equal(rows[0].language, 'ar');
  assert.equal(rows[0].usage_metadata.usage.cache_read_input_tokens, 500);
  assert.equal((await res.json()).content[0].text, 'NO_ARTICLE');
  near(rows[0].estimated_cost_usd, .0003);
});

test('paid earlier responses remain recorded when a later continuation fails', async () => {
  const rows = [];
  let calls = 0;
  const request = createTrackedAnthropicFetch({ trackUsage: async row => rows.push(row), logger: quiet,
    fetchImpl: async () => ++calls === 1 ? response('msg_first', { input_tokens: 10, output_tokens: 100 }, { stop_reason: 'max_tokens' }) : new Response('{"error":{"message":"credit balance is too low"}}', { status: 400 }) });
  await request({}, { contentType: 'digest' });
  const error = await request({}, { contentType: 'digest' });
  assert.equal(error.status, 400);
  assert.equal(rows.length, 1);
  near(rows[0].token_cost_usd, .00051);
});

test('parallel categories keep their own language and category attribution', async () => {
  const rows = [];
  const request = createTrackedAnthropicFetch({ trackUsage: async row => rows.push(row), logger: quiet,
    fetchImpl: async init => { await Promise.resolve(); return response(init.id, { input_tokens: 1 }); } });
  await Promise.all([
    withUsageContext({ category: 'World News', language: 'en' }, () => request({ id: 'a' })),
    withUsageContext({ category: 'LEB', language: 'ar' }, () => request({ id: 'b' })),
  ]);
  assert.deepEqual(rows.map(r => [r.category, r.language]), [['World News', 'en'], ['LEB', 'ar']]);
});

test('provider IDs are deduplicated with an upsert; legacy metadata columns degrade gracefully', async () => {
  const attempts = [];
  const writer = createUsageWriter({ from: () => ({
    async upsert(row, options) { attempts.push({ row, options }); return { error: { code: 'PGRST204', message: 'Could not find provider_request_id' } }; },
    async insert(row) { attempts.push({ row }); return row.usage_metadata ? { error: { code: '42703', message: 'column usage_metadata does not exist' } } : { error: null }; },
  }) }, quiet);
  assert.equal(await writer({ provider_request_id: 'msg_1', usage_metadata: { accounting_version: 2 }, token_cost_usd: .01 }), true);
  assert.deepEqual(attempts[0].options, { onConflict: 'provider_request_id', ignoreDuplicates: true });
  assert.deepEqual(attempts.at(-1).row, { token_cost_usd: .01 });
});

test('storage failure does not change the original provider response', async () => {
  const request = createTrackedAnthropicFetch({ trackUsage: async () => { throw Error('database down'); }, logger: quiet,
    fetchImpl: async () => response('msg_1', { input_tokens: 1 }) });
  assert.equal((await (await request({})).json()).id, 'msg_1');
});

test('all pages contribute to totals and a later page failure is reported', async () => {
  const source = Array.from({ length: 2103 }, (_, id) => ({ id, created_at: '2026-10-27T00:00:00Z' }));
  const ranges = [];
  const db = { from() { return this; }, select() { return this; }, order() { return this; }, async range(a,b) { ranges.push([a,b]); return { data: source.slice(a,b+1), error: null }; } };
  assert.equal((await readAllUsage(db)).length, 2103);
  assert.deepEqual(ranges, [[0,999],[1000,1999],[2000,2999]]);
  db.range = async a => a ? { error: { message: 'timeout' } } : { data: source.slice(0,1000) };
  await assert.rejects(readAllUsage(db), /timeout/);
});

test('provider totals separate old mixed fees and narration characters; dates use UAE month boundaries', () => {
  const rows = [
    { service: 'anthropic', token_cost_usd: 2, search_cost_usd: .2, estimated_cost_usd: 2.2, input_tokens: 1000, output_tokens: 500, web_searches: 200, created_at: '2026-09-30T21:00:00Z' },
    { service: 'unrealspeech', token_cost_usd: 1, estimated_cost_usd: 1, input_tokens: 125000, created_at: '2026-10-01T00:00:00Z' },
    { service: 'anthropic', token_cost_usd: 0, estimated_cost_usd: 4, input_tokens: 10, output_tokens: 0, usage_metadata: { usage: { cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } }, created_at: '2026-10-01T00:00:00Z' },
    { service: 'serper', token_cost_usd: 0, search_cost_usd: .001, estimated_cost_usd: .001, web_searches: 1, created_at: '2026-10-01T00:00:00Z' },
  ];
  const result = summarizeUsage(rows, new Date('2026-10-01T03:00:00Z'));
  near(result.cost_this_month, 3.201);
  near(result.anthropic_cost_this_month, 2);
  near(result.narration_cost_this_month, 1);
  near(result.search_cost_this_month, .201);
  assert.equal(result.calls_this_month, 4);
  assert.equal(result.total_input_tokens, 1010);
  assert.equal(result.total_cache_creation_input_tokens, 20);
  assert.equal(result.total_cache_read_input_tokens, 30);
  assert.equal(result.legacy_anthropic_rows, 1);
  near(result.by_day.at(-1).cost, 3.201);
  near(result.by_provider.reduce((sum,p) => sum + p.cost_this_month, 0), result.cost_this_month);
});

test('Anthropic web-search tool fees use Anthropic credits while Serper has its own bucket', () => {
  const row = { service: 'anthropic', input_tokens: 0, token_cost_usd: .1, search_cost_usd: .01, estimated_cost_usd: .11,
    usage_metadata: { usage: { server_tool_use: { web_search_requests: 1 } } }, created_at: '2026-10-27T00:00:00Z' };
  const result = summarizeUsage([row], new Date('2026-10-27T06:00:00Z'));
  near(result.anthropic_cost_this_month, .11);
  near(result.search_cost_this_month, 0);
});

test('Serper gets a separate character-free record at the actual successful lookup', async () => {
  const row = await withUsageContext({ category: 'Business', language: 'en' }, async () => searchUsageRow());
  assert.equal(row.service, 'serper');
  assert.equal(row.category, 'Business');
  assert.equal(row.input_tokens, 0);
  near(row.estimated_cost_usd, .001);
});
