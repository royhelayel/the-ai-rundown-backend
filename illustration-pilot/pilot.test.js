import test from 'node:test';import assert from 'node:assert/strict';
import {validatePlan,createIllustrationPilot} from './pilot.js';
test('rejects gaps, overlaps, fabricated triggers and missing coverage',()=>{
 const base={regions:[{top:0,bottom:.5,trigger:'news'},{top:.5,bottom:1,trigger:'today'}]};
 assert.equal(validatePlan(base,'news today'),base);
 for(const change of [{top:.6},{top:.4},{trigger:'invented'},{bottom:.9}]){
 const p=structuredClone(base);Object.assign(p.regions[1],change);assert.throws(()=>validatePlan(p,'news today'));
 }
});
test('existing durable claim prevents all API calls',async()=>{
 const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-only';let calls=0;
 try{const service=createIllustrationPilot({supabase:{storage:{createBucket:async()=>({error:null}),from:()=>({upload:async()=>({error:{message:'exists'}})})}},fetchImpl:async()=>{calls++;throw Error('unexpected');}});await service.start();assert.equal(calls,0);}finally{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
});
