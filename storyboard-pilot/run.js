import {anthropicCost} from '../usage-accounting.js';
import {boardPrompt,drawingPrompt,auditPrompt,validateBoard,validateDrawing} from './schema.js';
export const PILOT_ID='world-2026-10-30-v1';
export const PILOT_DAY='2026-10-30';
const bucketName='storyboard-pilots';
const parse=response=>JSON.parse((response.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('').replace(/^```(?:json)?\s*|\s*```$/g,''));
export async function runPilot({stories,callModel,save,now=()=>Date.now(),budget=1}){
 const start=now();let reserved=0;
 const report={id:PILOT_ID,day:PILOT_DAY,category:'World News',model:'claude-haiku-4-5-20251001',status:'running',startedAt:new Date(start).toISOString(),budgetUSD:budget,costUSD:0,concurrency:2,records:stories.slice(0,12).map((s,i)=>({index:i,headline:s.headline,text:s.text,status:'queued',calls:[]}))};
 const persist=async()=>{report.elapsedMs=now()-start;await save(structuredClone(report));};
 async function model(prompt,maxTokens,stage,record){
  // Reserve an upper bound BEFORE dispatch. Bytes conservatively exceed normal
  // English input token counts. Keep headroom for provider message framing.
  const worst=(Buffer.byteLength(prompt)+256)*.000001+maxTokens*.000005;
  if(report.costUSD+reserved+worst>budget)throw new Error('Pilot budget cap reached');
  reserved+=worst;const at=now();
  try{
   const r=await callModel(prompt,maxTokens,0,{category:'World News',day:PILOT_DAY,language:'en',contentType:'storyboard_pilot_'+stage});
   const cost=anthropicCost(r.usage||{}).total;
   report.costUSD+=cost;
   record.calls.push({stage,elapsedMs:now()-at,usage:r.usage,costUSD:cost,requestId:r.id});
   if(r.stop_reason==='max_tokens')throw new Error(stage+' output truncated');
   return parse(r);
  }finally{reserved-=worst;}
 }
 await persist();let cursor=0;
 const worker=async()=>{while(cursor<report.records.length){
  const record=report.records[cursor++],at=now();record.status='running';await persist();
  try{
   const board=validateBoard(await model(boardPrompt(record.text),1500,'storyboard',record),record.text);record.storyboard=board;
   let repair='';
   for(let attempt=0;attempt<2;attempt++){
    record.attempts=attempt+1;
    try{
     const drawing=validateDrawing(await model(drawingPrompt(record.text,board,repair),4500,attempt?'repair':'drawing',record),record.text);
     const review=await model(auditPrompt(record.text,board,drawing),700,'audit',record);
     if(review.pass!==true||!Array.isArray(review.issues)||review.issues.length)throw new Error((review.issues||['Model review did not pass']).join('; '));
     record.drawing=drawing;record.review=review;record.status='generated';break;
    }catch(e){repair=e.message;if(attempt===1||/budget cap|credit balance|401|403|429/i.test(repair))throw e;}
   }
  }catch(e){record.status='failed';record.error=String(e.message).replace(/api[_ -]?key[^\s]*/gi,'[redacted]').slice(0,500);}
  record.elapsedMs=now()-at;await persist();
 }};
 await Promise.all([worker(),worker()]);
 report.status='complete';report.finishedAt=new Date(now()).toISOString();report.generated=report.records.filter(r=>r.status==='generated').length;report.failed=report.records.filter(r=>r.status==='failed').length;
 await persist();return report;
}
export function createWorldPilot({supabase,callModel,parseStories,logger=console}){
 const bucket=supabase.storage.from(bucketName);let current=null;
 async function load(){if(current)return current;const {data}=await bucket.download(PILOT_ID+'/report.json');if(!data)return {id:PILOT_ID,status:'not_started'};return JSON.parse(await data.text());}
 async function start(){
  const {data,error}=await supabase.from('news_summaries').select('content,stories_content,time_slot,generated_at').eq('category','World News').eq('day',PILOT_DAY).eq('language','en').is('user_id',null).is('shared_key',null).in('time_slot',['Morning','Evening','Daily']);
  if(error)throw new Error('Pilot source lookup failed');
  const row=(data||[]).sort((a,b)=>String(b.generated_at||'').localeCompare(String(a.generated_at||'')))[0];
  const stories=parseStories(row?.stories_content||row?.content||'').map(s=>({headline:s.headline,text:s.summary||s.bullets?.join('. ')})).filter(s=>s.headline&&s.text).slice(0,12);
  if(!stories.length){logger.warn('World pilot: no published source stories; no model calls.');return;}
  const created=await supabase.storage.createBucket(bucketName,{public:false,allowedMimeTypes:['application/json'],fileSizeLimit:2000000});
  if(created.error&&!/already exists|duplicate/i.test(created.error.message||''))throw new Error('Pilot storage unavailable');
  // Atomic persistent claim: deployments/restarts cannot repeat this paid pilot.
  // Do not delete the claim or silently resume a partial run.
  const claim=await bucket.upload(PILOT_ID+'/claim.json',Buffer.from(JSON.stringify({at:new Date().toISOString(),stories:stories.length,budgetUSD:1})),{contentType:'application/json',upsert:false});
  if(claim.error){logger.log('World pilot already claimed or claim unavailable; no model calls.');return;}
  await runPilot({stories,callModel,save:async report=>{current=report;const saved=await bucket.upload(PILOT_ID+'/report.json',Buffer.from(JSON.stringify(report)),{contentType:'application/json',upsert:true});if(saved.error)throw new Error('Pilot report could not be saved');}});
  logger.log('World storyboard pilot completed.');
 }
 return {start,register(app){app.get('/api/storyboard-pilot/world-2026-10-30-v1',async(req,res)=>{try{res.set('Cache-Control','no-store');res.json(await load());}catch{res.status(503).json({error:'Pilot report unavailable'});}});}};
}
