import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuditJSON, sentencesOf, provenStoryFindings, provenRecapIssues, parseRecapLines, validateRecap, attributionMap, deduplicateRecapLines } from './recap-validation.js';

test('identical recap lines merge their story IDs without changing any facts', () => {
  const lines = [{ ids: ['S1'], text: 'Apple says it will replace affected devices.' }, { ids: ['S3'], text: 'Apple says it will replace affected devices.' }];
  const result = deduplicateRecapLines(lines);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.lines, [{ ids: ['S1', 'S3'], text: lines[0].text }]);
  assert.deepEqual(lines[0].ids, ['S1']);
});
test('similar recaps with different qualifications or numbers remain separate', () => {
  const result = deduplicateRecapLines([{ ids: ['S1'], text: 'The launch is confirmed.' }, { ids: ['S2'], text: 'The launch is not confirmed.' },
    { ids: ['S3'], text: 'The price is $699.' }, { ids: ['S4'], text: 'The price is $799.' }]);
  assert.equal(result.lines.length, 4);
});
test('duplicate recap removal happens before the grounding audit and preserves counted coverage', async () => {
  const result = await validateRecap({ lines: [{ ids: ['S1'], text: 'One verified announcement.' }, { ids: ['S2'], text: 'One verified announcement.' }], storyIds: ['S1', 'S2'],
    audit: async texts => { assert.deepEqual(texts, ['One verified announcement.']); return { missing: [], issues: [], dismissed: [] }; }, repairLines: async () => { throw Error('No repair expected'); } });
  assert.equal(result.report.passed, true);
  assert.equal(result.report.duplicateLinesRemoved, 1);
  assert.deepEqual(result.lines[0].ids, ['S1', 'S2']);
});

test('parses fenced JSON and prose without greedily joining multiple objects', () => {
  assert.deepEqual(parseAuditJSON('```json\n{"unsupported":[]}\n```\nExplanation.'), { unsupported: [] });
  assert.deepEqual(parseAuditJSON('{"issues":["quote \\\" and brace }"],"missingStories":[]}').missingStories, []);
  assert.throws(() => parseAuditJSON('{"unsupported":[]}\n{"unsupported":[]}'));
  assert.throws(() => parseAuditJSON('{"unsupported":['));
});
test('invalid schemas and unknown IDs cannot silently pass', () => {
  const st = { statements: new Map([['B1', 'A claim.']]), sourceText: 'A claim.' };
  assert.throws(() => provenStoryFindings({}, st));
  assert.throws(() => provenStoryFindings({unsupported:[{id:'B2',statement:'x',reason:'x'}]}, st));
  assert.equal(provenStoryFindings({unsupported:[]}, st).found.size, 0);
  const ctx = { sentences: ['A claim.'], digestText: 'A claim.', storyIds: ['S1'] };
  assert.throws(() => provenRecapIssues({missingStories:['S9'],issues:[]}, ctx));
  assert.throws(() => provenRecapIssues({missingStories:[]}, ctx));
  assert.throws(() => provenRecapIssues({missingStories:'S1',issues:[]}, ctx));
  assert.equal(provenRecapIssues({issues:[]}, ctx).missing.length, 0);   // coverage may be counted by code instead
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
test('a recap written one tagged line per story parses into its stories', () => {
  const ids = ['S1', 'S2', 'S3'];
  const lines = parseRecapLines('[1] In the Gulf, one thing.\n[S2] Two things.\ncontinued on a new line\n[3, 1] Joined.', ids);
  assert.deepEqual(lines, [{ ids: ['S1'], text: 'In the Gulf, one thing.' }, { ids: ['S2'], text: 'Two things. continued on a new line' }, { ids: ['S3', 'S1'], text: 'Joined.' }]);
  assert.equal(parseRecapLines('Plain prose with no tags. Another sentence.', ids), null);
  assert.equal(parseRecapLines('[9] Unknown story.', ids), null);
});

// ── Check, then mend only what is wrong ───────────────────────────────────────
const clean = { missing: [], issues: [], dismissed: [] };
const flag = (s, extra = {}) => ({ missing: [], dismissed: [], issues: [{ s, type: 'wrong', recap: 'x', digest: 'y', why: 'z' }], ...extra });
const L = (...texts) => texts.map((text, i) => ({ ids: [`S${i + 1}`], text }));
const IDS = n => Array.from({ length: n }, (_, i) => `S${i + 1}`);

test('audit failure withholds recap rather than publishing unchecked', async () => {
  const result = await validateRecap({ lines: L('A claim.'), storyIds: IDS(1), audit: async () => { throw Error('invalid JSON'); }, repairLines: async () => { throw Error('must not run'); } });
  assert.equal(result.briefing, ''); assert.equal(result.report.withheld, true);
});
test('only the flagged line is rewritten, and the rest is untouched', async () => {
  let checks = 0;
  const r = await validateRecap({
    lines: L('Good one.', 'Bad one.', 'Good two.'), storyIds: IDS(3),
    audit: async () => (++checks === 1 ? flag(2) : clean),
    repairLines: async (lines, issues, missing) => {
      assert.deepEqual(issues.map(i => i.s), [2]); assert.deepEqual(missing, []);
      return lines.map((l, i) => (i === 1 ? { ...l, text: 'Fixed one.' } : l));
    },
  });
  assert.equal(r.report.passed, true); assert.equal(r.briefing, 'Good one. Fixed one. Good two.'); assert.equal(r.report.repairs, 1);
});
test('a missing story is counted from the lines, not taken from the check', async () => {
  let checks = 0;
  const r = await validateRecap({
    lines: L('Story one.'), storyIds: IDS(2),
    // The check claims S1 is missing (noise) and never mentions S2; the lines say S2 is the gap.
    audit: async () => (++checks, { ...clean, missing: ['S1'] }),
    repairLines: async (lines, issues, missing) => { assert.deepEqual(missing, ['S2']); return [...lines, { ids: ['S2'], text: 'Story two.' }]; },
  });
  assert.equal(r.briefing, 'Story one. Story two.'); assert.equal(checks, 2);
});
test('untagged prose falls back to the check for coverage', async () => {
  let checks = 0;
  const r = await validateRecap({
    lines: [{ ids: null, text: 'Story one.' }], storyIds: IDS(2),
    audit: async () => (++checks === 1 ? { ...clean, missing: ['S2'] } : clean),
    repairLines: async (lines, issues, missing) => { assert.deepEqual(missing, ['S2']); return [...lines, { ids: ['S2'], text: 'Story two.' }]; },
  });
  assert.equal(r.report.passed, true);
});
test('after three failed repairs only the still-flagged line comes out', async () => {
  let repairs = 0;
  const r = await validateRecap({ lines: L('Keep this.', 'Lose this.'), storyIds: IDS(2), audit: async () => flag(2), repairLines: async (l) => { repairs++; return l; } });
  assert.equal(repairs, 3); assert.equal(r.report.passed, true); assert.equal(r.briefing, 'Keep this.');
  assert.deepEqual(r.report.removed, ['Lose this.']);
});
test('a garbled repair costs a round, not the recap', async () => {
  const r = await validateRecap({ lines: L('Keep this.', 'Lose this.'), storyIds: IDS(2), audit: async () => flag(2), repairLines: async () => { throw Error('bad JSON'); } });
  assert.equal(r.report.repairFailures, 3); assert.equal(r.briefing, 'Keep this.');
});
test('withheld only when nothing survives', async () => {
  const r = await validateRecap({ lines: L('Only line.'), storyIds: IDS(1), audit: async () => flag(1), repairLines: async (l) => l });
  assert.equal(r.briefing, ''); assert.equal(r.report.withheld, true);
});
test('too long is mended by tightening the longest lines, not a whole rewrite', async () => {
  const long = 'This line is deliberately padded with many extra words to push the recap far past its limit today.';
  const r = await validateRecap({ lines: L(`First: ${long}`, `Second: ${long}`, `Third: ${long}`, 'Short one.'), storyIds: IDS(4), maxWords: 40, audit: async () => clean,
    repairLines: async (lines, issues) => {
      assert.ok(issues.length && issues.every(i => i.type === 'long'));
      const cut = new Set(issues.map(i => i.s));
      return lines.map((l, i) => (cut.has(i + 1) ? { ...l, text: 'Tight.' } : l));
    } });
  assert.equal(r.report.passed, true); assert.ok(r.briefing.split(/\s+/).length <= 40); assert.ok(r.report.repairs > 0);
  const stuck = await validateRecap({ lines: L(`First: ${long}`, `Second: ${long}`, `Third: ${long}`), storyIds: IDS(3), maxWords: 40, audit: async () => clean, repairLines: async l => l });
  assert.equal(stuck.briefing, '');
});
test('a recap that only shortens the source is not "wrong"', () => {
  const r = provenRecapIssues({ missingStories: [], issues: [
    { s: 1, type: 'wrong', recap: 'Three men were sentenced', digest: 'Three men were sentenced to 158 years', why: 'omits the term' },
  ] }, { sentences: ['Three men were sentenced in court.'], digestText: 'Three men were sentenced to 158 years and nine months.', storyIds: ['S1'] });
  assert.equal(r.issues.length, 0); assert.equal(r.dismissed.length, 1);
});

test('leaving words out of the middle is shortening; leaving out a qualifier is not', () => {
  const ctx = { sentences: ['A Mexican judge sentenced three men to 158 years and nine months each.', 'The court found him guilty.', 'Over 250 were arrested.'],
    digestText: 'A Mexican judge sentenced three men to 158 years and nine months in prison each. The court found him not guilty. With 32,800 participants and over 250 people arrested nationwide.', storyIds: ['S1'] };
  const r = provenRecapIssues({ issues: [
    { s: 1, type: 'wrong', recap: 'sentenced three men to 158 years and nine months each', digest: 'sentenced three men to 158 years and nine months in prison each', why: 'omits in prison' },
    { s: 2, type: 'wrong', recap: 'found him guilty', digest: 'found him not guilty', why: 'drops the negation' },
    { s: 3, type: 'wrong', recap: 'Over 250 were arrested', digest: 'over 250 people arrested nationwide', why: 'words differ' },
  ] }, ctx);
  assert.deepEqual(r.dismissed.map(d => d.s), [1]);
  assert.deepEqual(r.issues.map(i => i.s), [2, 3]);
});

// ── The story check must prove its findings too ───────────────────────────────
const SRC = 'Lawsuits were filed in Arizona, Arkansas, Idaho, Kansas, Montana, Nebraska and West Virginia. Bezos said that by 2045 robots will handle commutes. The court found him not guilty.';
const STATEMENTS = new Map([
  ['D1.B1', 'Lawsuits were filed in eight states.'],
  ['D1.B2', 'Bezos said that by 2045 robots will handle commutes.'],
  ['D1.B3', 'The court found him guilty.'],
  ['D1.B4', 'Lawsuits were filed in Arizona and Idaho.'],
]);
test('the story check keeps proven findings and dismisses the rest', () => {
  const r = provenStoryFindings({ unsupported: [
    { id: 'D1.B1', type: 'wrong', statement: 'eight states', source: 'Arizona, Arkansas, Idaho, Kansas, Montana, Nebraska and West Virginia', reason: 'seven, not eight' },
    { id: 'D1.B2', type: 'added', statement: 'by 2045 robots will handle commutes', source: '', reason: 'not stated as a prediction' },
    { id: 'D1.B3', type: 'qualifier', statement: 'found him guilty', source: 'found him not guilty', reason: 'drops the negation' },
    { id: 'D1.B4', type: 'wrong', statement: 'Arizona and Idaho', source: 'Arizona, Arkansas, Idaho', reason: 'leaves states out' },
    { id: 'D1.B1', type: 'wrong', statement: 'nine states', source: 'seven states', reason: 'misquoted both sides' },
  ] }, { statements: STATEMENTS, sourceText: SRC });
  assert.deepEqual([...r.found.keys()].sort(), ['D1.B1', 'D1.B3']);
  assert.equal(r.dismissed.length, 3);
  assert.match(r.found.get('D1.B1'), /source: "Arizona/);
});

test('daily recaps publish only from verified digests and clear withheld text', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const source = readFileSync(new URL('./backend-server.js', import.meta.url), 'utf8');
  const start = source.indexOf('  // An empty string also clears an older recap', source.indexOf('async function generateAndStoreCategory'));
  const end = source.indexOf('\n  if (auditResult?.checked)', start);
  const block = source.slice(start, end);
  for (const verified of [true, false]) {
    let called = 0;
    const result = await runInNewContext(`(async()=>{${block};return {briefing,briefingSources}})()`, {
      gate: true, auditResult: { checked: verified }, category: 'World News', targetDay: '2026-10-25', timeSlot: 'Morning', digestContent: 'verified facts', language: 'en', console,
      generateBriefing: async () => { called++; return 'Short daily recap.'; },
      groundBriefing: async () => ({ briefing: 'Checked recap.', report: {} }),
      attributeRecap: async () => ['source'],
    });
    assert.equal(called, verified ? 1 : 0);
    assert.equal(result.briefing, verified ? 'Checked recap.' : '');
    assert.equal(result.briefingSources?.[0] || null, verified ? 'source' : null);
  }
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
