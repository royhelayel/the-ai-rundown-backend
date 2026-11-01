import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {hash,normalize,prepareJobs,spendDay,verified} from '../daily-motion/source.js';
import {validatePlan} from '../illustration-pilot/pilot.js';
const VERSION='world-illustration-low-v1',BUCKET='daily-news-illustrations';
const regeneration=JSON.parse(fs.readFileSync(new URL('./regeneration-2026-11-02.json',import.meta.url),'utf8'));
const columns='category,day,time_slot,language,content,stories_content,briefing,briefing_sources,audit_result,user_id,shared_key';
export const artworkKey=text=>hash(JSON.stringify([VERSION,'gpt-image-2','low','896x736',normalize(text)]));
const aliasPath=(meta,text)=>'aliases/'+hash(JSON.stringify([meta.category,meta.day,meta.language||'en',normalize(text)]))+'.json';
export const tokenCost=(stage,u={})=>stage==='image'?((u.input_tokens||0)*5+(u.output_tokens||0)*30)/1e6:((u.input_tokens||0)+(u.output_tokens||0)*5)/1e6;
export function imagePrompt(summary){return `Create a refined flat editorial infographic explaining ONLY this news summary: ${JSON.stringify(summary)}. Warm ivory #fbf8eb background, charcoal silhouettes, one muted ochre accent. Canvas 896x736 for a 350x295 phone display. Large recognizable forms, generous space. Use 2–3 separated visual groups with horizontal empty gutters for sequential reveals. Maximum four labels of 1–3 words, no paragraphs or full summary. Explain this specific event using clear objects and relationships, not decorative keyword icons. Show only relationships explicitly stated by the source. Never draw data charts, clock hands, geographic routes, transport, skylines or completed agreements unless explicitly established. Represent investigations with a neutral document and magnifier, not invented proceedings. For plans and future announcements, include Planned or Announced in the short label; never CLOSED or completed handshake. Preserve attribution in labels (e.g. Iran says or Court says); an allegation is not a confirmed outcome. Funding arrows go from funder to recipient. Do not invent facts, quantities or dates. Illustrations are symbolic, not documentary photographs. No photorealism, gradients, 3D, overlapping labels, small print or UI chrome.`;}
export function illustrationStore(supabase){let prepared;const bucket=supabase.storage.from(BUCKET);return{
 prepare(){return prepared||=(async()=>{const {error}=await supabase.storage.createBucket(BUCKET,{public:false,allowedMimeTypes:['application/json','image/png'],fileSizeLimit:20000000});if(error&&!/already exists|duplicate/i.test(error.message))throw Error('Artwork storage unavailable');})();},
 async get(path){const {data,error}=await bucket.download(path,{cacheNonce:randomUUID()},{cache:'no-store'});if(!data){if(error&&!/not found|does not exist|404/i.test(error.message||''))throw Error('Artwork storage read failed');return null;}return JSON.parse(await data.text());},
 async put(path,value,{exclusive=false}={}){const {error}=await bucket.upload(path,Buffer.from(JSON.stringify(value)),{contentType:'application/json',upsert:!exclusive,cacheControl:'0'});if(!error)return true;if(exclusive&&/already exists|duplicate|resource.*exists/i.test(error.message||''))return false;throw Error('Artwork storage write failed');},
 async image(key,bytes){const {error}=await bucket.upload(`images/${key}.png`,bytes,{contentType:'image/png',upsert:false,cacheControl:'31536000'});if(error&&!/already exists|duplicate/i.test(error.message))throw Error('Artwork image write failed');},
 async bytes(key){const {data}=await bucket.download(`images/${key}.png`);return data?Buffer.from(await data.arrayBuffer()):null;},
 async list(prefix){const result=[];for(let offset=0;offset<2000;offset+=100){const {data,error}=await bucket.list(prefix,{limit:100,offset,sortBy:{column:'name',order:'asc'}});if(error)throw Error('Artwork queue read failed');result.push(...(data||[]).filter(x=>x.name.endsWith('.json')).map(x=>prefix+'/'+x.name));if(!data||data.length<100)break;}return result;}
};}
export function createDailyIllustrations({supabase,parseStories,store=illustrationStore(supabase),fetchImpl=fetch,trackUsage=async()=>{},now=Date.now,enabled=process.env.LOCAL_PREVIEW!=='1'&&process.env.WORLD_ILLUSTRATIONS_ENABLED!=='false',hasKey=()=>!!process.env.OPENAI_API_KEY,maxJobs=24,logger=console}){
 let draining,blocked=false,timer;const cache=new Map();
 const remember=(key,value)=>{if(cache.size>100)cache.delete(cache.keys().next().value);cache.set(key,value);return value;};
 const asset=async key=>cache.get(key)||await store.get(`assets/${key}.json`).then(a=>a?.version===VERSION?remember(key,a):null);
 async function paid(stage,body,record,job){const at=now();const response=await fetchImpl('https://api.openai.com/v1/'+(stage==='image'?'images/generations':'responses'),{method:'POST',headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(300000)});const data=await response.json();
  if(data.usage){const cost=tokenCost(stage,data.usage);const call={stage,usage:data.usage,costUSD:cost,elapsedMs:now()-at,requestId:response.headers.get('x-request-id')||data.id};record.calls.push(call);record.costUSD+=cost;await store.put(`claims/${job.key}.json`,record);await trackUsage({service:'openai',model:body.model,category:'World News',time_slot:job.meta.timeSlot,language:'en',content_type:'world_illustration_'+stage,input_tokens:data.usage.input_tokens||0,output_tokens:data.usage.output_tokens||0,token_cost_usd:cost,search_cost_usd:0,estimated_cost_usd:cost,web_searches:0,provider_request_id:call.requestId,usage_metadata:{usage:data.usage,day:job.meta.day,artworkKey:job.key,quality:'low',size:'896x736'},created_at:new Date(now()).toISOString()});}
  if(!response.ok)throw Error('provider_'+response.status);return data;
 }
 async function reserve(day,key){for(let i=0;i<maxJobs;i++)if(await store.put(`budget/${day}/${String(i).padStart(3,'0')}.json`,{key,reservedUSD:.03,at:now()},{exclusive:true}))return true;return false;}
 async function generate(job){if(await asset(job.key))return;const record={key:job.key,meta:job.meta,status:'running',startedAt:now(),calls:[],costUSD:0};
  // Claims are global to the content hash, not a day. Uncertain/failed calls never auto-retry.
  if(!await store.put(`claims/${job.key}.json`,record,{exclusive:true}))return;
  try{
   if(!await reserve(spendDay(now()),job.key)){record.status='budget';return;}
   const image=await paid('image',{model:'gpt-image-2',prompt:imagePrompt(job.shortText)+(job.reviewCorrections?.length?' Previous rejected illustration issues to avoid: '+job.reviewCorrections.join(' '):''),n:1,size:'896x736',quality:'low',output_format:'png'},record,job);
   const encoded=image.data?.[0]?.b64_json;if(!encoded)throw Error('image_missing');
   await store.image(job.key,Buffer.from(encoded,'base64'));
   const result=await paid('vision',{model:'gpt-6.1-terra',store:false,max_output_tokens:1800,input:[{role:'user',content:[{type:'input_text',text:`Inspect the actual illustration against this sole factual source: ${JSON.stringify(job.shortText)}. Return JSON only: {"regions":[{"top":0,"bottom":0.5,"trigger":"exact phrase from summary","label":"short description"}],"visualConcerns":[]}. Choose 2–4 full-width horizontal bands, partitioning the entire image 0..1 without gaps or overlaps. Put boundaries in empty gutters; do not cut labels or objects. Order the bands by narrative reveal order. Every trigger is a verbatim phrase from the summary. Flag materially unsupported facts (including invented transport/geography/numbers or treating future events as completed), misleading visual claims, unreadable text, overlaps, or unavoidable cuts in visualConcerns. Conventional symbolic props are not themselves factual claims. Do not approve just because the image is attractive.`},{type:'input_image',image_url:'data:image/png;base64,'+encoded}]}]},record,job);
   if(result.status!=='completed')throw Error('vision_incomplete');const text=(result.output||[]).filter(x=>x.type==='message').flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('');
   const plan=validatePlan(JSON.parse(text.replace(/^```json\s*|\s*```$/g,'')),job.shortText);record.plan=plan;
   if(!Array.isArray(plan.visualConcerns)||plan.visualConcerns.length){record.status='withheld';return;}
   const regions=plan.regions.map(r=>({...r,at:Math.max(0,Math.min(.9,job.shortText.indexOf(r.trigger)/job.shortText.length))}));
   // First group is always visible. Subsequent reveals follow source phrase position.
   regions[0].at=0;
   const value={version:VERSION,key:job.key,summary:job.shortText,regions,createdAt:now(),costUSD:record.costUSD};await store.put(`assets/${job.key}.json`,value,{exclusive:true});remember(job.key,value);record.status='ready';
  }catch(e){record.status='failed';record.error=/^provider_\d+$/.test(e.message)?e.message:'generation_failed';if(/provider_(401|402|403|429)/.test(record.error))blocked=true;logger.warn('World illustration: '+record.error);}
  finally{record.elapsedMs=now()-record.startedAt;await store.put(`claims/${job.key}.json`,record);}
 }
 async function drain(){if(!enabled||!hasKey()||blocked)return;if(draining)return draining;draining=(async()=>{await store.prepare();const paths=await store.list('queue/'+spendDay(now()));let index=0;const worker=async()=>{while(index<paths.length&&!blocked){const job=await store.get(paths[index++]);if(job)await generate(job);}};await Promise.all([worker(),worker()]);})().catch(()=>logger.warn('World illustration worker paused')).finally(()=>{draining=null;});return draining;}
 async function queueRows(rows){if(!enabled||!hasKey())return;await store.prepare();for(const row of rows){if(row.language!=='en')continue;for(const source of prepareJobs(row,parseStories,{allowed:['World News']})){
   const baseKey=artworkKey(source.shortText),recovery=await store.get(`recoveries/${baseKey}.json`);
   const job={...source,key:recovery?.key||baseKey,...(recovery?{parentKey:baseKey,reviewCorrections:recovery.concerns}: {})};
   for(const a of [...job.aliases,{text:job.shortText}])await store.put(aliasPath(job.meta,a.text),{key:job.key,text:normalize(a.text)});
   if(!await asset(job.key))await store.put(`queue/${spendDay(now())}/${job.key}.json`,job,{exclusive:true});
  }}void drain();}
 async function queueEdition(category,day,timeSlot,language){if(!enabled||!hasKey()||category!=='World News'||language!=='en')return;const {data,error}=await supabase.from('news_summaries').select(columns).eq('category',category).eq('day',day).eq('time_slot',timeSlot).eq('language',language).is('user_id',null).is('shared_key',null);if(error)throw Error('Artwork edition unavailable');await queueRows(data||[]);}
 async function reconcileLatest(){if(!enabled||!hasKey())return;const {data,error}=await supabase.from('news_summaries').select(columns).eq('category','World News').eq('language','en').in('time_slot',['Morning','Evening','Daily']).gte('day',new Date(now()-7*864e5).toISOString().slice(0,10)).lte('day',spendDay(now())).is('user_id',null).is('shared_key',null).order('day',{ascending:false}).limit(48);if(error)throw Error('Artwork catch-up unavailable');const rows=(data||[]).filter(verified);const day=rows[0]?.day;await queueRows(rows.filter(r=>r.day===day));}
 async function lookup(meta,text){if(!enabled||meta.category!=='World News'||meta.language!=='en')return null;const row=await store.get(aliasPath(meta,text));if(!row||row.text!==normalize(text))return null;const recovery=await store.get(`recoveries/${row.key}.json`);const value=await asset(recovery?.key||row.key);return value?{text:normalize(text),status:'ready',artifact:{type:'illustration',id:value.key,from:0,to:1,regions:value.regions,script:value.summary}}:null;}
 async function regenerateWithheld(keys=regeneration.keys){
  if(!enabled||!hasKey())return {queued:0};
  await store.prepare();let queued=0;
  const paths=await store.list('queue/'+spendDay(now()));
  for(const path of paths){const source=await store.get(path);if(!source||!keys.includes(source.key)||source.meta?.day!==regeneration.day)continue;
   const prior=await store.get(`claims/${source.key}.json`);
   if(prior?.status!=='withheld'||await asset(source.key))continue;
   const key=hash(source.key+'owner-approved-regeneration-2026-11-02');
   const mapping={key,parentKey:source.key,concerns:prior.plan?.visualConcerns||[],at:now()};
   await store.put(`recoveries/${source.key}.json`,mapping,{exclusive:true});
   const job={...source,key,parentKey:source.key,reviewCorrections:mapping.concerns};
   for(const alias of [...job.aliases,{text:job.shortText}])await store.put(aliasPath(job.meta,alias.text),{key,text:normalize(alias.text)});
   if(await store.put(`queue/${spendDay(now())}/${key}.json`,job,{exclusive:true}))queued++;
  }
  await drain();await drain();return {queued};
 }
 async function status(){await store.prepare();const slots=await store.list('budget/'+spendDay(now()));const entries=await Promise.all(slots.map(async path=>{const slot=await store.get(path);return slot?store.get(`claims/${slot.key}.json`):null;}));return{enabled:enabled&&hasKey(),category:'World News',quality:'low',size:'896x736',maxDailyJobs:maxJobs,reviewFindings:entries.filter(r=>r?.status==='withheld').map(r=>({id:r.key,day:r.meta.day,concerns:(r.plan?.visualConcerns||[]).map(x=>String(x).slice(0,400))})),reservedUSD:slots.length*.03,estimatedActualUSD:entries.reduce((n,r)=>n+(r?.costUSD||0),0),counts:entries.filter(Boolean).reduce((out,r)=>({...out,[r.status]:(out[r.status]||0)+1}),{}),blocked};}
 return{queueRows,queueEdition,reconcileLatest,regenerateWithheld,drain,lookup,status,start(){if(!enabled)return;void drain();timer=setInterval(()=>void drain(),60000);timer.unref?.();return()=>clearInterval(timer);},register(app){
  app.get('/api/world-illustrations/status',async(_req,res)=>{try{res.set('Cache-Control','no-store').json(await status());}catch{res.status(503).json({error:'Artwork status unavailable'});}});
  app.get('/api/world-illustrations/image/:id',async(req,res)=>{if(!/^[a-f0-9]{64}$/.test(req.params.id))return res.sendStatus(400);try{if(!await asset(req.params.id))return res.sendStatus(404);const bytes=await store.bytes(req.params.id);if(!bytes)return res.sendStatus(404);res.type('png').set({'Cache-Control':'public,max-age=31536000,immutable','X-Content-Type-Options':'nosniff'}).send(bytes);}catch{res.sendStatus(503);}});
 }};
}
