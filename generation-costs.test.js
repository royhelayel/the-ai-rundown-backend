import test from'node:test';import assert from'node:assert/strict';import{summarizeGenerationCosts}from'./generation-costs.js';
test('generation report separates current images, old backfills, news and narration without private records',()=>{
 const base={created_at:'2026-11-03T06:00:00Z',category:'World News',user_id:'PRIVATE-ID',email:'PRIVATE-EMAIL'};
 const out=summarizeGenerationCosts([{...base,service:'anthropic',token_cost_usd:.12,search_cost_usd:.01,usage_metadata:{usage:{server_tool_use:{web_search_requests:1}}}},{...base,service:'serper',search_cost_usd:.03},{...base,service:'unrealspeech',token_cost_usd:.02},{...base,service:'openai',content_type:'world_illustration_image',token_cost_usd:.015,usage_metadata:{day:'2026-11-03'}},{...base,service:'openai',content_type:'world_illustration_image',token_cost_usd:99,usage_metadata:{day:'2026-10-31'}}],{day:'2026-11-03',start:'2026-11-03T05:48:00Z',end:'2026-11-03T06:32:00Z'});
 assert.equal(out.newsTotal,.18);assert.equal(out.illustrationTotal,.015);assert.ok(!JSON.stringify(out).includes('PRIVATE'));assert.ok(!('recent_runs'in out));
});
