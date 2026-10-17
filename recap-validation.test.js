import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuditJSON, sentencesOf, unsupportedMap, provenRecapIssues, replaceSentences, validateRecap, attributionMap } from './recap-validation.js';

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
  const ctx = { sentences: ['A claim.'], digestText: 'A claim.', storyIds: ['S1'] };
  assert.throws(() => provenRecapIssues({missingStories:['S9'],issues:[]}, ctx));
  assert.throws(() => provenRecapIssues({missingStories:[]}, ctx));
  assert.throws(() => provenRecapIssues({missingStories:[],issues:['a bare string']}, ctx));
});
test('US PhD regression keeps the complete claim intact', () => {
  const text = 'Applications for U.S. Ph.D. programs dropped 21 percent. Another story follows.';
  assert.deepEqual(sentencesOf(text), ['Applications for U.S. Ph.D. programs dropped 21 percent.', 'Another story follows.']);
  assert.deepEqual(sentencesOf('Dr. Smith reports 3.5 percent. Next finding.'), ['Dr. Smith reports 3.5 percent.', 'Next finding.']);
  assert.deepEqual(sentencesOf('هذا خبر. هذا آخر؟ نعم.'), ['هذا خبر.', 'هذا آخر؟', 'نعم.']);
});
// ── The check must prove its findings ─────────────────────────────────────────
const DIGEST = '[S1] Jobs report\n- Unemployment fell 41.8 percent, officials said.\n[S2] Court ruling\n- Three men were sentenced to 158 years and nine months in prison each.\n[S3] Cases rise\n- Cases rose to 120 from 86 the week before.';
const RECAP = ['Unemployment fell 42 percent.', 'Three men were jailed for 158 years and nine months each.', 'Cases rose to 120 from 86 the week before.'];
const prove = (issues, missingStories = []) => provenRecapIssues({ missingStories, issues }, { sentences: RECAP, digestText: DIGEST, storyIds: ['S1', 'S2', 'S3'] });

test('a real wrong number, quoted on both sides, is kept', () => {
  const r = prove([{ s: 1, type: 'wrong', recap: '42 percent', digest: '41.8 percent', why: 'rounded' }]);
  assert.equal(r.issues.length, 1); assert.equal(r.dismissed.length, 0);
});
test('findings that cannot show conflicting words are dismissed, not acted on', () => {
  const r = prove([
    { s: 3, type: 'wrong', recap: 'the week before', digest: 'the week before', why: 'not necessarily the previous week' },  // same words
    { s: 2, type: 'wrong', recap: '158 years', digest: '158 years and nine months', why: 'shortened' },                     // recap already says it
    { s: 1, type: 'wrong', recap: '42 percent', digest: '40 percent', why: 'invented quote' },                               // not in the digest
    { s: 1, type: 'qualifier', recap: 'fell 42', digest: '', why: 'no evidence' },                                           // no source words
    { s: 2, type: 'wrong', recap: 'sentenced to death', digest: '158 years', why: 'misquoted recap' },                       // not in that sentence
    { s: 3, type: 'added', recap: 'Cases rose to 120', digest: '', why: 'claims the digest lacks it' },                      // the digest says it
    { s: 9, type: 'broken', recap: 'x', digest: '', why: 'no such sentence' },
    { s: 1, type: 'opinion', recap: '42 percent', digest: '', why: 'unknown type' },
  ]);
  assert.equal(r.issues.length, 0); assert.equal(r.dismissed.length, 8);
});
test('a lost qualifier with the source words that carry it is kept', () => {
  const r = prove([{ s: 1, type: 'qualifier', recap: 'Unemployment fell 42 percent', digest: 'officials said', why: 'attribution dropped' }]);
  assert.equal(r.issues.length, 1);
});
test('replacing sentences keeps paragraphs and drops cleanly', () => {
  const text = 'First one. Second one.\n\nThird one.';
  const sents = sentencesOf(text);
  assert.equal(replaceSentences(text, sents, new Map([[2, 'Second, fixed.']])), 'First one. Second, fixed.\n\nThird one.');
  assert.equal(replaceSentences(text, sents, new Map([[2, '']])), 'First one.\n\nThird one.');
  assert.equal(replaceSentences(text, sents, new Map(), ['Added one.']), 'First one. Second one.\n\nThird one. Added one.');
});

// ── Check, then mend only what is wrong ───────────────────────────────────────
const clean = { missing: [], issues: [], dismissed: [] };
const flag = (s, extra = {}) => ({ missing: [], dismissed: [], issues: [{ s, type: 'wrong', recap: 'x', digest: 'y', why: 'z' }], ...extra });

test('audit failure withholds recap rather than publishing unchecked', async () => {
  const result = await validateRecap({ text: 'A claim.', audit: async () => { throw Error('invalid JSON'); }, repairSentences: async () => { throw Error('must not run'); } });
  assert.equal(result.briefing, ''); assert.equal(result.report.withheld, true);
});
test('only the flagged sentence is rewritten, and the rest is untouched', async () => {
  let checks = 0;
  const r = await validateRecap({
    text: 'Good one. Bad one. Good two.',
    audit: async () => (++checks === 1 ? flag(2) : clean),
    repairSentences: async (text, issues, missing) => {
      assert.deepEqual(issues.map(i => i.s), [2]); assert.deepEqual(missing, []);
      return replaceSentences(text, sentencesOf(text), new Map([[2, 'Fixed one.']]));
    },
  });
  assert.equal(r.report.passed, true); assert.equal(r.briefing, 'Good one. Fixed one. Good two.'); assert.equal(r.report.repairs, 1);
});
test('a story left out gets a sentence of its own', async () => {
  let checks = 0;
  const r = await validateRecap({
    text: 'Story one.',
    audit: async () => (++checks === 1 ? { ...clean, missing: ['S2'] } : clean),
    repairSentences: async (text, issues, missing) => { assert.deepEqual(missing, ['S2']); return replaceSentences(text, sentencesOf(text), new Map(), ['Story two.']); },
  });
  assert.equal(r.briefing, 'Story one. Story two.');
});
test('after three failed repairs only the still-flagged sentence comes out', async () => {
  let repairs = 0;
  const r = await validateRecap({ text: 'Keep this. Lose this.', audit: async () => flag(2), repairSentences: async (t) => { repairs++; return t; } });
  assert.equal(repairs, 3); assert.equal(r.report.passed, true); assert.equal(r.briefing, 'Keep this.');
  assert.deepEqual(r.report.removed, ['Lose this.']);
});
test('a garbled repair costs a round, not the recap', async () => {
  const r = await validateRecap({ text: 'Keep this. Lose this.', audit: async () => flag(2), repairSentences: async () => { throw Error('bad JSON'); } });
  assert.equal(r.report.repairFailures, 3); assert.equal(r.briefing, 'Keep this.');
});
test('withheld only when nothing survives', async () => {
  const r = await validateRecap({ text: 'Only sentence.', audit: async () => flag(1), repairSentences: async (t) => t });
  assert.equal(r.briefing, ''); assert.equal(r.report.withheld, true);
});
test('too long is mended by tightening the longest sentences, not a whole rewrite', async () => {
  const long = 'This sentence is deliberately padded with many extra words to push the recap far past its limit today. ';
  const text = long.repeat(3) + 'Short one.';
  const r = await validateRecap({ text, maxWords: 40, audit: async () => clean, repairSentences: async (t, issues) => {
    assert.ok(issues.length && issues.every(i => i.type === 'long'));
    const sents = sentencesOf(t);
    return replaceSentences(t, sents, new Map(issues.map(i => [i.s, 'Tight.'])));
  } });
  assert.equal(r.report.passed, true); assert.ok(r.briefing.split(/\s+/).length <= 40);
  const stuck = await validateRecap({ text, maxWords: 40, audit: async () => clean, repairSentences: async t => t });
  assert.equal(stuck.briefing, '');
  const short = await validateRecap({ text: 'One short story.', audit: async () => clean, repairSentences: async () => { throw Error('no'); } });
  assert.equal(short.report.passed, true);
});
test('a recap that only shortens the source is not "wrong"', () => {
  const r = provenRecapIssues({ missingStories: [], issues: [
    { s: 1, type: 'wrong', recap: 'Three men were sentenced', digest: 'Three men were sentenced to 158 years', why: 'omits the term' },
  ] }, { sentences: ['Three men were sentenced in court.'], digestText: 'Three men were sentenced to 158 years and nine months.', storyIds: ['S1'] });
  assert.equal(r.issues.length, 0); assert.equal(r.dismissed.length, 1);
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

test('attributionMap accepts a complete answer and keeps empty transitions', () => {
  const m = attributionMap({ sentences: [{ n: 1, stories: ['S1'] }, { n: 2, stories: [] }, { n: 3, stories: ['S2', 'S3', 'S2'] }] }, 3, ['S1', 'S2', 'S3']);
  assert.deepEqual(m, [['S1'], [], ['S2', 'S3']]);
});

test('attributionMap rejects unknown ids, gaps and repeats', () => {
  assert.throws(() => attributionMap({ sentences: [{ n: 1, stories: ['S9'] }] }, 1, ['S1']));
  assert.throws(() => attributionMap({ sentences: [{ n: 1, stories: ['S1'] }] }, 2, ['S1']));
  assert.throws(() => attributionMap({ sentences: [{ n: 1, stories: [] }, { n: 1, stories: [] }] }, 2, ['S1']));
  assert.throws(() => attributionMap({}, 1, ['S1']));
});
