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

export function recapIssues(parsed, storyIds) {
  if (!Array.isArray(parsed.missingStories) || !Array.isArray(parsed.issues)) throw new Error('Invalid recap audit schema');
  if (parsed.missingStories.some(id => !storyIds.includes(id)) || parsed.issues.some(s => typeof s !== 'string' || !s.trim())) throw new Error('Invalid recap audit findings');
  return [...parsed.missingStories.map(id => `Missing story ${id}`), ...parsed.issues];
}

export const wordCount = text => String(text || '').trim().split(/\s+/).filter(Boolean).length;

// `rounds` is how many times the recap is checked; every check but the last may be followed by a
// rewrite. Two (check, rewrite, recheck) is the default; the category recap uses three, because a
// rewrite that fixes one problem often leaves another, and a withheld recap shows nothing at all.
export async function validateRecap({ text, maxWords = 170, rounds = 2, audit, rewrite }) {
  const report = { checked: false, flags: [], rewritten: false, removed: [], withheld: false };
  try {
    for (let attempt = 0; attempt < rounds; attempt++) {
      if (!text.trim()) throw new Error('Empty recap');
      const issues = await audit(text);
      if (wordCount(text) > maxWords) issues.push(`Exceeds ${maxWords} words (${wordCount(text)})`);
      report.checked = true;
      report.flags.push(...issues);
      if (!issues.length) return { briefing: text, report: { ...report, passed: true } };
      if (attempt < rounds - 1) { text = await rewrite(text, issues); report.rewritten = true; }
    }
    report.error = 'Recap still fails validation after repair';
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
