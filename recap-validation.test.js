import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuditJSON, sentencesOf, unsupportedMap, recapIssues, validateRecap } from './recap-validation.js';

test('parses fenced JSON and prose without greedily joining multiple objects', () => {
  assert.deepEqual(parseAuditJSON('```json\n{"unsupported":[]}\n```\nExplanation.'), { unsupported: [] });
  assert.deepEqual(parseAuditJSON('{"issues":["quote \\\" and brace }"],"missingStories":[]}').missingStories, []);
  assert.throws(() => parseAuditJSON('{"unsupported":[]}\n{"unsupported":[]}'));
  assert.throws(() => parseAuditJSON('{"unsupported":['));
});
test('invalid schemas and unknown IDs cannot silently pass', () => {
  assert.throws(() => unsupportedMap({}, new Set(['B1'])));
  assert.throws(() => unsupportedMap({unsupported:[{id:'B2',reason:'x'}]}, new Set(['B1'])));
  assert.equal(unsupportedMap({unsupported:[]}, new Set()).size, 0);
  assert.throws(() => recapIssues({missingStories:['S9'],issues:[]}, ['S1']));
  assert.throws(() => recapIssues({missingStories:[]}, ['S1']));
});
test('US PhD regression keeps the complete claim intact', () => {
  const text = 'Applications for U.S. Ph.D. programs dropped 21 percent. Another story follows.';
  assert.deepEqual(sentencesOf(text), ['Applications for U.S. Ph.D. programs dropped 21 percent.', 'Another story follows.']);
  assert.deepEqual(sentencesOf('Dr. Smith reports 3.5 percent. Next finding.'), ['Dr. Smith reports 3.5 percent.', 'Next finding.']);
  assert.deepEqual(sentencesOf('هذا خبر. هذا آخر؟ نعم.'), ['هذا خبر.', 'هذا آخر؟', 'نعم.']);
});
test('audit failure withholds recap rather than publishing unchecked', async () => {
  const result = await validateRecap({text:'A claim.',audit:async()=>{throw Error('invalid JSON')},rewrite:async()=>{throw Error('must not run')}});
  assert.equal(result.briefing, ''); assert.equal(result.report.withheld, true);
});
test('repair checks coverage and caveats again, without deleting fragments', async () => {
  let checks = 0;
  const result = await validateRecap({text:'Drug caused deaths.',audit:async()=>++checks===1?['Missing story S2','Causation not established']:[],rewrite:async(_, issues)=>{
    assert.equal(issues.length,2); return 'Reports do not establish causation. Second story covered.';
  }});
  assert.equal(checks,2); assert.equal(result.report.passed,true);
  assert.match(result.briefing,/Second story/);
});
test('failed repair and failed recheck both withhold', async () => {
  for (const kind of ['repair','recheck','unresolved']) {
    let n = 0;
    const r = await validateRecap({text:'Original.',audit:async()=>{n++;if(n===2&&kind==='recheck')throw Error('offline');return ['Missing story S1']},rewrite:async()=>{if(kind==='repair')throw Error('offline');return 'Rewritten.'}});
    assert.equal(r.briefing,''); assert.equal(r.report.passed,false);
  }
});
test('word budget enforced after repair, short recaps not padded', async () => {
  let repairs=0;const r=await validateRecap({text:'word '.repeat(171),audit:async()=>[],rewrite:async()=>{repairs++;return 'word '.repeat(171)}});
  assert.equal(repairs,1);assert.equal(r.briefing,'');
  const short=await validateRecap({text:'One short story.',audit:async()=>[],rewrite:async()=>{throw Error('no')}});
  assert.equal(short.report.passed,true);
});

test('production orchestration clears recaps when source verification is unavailable', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const source = readFileSync(new URL('./backend-server.js', import.meta.url), 'utf8');
  const start = source.indexOf("  let briefing = '';", source.indexOf('async function generateAndStoreCategory'));
  const end = source.indexOf('\n  if (auditResult?.checked)',start);
  const block = source.slice(start,end);
  for (const input of [
    {gate:false,auditResult:null},
    {gate:true,auditResult:{checked:false}},
    {gate:true,auditResult:{checked:true,recheckError:'failed'}},
    {gate:true,auditResult:{checked:true,reserveCheck:{checked:false}}},
  ]) {
    const r = await runInNewContext(`(async()=>{${block};return {briefing,auditResult}})()`, {
      ...input, category:'Test', console,
      generateBriefing:()=>{throw Error('Should not generate from unverified source')},
    });
    assert.equal(r.briefing,''); assert.equal(r.auditResult.briefing.withheld,true);
  }
  const result = await runInNewContext(`(async()=>{${block};return {briefing,auditResult}})()`, {
    gate:true,auditResult:{checked:true},category:'Test',targetDay:'2026-10-14',timeSlot:'Morning',language:'en',digestContent:'Digest',console,
    generateBriefing:async()=> 'Candidate',groundBriefing:async()=>({briefing:'Verified.',report:{passed:true}}),
  });
  assert.equal(result.briefing,'Verified.');
});
