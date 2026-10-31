import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceSentences,validatePlan,reviewAudit} from './grounding.js';
const job={fullText:'Officials proposed a trade deal. The agreement is not final.',shortText:'A proposed trade deal is not final.'};
const plan={script:'A different model-written script.',evidenceIds:['F2'],concept:'Proposed deal',beats:[{start:0,end:1,sourceIds:['F2'],visual:'Document',movement:'Opens'}]};
test('checked short text is bound from source, never overwritten by planner',()=>{assert.equal(validatePlan(plan,job).script,job.shortText);assert.deepEqual(sourceSentences(job).map(s=>s.id),['F1','F2','Q1']);});
test('unknown or absent source references and invalid timing fail closed',()=>{assert.throws(()=>validatePlan({...plan,evidenceIds:['F900']},job),/source support/);assert.throws(()=>validatePlan({...plan,beats:[{start:0,end:2,sourceIds:['F1']}]},job),/timing/);});
test('approval requires explicit true and no issues; malformed rejection is not approval',()=>{for(const audit of [{pass:false,issues:[]},{pass:true,issues:[{}]},{pass:false,issues:[{scope:'code',sourceIds:['F900'],sceneQuote:'Wrong',issue:'Wrong'}]}])assert.equal(reviewAudit(audit,job,plan,'Wrong').invalid,true);assert.equal(reviewAudit({pass:true,issues:[]},job,plan,'').pass,true);});
test('valid factual rejection remains actionable and never approved',()=>{const verdict=reviewAudit({pass:false,issues:[{scope:'code',sourceIds:['F2'],sceneQuote:'Final deal',issue:'Source says not final'}]},job,plan,'<text>Final deal</text>');assert.equal(verdict.pass,undefined);assert.match(verdict.reason,/not final/);});
