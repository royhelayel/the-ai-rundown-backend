import{anthropicCost,pricesForModel}from'../usage-accounting.js';
import{BOARD_SCHEMA,DRAW_SCHEMA,AUDIT_SCHEMA,boardV3,drawingV3,boardV3Prompt,drawV3Prompt,auditV3Prompt}from'./contract-v3.js';
export const WAVE='sample'; // rest is a separate reviewed wave, never an open-ended queue.
export const REPAIR_ID='world-2026-10-30-v3-'+WAVE;
const HAIKU='claude-haiku-4-5-20251001',DRAW_MODEL='claude-sonnet-4-6';
const decode=r=>JSON.parse(r.content.filter(c=>c.type==='text').map(c=>c.text).join(''));
export async function runRepair({stories,callStructured,save,budget=2,now=()=>Date.now(),id=REPAIR_ID,previousRepairCost=0}){
 const start=now();let reserved=0,cursor=0,blocked=false;
 const report={id,day:'2026-10-30',category:'World News',contract:3,status:'running',concurrency:2,budgetUSD:budget,costUSD:0,previousRepairCost,models:{storyboard:HAIKU,drawing:DRAW_MODEL,audit:HAIKU},startedAt:new Date(start).toISOString(),records:stories.slice(0,12).map((s,i)=>({index:s.index??i,headline:s.headline,text:s.text,status:'queued',calls:[]}))};
 const persist=async()=>{report.elapsedMs=now()-start;report.repairTotalCostUSD=report.costUSD+previousRepairCost;await save(structuredClone(report));};
 async function call(prompt,schema,maxTokens,stage,model,row){
  if(blocked)throw Error('Provider unavailable; no further calls');const prices=pricesForModel(model);
  const worst=(Buffer.byteLength(prompt)+Buffer.byteLength(JSON.stringify(schema))+1024)*prices.input+maxTokens*prices.output;
  if(report.costUSD+reserved+worst>budget)throw Error('Repair budget cap reached');reserved+=worst;const at=now();
  try{
   const response=await callStructured({prompt,schema,maxTokens,model,details:{category:'World News',day:'2026-10-30',language:'en',contentType:'storyboard_repair_v3_'+stage}});
   const cost=anthropicCost(response.usage||{},response.model||model).total;report.costUSD+=cost;
   row.calls.push({stage,model:response.model||model,elapsedMs:now()-at,usage:response.usage,costUSD:cost,requestId:response.id});await persist();
   if(response.stop_reason!=='end_turn')throw Error(stage+' response stopped: '+response.stop_reason);
   return decode(response);
  }catch(e){if(/401|403|429|credit balance|not_found|invalid_request/i.test(e.message))blocked=true;throw e;}finally{reserved-=worst;}
 }
 await persist();
 const worker=async()=>{while(cursor<report.records.length){const row=report.records[cursor++],at=now();row.status='running';await persist();try{
  row.storyboard=boardV3(await call(boardV3Prompt(row.text),BOARD_SCHEMA,1600,'storyboard',HAIKU,row),row.text);
  let correction='';
  for(let attempt=0;attempt<2;attempt++){
   row.attempts=attempt+1;
   try{
    const candidate=await call(drawV3Prompt(row.text,row.storyboard,correction),DRAW_SCHEMA,9000,attempt?'repair':'drawing',DRAW_MODEL,row);row.lastCandidate=candidate;
    const drawing=drawingV3(candidate,row.text);row.validatedDrawing=drawing;
    const review=await call(auditV3Prompt(row.text,row.storyboard,drawing),AUDIT_SCHEMA,1400,'audit',HAIKU,row);row.review=review;
    if(review.pass!==true||!Array.isArray(review.issues)||review.issues.length)throw Error((review.issues||['Audit did not pass']).join('; '));
    row.drawing=drawing;row.status='generated';delete row.lastCandidate;delete row.validatedDrawing;break;
   }catch(e){correction=e.message;row.previousIssues=[...(row.previousIssues||[]),correction];if(attempt===1||blocked||/budget/.test(correction))throw e;}
  }
 }catch(e){row.status='failed';row.error=String(e.message).slice(0,700);}row.elapsedMs=now()-at;await persist();}};
 await Promise.all([worker(),worker()]);report.status='complete';report.generated=report.records.filter(r=>r.status==='generated').length;report.failed=report.records.length-report.generated;report.finishedAt=new Date(now()).toISOString();await persist();return report;
}
export function createRepairV3({supabase,callStructured,logger=console}){
 const bucket=supabase.storage.from('storyboard-pilots');let current;
 const load=async key=>{const{data}=await bucket.download(key+'/report.json');return data?JSON.parse(await data.text()):null;};
 async function start(){
  const source=await load('world-2026-10-30-v2');if(source?.status!=='complete')return;
  let previousRepairCost=0;
  if(WAVE==='rest'){const sample=await load('world-2026-10-30-v3-sample');if(sample?.status!=='complete'||sample.generated!==3)throw Error('Sample must pass before remaining wave');previousRepairCost=sample.costUSD;}
  const stories=source.records.filter(r=>WAVE==='sample'?[0,1,2].includes(r.index):![0,1,2].includes(r.index));
  const claim=await bucket.upload(REPAIR_ID+'/claim.json',Buffer.from(JSON.stringify({at:new Date().toISOString(),budgetUSD:2-previousRepairCost,stories:stories.length})),{upsert:false,contentType:'application/json'});
  if(claim.error){logger.log('Repair wave already claimed or storage unavailable; no calls.');return;}
  await runRepair({stories,callStructured,budget:2-previousRepairCost,previousRepairCost,save:async report=>{current=report;const{error}=await bucket.upload(REPAIR_ID+'/report.json',Buffer.from(JSON.stringify(report)),{upsert:true,contentType:'application/json'});if(error)throw Error('Cannot save repair report');}});
 }
 return{start,register(app){app.get('/api/storyboard-pilot/world-2026-10-30-v3',async(req,res)=>{try{const result=current||await load(REPAIR_ID);res.set('Cache-Control','no-store');res.json(result||{id:REPAIR_ID,status:'not_started'});}catch{res.status(503).json({error:'Report unavailable'});}});}};
}
