import test from 'node:test';
import assert from 'node:assert/strict';
import { groupTokens, sameEvent, joinsStory } from './story-grouping.js';

// Real headlines from the 18 Oct pool, labelled by hand. `same` is what a reader would say.
const PAIRS = [
  // Different events the old rule merged.
  { same: false, a: 'Here’s Where to Buy New York Knicks Home Opener Tickets at Madison Square Garden Online',
    b: 'Harry Styles Pays Tribute To Liam Payne With New Song At Madison Square Garden Concert' },
  { same: false, a: 'Trump touts his power at Kentucky rally to energize voters ahead of midterm elections',
    b: '‘Standing up for democracy’: Atlanta ‘No Kings’ rally draws Trump critics ahead of midterms' },
  { same: false, a: 'Clashes, fires and looting break out as protesters rally across France',
    b: 'Rioters loot stores, set fires in central Milan during cost-of-living protest' },
  { same: false, a: 'Man City continue to weather storm as Haaland scores twice in Ipswich win',
    b: 'During El Niño, a perfect storm of weather systems could spell disaster for the Great Barrier Reef' },
  { same: false, a: 'Heating oil customers face tough winter',
    b: 'Yvette Cooper pledges £140m to boost urgent care as NHS faces ‘tough’ winter' },
  // The same event, worded differently.
  { same: true, a: 'Populist Czech PM Babis goes empty-handed in Senate elections',
    b: 'Pro-Western opposition wins big in Czech Senate election, dealing a blow to populist PM Babiš' },
  { same: true, a: 'European football: Barcelona thrash Real Betis to maintain 100% record',
    b: 'Lamine Yamal opens scoring as Barcelona beat Real Betis' },
  { same: true, a: 'Harry Styles Debuts Unreleased Song at MSG to Honor Liam Payne on Second Death Anniversary',
    b: 'Harry Styles Pays Tribute To Liam Payne With New Song At Madison Square Garden Concert' },
  { same: true, a: 'Israeli settlers attack European diplomats in West Bank',
    b: 'European diplomats attacked by Israeli settlers in West Bank' },
];

for (const p of PAIRS) {
  test(`${p.same ? 'same' : 'different'}: "${p.a.slice(0, 40)}…" / "${p.b.slice(0, 40)}…"`, () => {
    assert.equal(sameEvent(groupTokens(p.a), groupTokens(p.b)), p.same);
  });
}

test('a story is joined through one of its articles, not the words it has gathered', () => {
  // The old rule pooled every member's words, so a third headline sharing a word with each of
  // the first two could join. Matching one article at a time, it cannot.
  const a = groupTokens('Dubai company wins top economy award for kiteboard making');
  const b = groupTokens('Kiteboard maker in Dubai named among top economy award winners');
  const story = { memberTokens: [a, b], tokens: new Set([...a, ...b]) };
  assert.equal(joinsStory(groupTokens('Dubai World Trade Centre strengthens role in events economy'), story), false);
  assert.equal(joinsStory(groupTokens('Dubai kiteboard company wins economy award'), story), true);
});

test('accented Latin letters are folded; Arabic is left as it is', () => {
  assert.ok(groupTokens('Babiš loses Senate').has('babis'));
  assert.ok(groupTokens('الجيش اللبناني ينتشر في الضاحية').has('اللبناني'));
});
