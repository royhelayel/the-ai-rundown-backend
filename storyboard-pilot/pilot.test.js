import test from 'node:test';
import assert from 'node:assert/strict';
import {runPilot,createWorldPilot} from './run.js';
import {validateDrawing,validateBoard} from './schema.js';
const text='Officials transferred the passport to the court. Travel is restricted pending review.';
const board={concept:'Transfer',beats:[{evidence:'transferred the passport',action:'Passport travels into a court document tray.'},{evidence:'Travel is restricted',action:'A travel route closes while document stays in tray.'},{evidence:'pending review',action:'A neutral review marker appears, preserving unresolved status.'}]};
const drawing={groups:[0,1].map(i=>({evidence:'transferred the passport',shapes:[0,1,2].map(n=>({type:'rect',x:20+n*25,y:30+i*40,width:20,height:20,fill:'ink',stroke:'none'})),frames:[{t:0,x:0},{t:1,x:50}]}))};
const reply=(v)=>({id:'test',content:[{type:'text',text:JSON.stringify(v)}],usage:{input_tokens:100,output_tokens:100},stop_reason:'end_turn'});
test('bounded drawing rejects code, unsupported labels and missing evidence',()=>{
 assert.equal(validateDrawing(drawing,text).groups.length,2);
 for(const change of [s=>s.groups[0].shapes[0].type='script',s=>s.groups[0].evidence='unreported assertion',s=>s.groups[0].shapes[0]={type:'text',x:20,y:20,text:'invented'}]){const d=structuredClone(drawing);change(d);assert.throws(()=>validateDrawing(d,text));}
 assert.throws(()=>validateBoard({beats:[]},text));
});
test('pilot makes separate storyboard/drawing/audit calls and records actual usage',async()=>{
 const calls=[],snapshots=[];
 const result=await runPilot({stories:[{headline:'Passport review',text}],callModel:async(p,m,r,details)=>{calls.push(details.contentType);return reply(calls.length===1?board:calls.length===2?drawing:{pass:true,issues:[]});},save:async s=>snapshots.push(s)});
 assert.equal(result.generated,1);assert.ok(Math.abs(result.costUSD-.0018)<1e-10);assert.deepEqual(calls,['storyboard_pilot_storyboard','storyboard_pilot_drawing','storyboard_pilot_audit']);assert.equal(snapshots.at(-1).status,'complete');
});
test('one automatic repair only; rejected output is never published as generated',async()=>{
 let count=0;const result=await runPilot({stories:[{headline:'Passport review',text}],callModel:async()=>reply(++count===1?board:{groups:[]}),save:async()=>{}});
 assert.equal(count,3);assert.equal(result.failed,1);assert.equal(result.records[0].attempts,2);assert.equal(result.records[0].drawing,undefined);
});
test('budget is reserved before dispatch and batch is capped at twelve',async()=>{
 let calls=0;const result=await runPilot({stories:Array.from({length:15},()=>({headline:'Test',text})),budget:.000001,callModel:async()=>{calls++;return reply(board);},save:async()=>{}});
 assert.equal(calls,0);assert.equal(result.records.length,12);assert.equal(result.costUSD,0);
});
test('persistent claim prevents calls on restart even with provider credentials',async()=>{
 let calls=0,uploaded=0;const storage={download:async()=>({data:{text:async()=>JSON.stringify({status:'complete',costUSD:.2,records:[{index:0,headline:'Test',text,status:'failed'}]})}}),upload:async()=>{uploaded++;return{error:{message:'Duplicate'}};}};
 const client={storage:{from:()=>storage,createBucket:async()=>({})},from:()=>({select(){return this},eq(){return this},is(){return this},in:async()=>({data:[{stories_content:'source'}]})})};
 const pilot=createWorldPilot({supabase:client,callModel:async()=>{calls++},parseStories:()=>[{headline:'Test',summary:text}],logger:{log(){},warn(){}}});
 await pilot.start();await pilot.start();assert.equal(uploaded,2);assert.equal(calls,0);
});

test('safe compatibility handling preserves motion without inventing geometry',()=>{
 const raw=structuredClone(drawing);raw.groups[0].frames=[{t:.1,rotate:0},{t:.9,rotate:360}];
 raw.groups[0].shapes.push({type:'polygon',points:[30,30,50,60,10,60],fill:'ink',stroke:'none'});
 raw.groups[0].shapes.push({type:'text',x:30,y:30,text:'invented label',fill:'ink',stroke:'none'});
 const result=validateDrawing(raw,text);
 assert.equal(result.groups[0].frames[0].t,0);assert.equal(result.groups[0].frames.at(-1).t,1);assert.equal(result.groups[0].frames.at(-1).rotate,360);
 assert.equal(result.removedUnsupportedLabels,1);assert.equal(result.groups[0].shapes.at(-1).type,'polygon');
});
