import fs from 'node:fs';
import {createPaperCache} from './paper.js';
import {randomUUID} from 'node:crypto';
import {hash,normalize,prepareJobs,spendDay,verified} from '../daily-motion/source.js';
import {POLICY,FAMILIES,styleKey,referenceFor,referenceHash,directionPrompt,validateDirection,familyPrompt,reviewPrompt,validateReview} from './art-direction.js';
const VERSION=POLICY,BUCKET='daily-news-illustrations';
const regeneration=JSON.parse(fs.readFileSync(new URL('./regeneration-2026-11-02.json',import.meta.url),'utf8'));
const columns='category,day,time_slot,language,content,stories_content,briefing,briefing_sources,audit_result,user_id,shared_key';
export const artworkKey=styleKey;
const aliasPath=(meta,text)=>'aliases/'+hash(JSON.stringify([meta.category,meta.day,meta.language||'en',normalize(text)]))+'.json';
export const tokenCost=(stage,u={})=>stage==='image'?(((u.input_tokens_details?.text_tokens??u.input_tokens??0)*5)+(u.input_tokens_details?.image_tokens||0)*8+(u.output_tokens||0)*30)/1e6:((u.input_tokens||0)+(u.output_tokens||0)*5)/1e6;
export const imagePrompt=familyPrompt;
const responseJSON=data=>{if(data.status!=='completed')throw Error('incomplete_response');const text=(data.output||[]).filter(x=>x.type==='message').flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('');return JSON.parse(text.replace(/^```json\s*|\s*```$/g,''));};
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
 const paperImage=createPaperCache(id=>store.bytes(id));
 const remember=(key,value)=>{if(cache.size>100)cache.delete(cache.keys().next().value);cache.set(key,value);return value;};
 const asset=async key=>cache.get(key)||await store.get(`assets/${key}.json`).then(a=>[VERSION,'world-illustration-low-v1'].includes(a?.version)?remember(key,a):null);
 async function paid(stage,body,record,job){const at=now();const response=await fetchImpl('https://api.openai.com/v1/'+(stage==='image'?'images/edits':'responses'),{method:'POST',headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(300000)});const data=await response.json();
  if(data.usage){const cost=tokenCost(stage,data.usage);const call={stage,usage:data.usage,costUSD:cost,elapsedMs:now()-at,requestId:response.headers.get('x-request-id')||data.id};record.calls.push(call);record.costUSD+=cost;await store.put(`claims/${job.key}.json`,record);await trackUsage({service:'openai',model:body.model,category:'World News',time_slot:job.meta.timeSlot,language:'en',content_type:'world_illustration_'+stage,input_tokens:data.usage.input_tokens||0,output_tokens:data.usage.output_tokens||0,token_cost_usd:cost,search_cost_usd:0,estimated_cost_usd:cost,web_searches:0,provider_request_id:call.requestId,usage_metadata:{usage:data.usage,day:job.meta.day,artworkKey:job.key,quality:'low',size:'896x736',policy:VERSION,family:record.direction?.family},created_at:new Date(now()).toISOString()});}
  if(!response.ok)throw Error('provider_'+response.status);return data;
 }
 async function reserve(day,key){for(let i=0;i<maxJobs;i++)if(await store.put(`budget/${day}/${String(i).padStart(3,'0')}.json`,{key,reservedUSD:.03,at:now()},{exclusive:true}))return true;return false;}
 async function generate(job){if(await asset(job.key))return;const record={key:job.key,meta:job.meta,policy:VERSION,status:'running',startedAt:now(),calls:[],costUSD:0};
  // Claims are global to the content hash, not a day. Uncertain/failed calls never auto-retry.
  if(!await store.put(`claims/${job.key}.json`,record,{exclusive:true})){const prior=await store.get(`claims/${job.key}.json`);if(prior?.status!=='budget'||prior.calls?.length||spendDay(prior.startedAt)===spendDay(now())||!await store.put(`budget-retries/${job.key}-${spendDay(now())}.json`,{at:now()},{exclusive:true}))return;await store.put(`claims/${job.key}.json`,record);}
  try{
   if(!await reserve(spendDay(now()),job.key)){record.status='budget';return;}
   const directed=await paid('direction',{model:'gpt-6.1-terra',store:false,max_output_tokens:900,input:directionPrompt(job.shortText)},record,job);
   const direction=validateDirection(responseJSON(directed),job.shortText);record.direction=direction;record.policy=VERSION;await store.put(`claims/${job.key}.json`,record);
   const reference='data:image/png;base64,'+referenceFor(direction.family).toString('base64');
   const image=await paid('image',{model:'gpt-image-2',images:[{image_url:reference}],prompt:imagePrompt(job.shortText,direction),n:1,size:'896x736',quality:'low',output_format:'png'},record,job);
   const encoded=image.data?.[0]?.b64_json;if(!encoded)throw Error('image_missing');
   await store.image(job.key,Buffer.from(encoded,'base64'));
   const result=await paid('vision',{model:'gpt-6.1-terra',store:false,max_output_tokens:1800,input:[{role:'user',content:[{type:'input_text',text:reviewPrompt(job.shortText,direction)},{type:'input_image',image_url:'data:image/png;base64,'+encoded},{type:'input_image',image_url:reference}]}]},record,job);
   const plan=validateReview(responseJSON(result),job.shortText);record.plan=plan;
   if(plan.visualConcerns.length||plan.qualityConcerns.length){record.status='withheld';return;}
   const regions=plan.regions.map(r=>({...r,at:Math.max(0,Math.min(.9,job.shortText.indexOf(r.trigger)/job.shortText.length))}));
   // First group is always visible. Subsequent reveals follow source phrase position.
   regions[0].at=0;
   const value={version:VERSION,family:direction.family,referenceHash:referenceHash(direction.family),direction,key:job.key,summary:job.shortText,regions,createdAt:now(),costUSD:record.costUSD};await store.put(`assets/${job.key}.json`,value,{exclusive:true});remember(job.key,value);record.status='ready';
  }catch(e){record.status='failed';record.error=/^provider_\d+$/.test(e.message)?e.message:'generation_failed';if(/provider_(401|402|403|429)/.test(record.error))blocked=true;logger.warn('World illustration: '+record.error);}
  finally{record.elapsedMs=now()-record.startedAt;await store.put(`claims/${job.key}.json`,record);}
 }
 async function carryDeferred(){
  if(!enabled||!hasKey())return;
  await store.prepare();const day=spendDay(now()),yesterday=spendDay(now()-864e5),since=spendDay(now()-7*864e5);
  for(const path of await store.list('queue/'+yesterday)){const job=await store.get(path);if(!job||job.meta?.category!=='World News'||job.meta?.language!=='en'||job.meta.day<since||job.key!==artworkKey(job.shortText))continue;const prior=await store.get(`claims/${job.key}.json`);if(prior?.status==='budget'&&!prior.calls?.length)await store.put(`queue/${day}/${job.key}.json`,job,{exclusive:true});}
 }
 async function drain(){if(!enabled||!hasKey()||blocked)return;if(draining)return draining;draining=(async()=>{await store.prepare();const paths=await store.list('queue/'+spendDay(now()));let index=0;const worker=async()=>{while(index<paths.length&&!blocked){const job=await store.get(paths[index++]);if(job)await generate(job);}};await Promise.all([worker(),worker()]);})().catch(()=>logger.warn('World illustration worker paused')).finally(()=>{draining=null;});return draining;}
 async function queueRows(rows){if(!enabled||!hasKey())return;await store.prepare();for(const row of rows){if(row.language!=='en')continue;for(const source of prepareJobs(row,parseStories,{allowed:['World News']})){
   const baseKey=artworkKey(source.shortText),recovery=await store.get(`recoveries/${baseKey}.json`);
   const job={...source,key:recovery?.key||baseKey,...(recovery?{parentKey:baseKey,reviewCorrections:recovery.concerns}: {})};
   for(const a of [...job.aliases,{text:job.shortText}]){const path=aliasPath(job.meta,a.text),old=await store.get(path);const fallbackKey=old?.key!==job.key&&old?.key&&await asset(old.key)?old.key:old?.fallbackKey;await store.put(path,{key:job.key,text:normalize(a.text),...(fallbackKey?{fallbackKey}: {})});}
   if(!await asset(job.key))await store.put(`queue/${spendDay(now())}/${job.key}.json`,job,{exclusive:true});
  }}void drain();}
 async function queueEdition(category,day,timeSlot,language){if(!enabled||!hasKey()||category!=='World News'||language!=='en')return;const {data,error}=await supabase.from('news_summaries').select(columns).eq('category',category).eq('day',day).eq('time_slot',timeSlot).eq('language',language).is('user_id',null).is('shared_key',null);if(error)throw Error('Artwork edition unavailable');await queueRows(data||[]);}
 async function reconcileLatest(){if(!enabled||!hasKey())return;const {data,error}=await supabase.from('news_summaries').select(columns).eq('category','World News').eq('language','en').in('time_slot',['Morning','Evening','Daily']).gte('day',new Date(now()-7*864e5).toISOString().slice(0,10)).lte('day',spendDay(now())).is('user_id',null).is('shared_key',null).order('day',{ascending:false}).limit(48);if(error)throw Error('Artwork catch-up unavailable');const rows=(data||[]).filter(verified);const day=rows[0]?.day;await queueRows(rows.filter(r=>r.day===day));}
 async function lookup(meta,text){if(!enabled||meta.category!=='World News'||meta.language!=='en')return null;const row=await store.get(aliasPath(meta,text));if(!row||row.text!==normalize(text))return null;const recovery=await store.get(`recoveries/${row.key}.json`);const current=await asset(recovery?.key||row.key),value=current||(row.fallbackKey?await asset(row.fallbackKey):null);return value?{text:normalize(text),status:'ready',artifact:{type:'illustration',policy:value.version,family:value.family||null,id:value.key,from:0,to:1,regions:value.regions,script:value.summary}}:null;}
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
 async function status(){await store.prepare();const slots=await store.list('budget/'+spendDay(now()));const entries=await Promise.all(slots.map(async path=>{const slot=await store.get(path);return slot?store.get(`claims/${slot.key}.json`):null;}));return{enabled:enabled&&hasKey(),category:'World News',policy:VERSION,families:FAMILIES,quality:'low',size:'896x736',maxDailyJobs:maxJobs,reviewFindings:entries.filter(r=>r?.status==='withheld').map(r=>({id:r.key,day:r.meta.day,policy:r.policy||'world-illustration-low-v1',family:r.direction?.family,qualityConcerns:r.plan?.qualityConcerns||[],concerns:(r.plan?.visualConcerns||[]).map(x=>String(x).slice(0,400))})),reservedUSD:slots.length*.03,estimatedActualUSD:entries.reduce((n,r)=>n+(r?.costUSD||0),0),currentPolicyCounts:entries.filter(r=>r?.policy===VERSION).reduce((out,r)=>({...out,[r.status]:(out[r.status]||0)+1}),{}),counts:entries.filter(Boolean).reduce((out,r)=>({...out,[r.status]:(out[r.status]||0)+1}),{}),blocked};}
 return{queueRows,queueEdition,reconcileLatest,regenerateWithheld,carryDeferred,drain,lookup,status,start(){if(!enabled)return;let lastDay=spendDay(now());void carryDeferred().then(()=>drain()).catch(()=>logger.warn('World artwork carryover paused'));timer=setInterval(()=>{const day=spendDay(now());if(day!==lastDay){lastDay=day;void carryDeferred().then(()=>reconcileLatest()).catch(()=>logger.warn('World artwork catch-up paused'));}void drain();},60000);timer.unref?.();return()=>clearInterval(timer);},register(app){
  app.get('/api/world-illustrations/status',async(_req,res)=>{try{res.set('Cache-Control','no-store').json(await status());}catch{res.status(503).json({error:'Artwork status unavailable'});}});
  app.get('/api/world-illustrations/image/:id',async(req,res)=>{if(!/^[a-f0-9]{64}$/.test(req.params.id))return res.sendStatus(400);try{if(!await asset(req.params.id))return res.sendStatus(404);const paper=req.query?.paper==='transparent-v1';const image=paper?await paperImage(req.params.id):null;const bytes=paper?image?.bytes:await store.bytes(req.params.id);if(!bytes)return res.sendStatus(404);if(paper)res.set('X-Illustration-Paper',image.processed?'transparent-v1':'original');res.type('png').set({'Cache-Control':'public,max-age=31536000,immutable','X-Content-Type-Options':'nosniff'}).send(bytes);}catch{res.sendStatus(503);}});
 }};
}
