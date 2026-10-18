// A story's Coverage may only link to its own articles.
//
// stripInventedLinks already keeps the writer to links we handed over, but it accepts any link
// handed over for the category. On 17 Oct two Qatar stories with no link of their own — "Qatar
// selected as co-chair of Arab Competition Network's M&A working group" and "MOI announces towing
// schedule" — were credited to The Peninsula with a link to a Gulf Times article about Moldova's
// prime minister, which was another story's (Roy, 2026-10-18). This checks each written story
// against the story blocks the writer was given: a link is kept only when it belongs to the
// block the story was written from, or to one the story plainly also covers.

const STOP = new Set(('the and for with from that this into over after before about amid says said will '
  + 'have has its their are was were been new more than also but not who what when where how why '
  + 'his her they them she him our out off one two all any can could would should may might just '
  + 'year years day days week weeks').split(' '));

export function wordsOf(s) {
  const t = String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return (t.match(/[a-z0-9؀-ۿ]+/g) || []).filter(w => (w.length > 2 || /\d/.test(w)) && !STOP.has(w));
}

// The blocks buildStoryBlocks writes: "[3 OUTLETS] [5] Title\nDate: …", then each outlet as
// "  — Source (url)" (its text, if any, on the following lines), or "Carried by N outlet(s): A, B"
// when nothing could be read.
const BLOCK_START = /^(?:\[\d+ OUTLETS[^\]\n]*\] )?\[(\d+)\] (.+)\nDate: /gm;
const OUTLET_LINE = /^\s+— (.+?) \((https?:\/\/[^)\s]+)\)\s*$/gm;
const OUTLET_NAME = /^\s+— (.+?)(?: \(https?:\/\/[^)\s]+\))?\s*$/gm;

export function parseStoryBlocks(context) {
  const text = String(context || '');
  const starts = [...text.matchAll(BLOCK_START)];
  return starts.map((m, i) => {
    const body = text.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : text.length);
    const links = [...body.matchAll(OUTLET_LINE)].map(x => ({ source: x[1].trim(), url: x[2] }));
    const carried = (body.match(/^Carried by \d+ outlet\(s\): (.+)$/m) || [])[1];
    const outlets = [...new Set([
      ...[...body.matchAll(OUTLET_NAME)].map(x => x[1].trim()),
      ...(carried ? carried.split(/,\s*/).map(s => s.trim()) : []),
    ].filter(Boolean))];
    return { n: Number(m[1]), title: m[2].trim(), links, outlets, words: new Set(wordsOf(body)) };
  });
}

const COVERAGE = /^\s*\*\*(Coverage|التغطية|المصادر):\*\*/;

// Splits a digest into its stories (## headline … up to the next ## or the Sources list).
function storiesOf(digest) {
  const lines = String(digest || '').split('\n');
  const out = [];
  let cur = null;
  lines.forEach((line, i) => {
    if (/^##\s/.test(line)) {
      if (/^##\s+\[?(Sources|المصادر)/i.test(line)) { cur = null; return; }
      cur = { start: i, headline: line.replace(/^##\s+/, ''), lines: [] };
      out.push(cur);
    } else if (cur) cur.lines.push(i);
  });
  return out;
}

// Which block a story was written from: the one sharing the most distinctive words with it.
// A word in every block ("Qatar" in the Qatar feed) counts for little; a name only one block
// carries counts for a lot.
function scoreBlocks(storyWords, blocks) {
  const n = blocks.length;
  const df = new Map();
  for (const b of blocks) for (const w of b.words) df.set(w, (df.get(w) || 0) + 1);
  const idf = w => Math.log(1 + n / (df.get(w) || n));
  return blocks.map(b => { let s = 0; for (const w of storyWords) if (b.words.has(w)) s += idf(w); return s; });
}

// Keeps a story's Coverage links only when they belong to it. A link from another block survives
// when that block scores at least 0.3 of the best one — on 17–18 Oct
// every wrong link scored 0.17 or less and every second account of the same event 0.48 or more (the writer may have combined two
// accounts of one event). When nothing survives, the outlets are named without a link rather
// than linked to the wrong article. Anything it cannot place is left alone.
export function confineCoverageLinks(digest, context, { share = 0.3 } = {}) {
  const blocks = parseStoryBlocks(context);
  if (!digest || blocks.length < 2) return { content: digest, dropped: [] };
  const owner = new Map();
  blocks.forEach((b, i) => b.links.forEach(l => { if (!owner.has(l.url)) owner.set(l.url, i); }));
  const lines = String(digest).split('\n');
  const dropped = [];
  for (const st of storiesOf(digest)) {
    const covIdx = st.lines.find(i => COVERAGE.test(lines[i]));
    if (covIdx === undefined) continue;
    const textWords = new Set(wordsOf([st.headline, ...st.lines.filter(i => i !== covIdx).map(i => lines[i])].join(' ')));
    const scores = scoreBlocks(textWords, blocks);
    const best = scores.indexOf(Math.max(...scores));
    if (!(scores[best] > 0)) continue;
    const line = lines[covIdx];
    const head = line.slice(0, line.indexOf(':**') + 3);
    const links = [...line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map(m => ({ outlet: m[1], url: m[2] }));
    if (!links.length) continue;
    const kept = [], lost = [];
    for (const l of links) {
      const o = owner.get(l.url);
      if (o === undefined || o === best || scores[o] >= share * scores[best]) { kept.push(l); continue; }
      // The outlet may be right and only the link wrong: use that outlet's own link to this story.
      const own = blocks[best].links.find(x => x.source === l.outlet);
      if (own && !links.some(x => x.url === own.url)) kept.push({ outlet: l.outlet, url: own.url });
      else lost.push(l);
      dropped.push({ headline: st.headline, outlet: l.outlet, url: l.url, from: blocks[o].title, to: own ? own.url : null });
    }
    if (!lost.length) { lines[covIdx] = `${head} ${kept.map(l => `[${l.outlet}](${l.url})`).join(' · ')}`; continue; }
    if (kept.length) { lines[covIdx] = `${head} ${kept.map(l => `[${l.outlet}](${l.url})`).join(' · ')}`; continue; }
    const names = [...new Set(lost.map(l => l.outlet).filter(o => blocks[best].outlets.includes(o)))];
    const named = names.length ? names : blocks[best].outlets.slice(0, 3);
    lines[covIdx] = named.length ? `${head} ${named.join(' · ')}` : null;
  }
  return { content: lines.filter(l => l !== null).join('\n'), dropped };
}

