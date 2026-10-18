// The article on a page, and whether it is the article we asked for.
//
// fetchArticleBody used to keep every <p> on the page longer than 40 characters, which brought in
// whatever else sat in paragraphs: France 24's "One of your browser extensions seems to be
// blocking the video player" opened a Belgian protests story on 18 Oct. Mozilla's Readability —
// the extractor behind Firefox's Reader View — finds the article's main body instead, and the
// old way stays as the fallback for pages Readability cannot make sense of (Roy, 2026-10-18).
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

const clean = (s) => String(s || '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();

export function readabilityText(html) {
  try {
    const { document } = parseHTML(String(html || ''));
    const art = new Readability(document, { charThreshold: 250 }).parse();
    if (!art?.content) return '';
    // Paragraph by paragraph, so the text keeps its sentence breaks and captions and bylines
    // (short lines) stay out.
    const { document: body } = parseHTML(`<!doctype html><html><body>${art.content}</body></html>`);
    const paras = [...body.querySelectorAll('p, li, blockquote')]
      .map(p => clean(p.textContent))
      .filter(t => t.length > 40);
    const text = paras.length ? paras.join(' ') : clean(art.textContent);
    return text;
  } catch {
    return '';
  }
}

// How much of a headline the text is about: the share of the headline's significant words that
// appear in it. Used to catch a page that is not the article we asked for — a section front, a
// different story at a reused URL, a consent wall — without asking a model.
const STOP = new Set(('the and for with from that this into over after before about amid says said will have has '
  + 'its their are was were been more than also but not who what when where how why your you our out '
  + 'here there just could would should can may might new one two all any').split(' '));
const words = (s) => (String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .match(/[a-z0-9؀-ۿ]+/g) || []).filter(w => w.length > 3 && !STOP.has(w));

export function headlineShare(text, headline) {
  const h = [...new Set(words(headline))];
  if (h.length < 3) return null;                     // too short a headline to judge by
  const t = new Set(words(text));
  return h.filter(w => t.has(w)).length / h.length;
}
