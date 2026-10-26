import test from 'node:test';
import assert from 'node:assert/strict';
import { safeAudioRecord, mergeAudioRanges, registerAudioProgressRoutes, mergeAudioRecords } from './audio-progress.js';
test('audio records validate their shape and derive completion from coverage rather than position',()=>{
 const row={key:'key',day:'2026-10-26',period:'Daily',language:'en',category:'World',position:1,ranges:[[0,.3],[.2,.7]],completed:false};
 assert.equal(safeAudioRecord(row).completed,true);
 assert.equal(safeAudioRecord({...row,ranges:[[0,.1]],completed:true}).completed,false);
 assert.equal(safeAudioRecord({...row,period:'invalid'}),null);
 assert.deepEqual(mergeAudioRanges([[0,.5]],[[.3,.7]]),[[0,.7]]);
});
test('progress endpoints require a verified session before database access',async()=>{
 const handlers={};let accessed=false;
 registerAudioProgressRoutes({get:(p,fn)=>handlers.get=fn,post:(p,fn)=>handlers.post=fn},{from:()=>{accessed=true;},auth:{getUser:async()=>({error:'invalid'})}});
 for(const handler of Object.values(handlers)) {
  const res={statusCode:200,status(n){this.statusCode=n;return this;},json(){return this;}};
  await handler({headers:{},body:{records:[],user_id:'other'}},res);
  assert.equal(res.statusCode,401);
 }
 assert.equal(accessed,false);
});

test('devices merge unique coverage and the server rejects an unearned mix completion',()=>{
 const base={day:'2026-10-26',period:'Daily',language:'en',category:'World',queueKeys:['world','tech']};
 const previous=[{content_key:'world',data:{...base,key:'world',ranges:[[0,.4]],completed:false,updatedAt:5}}, {content_key:'tech',data:{...base,key:'tech',ranges:[[0,.7]],completed:true,updatedAt:5}}];
 const merged=mergeAudioRecords([safeAudioRecord({...base,key:'world',ranges:[[.3,.7]],position:.7,updatedAt:10})],previous)[0].data;
 assert.deepEqual(merged.ranges,[[0,.7]]);
 assert.equal(merged.mixCompleted,true);
 const skipped=mergeAudioRecords([safeAudioRecord({...base,key:'world',ranges:[[0,.1]],mixCompleted:true})],[])[0].data;
 assert.equal(skipped.mixCompleted,false);
});
