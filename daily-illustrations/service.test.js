import test from 'node:test';import assert from 'node:assert/strict';
import {createDailyIllustrations,artworkKey,tokenCost} from './service.js';
const full='Officials proposed a trade deal. The agreement is not final.',short='A proposed trade deal is not final.';
const row={category:'World News',day:'2026-11-02',time_slot:'Morning',language:'en',content:full,briefing:short,briefing_sources:[{text:short,stories:[{headline:'Proposed trade deal'}]}],audit_result:{checked:true}};
const parser=r=>[{headline:'Proposed trade deal',summary:r.content}];
const now=()=>Date.parse('2026-11-02T06:00:00Z');
function memory(){const data=new Map(),images=new Map();return{data,images,prepare:async()=>{},get:async p=>data.get(p)||null,put:async(p,b,{exclusive=false}={})=>{if(exclusive&&data.has(p))return false;data.set(p,structuredClone(b));return true;},image:async(k,v)=>images.set(k,v),bytes:async k=>images.get(k),list:async prefix=>[...data.keys()].filter(k=>k.startsWith(prefix+'/')&&!k.slice(prefix.length+1).includes('/')).sort()};}
function fixture(options={}){const store=options.store||memory(),calls=[],usage=[];const service=createDailyIllustrations({store,parseStories:parser,now,enabled:true,repairReviews:false,hasKey:()=>true,logger:{warn(){}},trackUsage:async r=>usage.push(r),fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);calls.push(body);return {ok:true,headers:new Headers({'x-request-id':'request-'+calls.length}),json:async()=>url.endsWith('/edits')?{usage:{input_tokens:200,output_tokens:139},data:[{b64_json:Buffer.from('fake-image').toString('base64')}]}:typeof body.input==='string'?{status:'completed',usage:{input_tokens:200,output_tokens:150},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({family:'editorial-cartoon',tone:'neutral',concept:'A proposal awaiting agreement',elements:[{description:'A proposed agreement document',sourceQuote:'trade deal'}],labels:[{text:'Not final',sourceQuote:'not final'}]})}]}]}:{status:'completed',usage:{input_tokens:1200,output_tokens:200},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({regions:[{top:0,bottom:.5,trigger:'A proposed trade deal',label:'Proposal'},{top:.5,bottom:1,trigger:'not final',label:'Pending'}],visualConcerns:options.concerns||[],qualityConcerns:options.qualityConcerns||[]})}]}]}};},...options});return{service,store,calls,usage};}
test('only checked shared English World daily rows generate; lookup is read-only',async()=>{const f=fixture();for(const ext of [{category:'Business'},{language:'ar'},{user_id:'private'},{shared_key:'shared'},{audit_result:{checked:false}},{time_slot:'Weekly'}])await f.service.queueRows([{...row,...ext}]);await f.service.drain();assert.equal(f.calls.length,0);assert.equal(await f.service.lookup(row,full),null);assert.equal(f.calls.length,0);});
test('one short-source artwork serves Quick and Full and unchanged later editions without more calls',async()=>{const f=fixture();await f.service.queueRows([row,row]);await f.service.drain();assert.equal(f.calls.length,3);assert.equal(f.calls[1].quality,'low');assert.equal(f.calls[1].size,'896x736');assert.equal(f.calls[1].prompt.includes(short),true);assert.equal(f.calls[1].prompt.includes(full),false);const a=await f.service.lookup(row,full),b=await f.service.lookup(row,short);assert.equal(a.artifact.type,'illustration');assert.equal(a.artifact.id,b.artifact.id);assert.equal(f.usage.length,3);await f.service.queueRows([{...row,day:'2026-11-03',time_slot:'Evening'}]);await f.service.drain();assert.equal(f.calls.length,3);assert.equal((await f.service.lookup({...row,day:'2026-11-03'},short)).artifact.id,a.artifact.id);});
test('material visual concerns withhold public image and never auto-repair or retry on restart',async()=>{const f=fixture({concerns:['Invented transport']});await f.service.queueRows([row]);await f.service.drain();assert.equal((await f.service.lookup(row,short)).status,'withheld');assert.equal(f.calls.length,3);const fresh=fixture({store:f.store});await fresh.service.queueRows([row]);await fresh.service.drain();assert.equal(fresh.calls.length,0);assert.equal((await fresh.service.status()).counts.withheld,1);});
test('ambiguous network failure never repeats a paid request',async()=>{let n=0;const f=fixture({fetchImpl:async()=>{n++;throw Error('timeout');}});await f.service.queueRows([row]);await f.service.drain();await f.service.queueRows([row]);await f.service.drain();assert.equal(n,1);assert.equal((await f.service.status()).counts.failed,1);});
test('zero daily quota prevents API calls and reports budget status',async()=>{const f=fixture({maxJobs:0});await f.service.queueRows([row]);await f.service.drain();assert.equal(f.calls.length,0);assert.equal(f.store.data.get(`claims/${artworkKey(short)}.json`).status,'budget');});
test('price estimates retain image and vision usage separately',()=>{assert.equal(tokenCost('image',{input_tokens:278,output_tokens:139}),.00556);assert.equal(tokenCost('vision',{input_tokens:1000,output_tokens:200}),.002);});
test('authorized regeneration retries only withheld stories once, preserves accepted images, and keeps new aliases on catch-up',async()=>{
 const concerns=['Invented transport'];const f=fixture({concerns});const edition={...row,day:'2026-10-31'};
 await f.service.queueRows([edition]);await f.service.drain();const parent=artworkKey(short);assert.equal(f.calls.length,3);concerns.length=0;
 const result=await f.service.regenerateWithheld([parent]);assert.equal(result.queued,1);assert.equal(f.calls.length,6);
 assert.equal(f.calls[4].images.length,1);
 const ready=await f.service.lookup(edition,short);assert.equal(ready.status,'ready');assert.notEqual(ready.artifact.id,parent);
 await f.service.regenerateWithheld([parent]);await f.service.queueRows([edition]);await f.service.drain();assert.equal(f.calls.length,6);assert.equal((await f.service.lookup(edition,full)).artifact.id,ready.artifact.id);
 const fresh=fixture({store:f.store});await fresh.service.regenerateWithheld([parent]);await fresh.service.queueRows([edition]);await fresh.service.drain();assert.equal(fresh.calls.length,0);
 const accepted=fixture();await accepted.service.queueRows([edition]);await accepted.service.drain();await accepted.service.regenerateWithheld([parent]);assert.equal(accepted.calls.length,3);assert.equal((await accepted.service.lookup(edition,short)).artifact.id,parent);
});
test('style review failures withhold otherwise factual images',async()=>{const f=fixture({qualityConcerns:['Cluttered and unlike reference']});await f.service.queueRows([row]);await f.service.drain();assert.equal((await f.service.lookup(row,short)).status,'withheld');assert.equal((await f.service.status()).counts.withheld,1);assert.ok(f.calls[1].images[0].image_url.startsWith('data:image/png;base64,'));});
test('legacy accepted artwork survives a withheld new-style replacement',async()=>{
 const initial=fixture();await initial.service.queueRows([row]);await initial.service.drain();const current=artworkKey(short),old='f'.repeat(64);const a=initial.store.data.get(`assets/${current}.json`);initial.store.data.delete(`assets/${current}.json`);initial.store.data.delete(`claims/${current}.json`);initial.store.data.set(`assets/${old}.json`,{...a,key:old,version:'world-illustration-low-v1'});
 for(const [path,value] of initial.store.data)if(path.startsWith('aliases/'))initial.store.data.set(path,{...value,key:old});
 const f=fixture({store:initial.store,qualityConcerns:['Poor match']});await f.service.queueRows([row]);await f.service.drain();assert.equal((await f.service.lookup(row,short)).artifact.id,old);assert.equal((await f.service.lookup(row,full)).artifact.policy,'world-illustration-low-v1');
});
test('quota-only deferrals resume next day; paid failures still never retry',async()=>{
 const first=fixture({maxJobs:0});await first.service.queueRows([row]);await first.service.drain();assert.equal(first.calls.length,0);
 const next=fixture({store:first.store,now:()=>now()+864e5});await next.service.carryDeferred();await next.service.drain();assert.equal(next.calls.length,3);assert.equal((await next.service.lookup(row,short)).status,'ready');
});
test('reference input tokens are accounted at image-input rate',()=>{assert.equal(tokenCost('image',{input_tokens:1200,input_tokens_details:{text_tokens:200,image_tokens:1000},output_tokens:139}),.01317);});

test('transparent image delivery is opt-in, cached, and never modifies the stored original',async()=>{
 const {PNG}=await import('pngjs');const png=new PNG({width:10,height:10});for(let i=0;i<100;i++)png.data.set([252,247,232,255],i*4);png.data.set([20,20,20,255],(5*10+5)*4);
 const original=PNG.sync.write(png),f=fixture();await f.service.queueRows([row]);await f.service.drain();const id=(await f.service.lookup(row,short)).artifact.id;f.store.images.set(id,original);
 let downloads=0;const read=f.store.bytes;f.store.bytes=async key=>{downloads++;return read(key);};
 const routes=new Map();f.service.register({get:(path,handler)=>routes.set(path,handler)});const route=routes.get('/api/world-illustrations/image/:id');
 const response=()=>({headers:{},set(k,v){if(typeof k==='object')Object.assign(this.headers,k);else this.headers[k]=v;return this;},type(){return this;},send(bytes){this.body=bytes;return this;},sendStatus(code){this.code=code;return this;}});
 const first=response();await route({params:{id},query:{paper:'transparent-v1'}},first);assert.equal(first.headers['X-Illustration-Paper'],'transparent-v1');assert.equal(PNG.sync.read(first.body).data[3],0);
 const second=response();await route({params:{id},query:{paper:'transparent-v1'}},second);assert.equal(downloads,1);assert.equal(second.body,first.body);
 const raw=response();await route({params:{id},query:{}},raw);assert.equal(raw.body,original);assert.equal(PNG.sync.read(raw.body).data[3],255);
});

test('a withheld image gets exactly one budgeted, correction-aware repair and never bypasses review',async()=>{
 const f=fixture({repairReviews:true,qualityConcerns:['Labels overlap']});await f.service.queueRows([row]);await f.service.drain();await f.service.drain();
 assert.equal(f.calls.length,6);assert.match(f.calls[3].input,/Labels overlap/);assert.match(f.calls[4].prompt,/Labels overlap/);
 assert.equal((await f.service.status()).reservedUSD,.06);assert.equal((await f.service.lookup(row,short)).status,'withheld');
 await f.service.queueRows([row]);await f.service.drain();assert.equal(f.calls.length,6);
});
test('a corrective repair still obeys the daily reservation cap',async()=>{const f=fixture({repairReviews:true,qualityConcerns:['Labels overlap'],maxJobs:1});await f.service.queueRows([row]);await f.service.drain();await f.service.drain();assert.equal(f.calls.length,3);assert.equal((await f.service.lookup(row,short)).status,'budget');});
test('an invalid completed direction may retry once before any image call; ambiguous network calls cannot',async()=>{
 const f=fixture();await f.service.queueRows([row]);await f.service.drain();const key=artworkKey(short);f.store.data.delete(`assets/${key}.json`);f.store.data.set(`claims/${key}.json`,{key,meta:{day:row.day},status:'failed',error:'generation_failed',startedAt:now(),calls:[{stage:'direction'}],costUSD:.001});
 const next=fixture({store:f.store});await next.service.queueRows([row]);await next.service.drain();assert.equal(next.calls.length,3);assert.equal((await next.service.status()).reservedUSD,.03);assert.equal((await next.service.lookup(row,short)).status,'ready');
});
test('a checked story without a usable recap or short first sentence still queues from its headline',async()=>{
 const r={...row,content:Array(80).fill('Long quoted reporting').join(' '),briefing:null,briefing_sources:[]};const f=fixture({parseStories:x=>[{headline:'Officials proposed a trade deal that is not final.',summary:x.content}]});await f.service.queueRows([r]);await f.service.drain();assert.equal(f.calls.length,3);assert.ok(f.calls[0].input.includes('Officials proposed a trade deal that is not final.'));
});

test('a confirmed HTTP 400 before image output can retry once using its existing direction and reservation',async()=>{
 const first=fixture();await first.service.queueRows([row]);await first.service.drain();const key=artworkKey(short),prior=first.store.data.get(`claims/${key}.json`);first.store.data.delete(`assets/${key}.json`);first.store.images.delete(key);first.store.data.set(`claims/${key}.json`,{...prior,status:'failed',error:'provider_400',calls:prior.calls.slice(0,1)});
 const next=fixture({store:first.store});await next.service.queueRows([row]);await next.service.drain();assert.equal(next.calls.length,2);assert.ok(next.calls[0].images);assert.equal((await next.service.status()).reservedUSD,.03);assert.equal((await next.service.lookup(row,short)).status,'ready');
});
