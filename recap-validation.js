// Model output is data: accept one complete JSON object, never partial/truncated JSON.
export function parseAuditJSON(raw) {
  const objects = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (start < 0) { if (ch === '{') { start = i; depth = 1; } continue; }
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      objects.push(JSON.parse(raw.slice(start, i + 1))); start = -1;
    }
  }
  if (start >= 0 || objects.length !== 1) throw new Error('Audit must return exactly one complete JSON object');
  return objects[0];
}

export function sentencesOf(text) {
  // Protect abbreviations even before capitals ("U.S. Ph.D. programs"). Keeping
  // two sentences together is safer than deleting half a sentence during repair.
  const marks = [];
  const protectedText = (text || '').trim().replace(/\b(?:[A-Za-z]\.){2,}|\b(?:Ph\.D|M\.D|Dr|Mr|Mrs|Ms|Prof|Sen|Rep|St|No|vs|etc)\./g, value => {
    marks.push(value); return `\uE000${marks.length - 1}\uE001`;
  });
  return protectedText.split(/(?<=[.!?؟]["'”’)\]]*)\s+(?=["'“‘(\[]?[A-Z؀-ۿ])/)
    .map(s => s.replace(/\uE000(\d+)\uE001/g, (_, i) => marks[Number(i)]).trim()).filter(Boolean);
}


export const wordCount = text => String(text || '').trim().split(/\s+/).filter(Boolean).length;

// For "is this quote really there": case, punctuation, quote marks and spacing do not count.
export const normQuote = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// The recap check must prove each problem with the words involved (Roy, 2026-10-18). A finding is
// kept only when its recap words really are in the sentence it names and, for a wrong fact or a
// lost qualifier, its source words really are in the digest and say something the recap does
// not. A finding that cannot show conflicting words — "the week before" flagged against "the week
// before" — is dismissed, not acted on. Missing stories need no quote: the ID is the evidence.
export const ISSUE_TYPES = ['wrong', 'qualifier', 'added', 'broken'];

// Words whose absence changes what a sentence claims. Leaving any of these out is never "only
// shortening": "not guilty" is not "guilty", "proposed" is not done.
const MEANING_WORDS = new Set(['not', 'no', 'never', 'nor', 'without', 'denied', 'denies', 'deny', 'alleged', 'allegedly',
  'reportedly', 'reported', 'purported', 'purportedly', 'suspected', 'proposed', 'planned', 'plans', 'may', 'might', 'could',
  'would', 'unconfirmed', 'according', 'says', 'said', 'claims', 'claimed', 'estimated', 'about', 'nearly', 'almost', 'over',
  'under', 'up', 'least', 'most', 'only', 'if', 'unless', 'expected', 'likely', 'possible', 'possibly', 'former', 'acting']);

// The recap's words all appear, in order, in the source's words, and nothing left out changes the
// meaning: the recap only shortened the source. "158 years and nine months each" against "158
// years and nine months in prison each" is that; "guilty" against "not guilty" is not.
// Small joining words a shortened list or phrase adds ("Arizona and Idaho" from "Arizona,
// Arkansas, Idaho") — they carry no claim of their own.
const JOINERS = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'with', 'for', 'as', 'its', 'their']);

export function onlyShortens(rq, dq) {
  const d = dq.split(' ');
  const r = rq.split(' ').filter(w => !JOINERS.has(w) || d.includes(w));
  const dropped = [];
  let i = 0;
  for (const w of d) { if (i < r.length && w === r[i]) i++; else dropped.push(w); }
  return i === r.length && dropped.length > 0 && !dropped.some(w => MEANING_WORDS.has(w));
}
export function provenRecapIssues(parsed, { sentences, digestText, storyIds }) {
  if (!parsed || !Array.isArray(parsed.issues)) throw new Error('Invalid recap audit schema');
  if (parsed.missingStories !== undefined && !Array.isArray(parsed.missingStories)) throw new Error('Invalid recap audit schema');
  parsed = { ...parsed, missingStories: parsed.missingStories || [] };
  if (parsed.missingStories.some(id => !storyIds.includes(id))) throw new Error('Invalid recap audit findings');
  const digest = normQuote(digestText);
  const issues = [], dismissed = [];
  for (const it of parsed.issues) {
    if (!it || typeof it !== 'object') throw new Error('Invalid recap audit findings');
    const n = it.s, rq = normQuote(it.recap), dq = normQuote(it.digest);
    const sentence = Number.isInteger(n) && n >= 1 && n <= sentences.length ? normQuote(sentences[n - 1]) : null;
    let dismiss = null;
    if (!ISSUE_TYPES.includes(it.type)) dismiss = 'unknown type';
    else if (!sentence) dismiss = 'no such sentence';
    else if (!rq || !sentence.includes(rq)) dismiss = 'its recap words are not in that sentence';
    else if (it.type === 'wrong' || it.type === 'qualifier') {
      if (!dq || !digest.includes(dq)) dismiss = 'its source words are not in the digest';
      else if (rq === dq || sentence.includes(dq)) dismiss = 'the recap already says what the source says';
      // "over 250 people arrested" against "over 250 people arrested nationwide": the recap only
      // shortened the source, and leaving things out is a recap's job. A lost qualifier is
      // different — "killed" against "allegedly killed" — so this applies to wrong facts only.
      else if (it.type === 'wrong' && (dq.includes(rq) || onlyShortens(rq, dq))) dismiss = 'the recap shortens the source, it does not contradict it';
    } else if (it.type === 'added' && digest.includes(rq)) dismiss = 'the digest says it';
    const finding = { s: n, type: it.type, recap: String(it.recap || ''), digest: String(it.digest || ''), why: String(it.why || '').slice(0, 300) };
    if (dismiss) dismissed.push({ ...finding, dismissed: dismiss }); else issues.push(finding);
  }
  return { missing: [...new Set(parsed.missingStories)], issues, dismissed };
}
// The same proof for the story check (Roy, 2026-10-18). Each finding names a statement by id and
// quotes the words in it that are wrong, and — for a wrong fact or a lost qualifier — the words in
// the outlets' text it contradicts or drops. Code confirms both quotes are really there; a finding
// that cannot show them, or where the source says the same thing, or where the statement only
// left words out, is dismissed. On Oct 17 the unproven check flagged 115 statements, rewrote 87
// stories and dropped 12, some over "by 2045" while granting the source said it.
export function provenStoryFindings(parsed, { statements, sourceText }) {
  if (!parsed || !Array.isArray(parsed.unsupported)) throw new Error('Missing unsupported array');
  const source = normQuote(sourceText);
  const found = new Map(), dismissed = [];
  for (const u of parsed.unsupported) {
    if (!u || typeof u.id !== 'string' || !statements.has(u.id)) throw new Error('Invalid audit finding');
    const type = ISSUE_TYPES.includes(u.type) ? u.type : 'added';
    const said = normQuote(statements.get(u.id)), sq = normQuote(u.statement), oq = normQuote(u.source);
    let dismiss = null;
    if (!sq || !said.includes(sq)) dismiss = 'its statement words are not in that statement';
    else if (type === 'wrong' || type === 'qualifier') {
      if (!oq || !source.includes(oq)) dismiss = 'its source words are not in the source';
      else if (sq === oq || said.includes(oq)) dismiss = 'the statement already says what the source says';
      else if (type === 'wrong' && (oq.includes(sq) || onlyShortens(sq, oq))) dismiss = 'the statement shortens the source, it does not contradict it';
    } else if (type === 'added' && source.includes(sq)) dismiss = 'the source says it';
    const reason = `${String(u.reason || '').slice(0, 400)}${u.statement ? ` [statement: "${u.statement}"${u.source ? `; source: "${u.source}"` : ''}]` : ''}`;
    if (dismiss) dismissed.push({ id: u.id, type, reason, dismissed: dismiss });
    else found.set(u.id, reason.slice(0, 600));
  }
  return { found, dismissed };
}

export const describeIssue = i => (i.type === 'long'
  ? `S${i.s} too long — ${i.why}`
  : `S${i.s} ${i.type}: "${i.recap}"${i.digest ? ` vs source "${i.digest}"` : ''}${i.why ? ` — ${i.why}` : ''}`);

// The recap is written as one line per story, each starting with its story number — "[3] In the
// Middle East, …" (Roy, 2026-10-18). Coverage and length are then counted rather than judged: a
// World recap written as prose ran to 636 words for twelve stories, and the check's "missing
// story" findings moved from round to round. Returns null when the text is not written that way.
export function parseRecapLines(text, storyIds) {
  const raw = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const lines = [];
  for (const l of raw) {
    const m = l.match(/^\[\s*S?(\d+(?:\s*[,&]\s*S?\d+)*)\s*\]\s*(.+)$/i);
    if (!m) { if (lines.length) lines[lines.length - 1].text += ` ${l}`; continue; }
    const ids = [...new Set(m[1].split(/[,&]/).map(n => `S${parseInt(n.replace(/\D/g, ''), 10)}`))].filter(id => storyIds.includes(id));
    if (ids.length) lines.push({ ids, text: m[2].trim() });
  }
  return lines.length && lines.length >= Math.ceil(raw.length / 2) ? lines : null;
}

// Too long is mended like everything else: by tightening the longest lines until the recap fits,
// never by rewriting it whole — a whole rewrite of a 471-word World recap came back at 513, then
// 612, dropping stories each time (2026-10-18).
export function linesToTighten(lines, maxWords) {
  const counted = lines.map((l, i) => ({ s: i + 1, w: wordCount(l.text) }));
  const target = Math.max(10, Math.floor((maxWords - 10) / Math.max(1, counted.length)));
  let excess = counted.reduce((n, x) => n + x.w, 0) - maxWords + 10;
  const picks = [];
  for (const { s, w } of [...counted].sort((x, y) => y.w - x.w)) {
    if (excess <= 0 || w <= target) break;
    picks.push({ s, type: 'long', recap: '', digest: '', why: `cut it to at most ${target} words, keeping its one key point and copying its figures exactly` });
    excess -= w - target;
  }
  return picks;
}

export const recapText = lines => lines.map(l => l.text).join(' ');

// Remove only literally repeated recap lines; similar wording can contain an important
// new fact or qualification. Preserve all story IDs so coverage and attribution stay
// correct when two digest entries produced the same sentence.
export function deduplicateRecapLines(lines) {
  const kept = [], seen = new Map();
  let removed = 0;
  for (const line of lines) {
    const key = String(line.text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!key) continue;
    const previous = seen.get(key);
    if (previous) {
      previous.ids = previous.ids && line.ids ? [...new Set([...previous.ids, ...line.ids])] : null;
      removed++;
    } else {
      const copy = { ...line, ids: line.ids ? [...line.ids] : line.ids };
      kept.push(copy); seen.set(key, copy);
    }
  }
  return { lines: kept, removed };
}

// Check, then mend only what is wrong, up to `repairs` times: each repair rewrites just the lines
// the check flagged, tightens the longest ones when the recap is over length, and adds a line for
// a story left out — so fixing one line cannot break another the way rewriting the whole recap
// did. When every line carries its story, a missing story is counted, not taken from the check.
// A line still flagged after the last repair is taken out; the recap is withheld only if nothing
// survives, it is still too long, or the check itself cannot run.
export async function validateRecap({ lines, storyIds = [], maxWords = 170, repairs = 3, audit, repairLines }) {
  const report = { checked: false, flags: [], dismissed: [], repairs: 0, repairFailures: 0, removed: [], withheld: false, duplicateLinesRemoved: 0 };
  const tagged = lines.length > 0 && lines.every(l => l.ids && l.ids.length);
  try {
    for (let round = 0; ; round++) {
      const unique = deduplicateRecapLines(lines);
      lines = unique.lines;
      report.duplicateLinesRemoved += unique.removed;
      if (!lines.length || !recapText(lines).trim()) throw new Error('Empty recap');
      const { missing: claimed, issues, dismissed } = await audit(lines.map(l => l.text));
      const covered = new Set(lines.flatMap(l => l.ids || []));
      const missing = tagged ? storyIds.filter(id => !covered.has(id)) : claimed;
      const words = wordCount(recapText(lines));
      const over = words > maxWords;
      report.checked = true;
      report.dismissed.push(...dismissed.map(d => `${describeIssue(d)} [dismissed: ${d.dismissed}]`));
      report.flags.push(...missing.map(id => `Missing story ${id}`), ...issues.map(describeIssue),
        ...(over ? [`Exceeds ${maxWords} words (${words})`] : []));
      if (!missing.length && !issues.length && !over) return { briefing: recapText(lines), lines, report: { ...report, passed: true } };
      if (round < repairs) {
        const tighten = over ? linesToTighten(lines, maxWords).filter(t => !issues.some(i => i.s === t.s)) : [];
        try { lines = await repairLines(lines, [...issues, ...tighten], missing); report.repairs++; }
        catch { report.repairFailures++; }       // a garbled repair costs a round, not the recap
        continue;
      }
      // Out of repairs: take out the lines still flagged. A story still missing stays missing — a
      // recap that leaves one out is still accurate about the rest.
      const flagged = new Set(issues.map(i => i.s));
      report.removed = lines.filter((_, i) => flagged.has(i + 1)).map(l => l.text);
      lines = lines.filter((_, i) => !flagged.has(i + 1));
      if (!lines.length) throw new Error('Nothing in the recap survived its check');
      if (wordCount(recapText(lines)) > maxWords) throw new Error(`Still exceeds ${maxWords} words after repair`);
      return { briefing: recapText(lines), lines, report: { ...report, passed: true, trimmed: report.removed.length > 0 } };
    }
  } catch (e) { report.error = e.message; }
  return { briefing: '', lines: [], report: { ...report, passed: false, withheld: true } };
}

// Which digest stories each recap sentence draws on, as returned by the attribution check:
// {"sentences":[{"n":1,"stories":["S1"]}, …]}. Every sentence must be answered, every ID must be a
// real story, and a sentence may name none (a transition carries no facts). Anything else throws,
// and the recap is published without attributions rather than with guessed ones.
export function attributionMap(parsed, sentenceCount, storyIds) {
  if (!parsed || !Array.isArray(parsed.sentences)) throw new Error('Missing sentences array');
  const valid = new Set(storyIds);
  const out = Array.from({ length: sentenceCount }, () => null);
  for (const s of parsed.sentences) {
    const n = s?.n;
    if (!Number.isInteger(n) || n < 1 || n > sentenceCount || out[n - 1]) throw new Error('Invalid or repeated sentence number');
    if (!Array.isArray(s.stories) || s.stories.some(id => typeof id !== 'string' || !valid.has(id))) throw new Error('Invalid story id');
    out[n - 1] = [...new Set(s.stories)];
  }
  if (out.some(x => x === null)) throw new Error('A sentence was not attributed');
  return out;
}
