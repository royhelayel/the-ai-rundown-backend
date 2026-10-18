import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStoryBlocks, confineCoverageLinks } from './coverage-links.js';

// Blocks in the shape buildStoryBlocks writes, after the 17 Oct Qatar and UAE feeds.
const context = [
  `[1] Moldova's Prime Minister meets with Qatar's Ambassador
Date: 2026-10-17
Material: full articles.
Accounts from 1 of 1 outlet(s):
  — Gulf Times (https://www.gulf-times.com/article/735982/qatar/moldovas-prime-minister)
    The Prime Minister of Moldova met Qatar's ambassador to discuss bilateral relations and cooperation in trade.`,
  `[2] Qatar selected as co-chair of Arab Competition Network's Mergers and Acquisitions working group
Date: 2026-10-17
Material: the headline only — no article or description could be retrieved. Write this story from the headline above and nothing else.
Carried by 1 outlet(s): The Peninsula`,
  `[2 OUTLETS] [3] Nahyan bin Mabarak joins Iraqi community in UAE in celebrating Iraq's heritage
Date: 2026-10-17
Material: full articles.
Accounts from 1 of 2 outlet(s):
  — WAM (https://www.wam.ae/en/article/nahyan-iraqi-community)
    Sheikh Nahyan bin Mubarak, Minister of Tolerance and Coexistence, joined the Iraqi community at UAE Loves Iraq at Expo City Dubai, attended by 15,000 people.
Also carried this story (link only — cite them, but use no facts from them):
  — The Peninsula (https://thepeninsulaqatar.com/article/nahyan-iraq)`,
  `[4] 'My soul is Iraqi, my heart is Emirati': Iraqi community comes together in celebration in Dubai
Date: 2026-10-17
Material: full articles.
Accounts from 1 of 1 outlet(s):
  — The National (https://www.thenationalnews.com/news/uae/my-soul-is-iraqi)
    More than 15,000 people gathered at Expo City Dubai for UAE Loves Iraq, where Sheikh Nahyan bin Mubarak, Minister of Tolerance, joined the Iraqi community.`,
].join('\n\n');

test('parses each block with its title, links and outlets', () => {
  const b = parseStoryBlocks(context);
  assert.equal(b.length, 4);
  assert.equal(b[1].title.startsWith('Qatar selected as co-chair'), true);
  assert.deepEqual(b[1].links, []);
  assert.deepEqual(b[1].outlets, ['The Peninsula']);
  assert.deepEqual(b[2].links.map(l => l.source), ['WAM', 'The Peninsula']);
});

test('a link to another story is removed, and the outlet is still named', () => {
  const digest = `## Qatar selected as co-chair of Arab Competition Network's mergers and acquisitions working group
**Coverage:** [The Peninsula](https://www.gulf-times.com/article/735982/qatar/moldovas-prime-minister)

- Qatar has been selected as co-chair of the Arab Competition Network's Mergers and Acquisitions working group.`;
  const { content, dropped } = confineCoverageLinks(digest, context);
  assert.match(content, /^\*\*Coverage:\*\* The Peninsula$/m);
  assert.doesNotMatch(content, /gulf-times/);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].from, /Moldova/);
});

test('a second outlet on the same event is kept', () => {
  const digest = `## Sheikh Nahyan celebrates Iraqi heritage at Dubai event attended by over 15,000 people
**Coverage:** [WAM](https://www.wam.ae/en/article/nahyan-iraqi-community) · [The National](https://www.thenationalnews.com/news/uae/my-soul-is-iraqi)
- Sheikh Nahyan bin Mubarak, Minister of Tolerance and Coexistence, joined the Iraqi community at UAE Loves Iraq at Expo City Dubai, attended by more than 15,000 people.`;
  const { content, dropped } = confineCoverageLinks(digest, context);
  assert.equal(dropped.length, 0);
  assert.equal(content, digest);
});

test("a wrong link is replaced by the same outlet's link to this story", () => {
  const digest = `## Sheikh Nahyan joins Iraqi community at UAE Loves Iraq
**Coverage:** [WAM](https://www.wam.ae/en/article/nahyan-iraqi-community) · [The Peninsula](https://www.gulf-times.com/article/735982/qatar/moldovas-prime-minister)
- Sheikh Nahyan bin Mubarak joined the Iraqi community at UAE Loves Iraq at Expo City Dubai.`;
  const { content, dropped } = confineCoverageLinks(digest, context);
  assert.match(content, /\[The Peninsula\]\(https:\/\/thepeninsulaqatar\.com\/article\/nahyan-iraq\)/);
  assert.equal(dropped[0].to, 'https://thepeninsulaqatar.com/article/nahyan-iraq');
});

test('a link it cannot place is left alone, and so is a context it cannot read', () => {
  const digest = `## Qatar selected as co-chair of Arab Competition Network working group
**Coverage:** [QNA](https://www.qna.org.qa/en/some-article)
- Qatar was selected as co-chair.`;
  assert.equal(confineCoverageLinks(digest, context).content, digest);
  assert.equal(confineCoverageLinks(digest, 'no blocks here').content, digest);
});
