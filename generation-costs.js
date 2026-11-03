// Aggregate-only diagnostics: never return usage rows, user IDs, emails or request IDs.
const fields='service,category,time_slot,language,content_type,created_at,token_cost_usd,search_cost_usd,estimated_cost_usd,metadata_day:usage_metadata->>day,provider_usage:usage_metadata->usage';
const n=v=>Number.isFinite(Number(v))?Math.max(0,Number(v)):0;
const round=v=>Math.round(v*1e8)/1e8;
export function summarizeGenerationCosts(rows,{day,start,end}){
 const totals={news:{anthropic:0,search:0,narration:0},illustrations:{openai:0,legacyAnimation:0}},categories={};let counted=0;
 const cutoff=Date.parse(end||new Date().toISOString())+15*60e3;
 for(const r of rows){
  const time=Date.parse(r.created_at);if(time<Date.parse(start)||time>cutoff)continue;
  const metadataDay=r.metadata_day??r.usage_metadata?.day;
  if(r.service==='openai'&&metadataDay&&metadataDay!==day)continue;
  const token=n(r.token_cost_usd??r.estimated_cost_usd),search=n(r.search_cost_usd),tools=n((r.provider_usage??r.usage_metadata?.usage)?.server_tool_use?.web_search_requests)*.01;
  const art=/^(world_illustration_|daily_motion_)/.test(r.content_type||'');
  let cost=0;if(art){cost=token+search;if(r.service==='openai')totals.illustrations.openai+=cost;else totals.illustrations.legacyAnimation+=cost;}
  else if(r.service==='anthropic'){totals.news.anthropic+=token+tools;totals.news.search+=Math.max(0,search-tools);cost=token+search;}
  else if(r.service==='serper'){cost=search||token;totals.news.search+=cost;}
  else if(r.service==='unrealspeech'){cost=token;totals.news.narration+=cost;}
  else continue;
  counted++;if(r.category){const item=categories[r.category]||={news:0,illustrations:0};item[art?'illustrations':'news']+=cost;}
 }
 for(const bucket of Object.values(totals))for(const k of Object.keys(bucket))bucket[k]=round(bucket[k]);
 return{currency:'USD',basis:'recorded provider usage, not invoices',day,startedAt:start,completedAt:end,includesNarrationTailMinutes:15,recordedCalls:counted,...totals,newsTotal:round(Object.values(totals.news).reduce((a,b)=>a+b,0)),illustrationTotal:round(Object.values(totals.illustrations).reduce((a,b)=>a+b,0)),categories:Object.fromEntries(Object.entries(categories).map(([k,v])=>[k,{news:round(v.news),illustrations:round(v.illustrations)}]))};
}
export async function generationCosts(db,{day,slot,language}){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day||'')||!['Morning','Evening'].includes(slot)||!['en','ar'].includes(language))throw Error('Invalid generation scope');
 const {data:run,error}=await db.from('generation_logs').select('started_at,completed_at').eq('day',day).eq('time_slot',slot).eq('language',language).order('started_at',{ascending:false}).limit(1).maybeSingle();if(error)throw Error('Generation accounting unavailable');if(!run)return{day,slot,language,status:'not_started'};
 const rows=[];for(let offset=0;;offset+=1000){const {data,error:err}=await db.from('api_usage').select(fields).eq('time_slot',slot).eq('language',language).gte('created_at',run.started_at).lte('created_at',new Date(Date.parse(run.completed_at||new Date().toISOString())+15*60e3).toISOString()).order('created_at',{ascending:true}).range(offset,offset+999);if(err)throw Error('Generation accounting unavailable');rows.push(...data);if(data.length<1000)break;}
 return{slot,language,...summarizeGenerationCosts(rows,{day,start:run.started_at,end:run.completed_at})};
}
