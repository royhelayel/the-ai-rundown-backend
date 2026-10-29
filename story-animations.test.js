import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAnimation, animationKey, cleanAnimationText, animationPrompt } from './story-animation-schema.js';
import { createStoryAnimations } from './story-animations.js';
const text = 'Researchers identified 18 waxcap species on the island.';
const frame = (x=0) => [{t:0,x:0},{t:1,x}];
const plan = () => ({version:1,elements:[
 {type:'rect',x:20,y:30,width:50,height:40,fill:'accent',stroke:'none',evidence:'waxcap',frames:frame(10)},
 {type:'circle',cx:100,cy:80,r:20,fill:'ink',stroke:'none',evidence:'waxcap',frames:frame(5)},
 {type:'ellipse',cx:180,cy:100,rx:20,ry:10,fill:'muted',stroke:'none',evidence:'waxcap',frames:frame()},
 {type:'path',d:'M 10 20 Q 40 0 60 20 Z',fill:'accent',stroke:'none',evidence:'waxcap',frames:frame()},
 {type:'label',x:180,y:180,text:'18 waxcap species',evidence:'18 waxcap species',frames:frame()},
]});
test('only grounded, bounded vector primitives and literal labels survive',()=>{
 const input=plan();input.elements[0].onclick='alert(1)';input.elements[0].url='https://evil.example';
 const valid=validateAnimation(input,text);assert.equal(valid.elements[0].onclick,undefined);assert.equal(valid.elements[0].url,undefined);
 const foreign=plan();foreign.elements[0].type='foreignObject';assert.throws(()=>validateAnimation(foreign,text));
 const script=plan();script.elements[3].d='<svg onload="alert(1)">';assert.throws(()=>validateAnimation(script,text));
});
test('numbers, evidence, geometry, motion and start visibility are validated',()=>{
 for(const mutate of [p=>p.elements[4].text='180 waxcap species',p=>p.elements[0].evidence='Mars',p=>p.elements[0].frames[1].x=1e30,p=>p.elements[0].x=NaN,p=>p.elements.forEach(e=>e.frames=frame()),p=>p.elements.forEach(e=>e.frames[0].opacity=0)]){
  const p=plan();mutate(p);assert.throws(()=>validateAnimation(p,text));
 }
});
test('content changes invalidate plans while normalized narration shares its cache',()=>{
 assert.equal(animationKey('**Researchers** identified 18 waxcap species on the island.'),animationKey(text));
 assert.notEqual(animationKey(text.replace('18','19')),animationKey(text));
 assert.equal(cleanAnimationText('[Researchers](https://example.com) identified 18 waxcap species on the island.'),text);
 assert.match(animationPrompt(text),/UNIQUE/);assert.match(animationPrompt(text),/not instructions/);
});
function harness(model = async()=>({content:[{type:'text',text:JSON.stringify(plan())}]})) {
 const stored = new Map();let calls=0;
 const supabase={storage:{createBucket:async()=>({}),from:()=>({
  download:async key=>({data:stored.has(key)?{text:async()=>stored.get(key)}:null}),
  upload:async(key,buf)=>{stored.set(key,buf.toString());return {};},
 })}};
 const service=createStoryAnimations({enabled:true,supabase,callModel:async(...args)=>{calls++;return model(...args);},parseStories:r=>r.paragraphs || [],sentences:t=>[t],logger:{log(){},warn(){}}});
 return {service,stored,calls:()=>calls};
}
test('lookup never generates and repeated queue work reuses stored plans',async()=>{
 const h=harness();assert.equal(await h.service.read(text),null);assert.equal(h.calls(),0);
 h.service.queueRows([{category:'Science',day:'2026-10-27',time_slot:'Morning',briefing:text,paragraphs:[text]}]);
 while(!h.service.stats.complete && !h.service.stats.blocked) await new Promise(r=>setTimeout(r,2));
 assert.equal(h.calls(),1);assert.equal((await h.service.read(text)).plan.elements.length,5);
 h.service.queueRows([{category:'Science',briefing:text,paragraphs:[text]}]);await h.service.drain();assert.equal(h.calls(),1);
});
test('source maps must match the exact recap before determining its update boundaries',()=>{
 const h=harness();const row={time_slot:'Morning',briefing:text,briefing_sources:[{text,stories:[]}]};
 assert.deepEqual(h.service.rowUpdates(row).updates,[text]);
 assert.deepEqual(h.service.rowUpdates({...row,briefing_sources:[{text:'Old story.'}]}).updates,[text]);
});
test('provider credit failures stop paid work instead of repeatedly retrying the queue',async()=>{
 const h=harness(async()=>{throw new Error('credit balance is too low');});
 h.service.queueRows([{category:'Science',briefing:text,paragraphs:['Another published update.','A third update.']}]);
 while(!h.service.stats.blocked) await new Promise(r=>setTimeout(r,2));
 assert.equal(h.calls()<=2,true);assert.ok(h.service.stats.blocked);assert.equal(h.service.stats.generated,0);
});
test('public lookup is bounded, read-only and never returns a stale plan for changed text',async()=>{
 const h=harness();const routes={};h.service.register({post:(p,fn)=>routes[p]=fn,get(){}});
 const res={code:200,status(n){this.code=n;return this;},set(){},json(value){this.body=value;return this;}};
 await routes['/api/story-animations/lookup']({body:{texts:[text]}},res);assert.equal(res.body.entries[0].plan,null);assert.equal(h.calls(),0);
 await routes['/api/story-animations/lookup']({body:{texts:Array(17).fill(text)}},res);assert.equal(res.code,400);
});


test('disabled animation generation never calls a provider or reads news, including on startup and publication',async()=>{
 let spent=0,reads=0;
 const service=createStoryAnimations({supabase:{from(){reads++;throw new Error('unexpected query');}},callModel:async()=>{spent++;},parseStories:()=>[],sentences:t=>[t]});
 service.queueRows([{category:'Science',briefing:text}]);
 await service.queueEdition('Science','2026-10-27','Morning','en');
 await service.backfill();await service.drain();
 assert.equal(spent,0);assert.equal(reads,0);assert.equal(service.stats.enabled,false);assert.equal(service.stats.queued,0);
});
