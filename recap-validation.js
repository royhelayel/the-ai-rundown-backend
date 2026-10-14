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

export async function validateRecap({ text, maxWords = 170, audit, rewrite }) {
  const report = { checked: false, flags: [], rewritten: false, removed: [], withheld: false };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!text.trim()) throw new Error('Empty recap');
      const issues = await audit(text);
      if (wordCount(text) > maxWords) issues.push(`Exceeds ${maxWords} words (${wordCount(text)})`);
      report.checked = true;
      report.flags.push(...issues);
      if (!issues.length) return { briefing: text, report: { ...report, passed: true } };
      if (!attempt) { text = await rewrite(text, issues); report.rewritten = true; }
    }
    report.error = 'Recap still fails validation after repair';
  } catch (e) { report.error = e.message; }
  return { briefing: '', report: { ...report, passed: false, withheld: true } };
}
