import test from 'node:test';
import assert from 'node:assert/strict';
import { readabilityText, headlineShare } from './article-text.js';

const body = Array.from({ length: 6 }, (_, i) =>
  `<p>Lebanese Army units deployed in and around Dahieh on Saturday after tensions involving Hezbollah supporters, paragraph ${i + 1} of the report, with details from officials on the ground.</p>`).join('');
const page = `<!doctype html><html><head><title>Army deploys</title></head><body>
  <nav><p>Home · World · Business · Sport · Culture · Subscribe to our newsletter for the latest updates every day</p></nav>
  <article><h1>Army deploys in Dahieh after Hezbollah tensions</h1>${body}</article>
  <aside><p>Related: Ten things to know about the property market this autumn, from rates to rents and more</p></aside>
  <footer><p>© The Daily Star. All rights reserved. Terms of use, privacy policy and cookie settings apply here.</p></footer>
</body></html>`;

test('reads the article and leaves the page around it out', () => {
  const t = readabilityText(page);
  assert.match(t, /^Lebanese Army units deployed/);
  assert.doesNotMatch(t, /newsletter|property market|All rights reserved/);
});

test('a page it cannot parse gives no text rather than an error', () => {
  assert.equal(readabilityText(''), '');
});

test('headline share: the right article covers its headline, a different one does not', () => {
  const t = readabilityText(page);
  assert.ok(headlineShare(t, 'Army deploys in Dahieh after Hezbollah tensions') >= 0.6);
  assert.ok(headlineShare(t, 'Lacroix reaffirms UN commitment as UNIFIL prepares for drawdown') < 0.25);
  assert.equal(headlineShare(t, 'Breaking news'), null);   // too short a headline to judge by
});
