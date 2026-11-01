import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
export const PILOT_ID='illustrated-reveals-2026-11-02-v1';
const stories=JSON.parse(fs.readFileSync(new URL('./stories.json',import.meta.url),'utf8'));
export function validatePlan(plan,summary){
 if(!Array.isArray(plan.regions)||plan.regions.length<2||plan.regions.length>5)throw Error('Expected 2–5 regions');
 const sorted=[...plan.regions].sort((a,b)=>a.top-b.top);
 let edge=0;
 for(const r of sorted){
  if(!Number.isFinite(r.top)||!Number.isFinite(r.bottom)||r.top<0||r.bottom>1||r.bottom-r.top<.08||Math.abs(r.top-edge)>.002)throw Error('Regions must partition the whole image');
  if(typeof r.trigger!=='string'||!r.trigger||!summary.includes(r.trigger))throw Error('Trigger must be exact source text');
  edge=r.bottom;
 }
 if(Math.abs(edge-1)>.002)throw Error('Incomplete image coverage');
 return plan;
}
export function createIllustrationPilot({supabase,fetchImpl=fetch,profile='high'}){
 const low=profile==='low';
 const PILOT_ID=low?'illustrated-low-small-2026-11-02-v1':'illustrated-reveals-2026-11-02-v1';
 const route=low?'illustration-low':'illustration-pilot';
 const selected=low?stories.filter(s=>s.id==='newspaper'):stories;
 const bucket=supabase.storage.from('illustrated-reveal-pilots');
 const read=async()=>{const {data}=await bucket.download(PILOT_ID+'/report.json',{cacheNonce:randomUUID()},{cache:'no-store'});return data?JSON.parse(await data.text()):null;};
 const save=async value=>{const {error}=await bucket.upload(PILOT_ID+'/report.json',Buffer.from(JSON.stringify(value)),{contentType:'application/json',upsert:true});if(error)throw Error('Cannot save illustration pilot');};
 const api=async(endpoint,body)=>{
  const response=await fetchImpl('https://api.openai.com/v1/'+endpoint,{method:'POST',headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(300000)});
  const data=await response.json();
  if(!response.ok)throw Error(`OpenAI ${response.status}: ${data.error?.code||data.error?.type||'request_failed'}`);
  return {data,requestId:response.headers.get('x-request-id')};
 };
 return {
 async start(){
  if(!process.env.OPENAI_API_KEY)return;
  const prepared=await supabase.storage.createBucket('illustrated-reveal-pilots',{public:false,allowedMimeTypes:['application/json','image/png'],fileSizeLimit:20000000});
  if(prepared.error&&!/already exists|duplicate/i.test(prepared.error.message))throw Error('Cannot prepare pilot storage');
  const {error}=await bucket.upload(PILOT_ID+'/claim.json',Buffer.from(JSON.stringify({images:selected.length,visionCalls:low?0:3,retries:0})),{contentType:'application/json',upsert:false});
  if(error)return; // A durable claim prevents repeated spend on redeploy or uncertain failures.
  const report={id:PILOT_ID,status:'running',createdAt:new Date().toISOString(),imageModel:'gpt-image-2',quality:low?'low':'high',size:low?'896x736':'1024x1280',visionModel:'gpt-6.1-terra',stories:[],timing:'Silent approximate timing; no narration alignment yet',costUSD:null};
  await save(report);
  for(const story of selected){
   const item={...story,status:'generating',calls:[]};report.stories.push(item);await save(report);const begin=Date.now();
   try{
    let prompt=`Create a polished flat editorial infographic for a mobile news app. Sole factual source: ${JSON.stringify(story.summary)}. Explain the event using clear recognizable illustrative objects and purposeful visual relationships. Warm ivory #fbf8eb background, charcoal silhouettes and one muted ochre accent. Match a refined newspaper editorial illustration: flat vector-like forms, no photorealism, no gradients or 3D. Strong hierarchy, generous spacing, very short legible labels. Portrait 4:5. Arrange 2–4 story-specific visual groups with empty horizontal gutters separating groups, allowing sequential reveals without cutting objects or labels. No frames or UI chrome. No additional facts, dates, statistics, quotations, routes, flags or causal claims beyond the source. Do not merely draw keywords or generic icons: explain this specific event. Do not invent amounts or people. Keep all objects and text inside the canvas.`;
    if(low)prompt=prompt.replace('Portrait 4:5.','Near-landscape 896 by 736 pixels, intended for a 350 by 295 CSS pixel phone illustration area.').replace('Arrange 2–4 story-specific visual groups with empty horizontal gutters separating groups, allowing sequential reveals without cutting objects or labels.','Compose one clear explanatory illustration: newspaper at center, eviction and blocked donations as two pressures leading to announced future closure. ONLY these exact labels: Novaya Gazeta; Eviction; Donations blocked; Closure announced. Do NOT typeset the source summary or any other prose. No CLOSED sign, since closure is future. Large recognizable forms and generous breathing room.');
    const imageAt=Date.now();const image=await api('images/generations',{model:report.imageModel,prompt,n:1,size:report.size,quality:report.quality,output_format:'png'});
    item.calls.push({stage:'image',requestId:image.requestId,elapsedMs:Date.now()-imageAt,usage:image.data.usage||null});
    const encoded=image.data.data?.[0]?.b64_json;if(!encoded)throw Error('Image bytes absent');
    const {error:uploadError}=await bucket.upload(`${PILOT_ID}/${story.id}.png`,Buffer.from(encoded,'base64'),{contentType:'image/png',upsert:false});if(uploadError)throw Error('Image storage failed');
    item.imageReady=true;item.prompt=prompt;item.status='planning';await save(report);
    if(low){item.status='review_required';item.elapsedMs=Date.now()-begin;await save(report);continue;}
    const visionAt=Date.now();const vision=await api('responses',{model:report.visionModel,store:false,max_output_tokens:2200,input:[{role:'user',content:[{type:'input_text',text:`Inspect the actual illustration and plan sequential reveals. Summary: ${JSON.stringify(story.summary)}. Return JSON only: {"regions":[{"top":0,"bottom":0.4,"trigger":"exact phrase copied from summary","label":"short region description"}],"visualConcerns":["observed issue if any"]}. Choose 2–5 full-width horizontal bands with boundaries in empty gutters. top/bottom are fractions of image height. Bands must partition the entire image from 0 to 1 without gaps or overlaps. Include every label and object intact. Order regions by the desired storytelling reveal order, not necessarily vertical position. The first revealed region must introduce the main subject. Trigger phrases must occur verbatim in the summary. Honestly report any unsupported details, overlaps or unavoidable cuts in visualConcerns. Do not rewrite the illustration or assume a fixed layout.`},{type:'input_image',image_url:'data:image/png;base64,'+encoded}]}]});
    item.calls.push({stage:'vision',requestId:vision.requestId,elapsedMs:Date.now()-visionAt,usage:vision.data.usage||null});
    const output=(vision.data.output||[]).filter(x=>x.type==='message').flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('');
    item.rawPlan=output;
    item.plan=validatePlan(JSON.parse(output.replace(/^```json\s*|\s*```$/g,'')),story.summary);
    item.status='review_required';
   }catch(e){item.status='failed';item.error=e.message;}
   item.elapsedMs=Date.now()-begin;await save(report);
   // Authentication/billing/access failures cannot be fixed by another paid attempt.
   if(item.error?.match(/OpenAI (400|401|402|403|429)/)){report.status='blocked';break;}
  }
  if(report.status==='running')report.status='complete';report.finishedAt=new Date().toISOString();await save(report);
 },
 register(app){
  app.get('/api/'+route,async(req,res)=>{try{const report=await read(); if(report){report.estimatedCostUSD=(report.stories||[]).flatMap(s=>s.calls||[]).reduce((sum,c)=>{const u=c.usage||{};return sum+(c.stage==='image'?((u.input_tokens||0)*5+(u.output_tokens||0)*30):((u.input_tokens||0)+(u.output_tokens||0)*5))/1e6;},0);report.costNote='Estimate from recorded usage and published standard token rates; confirm against provider billing.';} res.set('Cache-Control','no-store').json(report||{id:PILOT_ID,status:'not_started'});}catch{res.status(503).json({error:'Pilot report unavailable'});}});
  app.get('/api/'+route+'/image/:id',async(req,res)=>{
   if(!stories.some(s=>s.id===req.params.id))return res.sendStatus(404);
   const {data}=await bucket.download(`${PILOT_ID}/${req.params.id}.png`);if(!data)return res.sendStatus(404);
   res.type('png').set('Cache-Control','public,max-age=3600').send(Buffer.from(await data.arrayBuffer()));
  });
  app.get('/'+route,(_req,res)=>{let html=fs.readFileSync(new URL('./review.html',import.meta.url),'utf8');if(low)html=html.replaceAll('illustration-pilot',route).replaceAll('Illustrated reveal pilot','Low-quality small-image test').replace('Three first-pass images and model-planned reveals. Silent timing demonstration, not narration synchronization. Existing Oct 31 summaries; not today\'s reporting.','One low-quality image at 896 × 736. No reveal-planning call. Existing Oct 31 short summary.').replace('aspect-ratio:4/5','aspect-ratio:896/736');res.type('html').send(html);});
 }
 };
}
