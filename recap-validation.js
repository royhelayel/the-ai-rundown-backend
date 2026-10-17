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

export function unsupportedMap(parsed, validIds) {
  if (!Array.isArray(parsed.unsupported)) throw new Error('Missing unsupported array');
  const out = new Map();
  for (const u of parsed.unsupported) {
    if (!u || typeof u.id !== 'string' || !validIds.has(u.id) || typeof u.reason !== 'string' || !u.reason.trim()) throw new Error('Invalid audit finding');
    out.set(u.id, u.reason.slice(0, 500));
  }
  return out;
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
export function provenRecapIssues(parsed, { sentences, digestText, storyIds }) {
  if (!parsed || !Array.isArray(parsed.missingStories) || !Array.isArray(parsed.issues)) throw new Error('Invalid recap audit schema');
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
    } else if (it.type === 'added' && digest.includes(rq)) dismiss = 'the digest says it';
    const finding = { s: n, type: it.type, recap: String(it.recap || ''), digest: String(it.digest || ''), why: String(it.why || '').slice(0, 300) };
    if (dismiss) dismissed.push({ ...finding, dismissed: dismiss }); else issues.push(finding);
  }
  return { missing: [...new Set(parsed.missingStories)], issues, dismissed };
}
export const describeIssue = i => `S${i.s} ${i.type}: "${i.recap}"${i.digest ? ` vs source "${i.digest}"` : ''}${i.why ? ` — ${i.why}` : ''}`;

// Swap, drop or add whole sentences in place, so the recap's paragraphs survive a repair.
export function replaceSentences(text, sentences, replacements = new Map(), additions = []) {
  let out = text;
  for (const [n, next] of replacements) {
    const old = sentences[n - 1];
    if (old && out.includes(old)) out = out.replace(old, next);
  }
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return additions.length ? `${out} ${additions.join(' ')}`.trim() : out;
}

// Check, then mend only what is wrong, up to `repairs` times: each repair rewrites just the
// sentences the check flagged (and adds a sentence for a story left out), so fixing one sentence
// cannot break another the way rewriting the whole recap did. A sentence still flagged after the
// last repair is taken out; the recap is withheld only if nothing survives, or the check itself
// cannot run. `rewrite` (the whole recap) is kept for the one thing a sentence cannot fix: length.
export async function validateRecap({ text, maxWords = 170, repairs = 3, audit, repairSentences, rewrite }) {
  const report = { checked: false, flags: [], dismissed: [], repairs: 0, repairFailures: 0, rewritten: false, removed: [], withheld: false };
  try {
    for (let round = 0; ; round++) {
      if (!text.trim()) throw new Error('Empty recap');
      const { missing, issues, dismissed } = await audit(text);
      const over = wordCount(text) > maxWords;
      report.checked = true;
      report.dismissed.push(...dismissed.map(d => `${describeIssue(d)} [dismissed: ${d.dismissed}]`));
      report.flags.push(...missing.map(id => `Missing story ${id}`), ...issues.map(describeIssue),
        ...(over ? [`Exceeds ${maxWords} words (${wordCount(text)})`] : []));
      if (!missing.length && !issues.length && !over) return { briefing: text, report: { ...report, passed: true } };
      if (round < repairs) {
        try {
          if (over) { text = await rewrite(text, [...missing.map(id => `Missing story ${id}`), ...issues.map(describeIssue), `Exceeds ${maxWords} words`]); report.rewritten = true; }
          else { text = await repairSentences(text, issues, missing); report.repairs++; }
        } catch { report.repairFailures++; }       // a garbled repair costs a round, not the recap
        continue;
      }
      // Out of repairs: take out the sentences still flagged. A story still missing stays missing —
      // a recap that leaves one out is still accurate about the rest.
      const sents = sentencesOf(text);
      const flagged = new Set(issues.map(i => i.s));
      report.removed = sents.filter((_, i) => flagged.has(i + 1));
      text = replaceSentences(text, sents, new Map([...flagged].map(n => [n, ''])));
      if (!text.trim()) throw new Error('Nothing in the recap survived its check');
      if (wordCount(text) > maxWords) throw new Error(`Still exceeds ${maxWords} words after repair`);
      return { briefing: text, report: { ...report, passed: true, trimmed: report.removed.length > 0 } };
    }
  } catch (e) { report.error = e.message; }
  return { briefing: '', report: { ...report, passed: false, withheld: true } };
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
