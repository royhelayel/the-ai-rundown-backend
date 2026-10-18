// Which articles are the same story. Kept apart from the server so the rule can be tested on
// real headlines (story-grouping.test.js).

export const STOPISH = new Set(['the','and','for','with','from','that','this','have','been','will','after','over','into','their','says','said','amid','more','than','what','when','about','which','were','they','could','would']);
// Arabic kept, and given its own stop list: without one, "من" "في" "على" behave like
// English "the" and match everything. Measured before the fix — 505 Arabic KSA articles
// produced 505 stories, because every Arabic title tokenised to an empty set.
const AR_STOP = new Set(['من','في','على','إلى','عن','مع','أن','إنّ','إن','التي','الذي','هذا','هذه','كان','قال','بعد','بين','خلال','الى','ما','لا','هو','هي','كما','عند','لدى','ضد','أو','او','كل','بعض','حول','منذ','حتى','قبل']);
export const sigTokens = (t) => (t || '').toLowerCase()
  .replace(/[^a-z0-9\u0600-\u06FF\s]/g, ' ')
  .split(/\s+/)
  .filter(w => w.length > 3 && !STOPISH.has(w) && !AR_STOP.has(w));

// An article joins a story when it shares three significant words with one article already in
// it — and those three are a fair part of the shorter headline. It used to be compared with every
// word the story had gathered so far, so a big story kept growing a vocabulary that anything
// could match: WAM's piece on Dubai World Trade Centre's events economy ended up inside a story
// about a Dubai kiteboard maker's economy award (17–18 Oct; Roy, 2026-10-18).
//
// Tested on 18 Oct's 494 pool articles against the old rule: it undoes four wrong merges (Knicks
// tickets + a Harry Styles concert + a boxing stream; Milan riots inside France's protests; a
// Trump rally with a rally against him; an El Niño reef study inside a Man City match) and splits
// three pieces of stories that belong together, which the meaning pass after it can rejoin — a
// wrong split can be repaired downstream, a wrong merge cannot. Accented Latin letters are
// folded first, so "Babiš" and "Babis" are one word.
export const sameEvent = (x, y) => {
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared >= 3 && shared >= GROUP_SHARE * Math.min(x.size, y.size);
};
export const GROUP_SHARE = 0.35;
const foldLatin = (s) => String(s || '').replace(/[\u00C0-\u024F]/g, ch => ch.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
export const groupTokens = (title) => new Set(sigTokens(foldLatin(title)));
export const joinsStory = (toks, st) => (st.memberTokens || [st.tokens]).some(mt => sameEvent(toks, mt));
