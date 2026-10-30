import test from'node:test';import assert from'node:assert/strict';
import{sourceSentences,boardV3,drawingV3,DRAW_SCHEMA}from'./contract-v3.js';
import{runRepair,createRepairV3}from'./repair-v3.js';
import{anthropicCost}from'../usage-accounting.js';
const text='Officials transferred the passport to the court. Travel is restricted pending review.';
const board={concept:'Document handover and travel restriction',beats:[{sourceIds:[0],action:'The document moves into a court tray.'},{sourceIds:[1],action:'A route closes while the document stays in the tray.'}]};
const candidate={groups:[0,1].map(i=>({sourceIds:[i],at:{x:180+i*240,y:190},shapes:Array.from({length:4},(_,n)=>({type:'rect',x:-60+n*20,y:-30,width:15,height:60,rx:3,fill:'ink',stroke:'none',sw:0})),frames:[{t:0,x:0,y:0,s:1,r:0,o:1},{t:1,x:30,y:0,s:1,r:0,o:1}]}))};
const response=(data,model)=>({id:'test',model,content:[{type:'text',text:JSON.stringify(data)}],usage:{input_tokens:100,output_tokens:100},stop_reason:'end_turn'});
test('decimal amounts remain intact in evidence and labels cannot invent source wording',()=>{
 const ss=sourceSentences('The loss was $6.3 billion. Review continues.');assert.equal(ss.length,2);assert.match(ss[0].text,/6.3/);
 assert.throws(()=>boardV3({...board,beats:[{...board.beats[0],sourceIds:[99]},board.beats[1]]},text));
});
test('local coordinates preserve whole-object layout, zero scale and numeric path safety',()=>{
 const plan=drawingV3(candidate,text);assert.equal(plan.coordinateSpace,'local');assert.equal(plan.groups[0].at.x,180);assert.equal(plan.groups[0].shapes[0].x,-60);
 const zero=structuredClone(candidate);zero.groups[1].frames[0].s=0;assert.doesNotThrow(()=>drawingV3(zero,text));
 for(const shape of[{type:'script'},{type:'path',d:'M0 0 onload=alert(1)',fill:'ink',stroke:'none',sw:0},{type:'path',d:'M1e999 0',fill:'ink',stroke:'none',sw:0}]){const raw=structuredClone(candidate);raw.groups[0].shapes[0]=shape;assert.throws(()=>drawingV3(raw,text));}
});
test('schema only uses provider-supported features, closed objects and finite shape vocabulary',()=>{
 const walk=s=>{if(s.type==='object')assert.equal(s.additionalProperties,false);for(const key of['minimum','maximum','maxItems','minLength','maxLength'])assert.equal(s[key],undefined);if(s.properties)Object.values(s.properties).forEach(walk);if(s.items)walk(s.items);if(s.anyOf)s.anyOf.forEach(walk);};walk(DRAW_SCHEMA);
});
test('real workflow sends schemas at every stage and uses model-specific accounting',async()=>{
 const calls=[];const r=await runRepair({stories:[{headline:'Passport',text}],save:async()=>{},callStructured:async req=>{calls.push(req);return response(calls.length===1?board:calls.length===2?candidate:{pass:true,issues:[]},req.model);}});
 assert.equal(r.generated,1);assert.equal(calls.length,3);assert.ok(calls.every(c=>c.schema?.additionalProperties===false));assert.equal(calls[1].model,'claude-sonnet-4-6');assert.ok(Math.abs(r.costUSD-.003)<1e-10);
 assert.equal(anthropicCost({input_tokens:1000000,output_tokens:1000000},'claude-sonnet-4-6').total,18);
});
test('semantic audit failure stays rejected after one repair and is never relabeled passed',async()=>{
 let calls=0;const r=await runRepair({stories:[{headline:'Passport',text}],save:async()=>{},callStructured:async req=>response(++calls===1?board:req.details.contentType.endsWith('audit')?{pass:false,issues:['Implies an unsupported outcome']}:candidate,req.model)});
 assert.equal(calls,5);assert.equal(r.generated,0);assert.equal(r.records[0].attempts,2);assert.equal(r.records[0].drawing,undefined);assert.match(r.records[0].error,/unsupported/);
});
test('budget cap prevents provider calls and persistent claims prevent repeated paid waves',async()=>{
 let calls=0;await runRepair({stories:[{headline:'Passport',text}],budget:0,save:async()=>{},callStructured:async()=>{calls++;}});assert.equal(calls,0);
 const bucket={download:async()=>({data:{text:async()=>JSON.stringify({status:'complete',records:[{index:0,headline:'Passport',text,status:'failed'}]})}}),upload:async()=>({error:{message:'Duplicate'}})};
 const pilot=createRepairV3({supabase:{storage:{from:()=>bucket}},callStructured:async()=>{calls++},logger:{log(){}}});await pilot.start();await pilot.start();assert.equal(calls,0);
});
test('transport accounting stores Sonnet rates rather than silently charging Haiku prices',async()=>{
 const{createTrackedAnthropicFetch}=await import('../usage-accounting.js');let stored;
 const tracked=createTrackedAnthropicFetch({trackUsage:async row=>{stored=row;},fetchImpl:async()=>new Response(JSON.stringify({id:'sonnet-test',model:'claude-sonnet-4-6',usage:{input_tokens:1000,output_tokens:1000}}))});
 await tracked({method:'POST'},{contentType:'storyboard_repair_v3_drawing'});
 assert.equal(stored.model,'claude-sonnet-4-6');assert.equal(stored.estimated_cost_usd,.018);assert.equal(stored.usage_metadata.prices.input,3e-6);
});
