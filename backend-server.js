import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ override: true });

const app = express();
app.use(cors());
app.use(express.json());



// Constants
const DEFAULT_CATEGORIES = [
  'World News',
  'Technology',
  'Business',
  'Politics',
  'Sports',
  'Entertainment',
  'Science',
  'Health',
  'UAE',
  'KSA',
  'QAT',
  'LEB',
  // Subcategories — their own generation unit (own search + own digest), same as any
  // category above, not a filter on Technology/Sports. English-only for now: no entry
  // in ARABIC_CATEGORY_QUERIES, and generateAllNewsForTimeSlot's default category list
  // for language='ar' filters to categories that DO have one, so these are skipped
  // automatically on Arabic runs rather than falling through to a broken query.
  'AI',
  'Crypto',
  'Football',
  'Basketball',
];

const TIME_SLOTS = [
  { value: 'morning', label: 'Morning', time: '6 AM', cronTime: '0 6 * * *' },
  { value: 'evening', label: 'Evening', time: '6 PM', cronTime: '0 18 * * *' },
];


// === Authentication & Email Imports ===
import { createClient } from '@supabase/supabase-js';
import { TIER1_SOURCES, GOOGLE_SECTIONS, sourcesFor, mayFetchBody, sourceForUrl } from './tier1-sources.js';
import { Resend } from 'resend';

// === Initialize Supabase Admin Client ===
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// === Initialize Resend ===
const resend = new Resend(process.env.RESEND_API_KEY);

console.log('✓ Supabase Admin Client Initialized');
console.log('✓ Resend Email Service Initialized');



// Function to get today's date in YYYY-MM-DD format (UAE timezone)
// Uses Intl API directly to avoid the new Date(localeString).toISOString() timezone bug
function getTodayDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date());
}

function markdownToEmailHtml(content) {
  const getDomain = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

  // 1. Split sources section
  const sourcesIdx = content.search(/^#{1,3} (?:\[)?Sources(?:\]|\()?/im);
  const beforeSources = sourcesIdx > -1 ? content.slice(0, sourcesIdx).trim() : content.trim();
  const sourcesSection = sourcesIdx > -1 ? content.slice(sourcesIdx) : '';
  const sourceLinks = [...sourcesSection.matchAll(/[-*\d.]\s*\[([^\]]+)\]\(([^)\s]+)\)/g)]
    .map(m => ({ title: m[1], url: m[2] }))
    .filter((s, i, arr) => arr.findIndex(x => x.url === s.url) === i);

  // 2. Extract top note (italic disclaimer before first ## heading)
  const firstHeadingIdx = beforeSources.search(/^#{1,3} /m);
  const topNote = firstHeadingIdx > 0 ? beforeSources.slice(0, firstHeadingIdx).trim() : '';
  const mainContent = firstHeadingIdx > 0 ? beforeSources.slice(firstHeadingIdx).trim() : beforeSources;

  // 3. Normalize headings — strip any embedded URL so headlines are always plain text
  const normalizeHeading = (line) => {
    const m = line.match(/^(#{1,3} )(.+)$/);
    if (!m) return line;
    const [, hashes, text] = m;
    // ## [Title](URL) → ## Title
    const linkedMatch = text.match(/^\[(.+?)\]\(https?:\/\/[^)]+\)\s*$/);
    if (linkedMatch) return `${hashes}${linkedMatch[1]}`;
    // Strip bare URL anywhere in heading
    const stripped = text.replace(/(https?:\/\/[^\s)]+)/g, '').replace(/[()[\]]/g, '').replace(/\s+/g, ' ').trim();
    return `${hashes}${stripped || text}`;
  };

  const processedLines = mainContent
    .split('\n')
    .reduce((acc, line) => {
      const trimmed = line.trim();
      // Merge bare URL lines onto preceding heading (backward compat)
      if (/^https?:\/\/\S+$/.test(trimmed) && acc.length > 0) {
        const prev = acc[acc.length - 1];
        const m = prev.match(/^(#{1,3} )(.+)$/);
        if (m && !m[2].includes('](')) { acc[acc.length - 1] = `${m[1]}[${m[2].trim()}](${trimmed})`; return acc; }
      }
      acc.push(/^#{1,3} /.test(line) ? normalizeHeading(line) : line);
      return acc;
    }, [])
    .join('\n')
    .replace(/^https?:\/\/\S+$/gm, '');

  // 4. Split into per-story chunks and build URL → story-index map
  //    (same approach as the website's urlToStoryIdx)
  const chunks = [];
  const urlToStoryIdx = {};
  let cur = null;
  processedLines.split('\n').forEach(line => {
    if (/^#{1,3} /.test(line)) {
      if (cur) chunks.push(cur);
      cur = { heading: line.replace(/^#{1,3} /, '').trim(), lines: [], idx: chunks.length };
    } else if (cur) {
      cur.lines.push(line);
    }
    // Record every URL in this line against the current story index
    [...line.matchAll(/\((https?:\/\/[^)\s]+)\)/g)].forEach(([, url]) => {
      if (urlToStoryIdx[url] === undefined && cur) urlToStoryIdx[url] = cur.idx ?? chunks.length;
    });
  });
  if (cur) chunks.push(cur);

  // 5. Render a single body line into HTML
  const renderBodyLine = (line) => {
    if (!line.trim()) return '';
    // Coverage — extract URLs for story mapping but don't render the line itself
    if (/^\*\*Coverage:\*\*/.test(line)) return '';
    // Perspectives differ — gray label + text (matches website)
    const perspMatch = line.match(/^\*\*Perspectives differ:\*\*\s*(.+)$/);
    if (perspMatch) {
      const text = perspMatch[1].replace(/\*\*(.+?)\*\*/g, '<strong style="font-weight:700;color:#111827;">$1</strong>');
      return `<div style="margin:6px 0 10px;font-size:12px;color:#9ca3af;line-height:1.55;"><span style="font-weight:700;color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">Perspectives differ</span>&nbsp;&nbsp;${text}</div>`;
    }
    // Why this matters — gray label + text (matches website)
    const whyMatch = line.match(/^\*\*Why this matters:\*\*\s*(.+)$/);
    if (whyMatch) {
      const text = whyMatch[1].replace(/\*\*(.+?)\*\*/g, '<strong style="font-weight:700;color:#111827;">$1</strong>');
      return `<div style="margin:6px 0 10px;font-size:12px;color:#9ca3af;line-height:1.55;"><span style="font-weight:700;color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">Why this matters</span>&nbsp;&nbsp;${text}</div>`;
    }
    // Bullet point — left-border style matching website
    const bulletMatch = line.match(/^[-*] (.+)$/);
    if (bulletMatch) {
      const text = bulletMatch[1].replace(/\*\*(.+?)\*\*/g, '<strong style="font-weight:700;color:#111827;">$1</strong>');
      return `<div style="margin:4px 0;padding-left:9px;border-left:2px solid #e5e7eb;color:#374151;font-size:13px;line-height:1.5;">${text}</div>`;
    }
    // Italic lines
    if (/^_.*_$/.test(line.trim())) {
      return `<div style="font-size:12px;color:#9ca3af;font-style:italic;margin:4px 0;">${line.trim().replace(/^_+|_+$/g, '')}</div>`;
    }
    return '';
  };

  // Helper: render source cards for a given list of sources (2-column table for email clients)
  const renderSourceCards = (sources) => {
    if (!sources.length) return '';
    const rows = [];
    for (let i = 0; i < sources.length; i += 2) {
      const pair = [sources[i], sources[i + 1]].filter(Boolean);
      const cells = pair.map(s => {
        const domain = getDomain(s.url);
        return `<td width="50%" style="padding:3px;vertical-align:top;">
          <a href="${s.url}" target="_blank" rel="noopener noreferrer" style="display:block;padding:8px 10px;background:white;border:1px solid #e8e8ee;border-radius:10px;text-decoration:none;">
            <div style="display:flex;align-items:center;gap:5px;margin-bottom:5px;">
              <img src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" width="11" height="11" style="border-radius:2px;opacity:0.85;vertical-align:middle;" />
              <span style="font-size:9px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.04em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${domain}</span>
              <span style="font-size:9px;color:#c4c9d4;">↗</span>
            </div>
            <div style="font-size:12px;font-weight:600;color:#1e293b;line-height:1.35;">${s.title}</div>
          </a>
        </td>`;
      }).join('');
      rows.push(`<tr>${cells}</tr>`);
    }
    return `<div style="margin-top:10px;"><table width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join('')}</table></div>`;
  };

  // 6. Render all story cards — each with its own per-story source cards below (matches website)
  const storiesHtml = chunks.map(chunk => {
    const bodyHtml = chunk.lines.map(renderBodyLine).filter(Boolean).join('');
    const storySources = sourceLinks.filter(s => urlToStoryIdx[s.url] === chunk.idx);
    const storySourcesHtml = renderSourceCards(storySources);
    return `<div style="background:#fafafa;border:1px solid #f0f0f0;border-radius:12px;padding:16px 20px;margin-bottom:12px;">
      <div style="font-size:15px;font-weight:800;color:#111827;line-height:1.3;margin-bottom:8px;">${chunk.heading}</div>
      ${bodyHtml}${storySourcesHtml}
    </div>`;
  }).join('');

  // 7. Top note
  const topNoteHtml = topNote
    ? `<p style="font-style:italic;color:#9ca3af;font-size:12px;margin:0 0 14px;line-height:1.5;">${topNote.replace(/^_+|_+$/g, '').replace(/\*\*(.+?)\*\*/g, '<strong style="color:#6b7280;font-weight:700;">$1</strong>')}</p>`
    : '';

  return topNoteHtml + storiesHtml;
}

// Function to generate news using Claude API (with retry on 429)
// Map broad category names to richer search queries that surface fresh results
const CATEGORY_SEARCH_QUERIES = {
  'Technology':    'latest technology news AI Apple Google Meta Microsoft startups gadgets announcements',
  'Business':      'latest business markets economy finance stocks corporate earnings news',
  'Politics':      'latest politics news US UK Europe government elections parliament congress policy',
  'Sports':        'latest sports results scores transfers breaking news football basketball tennis',
  'Entertainment': 'latest entertainment movies music celebrity film television streaming news',
  'Science':       'latest science research discoveries space climate environment health news',
  'Health':        'latest health medicine medical research treatment disease wellness news',
  'World News':    'top breaking world news today US UK Europe Middle East Asia major stories',
  'UAE':           'UAE Dubai Abu Dhabi news today',
  'KSA':           'Saudi Arabia Riyadh news today',
  'QAT':           'Qatar Doha news today',
  'LEB':           'Lebanon Beirut news today',
  'AI':            'latest artificial intelligence news OpenAI Anthropic Google DeepMind Meta models research funding launches',
  'Crypto':        'latest cryptocurrency news bitcoin ethereum blockchain crypto market regulation',
  'Football':      'latest football soccer news Premier League Champions League La Liga transfers results',
  'Basketball':    'latest NBA basketball news games results trades playoffs',
};

// Arabic search queries — pure Arabic terms for each category, used when language='ar'.
// These replace the English CATEGORY_SEARCH_QUERIES so Serper fetches Arabic-language articles.
const ARABIC_CATEGORY_QUERIES = {
  'World News':    'أبرز أخبار العالم السياسة الاقتصاد الأمن اليوم عاجل',
  'Technology':    'أخبار التكنولوجيا والذكاء الاصطناعي والتقنية والابتكار',
  'Business':      'أخبار الاقتصاد والأسواق المالية والاستثمار والأعمال',
  'Politics':      'أخبار السياسة الدولية والدبلوماسية والمفاوضات والحكومات',
  'Sports':        'أخبار الرياضة والكرة والبطولات والنتائج',
  'Entertainment': 'أخبار الفن والترفيه والسينما والموسيقى والمشاهير',
  'Science':       'أخبار العلوم والفضاء والاكتشافات والتكنولوجيا الحيوية',
  'Health':        'أخبار الصحة والطب والأبحاث الطبية والأوبئة',
  // Regional: city names + political, diplomatic, economic, security — same breadth as LEB
  'UAE':           'أخبار الإمارات السياسة الاقتصاد الدبلوماسية دبي أبوظبي اليوم',
  'KSA':           'أخبار السعودية السياسة الاقتصاد الدبلوماسية الأمن الرياض اليوم',
  'QAT':           'أخبار قطر السياسة الاقتصاد الدبلوماسية الدوحة اليوم',
  'LEB':           'أخبار لبنان السياسة الدبلوماسية الاقتصاد الأمن اليوم',
};

async function generateEmbedding(text) {
  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: [text], model: 'voyage-3-lite' })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[0]?.embedding || null;
  } catch { return null; }
}

// Regional categories: always use gl='us' so Serper hits Google's main English index.
// Country-specific gl codes (ae/sa/qa/lb) route to sparse regional indexes that return
// unrelated content. The country name in the query is enough to surface local news.
const REGIONAL_CATEGORIES_SET = new Set(['UAE', 'KSA', 'QAT', 'LEB']);

// ── Article freshness ────────────────────────────────────────────────────────
// Serper labels every result with its age — "3 hours ago", "4 months ago" — and until now
// nothing read it, because the date pin was believed to handle freshness upstream. It does
// not: Google's cdr filter matches on when it last CRAWLED a page, not when the page was
// published. Evergreen explainers get re-crawled whenever current coverage links to them, so
// on 2026-09-11 a World News pool pinned to Sep 10–11 contained eight articles from May —
// Reuters, NYT and Al Jazeera pieces on Ukraine and Iran, ranked 13th to 42nd, displacing
// fresher coverage of that day's actual top story.
//
// This is the second time this filter has existed. It was added on 14 May and removed eight
// minutes later as "redundant — date pinning handles it", which was wrong for the reason
// above. It stayed out because a strict window was starving the sparse regional categories:
// LEB and QAT were coming back with 0–2 articles. That has since been fixed a better way —
// the site:-targeted regional queries and the RSS feeds — so on the run that prompted this,
// regional pools were LEB 49, QAT 46, KSA 39, and the filter removes nothing from any of
// them. It removes 8 articles from one category out of sixteen.
//
// No "fall back to unfiltered if nothing survives" escape. That pattern is what hid this bug,
// the Killeen Daily Herald attribution and the mobile/desktop settings desync: all three
// failed quietly and were found months later. A category that filters down to nothing should
// be loud.
const MAX_ARTICLE_AGE_DAYS = 2;   // the pin covers day-1..day, so 2 days is the same window
function isArticleFresh(dateStr) {
  if (!dateStr) return true;                       // unlabelled — keep, the pin is still first line
  const d = String(dateStr).toLowerCase().trim();
  if (/\b(minute|hour)s?\s+ago/.test(d)) return true;
  const days = d.match(/(\d+)\s*days?\s+ago/);
  if (days) return parseInt(days[1], 10) <= MAX_ARTICLE_AGE_DAYS;
  if (/\b(week|month|year)s?\s+ago/.test(d)) return false;
  const parsed = new Date(dateStr);                // absolute date, e.g. "Sep 10, 2026"
  if (isNaN(parsed.getTime())) return true;        // unparseable — keep rather than guess
  return (Date.now() - parsed.getTime()) < (MAX_ARTICLE_AGE_DAYS + 1) * 86400000;
}

async function serperSearch(query, num = 10, day = null, gl = 'us', hl = 'en') {
  // Build day-pinned tbs: cover the target day plus the day before, so articles published
  // that day and any pieces filed just before midnight are both included.
  let tbs = 'qdr:2d'; // fallback when no day is provided
  if (day) {
    const d  = new Date(day + 'T12:00:00Z');
    const d1 = new Date(d); d1.setUTCDate(d1.getUTCDate() - 1);
    const fmt = x => `${String(x.getUTCMonth()+1).padStart(2,'0')}/${String(x.getUTCDate()).padStart(2,'0')}/${x.getUTCFullYear()}`;
    tbs = `cdr:1,cd_min:${fmt(d1)},cd_max:${fmt(d)}`;
  }
  const res = await fetch('https://google.serper.dev/news', {
    method: 'POST',
    headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num, gl, hl, tbs })
  });
  if (!res.ok) {
    console.warn(`⚠️  Serper non-OK for "${query}": HTTP ${res.status}`);
    return { news: [] };
  }
  return res.json();
}

// Tier-1 news outlets — articles from these domains are sorted to the top of the
// context so Claude prioritises major stories over niche/low-authority sources.
const TIER1_DOMAINS = new Set([
  'reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk',
  'nytimes.com', 'cnn.com', 'theguardian.com', 'washingtonpost.com',
  'wsj.com', 'bloomberg.com', 'ft.com', 'economist.com',
  'nbcnews.com', 'abcnews.go.com', 'cbsnews.com', 'npr.org',
  'politico.com', 'axios.com', 'theatlantic.com', 'time.com',
  'forbes.com', 'businessinsider.com', 'techcrunch.com', 'wired.com',
  'arstechnica.com', 'theverge.com', 'engadget.com',
  'espn.com', 'skysports.com', 'bbc.com/sport',
  'sciencenews.org', 'nature.com', 'scientificamerican.com',
  'healthline.com', 'webmd.com', 'statnews.com',
  'variety.com', 'hollywoodreporter.com', 'deadline.com',
  'aljazeera.com', 'dw.com', 'france24.com',
  // Pan-Arab
  'alarabiya.net', 'skynewsarabia.com', 'rt.com/arabic',
  // Regional — Gulf & Levant (English)
  'khaleejtimes.com', 'gulfnews.com', 'thenationalnews.com', 'arabianbusiness.com',
  'arabnews.com', 'saudigazette.com.sa', 'argaam.com',
  'gulf-times.com', 'thepeninsulaqatar.com',
  'dailystar.com.lb', 'lorientlejour.com', 'naharnet.com',
  // Regional — Gulf & Levant (Arabic)
  'al-akhbar.com', 'annahar.com', 'lbci.com.lb', 'lbcgroup.tv', 'mtv.com.lb', 'nna-leb.gov.lb',
  'albayan.ae', 'alkhaleej.ae', 'emaratalyoum.com', 'wam.ae',
  'alyaum.com', 'okaz.com.sa', 'sabq.org', 'aleqt.com',
  'al-sharq.com', 'peninsulaqatar.com',
  // National news agencies
  'spa.gov.sa', 'qna.org.qa',
]);

function isGoogleRedirect(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'google.com' || host.startsWith('news.google.');
  } catch { return false; }
}

// Strips punctuation, "the", "news", and TLDs so "AP News" and OUTLET_NAMES' "AP" (or
// "Sky Sports" and a derived "Skysports") normalize to the same token. Needed because every
// search result now arrives via a Google News redirect (see isGoogleRedirect below) — the
// true publisher domain is hidden inside the redirect, so cleanOutletName can never resolve
// it through OUTLET_NAMES and just keeps whatever label Google itself shows, which routinely
// differs from this file's own display strings for the same outlet.
function normalizeOutletName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\.(com|net|org|ae|sa|qa|lb|tr)\b/g, '')
    .replace(/\bnews\b/g, '')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]/g, '');
}

// Normalized display names for every TIER1_DOMAINS entry — OUTLET_NAMES' string where one
// exists, else a name derived straight from the domain. Built from TIER1_DOMAINS rather than
// OUTLET_NAMES: a lot of tier-1 domains (techcrunch.com, espn.com, forbes.com, theverge.com…)
// have no OUTLET_NAMES entry at all, so building this set from OUTLET_NAMES alone silently
// excluded them from ever matching. Built lazily; used only when the URL is a Google redirect.
let _tier1NormalizedNames = null;
function tier1DisplayNames() {
  if (!_tier1NormalizedNames) {
    _tier1NormalizedNames = new Set(
      [...TIER1_DOMAINS]
        .map(domain => normalizeOutletName(OUTLET_NAMES[domain] || deriveOutletName(domain)))
        .filter(Boolean)
    );
  }
  return _tier1NormalizedNames;
}

// sourceName is optional; only consulted when the URL is a Google News redirect so that
// tier-1 outlets whose links arrive as google.com/goto?url=… are not misclassified.
function isTier1(url, sourceName = '') {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (TIER1_DOMAINS.has(host) || [...TIER1_DOMAINS].some(d => host.endsWith('.' + d))) return true;
  } catch {}
  if (sourceName && isGoogleRedirect(url)) {
    return tier1DisplayNames().has(normalizeOutletName(sourceName));
  }
  return false;
}

// ── Regional local-source layer ──────────────────────────────────────────────
// Used ONLY for regional categories (UAE/KSA/QAT/LEB) to rank local coverage
// above international coverage. These domains stay in TIER1_DOMAINS as well, so
// non-regional categories still treat them (and Al Jazeera) as international tier-1.
const NATIONAL_AGENCIES = {
  UAE: ['wam.ae'],
  KSA: ['spa.gov.sa'],
  QAT: ['qna.org.qa'],
  LEB: ['nna-leb.gov.lb'],
};
// Local tier-1 outlets per region. An outlet counts as local regardless of the
// language it publishes in — the per-article language gate (titleIsArabic) keeps
// Arabic articles out of the English feed, so a bilingual outlet's ENGLISH pieces
// (e.g. Al Akhbar's english.al-akhbar.com) still get full local priority.
//   `en`  — English-edition domains, used to site:-target the English run.
//   `all` — every local domain (any language), used for is-local classification.
const LOCAL_TIER1 = {
  UAE: {
    en:  ['thenationalnews.com', 'thenational.ae', 'gulfnews.com', 'khaleejtimes.com', 'arabianbusiness.com'],
    all: ['thenationalnews.com', 'thenational.ae', 'gulfnews.com', 'khaleejtimes.com', 'arabianbusiness.com', 'albayan.ae', 'alkhaleej.ae', 'emaratalyoum.com'],
  },
  KSA: {
    en:  ['arabnews.com', 'saudigazette.com.sa', 'english.alarabiya.net', 'english.aawsat.com'],
    all: ['arabnews.com', 'saudigazette.com.sa', 'alarabiya.net', 'aawsat.com', 'asharqalawsat.com', 'alyaum.com', 'okaz.com.sa', 'sabq.org', 'aleqt.com', 'argaam.com'],
  },
  QAT: {
    en:  ['gulf-times.com', 'thepeninsulaqatar.com', 'peninsulaqatar.com', 'dohanews.co', 'aljazeera.com'],
    all: ['gulf-times.com', 'thepeninsulaqatar.com', 'peninsulaqatar.com', 'dohanews.co', 'aljazeera.com', 'al-sharq.com'],
  },
  LEB: {
    // `en` = English-edition domains to site:-target (avoid French lorientlejour.com
    // and Arabic-serving en.annahar.com so non-English doesn't enter the English run).
    en:  ['today.lorientlejour.com', 'naharnet.com', 'dailystar.com.lb', 'english.al-akhbar.com'],
    all: ['today.lorientlejour.com', 'lorientlejour.com', 'naharnet.com', 'dailystar.com.lb', 'al-akhbar.com', 'english.al-akhbar.com', 'annahar.com', 'en.annahar.com', 'lbci.com.lb', 'lbcgroup.tv', 'mtv.com.lb'],
  },
};
// Human-readable region subject for the prompt's region-relevance gate.
const REGION_SUBJECT = { UAE: 'the UAE', KSA: 'Saudi Arabia', QAT: 'Qatar', LEB: 'Lebanon' };
// Outlet-name hints used to bias Serper queries toward local coverage (English regional).
const REGIONAL_QUERY_HINTS = {
  UAE: { agency: 'WAM Emirates News Agency', outlets: 'The National Gulf News Khaleej Times' },
  KSA: { agency: 'SPA Saudi Press Agency',   outlets: 'Arab News Al Arabiya Saudi Gazette' },
  QAT: { agency: 'QNA Qatar News Agency',    outlets: 'Gulf Times The Peninsula Al Jazeera' },
  LEB: { agency: 'NNA National News Agency', outlets: "L'Orient Today Naharnet Annahar" },
};

// Domain → clean English outlet name. Serper labels outlets inconsistently — sometimes
// in Arabic/Farsi script, sometimes as a raw domain — so we normalise every source to one
// consistent English display name keyed off its domain (language-independent).
const OUTLET_NAMES = {
  // Lebanon
  'nna-leb.gov.lb': 'NNA', 'naharnet.com': 'Naharnet', 'nowlebanon.com': 'NOW Lebanon',
  'lorientlejour.com': "L'Orient-Le Jour", 'today.lorientlejour.com': "L'Orient Today",
  'dailystar.com.lb': 'The Daily Star', 'al-akhbar.com': 'Al Akhbar', 'english.al-akhbar.com': 'Al Akhbar',
  'annahar.com': 'Annahar', 'en.annahar.com': 'Annahar', 'lbci.com.lb': 'LBCI', 'lbcgroup.tv': 'LBCI', 'mtv.com.lb': 'MTV Lebanon',
  // UAE
  'wam.ae': 'WAM', 'thenationalnews.com': 'The National', 'thenational.ae': 'The National', 'gulfnews.com': 'Gulf News',
  'khaleejtimes.com': 'Khaleej Times', 'arabianbusiness.com': 'Arabian Business', 'albayan.ae': 'Al Bayan',
  'alkhaleej.ae': 'Al Khaleej', 'emaratalyoum.com': 'Emarat Al Youm',
  // Saudi
  'spa.gov.sa': 'SPA', 'arabnews.com': 'Arab News', 'saudigazette.com.sa': 'Saudi Gazette',
  'aawsat.com': 'Asharq Al-Awsat', 'english.aawsat.com': 'Asharq Al-Awsat', 'asharqalawsat.com': 'Asharq Al-Awsat',
  'alyaum.com': 'Al Yaum', 'okaz.com.sa': 'Okaz', 'sabq.org': 'Sabq', 'aleqt.com': 'Al Eqtisadiah', 'argaam.com': 'Argaam',
  // Qatar
  'qna.org.qa': 'QNA', 'gulf-times.com': 'Gulf Times', 'thepeninsulaqatar.com': 'The Peninsula',
  'peninsulaqatar.com': 'The Peninsula', 'dohanews.co': 'Doha News', 'al-sharq.com': 'Al Sharq',
  // Pan-Arab / regional
  'aljazeera.com': 'Al Jazeera', 'alarabiya.net': 'Al Arabiya', 'english.alarabiya.net': 'Al Arabiya',
  'skynewsarabia.com': 'Sky News Arabia', 'anadoluagency.com': 'Anadolu Agency', 'aa.com.tr': 'Anadolu Agency',
  'iranintl.com': 'Iran International',
  // International tier-1
  'reuters.com': 'Reuters', 'apnews.com': 'AP', 'bbc.com': 'BBC', 'bbc.co.uk': 'BBC',
  'nytimes.com': 'The New York Times', 'cnn.com': 'CNN', 'theguardian.com': 'The Guardian',
  'washingtonpost.com': 'The Washington Post', 'wsj.com': 'The Wall Street Journal', 'bloomberg.com': 'Bloomberg',
  'ft.com': 'Financial Times', 'economist.com': 'The Economist', 'npr.org': 'NPR', 'politico.com': 'Politico',
  'axios.com': 'Axios', 'dw.com': 'DW', 'france24.com': 'France 24', 'time.com': 'Time',
};

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}
// Readable fallback when no map entry exists: title-case the domain's core label.
function deriveOutletName(domain) {
  if (!domain) return '';
  const core = domain.replace(/^(en|english|today|m|amp)\./, '').split('.').slice(0, -1).pop() || domain;
  return core.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
// Clean English outlet name for an article: prefer the domain map, then an already-English
// label, then a derived name. Never returns Arabic/Farsi script or a raw URL.
function cleanOutletName(source, url) {
  const domain = domainOf(url);
  for (const [d, name] of Object.entries(OUTLET_NAMES)) {
    if (domain === d || domain.endsWith('.' + d)) return name;
  }
  const s = (source || '').trim();
  if (s && !/[؀-ۿ]/.test(s) && !/^https?:/i.test(s) && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)) return s;
  return deriveOutletName(domain) || s || '';
}

function hostMatches(url, domains) {
  if (!domains || !domains.length) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return domains.some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
}
function isNationalAgency(url, region) { return hostMatches(url, NATIONAL_AGENCIES[region]); }
// English-edition local domains — used to site:-target the English run.
function localTier1En(region) { return LOCAL_TIER1[region]?.en || []; }
// Serper's own display labels for the local outlets, where they differ from what
// deriveOutletName() produces from the domain. Without these, "LBCI Lebanon" (Serper) never
// matches "lbci" (from lbci.com.lb) and one of Lebanon's most-carried broadcasters is scored
// as filler; likewise "ASHARQ AL-AWSAT English" against aawsat.com. Observed labels, taken
// from stored source_articles rather than guessed.
const LOCAL_DISPLAY_ALIASES = {
  UAE: ['The National', 'Gulf News', 'Khaleej Times', 'Arabian Business', 'WAM', 'Emirates 24|7', 'Al Bayan', 'Al Khaleej', 'Emarat Al Youm'],
  KSA: ['Arab News', 'Al Arabiya', 'Saudi Gazette', 'ASHARQ AL-AWSAT English', 'Asharq Al-Awsat', 'SPA', 'Saudi Press Agency', 'Okaz', 'Sabq', 'Argaam', 'Al Eqtisadiah'],
  QAT: ['Al Jazeera', 'QNA', 'Qatar news agency', 'Qatar News Agency', 'The Peninsula', 'Doha News', 'Gulf Times', 'Qatar Tribune', 'Al Sharq'],
  LEB: ["L'Orient Today", "L'Orient-Le Jour", 'Naharnet', 'The Daily Star', 'Al Akhbar', 'Annahar', 'An-Nahar', 'LBCI Lebanon', 'LBCI', 'MTV Lebanon', 'NNA', 'National News Agency'],
};

// Normalized local display names per region, built once. Same shape as tier1DisplayNames().
const _localNamesByRegion = {};
function localDisplayNames(region) {
  if (!_localNamesByRegion[region]) {
    const domains = [...(NATIONAL_AGENCIES[region] || []), ...(LOCAL_TIER1[region]?.all || [])];
    _localNamesByRegion[region] = new Set([
      ...domains.map(d => normalizeOutletName(OUTLET_NAMES[d] || deriveOutletName(d))),
      ...(LOCAL_DISPLAY_ALIASES[region] || []).map(normalizeOutletName),
    ].filter(Boolean));
  }
  return _localNamesByRegion[region];
}

// An outlet is "local" regardless of the language it publishes in.
//
// sourceName is optional and works exactly as it does in isTier1: consulted only when the URL
// is a Google News redirect, where the publisher's own domain is hidden inside the redirect
// and hostMatches can never see it. isTier1 was given this fallback and isLocalSource was
// not, which quietly disabled the whole local-first ranking for most of the pool — measured
// on a stored day, 36 of 53 Lebanon articles (68%) arrive as google.com redirects, so for
// two-thirds of the feed "is this a Lebanese outlet?" was answered no by construction. Local
// outlets then scored in the filler band, below international coverage they are meant to
// outrank, and the [LOCAL OUTLET] / [TOP LOCAL STORY] labels Claude prioritises on never
// appeared for them.
function isLocalSource(url, region, sourceName = '') {
  if (!region) return false;
  if (hostMatches(url, NATIONAL_AGENCIES[region]) || hostMatches(url, LOCAL_TIER1[region]?.all || [])) return true;
  if (sourceName && isGoogleRedirect(url)) {
    return localDisplayNames(region).has(normalizeOutletName(sourceName));
  }
  return false;
}
// True when a title is written in Arabic script (≥ 2 Arabic letters).
// Used to drop Arabic-language articles from the English feed.
function titleIsArabic(s) {
  return ((s || '').match(/[؀-ۿ]/g) || []).length >= 2;
}

// Auto-discover an outlet's RSS/Atom feed: read the homepage's
// <link rel="alternate" type="application/rss+xml"> tag, then fall back to
// common feed paths. Returns the absolute feed URL or null.
async function discoverRssFeed(siteDomainOrUrl) {
  if (!siteDomainOrUrl) return null;
  const base = siteDomainOrUrl.startsWith('http') ? siteDomainOrUrl : `https://${siteDomainOrUrl}`;
  const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; RadioNewsBot/1.0)' };
  const tryFetch = (u) => fetch(u, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(8000) });
  try {
    const r = await tryFetch(base);
    if (r.ok) {
      const html = await r.text();
      const tags = html.match(/<link[^>]+>/gi) || [];
      for (const tag of tags) {
        if (/type=["']application\/(?:rss|atom)\+xml["']/i.test(tag)) {
          const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
          if (href) { try { return new URL(href, base).href; } catch {} }
        }
      }
    }
  } catch {}
  for (const p of ['/rss', '/feed', '/rss.xml', '/feed.xml', '/en/rss', '/en/feed']) {
    try {
      const u = new URL(p, base).href;
      const r = await tryFetch(u);
      if (r.ok) {
        const ct = r.headers.get('content-type') || '';
        const txt = (await r.text()).slice(0, 400);
        if (ct.includes('xml') || /<rss|<feed|<rdf/i.test(txt)) return u;
      }
    } catch {}
  }
  return null;
}

// ── Regional RSS feeds ───────────────────────────────────────────────────────
// English-edition feeds for local outlets whose fresh coverage Google indexes
// unreliably. Pulled directly so we get guaranteed-fresh items with REAL publish
// timestamps (so we can hard-filter to the last 24h). Discovered via audit-region.
const RSS_MAX_AGE_HOURS = 28; // keep only items published within this window
const REGIONAL_RSS = {
  LEB: [
    { name: 'Naharnet',    url: 'https://www.naharnet.com/tags/lebanon/en/feed.atom' },
    { name: 'NOW Lebanon', url: 'https://nowlebanon.com/feed/' },
    // Annahar excluded: its only feed (en.annahar.com/rss) serves Arabic, which
    // the language gate would drop — its English isn't available via RSS.
  ],
  // UAE / KSA / QAT / EGY / KWT / BHR / OMN / JOR added as each audit completes.
};

function decodeXmlEntities(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

// Minimal RSS 2.0 / Atom parser — returns [{ title, link, date(Date|null), snippet }].
function parseRssFeed(xml) {
  const out = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? decodeXmlEntities(m[1]).trim() : '';
    };
    const title = pick('title');
    let link = pick('link');
    if (!link || /^\s*$/.test(link)) {
      const m = b.match(/<link\b[^>]*href=["']([^"']+)["']/i);
      if (m) link = m[1];
    }
    const dateStr = pick('pubDate') || pick('published') || pick('updated') || pick('dc:date');
    const d = dateStr ? new Date(dateStr) : null;
    const snippet = (pick('description') || pick('summary') || pick('content'))
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    out.push({ title, link, date: (d && !isNaN(d)) ? d : null, snippet });
  }
  return out;
}

// Fetch one feed and return fresh items (within maxAgeHours) shaped like Serper articles.
async function fetchRssItems(feed, maxAgeHours = RSS_MAX_AGE_HOURS) {
  try {
    const r = await fetch(feed.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RadioNewsBot/1.0)' },
      redirect: 'follow', signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return [];
    const items = parseRssFeed(await r.text());
    const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
    return items
      .filter(it => it.title && it.link)
      .filter(it => it.date && it.date.getTime() >= cutoff) // hard 24h-ish freshness
      .map(it => ({ title: it.title, link: it.link, source: feed.name, date: it.date.toISOString(), snippet: it.snippet }));
  } catch { return []; }
}

// ── Multi-outlet echo scoring ────────────────────────────────────────────────
// For each article, counts how many UNIQUE sources cover the same story,
// split into tier-1 vs non-tier-1 outlets.
// Two articles are considered "same story" if their titles share ≥ 2 significant words.
// Returns { tier1Count, totalCount } per article (tier1Count includes the article itself
// if it is from a tier-1 outlet; totalCount always ≥ 1).
const STOP_WORDS = new Set([
  'the','and','for','are','but','not','you','all','can','was','one','our','out',
  'day','get','has','him','his','how','its','may','new','now','old','see','two',
  'way','who','did','let','put','say','she','too','use','says','said','will',
  'with','that','this','from','they','what','when','more','than','about','after',
  'being','first','their','there','these','would','could','which','over','into',
  'also','just','amid','amid','than','some','have','been','were','have','well',
]);

function computeEchoScores(articles, region = null) {
  const tokenize = (title) =>
    (title || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOP_WORDS.has(w));

  const tokenSets = articles.map(a => new Set(tokenize(a.title)));

  return articles.map((article, i) => {
    const tier1Sources = new Set();
    const localSources = new Set();
    const allSources   = new Set([article.source || `src_${i}`]);

    // Count this article's own source as tier-1 / local if applicable
    if (isTier1(article.link, article.source)) tier1Sources.add(article.source || `src_${i}`);
    if (region && isLocalSource(article.link, region, article.source)) localSources.add(article.source || `src_${i}`);

    for (let j = 0; j < articles.length; j++) {
      if (i === j) continue;
      const sharedTokens = [...tokenSets[i]].filter(t => tokenSets[j].has(t)).length;
      if (sharedTokens >= 2) {
        const src = articles[j].source || `source_${j}`;
        allSources.add(src);
        if (isTier1(articles[j].link, articles[j].source)) tier1Sources.add(src);
        if (region && isLocalSource(articles[j].link, region, articles[j].source)) localSources.add(src);
      }
    }

    return {
      tier1Count: tier1Sources.size,  // tier-1 outlets covering same story (≥ 0)
      totalCount: allSources.size,    // all outlets covering same story (≥ 1)
      localCount: localSources.size,  // local outlets covering same story (regional only, ≥ 0)
    };
  });
}

// ── World News / Politics: distinct topic-angle queries instead of near-identical suffixes ──
// Each query targets a different news angle so Serper returns diverse, non-duplicate results.
const WORLD_NEWS_ANGLE_QUERIES = (dateLabel) => [
  `top breaking world news today major stories ${dateLabel}`,
  `international conflict military war ceasefire security latest ${dateLabel}`,
  `global diplomacy summit talks deal agreement ${dateLabel}`,
  `world economy trade sanctions markets finance policy ${dateLabel}`,
  `Europe Middle East Asia Africa Americas developments ${dateLabel}`,
];

// ── Spread rules ─────────────────────────────────────────────────────────────
// The four regional categories have carried a DIVERSITY rule since they were built; the
// global ones never got one. The result, measured on 2026-08-28: World News ran 6 of 8
// stories on Russia/Ukraine, Iran/US and Trump, and Business ran 5 of 5 on US markets with
// no energy and nothing outside the US.
//
// That is the ranking working as designed — a story's score is driven by how many outlets
// covered it, and Trump and Iran are by definition the most-covered stories on earth. The
// echo ranking is also what keeps a random local stabbing out of the feed, so the fix is not
// to lower that bar. It is to require a spread on top of it.
const SPREAD_RULES = {
  'World News': `\n\nDIVERSITY (REQUIRED): The world is not only conflict and Washington. No single running situation may occupy more than TWO of the ## slots — consolidate it into one story per the rule above and move on. Beyond the major geopolitical stories, you MUST include the other kinds of world story the search results support: science and space, business and economy, climate and environment, health, culture and society, sport, and significant events outside the US, Europe and the Middle East. A feed in which every story is one of two conflicts plus US politics has failed this rule.`,

  'Politics': `\n\nSIGNIFICANCE AND SPREAD (REQUIRED): Prefer consequence over obscurity. A story a reasonable reader would recognise as mattering beats a procedural item from a small legislature, even when both appear in the results. Spread the feed across regions rather than filling it with one country's domestic process, and include the major political stories of the day wherever the results support them. Do not return a feed made up entirely of minor parliamentary, regulatory or committee items.`,

  'Business': `\n\nDIVERSITY (REQUIRED): Do not return an all-US-markets feed. Where the search results support it, you MUST include energy and commodities (including OPEC and Gulf producers), Middle East and Gulf business, and major non-US corporate and economic stories, alongside US markets and earnings. Five US stock-market stories is a failure of this rule.`,
};

// ── Angle queries for the remaining categories ───────────────────────────────
// These ten ran five reworded variants of one sentence — "X news today", "X breaking
// update latest", "X analysis reaction development" — which is the same search five times
// as far as Google is concerned. Measured on 2026-08-28, the categories on suffixes averaged
// 35 unique articles against 56 for the two that already had angles, and the tail was far
// worse: AI 8, Health 11, Technology 14 unique articles out of a possible 240. AI then wrote
// 6 stories from 8 articles — not selecting the day's news, just printing what it found.
//
// Each set below is five genuinely different slices of the category, so the five searches
// compete for different results instead of returning the same page.
const CATEGORY_ANGLE_QUERIES = {
  'Technology': (d) => [
    `technology product launch announcement release ${d}`,
    `Apple Google Microsoft Meta Amazon company news ${d}`,
    `consumer devices hardware chips gadgets review ${d}`,
    `tech regulation antitrust privacy platform policy ${d}`,
    `tech startup funding round IPO acquisition ${d}`,
  ],
  'Business': (d) => [
    `stock markets indices trading session close ${d}`,
    `corporate earnings results profit guidance ${d}`,
    `central bank interest rates inflation economy ${d}`,
    `oil gas energy commodities OPEC Gulf producers ${d}`,
    `merger acquisition deal IPO corporate finance ${d}`,
  ],
  'Sports': (d) => [
    `sports results scores fixtures ${d}`,
    `transfers signings contracts moves ${d}`,
    `championship tournament final qualification ${d}`,
    `injury team news squad selection ${d}`,
    `sports governance doping ban federation ruling ${d}`,
  ],
  'Entertainment': (d) => [
    `film movie release box office ${d}`,
    `music album single artist tour ${d}`,
    `television streaming series premiere finale ${d}`,
    `celebrity awards red carpet nominations ${d}`,
    `studio entertainment industry deal production ${d}`,
  ],
  'Science': (d) => [
    `space astronomy mission launch telescope ${d}`,
    `climate environment emissions ecology study ${d}`,
    `biology genetics medicine research findings ${d}`,
    `physics chemistry materials engineering breakthrough ${d}`,
    `archaeology palaeontology discovery excavation ${d}`,
  ],
  'Health': (d) => [
    `medical research clinical trial study results ${d}`,
    `disease outbreak infection public health warning ${d}`,
    `healthcare policy hospitals insurance system ${d}`,
    `drug treatment approval FDA therapy ${d}`,
    `nutrition fitness mental health wellbeing ${d}`,
  ],
  'AI': (d) => [
    `AI model release launch capability benchmark ${d}`,
    `AI company funding valuation acquisition deal ${d}`,
    `AI regulation safety policy governance law ${d}`,
    `AI chips compute data centre infrastructure ${d}`,
    `AI research paper breakthrough agents robotics ${d}`,
  ],
  'Crypto': (d) => [
    `bitcoin ethereum price market movement ${d}`,
    `crypto regulation SEC enforcement legislation ${d}`,
    `crypto exchange ETF institutional adoption ${d}`,
    `stablecoin DeFi protocol token launch ${d}`,
    `crypto hack exploit fraud security breach ${d}`,
  ],
  'Football': (d) => [
    `football match result score report ${d}`,
    `football transfer signing contract deal ${d}`,
    `Champions League European competition ${d}`,
    `Premier League La Liga Serie A Bundesliga ${d}`,
    `football manager injury club ownership ${d}`,
  ],
  'Basketball': (d) => [
    `NBA game result score recap ${d}`,
    `NBA trade free agency signing ${d}`,
    `NBA playoffs standings season race ${d}`,
    `NBA injury player news roster ${d}`,
    `college international basketball EuroLeague ${d}`,
  ],
};

const POLITICS_ANGLE_QUERIES = (base, dateLabel) => [
  `${base} ${dateLabel}`,
  `government legislation elections parliament policy ${dateLabel}`,
  `political crisis opposition protest vote ${dateLabel}`,
  `foreign policy diplomacy relations sanctions ${dateLabel}`,
  `${base} latest breaking analysis`,
];

// ── Phase 2: ask Claude Haiku to generate targeted follow-up search queries ──
// Takes the top headlines from Phase 1 and produces 3 queries aimed at stories
// that the initial broad queries likely missed (niche angles, regional stories, fast-moving events).
async function generateAdaptiveQueries(headlines, categoryQuery, dateLabel) {
  try {
    const headlineList = headlines.slice(0, 10).map((h, i) => `${i + 1}. ${h}`).join('\n');
    const prompt = `You are a news search specialist. Here are the top stories already found for "${categoryQuery}" on ${dateLabel}:
${headlineList}

Generate exactly 3 targeted search queries to find ADDITIONAL important stories NOT already covered by the headlines above. Focus on:
- Major stories that may have been missed (different regions, angles, or topics)
- Fast-moving situations with new developments
- Stories that are trending but not yet widely picked up

Return ONLY 3 search queries, one per line, no numbering, no explanation, no preamble.`;

    const data = await callClaude(prompt, 150);
    const text = data.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '';
    const queries = text.trim().split('\n').map(l => l.trim()).filter(l => l.length > 5).slice(0, 3);
    console.log(`🔍 Phase 2 adaptive queries for "${categoryQuery}": ${queries.join(' | ')}`);
    return queries;
  } catch (err) {
    console.warn(`⚠️  Phase 2 query generation failed: ${err.message}`);
    return [];
  }
}

async function buildSearchContext(categoryQuery, day, language = 'en', isRegional = false, category = '') {
  // Format day as human-readable for queries (e.g. "May 14 2026")
  const dateLabel = day
    ? new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : 'today';

  const hl = language === 'ar' ? 'ar' : 'en';
  // Always use gl='us' so Serper hits the main Google index.
  // For Arabic, hl='ar' is enough to surface Arabic-language sources (Al Jazeera, BBC Arabic, etc.).
  // Using gl='ae' routes to a sparse UAE-only index and returns near-zero results for global topics.
  const gl = 'us';

  // ── Build Phase 1 queries ─────────────────────────────────────────────────
  // World News and Politics get distinct topic-angle queries (avoids 75% duplicate results
  // from near-identical suffix variants). All other categories get diversified suffixes.
  let queries;
  if (language === 'ar') {
    queries = [
      `${categoryQuery} ${dateLabel}`,
      `${categoryQuery} آخر الأخبار اليوم`,
      `${categoryQuery} أبرز الأحداث عاجل`,
      `${categoryQuery} تطورات مستجدات`,
      `${categoryQuery} تقارير وتحليلات`,
    ];
  } else if (category === 'World News') {
    queries = WORLD_NEWS_ANGLE_QUERIES(dateLabel);
  } else if (category === 'Politics') {
    queries = POLITICS_ANGLE_QUERIES(categoryQuery, dateLabel);
  } else if (REGIONAL_CATEGORIES_SET.has(category)) {
    // Regional (English): bias toward local outlets + the national wire so local
    // coverage is actually present in the pool for the local-first ranking to use.
    const h  = REGIONAL_QUERY_HINTS[category] || { agency: '', outlets: '' };
    const rs = REGION_SUBJECT[category] || categoryQuery;
    // site:-restricted query forces the national wire + top local outlets into the
    // pool even when they don't rank on the US Google index (e.g. Lebanon's French/
    // Arabic press). One query ORs the region's key local domains.
    const sites = [...(NATIONAL_AGENCIES[category] || []), ...localTier1En(category)].slice(0, 9);
    const siteFilter = sites.map(d => `site:${d}`).join(' OR ');
    // A second site query restricted to the local tier-1 outlets ONLY (no national wire),
    // so independent local coverage (L'Orient, Naharnet, Daily Star, Al Akhbar …) is
    // guaranteed in the pool and the feed isn't dominated by the national agency.
    const localOnly = localTier1En(category).slice(0, 6).map(d => `site:${d}`).join(' OR ');
    queries = [
      `${categoryQuery} ${dateLabel}`,
      `${categoryQuery} breaking latest`,
      `${rs} news ${h.outlets} ${dateLabel}`,
      siteFilter ? `${rs} (${siteFilter})` : `${rs} ${h.agency} ${dateLabel}`,
      localOnly ? `${rs} (${localOnly})` : `${categoryQuery} politics economy diplomacy security`,
      // Soft / local-interest pull — keeps the feed from going all-politics on heavy
      // news days (business, sports, culture, society, education, health, weather).
      `${rs} business economy sports culture entertainment lifestyle education health weather ${dateLabel}`,
    ];
  } else if (CATEGORY_ANGLE_QUERIES[category]) {
    queries = CATEGORY_ANGLE_QUERIES[category](dateLabel);
  } else {
    // Fallback for anything with no angle set — custom user categories reach here.
    // Still five near-identical variants, which is why every built-in category has angles.
    queries = [
      `${categoryQuery} news ${dateLabel}`,
      `${categoryQuery} breaking update latest`,
      `${categoryQuery} analysis reaction development`,
      `${categoryQuery} top stories today ${dateLabel}`,
      `${categoryQuery} major announcement impact`,
    ];
  }

  // Unified 30 results per query for all categories (was 20 for non-regional)
  const numPerQuery = 30;
  let results = await Promise.all(queries.map(q => serperSearch(q, numPerQuery, day, gl, hl).catch(() => ({ news: [] }))));

  // Merge results while preserving Google's ranking signal.
  // Each article gets a score = sum of (1 / position) across every query it appears in.
  let staleDropped = 0;
  const mergeIntoMaps = (rawResults, scoreMap, itemMap) => {
    rawResults.forEach(r => {
      (r.news || []).forEach((item, idx) => {
        if (!item.link || item.link.includes('wikipedia.org')) return;
        // Google's date pin matches on crawl date, so out-of-window articles arrive anyway.
        // Serper's own age label is the reliable signal — see isArticleFresh.
        if (!isArticleFresh(item.date)) { staleDropped++; return; }
        const url = item.link;
        const positionScore = 1 / (idx + 1); // rank 1 → 1.0, rank 2 → 0.5, rank 10 → 0.1
        scoreMap[url] = (scoreMap[url] || 0) + positionScore;
        if (!itemMap[url]) itemMap[url] = item;
      });
    });
  };

  const scoreMap = {};   // url → cumulative score
  const itemMap  = {};   // url → article object (first seen wins for metadata)
  mergeIntoMaps(results, scoreMap, itemMap);

  // ── Phase 2: Adaptive follow-up queries (English only) ──────────────────
  // Claude Haiku looks at Phase 1 headlines and generates 3 targeted follow-up
  // queries aimed at important stories the initial broad queries likely missed.
  // Now runs for regional categories too — same echo-priority logic applies.
  if (language === 'en' && Object.keys(scoreMap).length > 0) {
    const phase1Headlines = Object.values(itemMap).slice(0, 10).map(a => a.title).filter(Boolean);
    if (phase1Headlines.length >= 3) {
      const followUpQueries = await generateAdaptiveQueries(phase1Headlines, categoryQuery, dateLabel);
      if (followUpQueries.length > 0) {
        const followUpResults = await Promise.all(
          followUpQueries.map(q => serperSearch(q, numPerQuery, day, gl, hl).catch(() => ({ news: [] })))
        );
        const beforeCount = Object.keys(scoreMap).length;
        mergeIntoMaps(followUpResults, scoreMap, itemMap);
        const afterCount = Object.keys(scoreMap).length;
        console.log(`🔍 Phase 2 added ${afterCount - beforeCount} new unique articles (total: ${afterCount})`);
      }
    }
  }

  // ── Regional RSS: pull guaranteed-fresh local English coverage straight from
  // the outlets' own feeds, bypassing Google News' indexing/date gaps. Only for
  // today's English regional runs (feeds only carry recent items).
  if (isRegional && language === 'en' && day === getTodayDate() && (REGIONAL_RSS[category] || []).length) {
    const rssResults = await Promise.all(
      REGIONAL_RSS[category].map(f => fetchRssItems(f).catch(() => []))
    );
    const rssItems = rssResults.flat();
    let added = 0;
    rssItems.forEach(item => {
      if (!item.link) return;
      const url = item.link;
      scoreMap[url] = (scoreMap[url] || 0) + 0.7; // ensure it's retained in the pool
      if (!itemMap[url]) { itemMap[url] = item; added++; }
    });
    console.log(`📡 RSS added ${added} fresh local items for ${category} (last ${RSS_MAX_AGE_HOURS}h)`);
  }

  // ── Fallback: if date-pinned search returned nothing, retry with a wider 7-day window ──
  if (Object.keys(scoreMap).length === 0 && day) {
    console.warn(`⚠️  Date-pinned search returned 0 results for "${categoryQuery}" — retrying with 7-day window`);
    const fallbackResults = await Promise.all(
      queries.slice(0, 3).map(q => serperSearch(q, numPerQuery, null, gl, hl).catch(() => ({ news: [] })))
    );
    mergeIntoMaps(fallbackResults, scoreMap, itemMap);
  }

  if (staleDropped > 0) {
    console.log(`🗓️  Dropped ${staleDropped} out-of-window article${staleDropped === 1 ? '' : 's'} for "${categoryQuery}" (older than ${MAX_ARTICLE_AGE_DAYS} days despite the date pin)`);
  }

  if (Object.keys(scoreMap).length === 0) {
    throw new Error(`Serper returned no results for "${categoryQuery}" — API key may be invalid or rate-limited`);
  }
  // Loud, not silent. The last time a freshness filter existed it was removed because strict
  // dates starved LEB and QAT down to 0–2 articles; if that ever recurs it should appear in
  // the logs rather than be papered over by refilling the pool with stale material.
  if (Object.keys(scoreMap).length < 10) {
    console.warn(`⚠️  Thin pool for "${categoryQuery}": only ${Object.keys(scoreMap).length} articles after filtering (${staleDropped} dropped as stale)`);
  }

  // Language gate: keep the English feed English. Drop Arabic-script articles
  // from English runs (a bilingual local outlet's Arabic pieces are excluded,
  // but its English pieces stay and still get local priority). Falls back to the
  // unfiltered list if filtering would empty the pool.
  let urlList = Object.keys(scoreMap);
  if (language !== 'ar') {
    const filtered = urlList.filter(u => !titleIsArabic(itemMap[u].title));
    if (filtered.length > 0) urlList = filtered;
  }
  const articleList = urlList.map(url => itemMap[url]);

  // Regional categories rank LOCAL coverage above international coverage.
  const region = isRegional ? category : null;

  // Compute echo scores: tier-1 vs non-tier-1 (and local outlets when regional).
  const echoScores = computeEchoScores(articleList, region);
  const echoMap = {};
  urlList.forEach((url, i) => { echoMap[url] = echoScores[i]; });

  // ── Ranking ────────────────────────────────────────────────────────────────
  // Non-regional: tier-1 echo (×15) + other echo (×3) + own-tier-1 (+8) + position.
  // Regional (local-first): local sources outrank ALL international coverage, then
  // echo orders within each band — producing the desired order:
  //   1. national agency / local tier-1, most echoed
  //   2. national agency / local tier-1, less echoed
  //   3. international tier-1, most echoed
  //   4. international tier-1, less echoed
  const scoreFor = (url) => {
    const e = echoMap[url];
    if (region) {
      if (isLocalSource(url, region, itemMap[url]?.source)) {
        // Weight multi-local echo heavily and the national-agency bonus lightly, so a
        // story carried by several local outlets outranks a solo national-wire item
        // (prevents the national agency from dominating the feed).
        return 1000 + (e.localCount || 0) * 45 + (isNationalAgency(url, region) ? 12 : 0) + scoreMap[url];
      }
      if (isTier1(url, itemMap[url]?.source)) return 200 + e.tier1Count * 10 + scoreMap[url];
      return (e.totalCount - 1) * 3 + scoreMap[url]; // non-local, non-tier-1 — filler
    }
    // Two-key sort: (1) any tier-1 source in cluster (desc), (2) total echo count (desc),
    // (3) Serper position signal as tiebreaker within equal echo counts.
    const hasTier1 = e.tier1Count > 0 ? 1 : 0;
    return hasTier1 * 100_000 + e.totalCount * 10 + scoreMap[url];
  };
  const sorted = urlList.sort((a, b) => scoreFor(b) - scoreFor(a)).map(url => itemMap[url]);

  // Format context — annotate stories so Claude immediately knows coverage breadth.
  const context = sorted.map((item, i) => {
    const url    = item.link;
    const echo   = echoMap[url] || { tier1Count: 0, totalCount: 1, localCount: 0 };
    const t1     = echo.tier1Count;
    const total  = echo.totalCount;
    let label;
    if (region) {
      const lc = echo.localCount || 0;
      if (isLocalSource(url, region, item.source)) {
        label = isNationalAgency(url, region)
          ? (lc >= 2 ? `[NATIONAL AGENCY — ${lc} LOCAL OUTLETS — TOP LOCAL STORY] ` : `[NATIONAL AGENCY] `)
          : (lc >= 2 ? `[${lc} LOCAL OUTLETS — TOP LOCAL STORY] ` : `[LOCAL OUTLET] `);
      } else if (t1 >= 1) {
        label = `[INTERNATIONAL TIER-1${t1 >= 2 ? ` — ${t1} OUTLETS` : ''}] `;
      } else {
        label = total >= 3 ? `[${total} OUTLETS] ` : '';
      }
    } else {
      label = t1 >= 3   ? `[${total} OUTLETS — ${t1} TIER-1 — MAJOR STORY] `
            : t1 >= 1   ? `[${total} OUTLETS — ${t1} TIER-1] `
            : total >= 4 ? `[${total} OUTLETS — MAJOR STORY] `
            : total >= 2 ? `[${total} OUTLETS] `
            : '';
    }
    return `${label}[${i + 1}] Title: ${item.title}\nSource: ${cleanOutletName(item.source, url)}\nDate: ${item.date || 'recent'}\nURL: ${url}\nSummary: ${item.snippet || ''}`;
  }).join('\n\n');

  // Return both formatted context (for Claude) and raw article metadata (for audit storage)
  const articles = sorted.map(item => ({
    title:    item.title    || '',
    source:   cleanOutletName(item.source, item.link),
    date:     item.date     || '',
    url:      item.link     || '',
    snippet:  item.snippet  || '',
    // Never persist base64 data URIs — store the URL only if it's a real http URL
    imageUrl: (item.imageUrl || '').startsWith('http') ? item.imageUrl : '',
  }));

  return { context, articles };
}

// ── Corpus retrieval: lanes 1, 2 and 3 ───────────────────────────────────────
//
// The alternative to buildSearchContext. Same inputs, same return shape — { context,
// articles } — so it is a drop-in and, more importantly, directly comparable: the admin
// Compare tab runs both over the same category and shows the difference.
//
// The difference in kind: buildSearchContext asks a search engine "what happened today?"
// and hopes the phrasing was right. This asks each trusted outlet "what did you publish
// today?", which has an exact answer and can only return an outlet we named.

// Google News caps a feed request; asking per outlet is one request each either way.
async function fetchFeedItems(url, outletName, domain) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RadioNewsBot/1.0; +https://the-ai-rundown.vercel.app)' },
      redirect: 'follow', signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return [];
    const items = parseRssFeed(await r.text());
    return items.filter(it => it.title && it.link).map(it => ({
      title: it.title,
      link: it.link,
      source: outletName,
      domain,
      date: it.date ? it.date.toISOString() : '',
      publishedAt: it.date ? it.date.getTime() : null,
      // Google News puts an <a href> blob in <description>, not prose. Strip markup and
      // treat what is left as body text only if it actually reads as text — otherwise the
      // link markup counts as a body and a headline-only story looks like a sourced one.
      snippet: (() => {
        const plain = (it.snippet || '').replace(/<[^>]+>/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
        return plain.length > 60 ? plain.slice(0, 1200) : '';
      })(),
    }));
  } catch { return []; }
}

// Lane 2 — ask Google News for one named outlet's last day. `when:1d` pins the window at
// source, which the section feeds cannot do. The item link is a news.google.com redirect,
// but we already know the publisher because we asked for it by name.
function googleOutletFeedUrl(domain, gl, lang) {
  const q = encodeURIComponent(`site:${domain} when:1d`);
  const hl = lang === 'ar' ? 'ar' : 'en-US';
  const ceid = lang === 'ar' ? `${gl}:ar` : `${gl}:en`;
  return `https://news.google.com/rss/search?q=${q}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

function googleSectionFeedUrl(section, lang) {
  const hl = lang === 'ar' ? 'ar' : 'en-US';
  const gl = lang === 'ar' ? 'EG' : 'US';
  const ceid = lang === 'ar' ? 'EG:ar' : 'US:en';
  return `https://news.google.com/rss/headlines/section/topic/${section}?hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

// Google News titles arrive as "Headline - Publisher"; the RSS also carries <source>, which
// parseRssFeed does not pick up. Splitting the title is enough to attribute, and the
// allowlist check below is what actually enforces tier-one.
function splitGoogleTitle(title) {
  const i = title.lastIndexOf(' - ');
  return i > 20 ? { title: title.slice(0, i).trim(), publisher: title.slice(i + 3).trim() } : { title, publisher: '' };
}

// ── Lane 4b: read the article ────────────────────────────────────────────────
// Lanes 2 and 3 return a headline and nothing else — Google News descriptions are a link,
// not prose — so for most local stories the model would otherwise be writing from a
// headline. That is exactly how a 25-word fragment about Bab-el-Mandeb became two
// confident bullets about chokepoints and shipping tariffs.
//
// Three rules, all of them limits rather than capabilities:
//   · only where the outlet's own robots.txt permits it (see the registry's `fetch` flag)
//   · only the articles that actually became stories, not the whole pool — fetching all 57
//     costs 57% more and means sixty page requests a day at each outlet instead of twenty
//   · stop at any paywall or gate, and never work around one
const PAYWALL_SIGNALS = /subscribe to (continue|read)|sign in to (read|continue)|already a subscriber|this article is for subscribers|register to continue/i;

async function fetchArticleBody(url) {
  // Lane 2 and 3 links point at news.google.com, and Google no longer exposes the publisher
  // URL behind them: the token does not decode and the page carries no static link. So those
  // articles are unfetchable by construction, however permissive the outlet is — worth
  // distinguishing from an outlet that said no, because the fixes are different.
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (h === 'news.google.com' || h.endsWith('.google.com')) return { text: null, reason: 'google-redirect-unresolvable' };
  } catch { return { text: null, reason: 'bad-url' }; }
  if (!mayFetchBody(url)) return { text: null, reason: 'outlet-disallows' };
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RadioNewsBot/1.0; +https://the-ai-rundown.vercel.app)' },
      redirect: 'follow', signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return { text: null, reason: 'http-' + r.status };
    const html = await r.text();
    if (PAYWALL_SIGNALS.test(html)) return { text: null, reason: 'paywalled' };

    const stripped = html.replace(/<(script|style|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    const paras = [...stripped.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(m => decodeXmlEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
      .filter(t => t.length > 40);
    const text = paras.join(' ').slice(0, 4000);
    // A handful of words is boilerplate or a JS shell, not an article.
    return text.length > 250 ? { text, reason: 'ok' } : { text: null, reason: 'too-short' };
  } catch { return { text: null, reason: 'fetch-failed' }; }
}

// Enrich the stories we are actually going to write about. `variants` carries the other
// outlets that ran the same story, so when the first one blocks us we try a sibling that
// does not — a story on both Khaleej Times (blocks Claude) and The National (does not)
// should be read from The National and credited to both.
async function enrichWithBodies(articles, limit = 12) {
  const targets = articles.slice(0, limit);
  await Promise.all(targets.map(async (a) => {
    if ((a.snippet || '').length > 400) { a.bodySource = 'feed'; return; }   // lane 1 already gave us prose
    const candidates = [{ link: a.link, source: a.source }, ...(a.variants || [])];
    for (const c of candidates) {
      const { text, reason } = await fetchArticleBody(c.link);
      if (text) {
        a.snippet = text;
        a.bodySource = c.link === a.link ? 'fetched' : 'sibling';
        a.bodyFrom = c.source;
        return;
      }
      a.bodyReason = reason;
    }
    a.bodySource = 'none';
  }));
  articles.slice(limit).forEach(a => { if (!a.bodySource) a.bodySource = (a.snippet || '').length > 400 ? 'feed' : 'not-attempted'; });
  return articles;
}

const CORPUS_WINDOW_HOURS = { Morning: 24, Evening: 14 };

// `withSerper` defaults on. Search earns a place here for a reason the first draft of this
// design missed: asking Google for `site:naharnet.com when:1d` and searching Google for
// Lebanon news hit the index differently, so search returns tier-one articles the per-outlet
// query does not. Measured on 12 Sep: six tier-one Lebanese stories — Naharnet and L'Orient,
// both outlets lane 2 already asks by name — appeared only in Serper's results.
//
// What made search unusable before was never the search; it was that its output went
// unfiltered into the digest, which is how a Kyrgyz aggregator ended up cited. Put it behind
// the same allowlist gate lane 3 goes through and it becomes a discovery funnel: good at
// finding, not trusted to choose.
async function buildCorpusContext(category, day, language = 'en', timeSlot = 'Morning', withSerper = true) {
  const sources = sourcesFor(category, language);
  const section = GOOGLE_SECTIONS[category];
  const jobs = [];

  // Lane 1 — the outlet's own feed, where it still runs one.
  for (const s of sources.filter(x => x.lane === 1)) {
    jobs.push(fetchFeedItems(s.feed, s.name, s.domain).then(items => items.map(i => ({ ...i, lane: 1 }))));
  }
  // Lane 2 — the outlet via Google, by name.
  for (const s of sources.filter(x => x.lane === 2)) {
    jobs.push(fetchFeedItems(googleOutletFeedUrl(s.domain, s.gl, s.lang), s.name, s.domain)
      // snippet dropped: Google's <description> is a link whose text is the headline and the
      // publisher, which survives a length check while telling us nothing the title does not.
      .then(items => items.map(i => ({ ...i, lane: 2, title: splitGoogleTitle(i.title).title, snippet: '' }))));
  }
  // Lane 3 — Google's section, advisory. Publisher comes from the title suffix, and any
  // outlet not on the allowlist is dropped below, so this cannot smuggle anyone in.
  if (section) {
    jobs.push(fetchFeedItems(googleSectionFeedUrl(section, language), '', '')
      .then(items => items.map(i => {
        const { title, publisher } = splitGoogleTitle(i.title);
        return { ...i, lane: 3, title, source: publisher, snippet: '' };
      })));
  }

  // Lane 4 — Serper, as a discovery funnel. Everything it returns is matched against the
  // registry by domain below and dropped otherwise, so it can contribute articles but never
  // an outlet we have not vetted.
  if (withSerper) {
    const catQuery = language === 'ar'
      ? (ARABIC_CATEGORY_QUERIES[category] || category)
      : (CATEGORY_SEARCH_QUERIES[category] || category);
    jobs.push(
      buildSearchContext(catQuery, day, language, REGIONAL_CATEGORIES_SET.has(category), category)
        .then(r => (r.articles || []).map(a => ({
          title: a.title, link: a.url, source: a.source, domain: '',
          date: a.date || '', publishedAt: null, snippet: a.snippet || '', lane: 4,
        })))
        .catch(() => [])
    );
  }

  const raw = (await Promise.all(jobs)).flat();

  // ── Tier-one at ingestion ────────────────────────────────────────────────
  // Lanes 1 and 2 are tier-one by construction — we named the outlet. Lane 3 is not, so
  // its items are matched against the registry by publisher name and dropped otherwise.
  // This is the line that makes an Open.kg or a Killeen Daily Herald impossible rather
  // than merely filtered out at the end.
  const byName = new Map(TIER1_SOURCES.map(s => [s.name.toLowerCase(), s]));
  const kept = [];
  let droppedNonTier1 = 0, droppedStale = 0, droppedOffLang = 0;
  const cutoff = Date.now() - (CORPUS_WINDOW_HOURS[timeSlot] || 24) * 3600 * 1000;

  for (const a of raw) {
    if (a.lane === 3) {
      const hit = byName.get((a.source || '').toLowerCase());
      if (!hit) { droppedNonTier1++; continue; }
      a.domain = hit.domain;
    }
    if (a.lane === 4) {
      // Serper returns a real publisher URL, so match on domain — stricter and less
      // ambiguous than the name matching lane 3 needs.
      const hit = sourceForUrl(a.link);
      if (!hit) { droppedNonTier1++; continue; }
      a.domain = hit.domain;
      a.source = hit.name;
      // Serper's own age label is the only freshness signal its articles carry.
      if (!isArticleFresh(a.date)) { droppedStale++; continue; }
    }
    // Freshness from a real publish timestamp, not a search engine's crawl date.
    if (a.publishedAt && a.publishedAt < cutoff) { droppedStale++; continue; }
    // Keep the English feed English and the Arabic feed Arabic.
    const isAr = titleIsArabic(a.title);
    if (language === 'ar' ? !isAr : isAr) { droppedOffLang++; continue; }
    kept.push(a);
  }

  // ── Dedupe ───────────────────────────────────────────────────────────────
  // Same story reached by two lanes is one row. Keyed on the title, because the URLs
  // differ by lane — a publisher link from lane 1 and a Google redirect from lane 2 are
  // the same article. Lane 1 wins ties: it carries the most text.
  const seen = new Map();
  for (const a of kept.sort((x, y) => x.lane - y.lane)) {
    const key = (a.title || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, '').slice(0, 70);
    if (!key) continue;
    if (seen.has(key)) {
      const first = seen.get(key);
      first.alsoSeenIn.add(a.lane);
      // Kept so a blocked outlet can fall back to one that allows reading.
      if (a.link !== first.link) first.variants.push({ link: a.link, source: a.source, domain: a.domain });
      continue;
    }
    seen.set(key, { ...a, alsoSeenIn: new Set([a.lane]), variants: [] });
  }
  const articles = [...seen.values()];

  // ── Group into stories ───────────────────────────────────────────────────
  // The step that was missing, and the one that made everything downstream wrong.
  //
  // Dedupe above only merges IDENTICAL headlines, which is the right job for "the same
  // article arrived via two lanes" and no use at all for "sixteen outlets covered the same
  // event in their own words". Twelve articles about the Saudi pipeline attack produced
  // twelve distinct keys. computeEchoScores knew they were one story — it scored each of
  // them 13 to 16 — but it only ever wrote a number onto each article and never grouped
  // them, so the knowledge was thrown away between the two steps.
  //
  // Consequences, all of which this fixes: ranking was dominated by whichever event had the
  // most variants, so the top twelve slots were one story; the body-fetch budget went twelve
  // times to that story and never to anything else that happened; and **Perspectives
  // differ** — which must contrast how named outlets framed the same event — had no way to
  // see that AP, Al Jazeera and the Economist were describing one thing.
  const stories = [];
  for (const a of articles) {
    const toks = new Set(sigTokens(a.title));
    if (toks.size < 2) { stories.push({ lead: a, members: [a], tokens: toks }); continue; }
    // Three shared significant words, not two. Two is what computeEchoScores uses for a
    // loose "is this echoed" signal; for merging it is too eager — "Saudi" plus "Iran" would
    // fold unrelated stories together, and a wrong merge silently deletes a story.
    const hit = stories.find(st => [...toks].filter(t => st.tokens.has(t)).length >= 3);
    if (hit) {
      hit.members.push(a);
      toks.forEach(t => hit.tokens.add(t));
      // The lead is the member most worth reading: prose already in hand beats a headline,
      // and a fetchable publisher URL beats a Google redirect we cannot resolve.
      const better = (x, y) => ((x.snippet || '').length > 400 ? 2 : 0) + (x.lane <= 1 ? 1 : 0)
                             > ((y.snippet || '').length > 400 ? 2 : 0) + (y.lane <= 1 ? 1 : 0);
      if (better(a, hit.lead)) hit.lead = a;
    } else {
      stories.push({ lead: a, members: [a], tokens: toks });
    }
  }

  // A story's weight is the number of DISTINCT OUTLETS carrying it — not the number of
  // articles, so one outlet filing five updates does not outrank five outlets filing once.
  for (const st of stories) {
    st.outlets = [...new Set(st.members.map(m => m.source).filter(Boolean))];
    st.outletCount = st.outlets.length;
    st.publishedAt = Math.max(...st.members.map(m => m.publishedAt || 0));
  }
  stories.sort((a, b) => (b.outletCount - a.outletCount) || (b.publishedAt - a.publishedAt));

  // ── Read the stories we are going to write about ─────────────────────────
  // Several members per story, not one. Perspectives differ needs more than a single
  // outlet's account, and a story carried by sixteen outlets is exactly where framing
  // diverges most. Three distinct outlets per story is enough to contrast and keeps the
  // fetch count roughly where it was — twelve stories x up to 3 rather than twelve copies
  // of one event.
  const TOP_STORIES = 12, PER_STORY = 3;
  const toRead = [];
  for (const st of stories.slice(0, TOP_STORIES)) {
    const byOutlet = new Map();
    for (const m of st.members) if (!byOutlet.has(m.source)) byOutlet.set(m.source, m);
    st.readable = [...byOutlet.values()].slice(0, PER_STORY);
    toRead.push(...st.readable);
  }
  await enrichWithBodies(toRead, toRead.length);

  // Flattened back to an article list for the callers that still expect one, lead first so
  // the ordering reflects stories rather than duplicates.
  const articlesOut = stories.map(st => ({ ...st.lead, outletCount: st.outletCount,
    storyOutlets: st.outlets, memberCount: st.members.length }));

  // Headline-only is stated, not hidden. A story we could not read is marked as such in the
  // context so the model has no licence to elaborate on it — the alternative is what we have
  // now, where a headline and a link silently become three confident bullets.
  // One entry per STORY, carrying each outlet's own account of it. That shape is what the
  // digest prompt has always asked for and never been given: Coverage wants every outlet on
  // the story, and Perspectives differ wants to contrast how they framed it. Handing the
  // model twelve separate rows about one pipeline attack could only ever produce twelve
  // headlines or an invented contrast.
  const context = stories.map((st, i) => {
    const label = st.outletCount >= 4 ? `[${st.outletCount} OUTLETS — MAJOR STORY] `
                : st.outletCount >= 2 ? `[${st.outletCount} OUTLETS] ` : '';
    const accounts = (st.readable || [st.lead]).map(m => {
      const body = (m.snippet || '').trim();
      return body
        ? `  — ${m.source} (${m.link})\n    ${body}`
        : `  — ${m.source} (${m.link})\n    [HEADLINE ONLY: "${m.title}" — the article text could not be retrieved]`;
    }).join('\n');
    const unread = st.members.length > (st.readable || []).length
      ? `\n  also carried by: ${st.outlets.filter(o => !(st.readable || []).some(r => r.source === o)).join(', ')}`
      : '';
    const anyBody = (st.readable || []).some(m => (m.snippet || '').trim());
    return `${label}[${i + 1}] ${st.lead.title}\nDate: ${st.lead.date || 'recent'}\n`
         + `Accounts from ${(st.readable || []).length} of ${st.outletCount} outlet(s):\n${accounts}${unread}`
         + (anyBody ? '' : '\n  [NO ARTICLE TEXT for this story — write only what the headlines above support, and omit Perspectives differ rather than inferring one.]');
  }).join('\n\n');

  return {
    context,
    articles: articlesOut.map(a => ({
      title: a.title, source: a.source, date: a.date, url: a.link,
      snippet: a.snippet, lane: a.lane, outletCount: a.outletCount, domain: a.domain,
      storyOutlets: a.storyOutlets, memberCount: a.memberCount,
      bodySource: a.bodySource || 'not-attempted', bodyFrom: a.bodyFrom || null, bodyReason: a.bodyReason || null,
    })),
    stats: {
      fetched: raw.length,
      kept: articlesOut.length,
      articlesBeforeGrouping: articles.length,
      storiesAfterGrouping: stories.length,
      droppedNonTier1, droppedStale, droppedOffLang,
      dedupedAway: kept.length - articles.length,
      groupedAway: articles.length - stories.length,
      byLane: articlesOut.reduce((m, a) => (m[a.lane] = (m[a.lane] || 0) + 1, m), {}),
      outlets: [...new Set(articlesOut.map(a => a.source))].length,
      // How often we are writing from a headline alone — the number Roy asked to see.
      body: toRead.reduce((m, a) => {
        m[a.bodySource || 'none'] = (m[a.bodySource || 'none'] || 0) + 1;
        return m;
      }, {}),
      // Per STORY now, which is the number that matters: a story is readable if any of its
      // outlets gave us text, and only fully unreadable ones force a headline-only digest.
      storiesRead: stories.slice(0, TOP_STORIES).filter(st => (st.readable || []).some(m => (m.snippet || '').trim())).length,
      storiesTried: Math.min(TOP_STORIES, stories.length),
      storiesWithMultipleAccounts: stories.slice(0, TOP_STORIES)
        .filter(st => (st.readable || []).filter(m => (m.snippet || '').trim()).length >= 2).length,
      headlineOnly: stories.slice(0, TOP_STORIES).filter(st => !(st.readable || []).some(m => (m.snippet || '').trim())).length,
      bodyFailures: toRead.filter(a => a.bodySource === 'none')
        .map(a => ({ source: a.source, reason: a.bodyReason || 'unknown', title: (a.title || '').slice(0, 60) })),
      // Per lane, because the overall median is misleading: lane 2 carries no body text at
      // all, so a pool that is mostly lane 2 looks thin even when its lane-1 half is rich.
      medianTextByLane: [1, 2, 3].reduce((m, lane) => {
        const l = articles.filter(a => a.lane === lane).map(a => (a.snippet || '').length).sort((x, y) => x - y);
        if (l.length) m[lane] = l[Math.floor(l.length / 2)];
        return m;
      }, {}),
    },
  };
}

// ─── Feature flag — set to false to revert to single-content generation ───────
const GENERATE_STORIES_CONTENT = true;

// Shared Claude caller — used by both digest and stories generators
async function callClaude(prompt, maxTokens = 4000, retries = 3) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (response.status === 429 && retries > 0) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '65', 10);
    console.log(`⏳ Rate limited. Waiting ${retryAfter}s (${retries} retries left)...`);
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    return callClaude(prompt, maxTokens, retries - 1);
  }
  if (!response.ok) {
    const errData = await response.json();
    throw new Error(`Claude API error: ${response.status} - ${JSON.stringify(errData)}`);
  }
  return response.json();
}

// Detect when Claude returned an error/refusal instead of a news digest
function isClaudeErrorResponse(text) {
  const errorPhrases = [
    'no search results',
    'search results.*empty',
    'search results.*section is empty',
    'no articles.*provided',
    'haven\'t provided any',
    'i notice that no',
    'i appreciate.*but i notice',
    'i appreciate.*however.*i notice',
    'i appreciate.*but i\'m unable',
    'unable to complete this task',
    'no actual.*search results',
    'articles.*provided in your message',
    'actual content to synthesize',
    'no content.*to.*synthesize',
    'results section is empty',
    'please provide.*articles',
    'would need.*actual',
    'i don\'t see any search',
    'i notice.*no search',
  ];
  const lower = text.toLowerCase().slice(0, 600);
  return errorPhrases.some(p => new RegExp(p).test(lower));
}

// Post-process generated digest: strip non-tier-1 outlets from every Coverage: line.
// Keeps the content Claude wrote; only filters what gets attributed and displayed.
// If a story has zero tier-1 sources, keeps up to 2 best-available outlets so
// Coverage is never blank (rare edge case for niche category stories).
function filterCoverageTier1(content, region = null) {
  return content.replace(
    /(\*\*Coverage:\*\*)(.*)/g,
    (_, label, rest) => {
      const links = [...rest.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)];
      // isTier1's second arg is required for Google News redirect links (google.com/goto?
      // url=…) — the actual publisher domain isn't visible in the URL itself, so it's only
      // classified correctly by matching the outlet's display name against tier1DisplayNames().
      // Every search result comes back through exactly this kind of redirect (see
      // buildSearchContext / google.serper.dev/news), so omitting the name here made
      // isTier1 return false for every single link, tier1Links always came back empty, and
      // this silently fell through to "keep the first 2 links, whatever they are" — letting
      // non-tier1 outlets like The Hill sit right next to a real tier-1 source in Coverage.
      const localLinks = region ? links.filter(([, name, url]) => isLocalSource(url, region, name)) : [];
      const tier1Links = links.filter(([, name, url]) => isTier1(url, name));
      // On a regional feed, "best available" is not a safe last resort. A Lebanon story whose
      // only search hit was a Texas local paper running wire copy was attributed to the
      // Killeen Daily Herald — the fallback below did exactly what it says, and the result
      // read as though the feed sources Lebanon from central Texas. Local first, then
      // international tier-1, then nothing: a story with no credible outlet behind it is
      // better shown with no Coverage line than with a misleading one. The line is optional
      // downstream — the readers render outlets only when there are outlets.
      const kept = localLinks.length > 0 ? localLinks
        : tier1Links.length > 0 ? tier1Links
        : region ? [] : links.slice(0, 2);
      if (kept.length === 0) return '';
      const line = kept.map(([, name, url]) => `[${name}](${url})`).join(' · ');
      return `${label} ${line}`;
    }
  );
}

// Clean raw Claude output: strip filler lines, extract from first heading
function cleanRawSummary(rawSummary) {
  if (isClaudeErrorResponse(rawSummary)) {
    throw new Error('Claude returned an error response instead of a news digest — search results were likely empty');
  }
  const linesToRemove = [/^I['']ll search\b/i, /^Let me search\b/i, /^Here is a summary\b/i, /^The most recent major\b/i];
  const noFiller = rawSummary.split('\n').filter(line => !linesToRemove.some(re => re.test(line.trim()))).join('\n');
  const allLines = noFiller.split('\n');
  const firstHeadingIdx = allLines.findIndex(l => /^#{1,3}[\s\[]/.test(l) || /^#{1,3}$/.test(l.trim()));
  const disclaimerLines = firstHeadingIdx > 0 ? allLines.slice(0, firstHeadingIdx) : [];
  const storyLines = firstHeadingIdx > 0 ? allLines.slice(firstHeadingIdx) : allLines;
  const fullDisclaimer = disclaimerLines.map(l => l.trim()).filter(Boolean).join(' ');
  const usefulSentence = (fullDisclaimer.match(/I found that[^.]+\./i) || [])[0] || '';
  const joined = storyLines.join('\n').replace(/^(#{1,3})\s*\n(?!\s*\n)/gm, '$1 ');
  const fixedHeadings = joined
    .replace(/^(#{1,3} )(?!\[)([^\n]+\]\(https?:\/\/)/gm, '$1[$2')
    .replace(/^(#{1,3} )(.+)\n(https?:\/\/[^\s]+)/gm, '$1[$2]($3)');
  return (usefulSentence ? `_${usefulSentence}_\n\n` : '') + fixedHeadings;
}

async function generateNews(category, day, timeSlot, retries = 3, searchQuery = null, prebuiltContext = null, language = 'en') {
  const categoryQuery = searchQuery || (language === 'ar' ? (ARABIC_CATEGORY_QUERIES[category] || category) : (CATEGORY_SEARCH_QUERIES[category] || (category === 'All' ? 'top breaking news today' : category)));
  const dayInfo = day === getTodayDate() ? 'today' : `on ${day}`;
  const isRegional = REGIONAL_CATEGORIES_SET.has(category);

  console.log(`Generating digest for ${category} on ${day} at ${timeSlot}${language === 'ar' ? ' [AR]' : ''}`);

  // Fetch search results — reuse prebuiltContext if provided (shared with stories)
  let searchContext, sourceArticles = [];
  if (prebuiltContext) {
    searchContext = prebuiltContext;
  } else {
    const { context, articles } = await buildSearchContext(categoryQuery, day, language, isRegional, category);
    searchContext = context;
    sourceArticles = articles;
  }
  const serper_searches = prebuiltContext ? 0 : 5;
  const serper_cost = serper_searches * 0.001;

  const arabicInstruction = language === 'ar'
    ? `\n\nIMPORTANT: Write the entire digest in Modern Standard Arabic (اللغة العربية الفصحى). All headlines, bullet points, "Perspectives differ" text, and "Why this matters" text must be in Arabic. HOWEVER, keep the following structural markers in English exactly as shown — do NOT translate them: **Coverage:**, **Perspectives differ:**, **Why this matters:**, ## Sources. Keep source outlet names and URLs in their original form.`
    : '';

  // Count is a soft guide, NOT a target to pad toward — consolidation always wins.
  const storyCountInstruction = isRegional
    ? 'Cover every genuinely DISTINCT story the results support — usually 6–10, and fewer is fine when one big situation dominates the day. NEVER reach a number by splitting one situation into several stories.'
    : 'Cover every genuinely DISTINCT story the results support — usually 6–9. NEVER reach a number by splitting one situation into several stories.';

  // ── Prioritisation rules + region gate ─────────────────────────────────────
  // Regional categories rank LOCAL coverage first and drop off-region stories;
  // non-regional categories use the global tier-1 echo prioritisation.
  const regionSubject = REGION_SUBJECT[category];
  const regionGate = isRegional && regionSubject
    ? `\n\nREGION FILTER (CRITICAL): Only include stories specifically about ${regionSubject} — its government, economy, society, security, diplomacy, or people. DISCARD any story that is not centrally about ${regionSubject}, even if it comes from a major international outlet or is widely covered globally.`
    : '';

  const prioritisationRules = isRegional
    ? `PRIORITISATION RULES (LOCAL NEWS):
1. Articles labelled [NATIONAL AGENCY], [N LOCAL OUTLETS — TOP LOCAL STORY], or [LOCAL OUTLET] are LOCAL coverage — include these FIRST, prioritising stories covered by the most local outlets.
2. Then include [INTERNATIONAL TIER-1] stories, but ONLY when they are specifically about ${regionSubject || 'the region'}.
3. Prefer stories covered by multiple outlets over single-source stories.
4. Single-source stories should only be included if clearly significant and from a national agency or local tier-1 outlet.
5. DIVERSITY (REQUIRED): A local feed must reflect the FULL life of ${regionSubject || 'the region'}, not only politics, war, security, and diplomacy. Even on heavy news days, you MUST include the non-political local stories the results support — business & economy, sports, culture & entertainment, society & daily life, health, education, infrastructure & transport, weather, notable local events. Aim for a clear spread of topics across the feed; do NOT return an all-politics feed when softer local stories are present in the search results. A single dominant political situation = ONE story (per the consolidation rule), which leaves room for these other topics.`
    : `PRIORITISATION RULES:
1. Articles labelled with TIER-1 outlets (e.g. [3 OUTLETS — 3 TIER-1 — MAJOR STORY]) are globally significant — always include these first.
2. Articles with broad multi-outlet coverage (e.g. [4 OUTLETS — MAJOR STORY]) are widely reported — include these unless clearly less important than tier-1 stories.
3. Prefer stories covered by multiple outlets over single-source stories.
4. Single-source stories should only be included if clearly significant and from a tier-1 outlet.`;

  // Regional categories get the region gate; the three global ones that concentrate get a
  // spread rule. Nothing gets both — they pull in opposite directions.
  const spreadRule = !isRegional ? (SPREAD_RULES[category] || '') : '';

  const prompt = `You are a news analyst. Below are news articles about "${categoryQuery}" retrieved specifically for ${dayInfo} (${day}). Synthesize them into a detailed news digest.${regionGate}${spreadRule}${arabicInstruction}

SEARCH RESULTS:
${searchContext}

For each major story group, use this EXACT format — no introduction, no preamble:

## Synthesized neutral headline (your own words, not copied from any single source)
**Coverage:** [Outlet Name](exact-article-url) · [Outlet Name](exact-article-url) · [Outlet Name](exact-article-url) · [Outlet Name](exact-article-url) · ...
- Key fact or development, with context and nuance
- Another key detail — include numbers, names, and specifics where available
- Additional relevant detail or background
- For contested claims: "According to [source]..." or "[Party X] claims... while [Party Y] argues..."
**Perspectives differ:** Whenever two or more outlets, parties, or experts cover this story, explain in one or two sentences HOW their framing, emphasis, or interpretation differs — name the specific outlets or parties (e.g. "Al Jazeera frames the operation as aggression while The National stresses the ceasefire violation; Israeli officials call it a defensive strike"). Include this for every multi-source story unless the coverage is genuinely identical in angle. Omit ONLY when a single outlet covers the story.
**Why this matters:** One or two sentences on broader significance and implications.

CONSOLIDATION (TOP PRIORITY — overrides the story count): One ongoing situation = ONE story. If several articles cover different facets, incidents, angles, consequences, or updates of the SAME event, conflict, or negotiation, you MUST merge them into a single ## story whose bullets cover each facet and whose **Coverage:** lists ALL of those outlets together.
For example, a ceasefire deal, continued strikes despite it, the resulting civilian casualties, one side refusing to withdraw, residents returning to damaged homes, and reported truce violations are ALL the same story → ONE ## headline that LEADS with the core development (the ceasefire was agreed) and folds the strikes, casualties, and violations into its bullets, referencing every source — NOT six separate headlines, and NOT a headline that leads with the violations.
Before you finish, re-read your ## headlines: if any two describe the same situation from different angles, MERGE them. Every ## story must be a genuinely distinct topic.

HEADLINE FRAMING (applies after consolidation): When a merged story contains a major new development — a deal or ceasefire agreed, an agreement signed, a government formed, a leader elected, an offensive launched — ALONGSIDE its complications (violations, delays, disputes, casualties, pushback), the ## headline MUST state the development itself plainly and lead with it. Treat the complications as the tension inside the story (bullets and **Perspectives differ:**), never as the headline. Do NOT let a complication ("strikes undermine fragile truce", "violations threaten deal") replace or bury the underlying event ("Israel and Hezbollah agree to a ceasefire"). A reader must learn the central fact — that the thing happened — from the headline alone.

${storyCountInstruction} ${prioritisationRules}
Coverage must use real URLs from the search results provided. In **Coverage:**, only list outlets that are major international or regional news organisations — wire services (Reuters, AP), broadcasters (BBC, CNN, Al Jazeera), national newspapers (NYT, Guardian, WaPo, FT), and established regional outlets in TIER1_DOMAINS. Do NOT list niche blogs, legal/trade publications, local TV stations, aggregators, or any outlet whose primary audience is a single city or narrow profession. After all stories, include a sources section:

## Sources
- [Full article headline](exact-article-url)

Rules: Start with the first ## heading — no preamble. Headline is plain text — no URL on the ## line. Always include **Coverage:** immediately after each ##. CRITICAL: In **Coverage:**, list EVERY tier-1 outlet from the search results that covers this story. In **## Sources**, list every article URL used across all stories with its full headline as the link text. Complete all sentences. Never use Wikipedia as a source — skip any Wikipedia URLs entirely.

ACCURACY RULES (violations make the story wrong, not just imprecise):
- **Perspectives differ:** must contrast positions held by named tier-1 news organisations or official government/institutional sources only. Do NOT cite think-tanks, advocacy groups, regional institutes, or unnamed "international observers" — if no meaningful tier-1 contrast exists, omit the line entirely.
- Be precise about what type of agreement or deal is under discussion. A shipping/navigation deal and a nuclear deal are different things — do not conflate them in the headline or body, even when both tracks are active simultaneously.
- Do not attribute a quote or claim to an official unless a source in the search results directly attributes it to that person.`;

  const data = await callClaude(prompt, 5000);
  const rawSummary = data.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  const summary = filterCoverageTier1(cleanRawSummary(rawSummary), isRegional ? category : null);

  // Track usage
  if (data.usage) {
    const { input_tokens, output_tokens } = data.usage;
    const token_cost_usd = (input_tokens / 1_000_000) * 0.8 + (output_tokens / 1_000_000) * 4;
    const estimated_cost_usd = token_cost_usd + serper_cost;
    supabaseAdmin.from('api_usage').insert({
      service: 'anthropic', model: 'claude-haiku-4-5-20251001',
      input_tokens, output_tokens,
      web_searches: serper_searches, search_cost_usd: serper_cost, token_cost_usd, estimated_cost_usd,
      category, time_slot: timeSlot, content_type: 'digest',
      created_at: new Date().toISOString()
    }).then(({ error }) => {
      if (error) console.warn('Could not track API usage:', error.message);
    }, err => console.warn('Could not track API usage:', err.message));
  }

  return { summary, searchContext, sourceArticles };
}

// ── Evening incremental update ──────────────────────────────────────────────
// Evening no longer regenerates a category from scratch — it takes the digest Morning
// already published and asks Claude to fold in only what's genuinely new: merge a fresh
// development into its existing story (flagged Updated, same headline, new outlets
// appended to Coverage), append a genuinely new story at the end (flagged New), or
// reproduce an untouched story exactly as-is (flagged Unchanged). Reproducing every
// Morning story — even untouched ones — keeps this digest a complete, self-contained
// replacement rather than a diff, so the frontend shows Evening's row on its own instead
// of stitching two rows together (see the Evening-supersedes-Morning filter in App.js).
// Preserving Morning's story order — new stories only ever appended, never inserted or
// reordered — is also what keeps a story's position, and therefore its read status,
// stable across the Morning→Evening transition (see useListenHistory.js).
async function generateEveningUpdate(category, day, priorDigestContent, language = 'en') {
  const categoryQuery = language === 'ar' ? (ARABIC_CATEGORY_QUERIES[category] || category) : (CATEGORY_SEARCH_QUERIES[category] || (category === 'All' ? 'top breaking news today' : category));
  const isRegional = REGIONAL_CATEGORIES_SET.has(category);

  console.log(`Generating evening update for ${category} on ${day}${language === 'ar' ? ' [AR]' : ''}`);

  const { context: searchContext, articles: sourceArticles } = await buildSearchContext(categoryQuery, day, language, isRegional, category);
  const serper_searches = 5;
  const serper_cost = serper_searches * 0.001;

  const arabicInstruction = language === 'ar'
    ? `\n\nIMPORTANT: Write the entire digest in Modern Standard Arabic (اللغة العربية الفصحى). All headlines, bullet points, "Perspectives differ" text, and "Why this matters" text must be in Arabic. HOWEVER, keep the following structural markers in English exactly as shown — do NOT translate them: **Coverage:**, **Perspectives differ:**, **Why this matters:**, **Status:**, ## Sources. Keep source outlet names and URLs in their original form.`
    : '';

  const prompt = `You are a news analyst updating a digest that was already published earlier today. Below is the digest already published, followed by fresh search results for "${categoryQuery}" from later in the day.${arabicInstruction}

ALREADY PUBLISHED THIS MORNING:
${priorDigestContent}

FRESH SEARCH RESULTS:
${searchContext}

Produce an updated digest by working through the ALREADY PUBLISHED stories one at a time, in the SAME ORDER, then appending anything genuinely new:

1. For each already-published story, check whether the fresh search results contain a genuine new development for it — a real escalation, resolution, reaction, new figures, or fact that wasn't in the story before. Do NOT count an outlet simply re-reporting the same facts already in the story as a development.
   - If there IS a genuine new development: reproduce the story using the EXACT SAME headline text as published (copy it verbatim, do not reword it), keep every existing bullet, and add one or two new bullets covering only the new development. Extend its **Coverage:** line with the new outlet(s) — keep every outlet already listed, only add to it. End the story with a line **Status:** Updated
   - If there is NO genuine new development: reproduce the story completely unchanged — same headline, same bullets, same **Coverage:**, same **Perspectives differ:**/**Why this matters:** lines if present. End the story with a line **Status:** Unchanged
2. After all already-published stories, add any genuinely new story from the fresh search results that is NOT a continuation of one of them — a distinct topic not covered above. Write it in the normal digest format (own ## headline, **Coverage:**, bullets, **Perspectives differ:** / **Why this matters:** where applicable) and end it with **Status:** New
3. Never reorder, merge, drop, or rewrite an already-published story beyond what rule 1 allows. Never invent a development that the fresh search results don't support.

Use this EXACT format for every story:

## Headline
**Coverage:** [Outlet Name](exact-article-url) · [Outlet Name](exact-article-url) · ...
- Key fact or development
- Another key detail
**Perspectives differ:** (carry over or add per the normal rules — see below)
**Why this matters:** One or two sentences on broader significance.
**Status:** Updated | Unchanged | New

**Perspectives differ:** Whenever two or more outlets, parties, or experts cover a story, explain in one or two sentences HOW their framing, emphasis, or interpretation differs, naming the specific outlets or parties. Include for every multi-source story unless the coverage is genuinely identical in angle. Omit only when a single outlet covers the story.

Coverage must use real URLs from the fresh search results for any new outlets added; keep the original URLs for outlets carried over unchanged. Only list major international or regional news organisations — wire services, broadcasters, national newspapers, and established regional outlets. After all stories, include:

## Sources
- [Full article headline](exact-article-url)

List every article URL used across all stories (both carried-over and new) with its full headline as the link text. Rules: Start with the first ## heading — no preamble. Headline is plain text — no URL on the ## line. Always include **Coverage:** immediately after each ##, and **Status:** as the last line of each story. Complete all sentences. Never use Wikipedia as a source.

ACCURACY RULES (violations make the story wrong, not just imprecise):
- **Perspectives differ:** must contrast positions held by named tier-1 news organisations or official government/institutional sources only.
- Do not attribute a quote or claim to an official unless a source in the fresh search results directly attributes it to that person.`;

  const data = await callClaude(prompt, 5000);
  const rawSummary = data.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  const summary = filterCoverageTier1(cleanRawSummary(rawSummary), isRegional ? category : null);

  if (data.usage) {
    const { input_tokens, output_tokens } = data.usage;
    const token_cost_usd = (input_tokens / 1_000_000) * 0.8 + (output_tokens / 1_000_000) * 4;
    const estimated_cost_usd = token_cost_usd + serper_cost;
    supabaseAdmin.from('api_usage').insert({
      service: 'anthropic', model: 'claude-haiku-4-5-20251001',
      input_tokens, output_tokens,
      web_searches: serper_searches, search_cost_usd: serper_cost, token_cost_usd, estimated_cost_usd,
      category, time_slot: 'Evening', content_type: 'digest',
      created_at: new Date().toISOString()
    }).then(({ error }) => {
      if (error) console.warn('Could not track API usage:', error.message);
    }, err => console.warn('Could not track API usage:', err.message));
  }

  return { summary, searchContext, sourceArticles };
}

// ── Audit agent ──────────────────────────────────────────────────────────────
// Checks a generated digest against the exact search results it was written from —
// not general knowledge — flagging claims, numbers, names, or quotes that aren't
// traceable to that source text. Runs on the digest only: stories_content and briefing
// are reformatted FROM the digest (see generateStoriesContent/generateBriefing), not
// from the raw sources, so auditing them separately would just re-check the same facts
// twice for no extra safety. A cheap Haiku pass, not a second full generation.
//
// Failure of the audit itself (bad JSON, API error) must never block publishing — it
// returns null, and generateAndStoreCategory treats null the same as "not audited".
async function auditDigest(category, timeSlot, digestContent, searchContext) {
  const prompt = `You are a fact-checking editor. Below are the raw search results a news digest was supposed to be based on, and the digest itself. Check the digest ONLY against these search results — not your own general knowledge of the topic.

SEARCH RESULTS (ground truth):
${searchContext}

DIGEST TO CHECK:
${digestContent}

Find any claim, statistic, name, quote, or attributed statement in the digest that is NOT supported by the search results above. This includes: fabricated details, invented quotes, numbers that don't appear in or don't match the sources, and claims attributed to the wrong outlet or person. Do NOT flag stylistic choices, omissions, or reasonable synthesis/paraphrasing of what the sources say — only flag things that are actually unsupported or contradicted.

Respond with ONLY valid JSON, no other text, no markdown fences:
{"passed": true or false, "flags": [{"claim": "the exact sentence or phrase in question", "reason": "why it isn't supported by the search results"}]}

If every claim in the digest is grounded in the search results, return {"passed": true, "flags": []}.`;

  try {
    const data = await callClaude(prompt, 1500);
    const raw = data.content.filter(item => item.type === 'text').map(item => item.text).join('\n').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Judge did not return JSON');
    const parsed = JSON.parse(jsonMatch[0]);

    if (data.usage) {
      const { input_tokens, output_tokens } = data.usage;
      const token_cost_usd = (input_tokens / 1_000_000) * 0.8 + (output_tokens / 1_000_000) * 4;
      supabaseAdmin.from('api_usage').insert({
        service: 'anthropic', model: 'claude-haiku-4-5-20251001',
        input_tokens, output_tokens,
        web_searches: 0, search_cost_usd: 0, token_cost_usd, estimated_cost_usd: token_cost_usd,
        category, time_slot: timeSlot, content_type: 'audit',
        created_at: new Date().toISOString()
      }).then(({ error }) => {
        if (error) console.warn('Could not track audit API usage:', error.message);
      }, err => console.warn('Could not track audit API usage:', err.message));
    }

    return {
      passed: parsed.passed !== false,
      flags: Array.isArray(parsed.flags) ? parsed.flags : [],
      checked_at: new Date().toISOString(),
    };
  } catch (err) {
    console.warn(`⚠️  Audit failed for ${category}/${timeSlot} (not blocking publish):`, err.message);
    return null;
  }
}

// In-memory fallback so toggles work today even before `app_settings` exists —
// see the SQL note this ships with. Once that table exists, this becomes a warm cache
// only; the source of truth is always the Supabase read. Generic over any boolean
// setting key so the same pair backs both the audit toggle and the generation
// on/off switch below.
const settingsFallback = {};
let appSettingsTableMissing = false;

async function isSettingEnabled(key, defaultValue) {
  if (appSettingsTableMissing) return key in settingsFallback ? settingsFallback[key] : defaultValue;
  try {
    const { data, error } = await supabaseAdmin.from('app_settings').select('value').eq('key', key).maybeSingle();
    if (error) {
      if (error.code === 'PGRST205' || error.code === '42P01') {
        appSettingsTableMissing = true;
        console.warn(`⚠️  'app_settings' table not found — toggles are in-memory only until it's created. Run in Supabase:\n  CREATE TABLE IF NOT EXISTS app_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz DEFAULT now());`);
      }
      return key in settingsFallback ? settingsFallback[key] : defaultValue;
    }
    if (!data) return defaultValue; // never set — use the default, don't assume off
    const enabled = data.value === true || data.value?.enabled === true;
    settingsFallback[key] = enabled; // keep the fallback warm in case the table disappears mid-run
    return enabled;
  } catch {
    return key in settingsFallback ? settingsFallback[key] : defaultValue;
  }
}

async function setSettingEnabled(key, enabled) {
  settingsFallback[key] = enabled;
  try {
    const { error } = await supabaseAdmin.from('app_settings').upsert({ key, value: { enabled }, updated_at: new Date().toISOString() });
    if (error) {
      appSettingsTableMissing = true;
      return { persisted: false, warning: "Saved for this session only — 'app_settings' table doesn't exist yet." };
    }
    appSettingsTableMissing = false;
    return { persisted: true };
  } catch (err) {
    return { persisted: false, warning: err.message };
  }
}

const isAuditEnabled       = () => isSettingEnabled('audit_enabled', false);
const setAuditEnabled      = (enabled) => setSettingEnabled('audit_enabled', enabled);
// Default true — this switch is for deliberately pausing generation on non-testing
// days, not something that should silently start the pipeline off for anyone who
// hasn't touched it yet.
const isGenerationEnabled  = () => isSettingEnabled('generation_enabled', true);
const setGenerationEnabled = (enabled) => setSettingEnabled('generation_enabled', enabled);
// Narrower than the master switch above: only affects the *automated* Evening trigger
// (the scheduled GitHub Actions cron and the watchdog's self-correct) — manual "Generate
// Evening" clicks from the admin dashboard still work while this is off. Default true.
const isEveningAutoEnabled  = () => isSettingEnabled('evening_auto_enabled', true);
const setEveningAutoEnabled = (enabled) => setSettingEnabled('evening_auto_enabled', enabled);

// Generate shorter, punchier stories content by reformatting the already-generated digest.
// Using the digest (not raw search results) guarantees stories covers the exact same headlines.
async function generateStoriesContent(category, day, timeSlot, digestContent, language = 'en') {
  console.log(`Generating stories content for ${category} on ${day} at ${timeSlot}${language === 'ar' ? ' [AR]' : ''}`);

  const arabicInstruction = language === 'ar'
    ? `\n\nIMPORTANT: Write everything in Modern Standard Arabic (اللغة العربية الفصحى). All headlines, bullet points, and "Why this matters" text must be in Arabic. HOWEVER, keep the structural marker **Why this matters:** in English exactly as shown — do NOT translate it. Keep outlet names and URLs as-is.`
    : '';

  const prompt = `You are a news editor. Below is a detailed news digest. Convert every story in it into a short, punchy card suitable for audio listening and mobile reading.${arabicInstruction}

DIGEST:
${digestContent}

For each story in the digest, use this EXACT format — no preamble:

## [Use the EXACT same headline as the corresponding digest story — copy it verbatim, plain text. Do NOT shorten, rephrase, or invent a new headline.]
- One key fact — short, direct sentence under 20 words.
- Second key detail — short, direct sentence under 20 words.
- Third point if critical — short, direct sentence under 20 words.
**Summary:** Write 3–4 complete flowing sentences as a narrative paragraph — NOT a restatement of the bullets. Add the context, background, and nuance from the digest that the bullets leave out (history, causes, what's at stake, what happens next). This is the paragraph a reader wants when they tap for the full story, so it must read differently from and go beyond the bullets above. (REQUIRED — always include for every story.)
**Why this matters:** One sentence, maximum impact.
**Perspectives differ:** Carry this line over whenever the digest includes it for this story — keep the named outlets and the contrast, condensed to one clear sentence. Omit only if the digest has no perspectives line for that story.

Rules: Cover the same stories as the digest, in the same order. Start immediately with the first ## — no introduction, no Sources section, no Coverage lines. Each bullet is a single punchy sentence. The **Summary:** field is mandatory for every single story — never skip it.`;

  const data = await callClaude(prompt, 5000);
  const rawSummary = data.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  const summary = cleanRawSummary(rawSummary);

  // Track usage (search cost = 0, context reused from digest)
  if (data.usage) {
    const { input_tokens, output_tokens } = data.usage;
    const token_cost_usd = (input_tokens / 1_000_000) * 0.8 + (output_tokens / 1_000_000) * 4;
    supabaseAdmin.from('api_usage').insert({
      service: 'anthropic', model: 'claude-haiku-4-5-20251001',
      input_tokens, output_tokens,
      web_searches: 0, search_cost_usd: 0, token_cost_usd, estimated_cost_usd: token_cost_usd,
      category, time_slot: timeSlot, content_type: 'stories',
      created_at: new Date().toISOString()
    }).then(({ error }) => {
      if (error) console.warn('Could not track stories API usage:', error.message);
    }, err => console.warn('Could not track stories API usage:', err.message));
  }

  return summary;
}

// Generate a short spoken "category briefing" — a catch-up on the whole category for a
// quick read or a ~1 min listen. Length scales with the number of stories; see below.
async function generateBriefing(category, day, timeSlot, digestContent, language = 'en') {
  console.log(`Generating briefing for ${category} on ${day} at ${timeSlot}${language === 'ar' ? ' [AR]' : ''}`);

  const arabicInstruction = language === 'ar'
    ? `\n\nWrite the entire briefing in Modern Standard Arabic (اللغة العربية الفصحى).`
    : '';

  // Budget scales with how much there is to cover. A flat 90–120 words told the model to
  // lead with the biggest story and explicitly NOT to enumerate — so across eight or nine
  // stories it spent everything on one or two and dropped the rest, which is what the recap
  // was being criticised for. ~18 words per story gives every one a clause; the floor keeps
  // a thin category from reading as a stub, the cap keeps this inside its "1 min" promise
  // (~150 wpm, so 170 words ≈ 68s of speech).
  const storyCount = (digestContent.match(/^##\s+/gm) || []).length;
  const targetWords = Math.max(90, Math.min(170, Math.round(storyCount * 18)));

  const prompt = `You are a news anchor writing a short spoken briefing that catches a listener up on the "${category}" section.${arabicInstruction}

Below is today's full digest for this section${storyCount ? ` — ${storyCount} stories` : ''}:

${digestContent}

Write ONE cohesive briefing of about ${targetWords} words that catches the listener up on the WHOLE section — what is happening and why it matters — as if delivering a quick on-air catch-up.

Coverage is the priority: EVERY story in the digest above must appear, at minimum as a clause. Give the biggest story a sentence or two; give each remaining story at least a clause of its own. Do not spend the whole briefing on one or two stories and leave the rest out — a listener should finish it knowing everything that happened in this section, even if only in outline. Group related stories into a single sentence where that reads naturally.

Rules: Flowing prose in one or two short paragraphs — not a list. NO headings, NO bullet points, NO markdown, NO source names or URLs. Lead with the biggest story, then move through the rest. Conversational and clear, meant to be read aloud. Start immediately with the briefing text — no preamble, no title.`;

  const data = await callClaude(prompt, 600);
  // Same strip the period recaps get. The prompt asks for no headings and no bullets, but a
  // title line comes back often enough to be worth removing rather than only asking for —
  // and this text is read aloud, so a stray "# Technology Briefing" is a sentence the
  // narrator says out loud. (Rows generated before this still carry one; the reader strips
  // defensively too.)
  const text = stripRecapChrome(data.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));

  if (data.usage) {
    const { input_tokens, output_tokens } = data.usage;
    const token_cost_usd = (input_tokens / 1_000_000) * 0.8 + (output_tokens / 1_000_000) * 4;
    supabaseAdmin.from('api_usage').insert({
      service: 'anthropic', model: 'claude-haiku-4-5-20251001',
      input_tokens, output_tokens,
      web_searches: 0, search_cost_usd: 0, token_cost_usd, estimated_cost_usd: token_cost_usd,
      category, time_slot: timeSlot, content_type: 'briefing', created_at: new Date().toISOString()
    }).then(({ error }) => { if (error) console.warn('Could not track briefing API usage:', error.message); }, () => {});
  }

  return text;
}

// ── Period recaps: the week, and the month ────────────────────────────────────
//
// One per category, stored in news_summaries like everything else: under the category's own
// name, with time_slot 'Weekly' or 'Monthly' and `day` set to the period's LAST day. Nothing
// collides — the daily digests occupy 'Morning' and 'Evening' — and the existing read layer
// serves them with no new endpoint: mode=one&category=Technology&day=<end>&timeSlot=Weekly.
//
// They used to be a single recap across every section, stored under a `__period__` sentinel.
// That made them the one thing on the screen that did not belong to the topic you had
// selected, so a row offering "this week" beside a Technology story meant the whole app's
// week. Per category they answer the question the reader is actually asking.
//
// These are a curation, not a sweep. Even one category's week is dozens of stories, so the
// prompt is asked to pick what mattered and say why.
export const PERIOD_SLOTS = { Weekly: 7, Monthly: 0 };  // 0 = calendar month, computed below

function periodRange(period, endDay) {
  const end = new Date(`${endDay}T00:00:00Z`);
  const days = [];
  if (period === 'Monthly') {
    const y = end.getUTCFullYear(), m = end.getUTCMonth();
    const first = new Date(Date.UTC(y, m, 1));
    for (let d = new Date(first); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(d.toISOString().slice(0, 10));
    }
  } else {
    for (let i = 6; i >= 0; i--) {
      const d = new Date(end);
      d.setUTCDate(d.getUTCDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
  }
  return days;
}

// Headlines only. Feeding whole digests for a month would be hundreds of thousands of
// tokens and would bury the signal anyway — the judgement being asked for is "which of
// these mattered", and a headline plus its category is enough to make it.
function harvestHeadlines(rows) {
  const byCategory = {};
  for (const row of rows) {
    const heads = (row.content || '').split('\n')
      .filter(l => /^##\s+/.test(l))
      .map(l => l.replace(/^##\s+/, '').trim())
      .filter(Boolean);
    if (!heads.length) continue;
    byCategory[row.category] = byCategory[row.category] || new Set();
    heads.forEach(h => byCategory[row.category].add(h));
  }
  return byCategory;
}

// The prompt forbids headings and bullets; the model emits them anyway often enough that
// asking is not a control. This is: a title line would be read aloud verbatim by the
// narrator and shown as a stray heading in the reader, so it is stripped rather than hoped
// against. Bullets keep their text and lose the marker — a recap that arrives as a list is
// still readable prose once the dashes are gone.
function stripRecapChrome(text) {
  return (text || '')
    .split('\n')
    .filter(line => !/^\s*#{1,6}\s+/.test(line))          // drop heading lines outright
    .map(line => line.replace(/^\s*[-*•]\s+/, ''))         // demote bullets to sentences
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function generatePeriodRecap(period, endDay, language = 'en') {
  const days = periodRange(period, endDay);
  console.log(`Generating ${period} recaps ending ${endDay} (${days.length} days)${language === 'ar' ? ' [AR]' : ''}`);

  const { data: rows, error } = await supabaseAdmin
    .from('news_summaries')
    .select('category, day, content')
    .in('day', days)
    .in('time_slot', ['Morning', 'Evening'])   // the daily digests only — see below
    .eq('language', language)
    .is('user_id', null).is('shared_key', null)
    .not('category', 'in', '("__completed__","__period__")');
  if (error) throw new Error(`Could not read the period's digests: ${error.message}`);

  // The time_slot filter is load-bearing now that these are stored under real category
  // names. Before, period recaps lived under the `__period__` sentinel and the category
  // exclusion kept them out of their own source material; now a Weekly row for World News
  // sits under 'World News' like any digest, and without this filter next week's recap
  // would be written partly from last week's recap.
  const byCategory = harvestHeadlines(rows || []);

  // A listener gives one category's week about two minutes and its month about four — a
  // twelfth of the old all-sections budget, because this is now a twelfth of the material.
  const spec = period === 'Monthly'
    ? { words: 550, picks: 12, label: 'month' }
    : { words: 280, picks: 6,  label: 'week' };

  const arabicInstruction = language === 'ar'
    ? `\n\nWrite the entire recap in Modern Standard Arabic (اللغة العربية الفصحى).`
    : '';

  const results = [];
  for (const category of DEFAULT_CATEGORIES) {
    const heads = byCategory[category];
    if (!heads || !heads.size) {
      console.log(`  ⏭️  ${category} — no headlines in the window`);
      continue;
    }
    const total = heads.size;
    const source = [...heads].map(h => `- ${h}`).join('\n');

    const prompt = `You are a news anchor writing the ${spec.label}'s wrap-up on ${category} for a listener who may have missed days of it.${arabicInstruction}

Below are the ${category} headlines this ${spec.label} produced — ${total} in total:

${source}

Pick the ${spec.picks} or so that actually mattered and write a spoken recap of about ${spec.words} words.

This is a selection, not a summary of everything: ${total} stories cannot be covered in ${Math.max(1, Math.round(spec.words / 150))} minutes, and pretending otherwise produces a list nobody can follow. Choose on consequence — what changed, what a reasonable person would still be thinking about at the end of the ${spec.label}, what turned out to be the start of something. Say why each one mattered, not just that it happened.

Everything here is ${category}, so do not keep announcing the subject — the listener already chose it. Structure it as flowing prose in short paragraphs. Where several headlines are the same running story, treat them as one thread and say where it ended up.

The ${spec.label} is over by the time anyone hears this. Write in the past tense throughout — nothing in it is still upcoming, however a headline phrased it at the time it was written. NO headings, NO bullet points, NO markdown, NO source names or URLs, no dates unless they carry meaning. Conversational and clear, meant to be read aloud. Start immediately — no preamble, no title.`;

    try {
      const data = await callClaude(prompt, Math.round(spec.words * 2.2));
      const text = stripRecapChrome(data.content.filter(i => i.type === 'text').map(i => i.text).join('\n'));

      if (data.usage) {
        const { input_tokens, output_tokens } = data.usage;
        const token_cost_usd = (input_tokens / 1_000_000) * 0.8 + (output_tokens / 1_000_000) * 4;
        supabaseAdmin.from('api_usage').insert({
          service: 'anthropic', model: 'claude-haiku-4-5-20251001',
          input_tokens, output_tokens, web_searches: 0, search_cost_usd: 0,
          token_cost_usd, estimated_cost_usd: token_cost_usd,
          category, time_slot: period, content_type: 'period_recap',
          created_at: new Date().toISOString(),
        }).then(({ error: e }) => { if (e) console.warn('Could not track period recap usage:', e.message); }, () => {});
      }

      // content and briefing both carry the prose: the reader renders `content`, the player
      // narrates `briefing`, and for a recap they are the same text.
      await storeNews(category, endDay, period, text, null, null, null, null, language, text);
      console.log(`  ✓ ${category} — ${text.split(/\s+/).length} words from ${total} headlines`);
      results.push({ category, words: text.split(/\s+/).length, headlines: total });
    } catch (err) {
      // One category failing is not the run failing — the other eleven are still worth having.
      console.error(`  ✗ ${category} — ${err.message}`);
    }
  }

  if (!results.length) return null;   // nothing generated in this window — nothing to recap
  console.log(`✓ ${period} recaps stored for ${endDay} — ${results.length}/${DEFAULT_CATEGORIES.length} categories`);
  return results;
}

// Function to store news in Supabase
async function storeNews(category, day, timeSlot, content, userId = null, sharedKey = null, storiesContent = null, sourceArticles = null, language = 'en', briefing = null, leadImageUrl = null, auditResult = null) {
  try {
    const generated_at = new Date().toISOString();

    let query = supabaseAdmin
      .from('news_summaries')
      .select('id')
      .eq('category', category)
      .eq('day', day)
      .eq('time_slot', timeSlot)
      .eq('language', language);

    if (sharedKey) {
      query = query.eq('shared_key', sharedKey).is('user_id', null);
    } else if (userId) {
      query = query.eq('user_id', userId).is('shared_key', null);
    } else {
      query = query.is('user_id', null).is('shared_key', null);
    }

    const { data: existing } = await query.maybeSingle();

    // Count stories in the generated content (number of ## headings in stories_content)
    const storyCount = storiesContent
      ? (storiesContent.match(/^#{1,3} /mg) || []).length
      : null;

    const updatePayload = { content, generated_at };
    if (storiesContent !== null) updatePayload.stories_content = storiesContent;
    if (sourceArticles !== null) updatePayload.source_articles = sourceArticles;
    if (storyCount !== null)     updatePayload.story_count = storyCount;
    if (briefing !== null)       updatePayload.briefing = briefing;
    if (leadImageUrl !== null)   updatePayload.lead_image_url = leadImageUrl;
    if (auditResult !== null)    updatePayload.audit_result = auditResult;

    const runUpsert = async (payload) => {
      if (existing) {
        return supabaseAdmin.from('news_summaries').update(payload).eq('id', existing.id);
      } else {
        const row = { category, day, time_slot: timeSlot, language, ...payload };
        if (sharedKey) row.shared_key = sharedKey;
        else if (userId) row.user_id = userId;
        return supabaseAdmin.from('news_summaries').insert(row);
      }
    };

    let { error } = await runUpsert(updatePayload);

    // If only the `briefing` column is missing, drop just briefing and keep the rest
    // (don't lose stories_content/source_articles to the broad fallback below).
    if (error && error.message?.includes('briefing')) {
      const { briefing: _omit, ...withoutBriefing } = updatePayload;
      console.warn(`⚠️  'briefing' column missing — storing without it. Run in Supabase:\n  ALTER TABLE news_summaries ADD COLUMN IF NOT EXISTS briefing text;`);
      ({ error } = await runUpsert(withoutBriefing));
    }

    // Graceful fallback: if optional columns don't exist yet, retry with just the core fields
    if (error && (error.message?.includes('stories_content') || error.message?.includes('source_articles') || error.message?.includes('language') || error.message?.includes('story_count') || error.code === '42703')) {
      console.warn(`⚠️  Optional column missing — retrying without optional columns. Run in Supabase:\n  ALTER TABLE news_summaries ADD COLUMN IF NOT EXISTS stories_content text;\n  ALTER TABLE news_summaries ADD COLUMN IF NOT EXISTS source_articles jsonb;\n  ALTER TABLE news_summaries ADD COLUMN IF NOT EXISTS language text DEFAULT 'en';\n  ALTER TABLE news_summaries ADD COLUMN IF NOT EXISTS story_count integer;`);
      ({ error } = await runUpsert({ content, generated_at }));
    }

    if (error) throw new Error(`Supabase error: ${error.message}`);

    console.log(`✅ Stored news for ${category} on ${day} at ${timeSlot} [${language}]${storiesContent ? ' (+ stories)' : ''}${sourceArticles ? ` (+ ${sourceArticles.length} sources)` : ''}${userId ? ` (user ${userId})` : ''}${sharedKey ? ` (shared_key: ${sharedKey})` : ''}`);
  } catch (error) {
    console.error(`Error storing news in Supabase:`, error);
    throw error;
  }
}


// Mirrors frontend cleanForTTS exactly — must stay in sync so MD5 cache keys align
function cleanForTTS(text) {
  return text
    .replace(/\*\*(?:Coverage|التغطية|المصادر):\*\*[^\n]*/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/·/g, ', ')
    .replace(/\.{2,}/g, '.')
    .replace(/[#*`[\]()]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Unreal Speech TTS helper ──
// Uses /stream for texts ≤1000 chars (returns binary directly, ~0.3s latency).
// Uses /speech for longer texts (returns JSON with OutputUri, then downloads).
async function callUnrealSpeech(text) {
  const apiKey = process.env.UNREALSPEECH_API_KEY;
  if (!apiKey) throw new Error('UNREALSPEECH_API_KEY not set');
  const voiceId = process.env.UNREALSPEECH_VOICE_ID || 'Scarlett';
  const trimmed = text.trim();

  if (trimmed.length <= 1000) {
    const res = await fetch('https://api.v7.unrealspeech.com/stream', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ Text: trimmed, VoiceId: voiceId, Bitrate: '192k', Speed: '0', Pitch: '1' }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Unreal Speech error: ${res.status} — ${err}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  // Longer text: /speech returns JSON { OutputUri } → download from CDN
  const res = await fetch('https://api.v7.unrealspeech.com/speech', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Text: trimmed, VoiceId: voiceId, Bitrate: '192k', Speed: '0', Pitch: '1' }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Unreal Speech error: ${res.status} — ${err}`);
  }
  const { OutputUri } = await res.json();
  if (!OutputUri) throw new Error('Unreal Speech: no OutputUri in response');
  const audioRes = await fetch(OutputUri);
  if (!audioRes.ok) throw new Error('Unreal Speech: failed to download audio from OutputUri');
  return Buffer.from(await audioRes.arrayBuffer());
}

// ── TTS pre-generation helpers ──

// Mirrors the frontend parseStories() exactly so cache keys align
function parseStoriesForTTS(raw) {
  if (!raw) return [];
  const sourcesStart = raw.search(/^#{1,3}\s+(?:\[)?Sources(?:\])?/im);
  const content = sourcesStart > -1 ? raw.slice(0, sourcesStart).trim() : raw.trim();
  const chunks = content.split(/(?=^#{1,3} )/m).filter(c => /^#{1,3} /.test(c.trim()));
  return chunks.map(chunk => {
    const lines = chunk.trim().split('\n');
    const headingRaw = lines[0].replace(/^#{1,3}\s+/, '').trim();
    const headline = headingRaw
      .replace(/^\[(.+?)\]\(https?:\/\/[^)]+\)$/, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[()[\]]/g, '')
      .trim();
    const rest = lines.slice(1).join('\n');
    const bullets = [...rest.matchAll(/^[-*]\s+(.+)$/gm)].map(m => m[1]).slice(0, 3);
    const perspMatch = rest.match(/\*\*Perspectives differ:\*\*\s*(.+)/);
    const whyMatch   = rest.match(/\*\*Why this matters:\*\*\s*(.+)/);
    if (!headline || bullets.length === 0) return null;
    return { headline, bullets, perspectives: perspMatch?.[1] || null, why: whyMatch?.[1] || null };
  }).filter(Boolean);
}

// Mirrors buildStoryScript() + cleanForTTS() in the frontend — must stay in sync so MD5 cache keys align
function buildStoryScript(story) {
  const cl = cleanForTTS;
  const parts = [cl(story.headline) + '.'];
  story.bullets.forEach(b => parts.push(cl(b) + '.'));
  if (story.perspectives) parts.push('On the other hand, ' + cl(story.perspectives) + '.');
  if (story.why) parts.push('Here is why this matters. ' + cl(story.why) + '.');
  return parts.filter(Boolean).join(' ');
}

async function pregenerateTTSForContent(content, label) {
  if (!process.env.UNREALSPEECH_API_KEY) { console.log('⚠️  UNREALSPEECH_API_KEY not set — skipping TTS pre-gen'); return; }

  const stories = parseStoriesForTTS(content);
  if (!stories.length) return;

  console.log(`🔊 Pre-generating TTS for ${stories.length} stories (${label})...`);

  for (const story of stories) {
    try {
      const text   = buildStoryScript(story);
      const key    = crypto.createHash('md5').update(text.trim()).digest('hex');
      const fileName = `${key}.mp3`;

      // Skip if already cached
      const { data: existing } = await supabaseAdmin.storage
        .from('tts-cache').download(fileName).catch(() => ({ data: null }));
      if (existing) {
        console.log(`  ⏭️  Cached: ${story.headline.slice(0, 50)}`);
        continue;
      }

      let audioBuffer;
      try {
        audioBuffer = await callUnrealSpeech(text);
      } catch (ttsErr) {
        console.warn(`  ✗ Unreal Speech error for: ${story.headline.slice(0, 50)} — ${ttsErr.message}`);
        continue;
      }
      const { error: uploadErr } = await supabaseAdmin.storage
        .from('tts-cache')
        .upload(fileName, audioBuffer, { contentType: 'audio/mpeg', upsert: false });

      if (uploadErr) console.warn(`  ✗ Upload failed: ${uploadErr.message}`);
      else console.log(`  ✅ TTS cached: ${story.headline.slice(0, 50)}`);

      // Small delay to stay inside ElevenLabs rate limits
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.warn(`  ✗ TTS error: ${err.message}`);
    }
  }
}

// Helper: generate and store one category, returns { storiesContent } on success, throws on failure
async function generateAndStoreCategory(category, targetDay, timeSlot, language = 'en') {
  // Evening builds on Morning's digest when one exists for this category/day — see
  // generateEveningUpdate. No Morning digest (backfills, or Morning never ran that day)
  // falls back to a normal independent generation, same as before.
  let priorDigest = null;
  if (timeSlot === 'Evening') {
    const { data: morningRow } = await supabaseAdmin
      .from('news_summaries')
      .select('content')
      .eq('category', category).eq('day', targetDay).eq('time_slot', 'Morning').eq('language', language)
      .is('user_id', null).is('shared_key', null)
      .maybeSingle();
    if (morningRow?.content) priorDigest = morningRow.content;
  }

  const { summary: digestContent, sourceArticles, searchContext } = priorDigest
    ? await generateEveningUpdate(category, targetDay, priorDigest, language)
    : await generateNews(category, targetDay, timeSlot, 3, null, null, language);

  // First real http:// image from the article pool — used as the per-digest lead image
  const leadImageUrl = (sourceArticles || []).find(a => a.imageUrl?.startsWith('http'))?.imageUrl || null;

  // Digest-only, both languages — Arabic digests are checked against the Arabic
  // searchContext they were written from, same as English. One toggle controls both;
  // see auditDigest for why stories/briefing don't get their own separate check.
  let auditResult = null;
  if (await isAuditEnabled()) {
    auditResult = await auditDigest(category, timeSlot, digestContent, searchContext);
  }

  let storiesContent = null;
  if (GENERATE_STORIES_CONTENT) {
    try {
      storiesContent = await generateStoriesContent(category, targetDay, timeSlot, digestContent, language);
    } catch (err) {
      console.warn(`Stories generation failed for ${category}, falling back to digest:`, err.message);
    }
  }

  // Category-level briefing — a short synthesis of the whole category (for category Read/Play)
  let briefing = null;
  try {
    briefing = await generateBriefing(category, targetDay, timeSlot, digestContent, language);
  } catch (err) {
    console.warn(`Briefing generation failed for ${category}:`, err.message);
  }

  await storeNews(category, targetDay, timeSlot, digestContent, null, null, storiesContent, sourceArticles, language, briefing, leadImageUrl, auditResult);

  // Only pre-generate TTS for English (Arabic TTS not supported yet)
  if (language === 'en') {
    pregenerateTTSForContent(digestContent, `${category} / ${timeSlot} / digest`).catch(err =>
      console.warn(`TTS pre-gen (digest) failed for ${category}:`, err.message)
    );
    if (storiesContent) {
      pregenerateTTSForContent(storiesContent, `${category} / ${timeSlot} / stories`).catch(err =>
        console.warn(`TTS pre-gen (stories) failed for ${category}:`, err.message)
      );
    }
  }
}

// Function to generate all news for a time slot
// day defaults to today (UAE) — pass an explicit YYYY-MM-DD to backfill a specific date
// language: 'en' (default) or 'ar'. Arabic is only generated for Morning.
// categories: optional array to generate only specific categories (defaults to DEFAULT_CATEGORIES)
// Sent only when a generation cycle finishes with categories that never recovered after
// every retry (reconciliation pass + DB-verification final retry) — not for individual
// retries succeeding, which is the self-correcting path working as intended. Requires
// ADMIN_ALERT_EMAIL to be set; skips (with a log line) if it isn't, rather than failing
// the generation run over a missing notification address.
async function sendGenerationFailureAlert(timeSlot, day, language, failedList, succeededCount, totalCount) {
  const to = process.env.ADMIN_ALERT_EMAIL;
  if (!to) { console.warn('⚠️  ADMIN_ALERT_EMAIL not set — skipping failure alert email'); return; }
  try {
    const langLabel = language === 'ar' ? ' [AR]' : '';
    const list = failedList.map(f => `<li><strong>${f.category}</strong> — ${f.error}</li>`).join('');
    await resend.emails.send({
      from: process.env.FROM_EMAIL || 'noreply@resend.dev',
      to,
      subject: `⚠️ RadioNews: ${timeSlot}${langLabel} generation incomplete on ${day} (${failedList.length} categories)`,
      html: `<p>${succeededCount}/${totalCount} categories generated successfully for ${timeSlot}${langLabel} on ${day}. The following failed even after automatic retries:</p><ul>${list}</ul><p>These categories will show no news for this slot until manually regenerated from the admin dashboard.</p>`,
    });
    console.log(`📧 Failure alert email sent to ${to}`);
  } catch (err) {
    console.warn('Could not send failure alert email:', err.message);
  }
}

async function generateAllNewsForTimeSlot(timeSlot, day = null, language = 'en', categories = null) {
  const targetDay = day || getTodayDate();
  // Arabic default run: skip any category with no Arabic query rather than falling
  // through to CATEGORY_SEARCH_QUERIES's generic `|| category` fallback, which would
  // search Serper for the literal English category name (e.g. "AI") as Arabic content.
  const targetCategories = categories || (language === 'ar' ? DEFAULT_CATEGORIES.filter(c => ARABIC_CATEGORY_QUERIES[c]) : DEFAULT_CATEGORIES);
  const langLabel = language === 'ar' ? ' [AR]' : '';
  const startedAt = new Date();

  // Written immediately, not at the end — the watchdog workflow needs "started" to flip
  // true within seconds of a real run beginning, not ~19 minutes later when the full log
  // row used to land. Without this, "no log row yet" was indistinguishable from "never
  // started," and the watchdog would have triggered a duplicate run on top of one already
  // in progress. Falls back to a plain insert-at-the-end if this fails for any reason —
  // never let logging block generation itself.
  let generationLogId = null;
  try {
    const { data: logRow, error: logErr } = await supabaseAdmin
      .from('generation_logs')
      .insert({ day: targetDay, time_slot: timeSlot, language, started_at: startedAt.toISOString() })
      .select('id').single();
    if (logErr) throw logErr;
    generationLogId = logRow.id;
  } catch (err) {
    console.warn('Could not write start-of-run generation log:', err.message);
  }

  // Arabic is Morning-only
  if (language === 'ar' && timeSlot !== 'Morning') {
    console.log(`⏭️  Skipping Arabic generation for ${timeSlot} — Arabic is Morning-only`);
    return;
  }

  // ── Delete existing rows for this slot before generating fresh content ──────
  // This prevents stale data from a previous (possibly partial) run from showing
  // alongside newly generated content.
  try {
    const toDelete = [...targetCategories, '__completed__'];
    const { error: delError } = await supabaseAdmin
      .from('news_summaries')
      .delete()
      .eq('day', targetDay)
      .eq('time_slot', timeSlot)
      .eq('language', language)
      .in('category', toDelete)
      .is('user_id', null)
      .is('shared_key', null);
    if (delError) console.warn(`⚠️  Could not delete existing rows before generation:`, delError.message);
    else console.log(`🗑️  Cleared ${toDelete.length} existing rows for ${timeSlot}${langLabel} on ${targetDay}`);
  } catch (err) {
    console.warn(`⚠️  Delete step threw:`, err.message);
  }

  console.log(`\n🚀 Starting news generation for ${timeSlot}${langLabel} on ${targetDay} (${targetCategories.length} categories)...`);

  // ── Keep-alive self-ping ─────────────────────────────────────────────────
  // Render free tier spins down after 15 min of no incoming requests.
  // Pinging our own /health every 10 min resets that timer so the full
  // ~19-min sequential generation run completes without being killed.
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3001}`;
  const keepAliveTimer = setInterval(() => {
    fetch(`${RENDER_URL}/health`)
      .then(() => console.log('🔁 Keep-alive ping sent'))
      .catch(err => console.warn('⚠️  Keep-alive ping failed:', err.message));
  }, 10 * 60 * 1000); // every 10 minutes

  const succeeded   = [];
  const failed      = []; // [{ category, error }]

  // ── Main generation pass ─────────────────────────────────────────────────
  // Sequential with a short inter-category delay to stay within Serper/Claude
  // rate limits. The curl connection (--max-time 2400) keeps the Render dyno
  // alive for the full ~19 min this takes; no need for parallelism.
  for (const category of targetCategories) {
    try {
      await generateAndStoreCategory(category, targetDay, timeSlot, language);
      succeeded.push(category);
      console.log(`  ✅ ${category}${langLabel}`);
    } catch (error) {
      console.error(`  ❌ ${category}${langLabel}: ${error.message}`);
      failed.push({ category, error: error.message });
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  // ── Reconciliation pass: retry each failed category once ─────────────────
  const retrySucceeded = [];
  const retryFailed    = [];

  if (failed.length > 0) {
    console.log(`\n🔄 Reconciliation: retrying ${failed.length} failed ${failed.length === 1 ? 'category' : 'categories'}...`);
    for (const { category } of failed) {
      try {
        console.log(`  ↩️  Retrying ${category}${langLabel}...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
        await generateAndStoreCategory(category, targetDay, timeSlot, language);
        retrySucceeded.push(category);
        console.log(`  ✅ Retry succeeded: ${category}${langLabel}`);
      } catch (error) {
        console.error(`  ❌ Retry failed: ${category}${langLabel}: ${error.message}`);
        retryFailed.push({ category, error: error.message });
      }
    }
  }

  // ── DB verification pass: confirm rows actually landed in Supabase ──────────
  // generateAndStoreCategory() can succeed without throwing even when the stories
  // sub-step fails silently, so throw-based reconciliation is insufficient.
  // Query what's actually stored and retry any category that is still absent.
  const dbVerifyFailed = [];
  try {
    const { data: storedRows, error: verifyErr } = await supabaseAdmin
      .from('news_summaries')
      .select('category')
      .eq('day', targetDay)
      .eq('time_slot', timeSlot)
      .eq('language', language)
      .is('user_id', null)
      .is('shared_key', null)
      .in('category', targetCategories);

    if (verifyErr) {
      console.warn(`⚠️  DB verification query failed: ${verifyErr.message}`);
    } else {
      const storedSet = new Set((storedRows || []).map(r => r.category));
      const missingCategories = targetCategories.filter(c => !storedSet.has(c));

      if (missingCategories.length > 0) {
        console.log(`\n🔍 DB verification found ${missingCategories.length} missing ${missingCategories.length === 1 ? 'category' : 'categories'}: ${missingCategories.join(', ')}`);
        for (const category of missingCategories) {
          try {
            console.log(`  🔁 Final retry: ${category}${langLabel}...`);
            await new Promise(resolve => setTimeout(resolve, 10000));
            await generateAndStoreCategory(category, targetDay, timeSlot, language);
            retrySucceeded.push(category);
            console.log(`  ✅ Final retry succeeded: ${category}${langLabel}`);
          } catch (error) {
            console.error(`  ❌ Final retry failed: ${category}${langLabel}: ${error.message}`);
            dbVerifyFailed.push({ category, error: error.message });
          }
        }
      } else {
        console.log(`\n✅ DB verification: all ${targetCategories.length} categories confirmed in Supabase`);
      }
    }
  } catch (err) {
    console.warn(`⚠️  DB verification pass threw: ${err.message}`);
  }

  const totalSucceeded = succeeded.length + retrySucceeded.length;
  const allFailed = [...retryFailed, ...dbVerifyFailed];
  console.log(`\n✨ Generation complete for ${timeSlot}${langLabel} on ${targetDay} — ${totalSucceeded}/${targetCategories.length} categories succeeded`);
  if (allFailed.length > 0) {
    console.warn(`⚠️  Permanently failed: ${allFailed.map(f => f.category).join(', ')}`);
    if (targetDay === getTodayDate()) {
      await sendGenerationFailureAlert(timeSlot, targetDay, language, allFailed, totalSucceeded, targetCategories.length);
    }
  }

  // ── Completion marker (one per language per slot) ─────────────────────────
  try {
    await storeNews('__completed__', targetDay, timeSlot, 'completed', null, null, null, null, language);
    console.log(`✅ Completion marker written for ${timeSlot}${langLabel} on ${targetDay}`);
  } catch (err) {
    console.warn(`Could not write completion marker:`, err.message);
  }

  // ── Generation log ────────────────────────────────────────────────────────
  const completedAt       = new Date();
  const durationSeconds   = Math.round((completedAt - startedAt) / 1000);
  try {
    const payload = {
      day:                    targetDay,
      time_slot:              timeSlot,
      language:               language,
      started_at:             startedAt.toISOString(),
      completed_at:           completedAt.toISOString(),
      total_duration_seconds: durationSeconds,
      categories_succeeded:   succeeded,
      categories_failed:      failed,
      retry_succeeded:        retrySucceeded,
      retry_failed:           allFailed,
    };
    // Fill in the row written at the top of this function (see generationLogId) rather
    // than inserting a second one — falls back to insert if that row is missing for any
    // reason (e.g. the start-of-run write failed).
    const { error: updateErr } = generationLogId
      ? await supabaseAdmin.from('generation_logs').update(payload).eq('id', generationLogId)
      : { error: 'no id' };
    if (updateErr) await supabaseAdmin.from('generation_logs').insert(payload);
    console.log(`📝 Generation log saved (${durationSeconds}s, ${totalSucceeded}/${targetCategories.length} ok)`);
  } catch (err) {
    console.warn(`Could not save generation log:`, err.message);
  }

  clearInterval(keepAliveTimer);
}

// Cloud Scheduler will trigger the /api/generate/:timeSlot endpoints
// No local cron jobs needed on Cloud Run

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Generation completeness — real content, not the __completed__ marker ───────
// __completed__ gets written unconditionally at the end of a run, even when every
// category failed, so it can't answer "did this slot actually generate." This counts
// real rows against the expected category list instead — used by the watchdog workflow
// to tell "never ran" apart from "ran and produced content."
app.get('/api/generation-status', async (req, res) => {
  try {
    const { slot, day, language = 'en' } = req.query;
    if (!slot) return res.status(400).json({ error: 'slot is required (morning or evening)' });
    const timeSlot = slot.charAt(0).toUpperCase() + slot.slice(1).toLowerCase();
    const targetDay = day || getTodayDate();

    const targetCategories = language === 'ar' ? DEFAULT_CATEGORIES.filter(c => ARABIC_CATEGORY_QUERIES[c]) : DEFAULT_CATEGORIES;

    const { data: rows, error } = await supabaseAdmin
      .from('news_summaries')
      .select('category, content')
      .eq('day', targetDay).eq('time_slot', timeSlot).eq('language', language)
      .is('user_id', null).is('shared_key', null)
      .in('category', targetCategories);
    if (error) throw error;

    const withContent = new Set((rows || []).filter(r => r.content).map(r => r.category));
    const missing = targetCategories.filter(c => !withContent.has(c));

    const { data: logRow } = await supabaseAdmin
      .from('generation_logs')
      .select('started_at, completed_at')
      .eq('day', targetDay).eq('time_slot', timeSlot).eq('language', language)
      .order('started_at', { ascending: false }).limit(1).maybeSingle();

    res.json({
      day: targetDay, timeSlot, language,
      started: !!logRow,
      startedAt: logRow?.started_at || null,
      completedAt: logRow?.completed_at || null,
      succeededCount: withContent.size,
      totalCount: targetCategories.length,
      complete: missing.length === 0,
      missing,
      // The watchdog checks this before self-triggering — a deliberately paused
      // pipeline is not the same failure as a missed scheduled run, and must not be
      // "fixed" by turning generation back on behind the admin's back.
      generationEnabled: await isGenerationEnabled(),
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});


app.post('/api/user/custom-category', async (req, res) => {
  try {
    const { user_id, category_name, category_description, shared_key_override } = req.body;
    if (!user_id || !category_name) return res.status(400).json({ error: 'user_id and category_name are required' });

    const todayUAE = getTodayDate();
    const sharedKey = shared_key_override || (category_description || category_name).toLowerCase().trim();

    // Check abuse lock
    const { data: userRow } = await supabaseAdmin.from('users').select('category_locked_until').eq('id', user_id).maybeSingle();
    if (userRow?.category_locked_until >= todayUAE) {
      return res.status(429).json({ error: 'You can create a new category starting tomorrow.' });
    }

    // Soft-delete existing active category for this user
    await supabaseAdmin.from('custom_categories')
      .update({ deleted_at: new Date().toISOString() })
      .eq('user_id', user_id)
      .is('deleted_at', null);

    // Generate embedding for semantic similarity (best-effort, don't block on failure)
    const descriptionText = (category_description || category_name).trim();
    const embedding = await generateEmbedding(descriptionText);

    // Insert new category
    const row = {
      user_id,
      category_name: category_name.trim().slice(0, 25),
      category_description: descriptionText,
      shared_key: sharedKey,
      created_at: new Date().toISOString()
    };
    if (embedding) row.description_embedding = embedding;
    const { error } = await supabaseAdmin.from('custom_categories').insert(row);
    if (error) throw error;

    res.json({ success: true, shared_key: sharedKey });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/user/custom-category', async (req, res) => {
  try {
    const { user_id, category_name } = req.body;
    if (!user_id || !category_name) return res.status(400).json({ error: 'user_id and category_name are required' });

    const todayUAE = getTodayDate();

    await supabaseAdmin.from('custom_categories')
      .update({ deleted_at: new Date().toISOString() })
      .eq('user_id', user_id)
      .eq('category_name', category_name)
      .is('deleted_at', null);

    // Lock user from creating another category today
    await supabaseAdmin.from('users').update({ category_locked_until: todayUAE }).eq('id', user_id);

    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Generate news for a single custom category
app.post('/api/generate/custom-category', async (req, res) => {
  const { user_id, category, description, day, timeSlot } = req.body;

  if (!category || !day || !timeSlot) {
    return res.status(400).json({ error: 'category, day and timeSlot are required' });
  }

  const sharedKey = (description || category).toLowerCase().trim();
  const todayUAE = getTodayDate();

  // Check if news already exists for this sharedKey + day + 'Daily'
  const { data: existing } = await supabaseAdmin.from('news_summaries')
    .select('id').eq('shared_key', sharedKey).eq('day', day).eq('time_slot', 'Daily').maybeSingle();
  if (existing) { res.json({ status: 'already_exists', category, day, timeSlot: 'Daily' }); return; }

  // Check abuse prevention — if user already generated today
  const { data: userRow } = await supabaseAdmin.from('users').select('last_generated_date, category_locked_until').eq('id', user_id).maybeSingle();
  if (userRow?.last_generated_date === todayUAE) {
    return res.status(429).json({ error: 'You have already generated your custom news today. Come back tomorrow.' });
  }

  // Respond with accepted immediately, then generate in background
  res.json({ status: 'accepted', category, day, timeSlot: 'Daily' });
  (async () => {
    try {
      const { summary: newsContent } = await generateNews(category, day, 'Daily', 3, description || category);
      await storeNews(category, day, 'Daily', newsContent, null, sharedKey);
      await supabaseAdmin.from('users').update({ last_generated_date: todayUAE }).eq('id', user_id);
      console.log(`✓ Custom category news saved: ${category} (shared_key: ${sharedKey})`);
    } catch (err) { console.error('Custom category generation error:', err.message); }
  })();
});

// Manual trigger endpoint — supports both GET (browser/admin) and POST (Cloud Scheduler)
// Optional: ?day=YYYY-MM-DD (GET) or { day: "YYYY-MM-DD" } (POST body) to target a specific date
// ── Period recaps ─────────────────────────────────────────────────────────────
// POST /api/generate/period/weekly  { day?, language? }
// POST /api/generate/period/monthly { day?, language? }
//
// `day` is the LAST day of the period and defaults to today, so the weekly job runs on a
// Sunday and the monthly on the last of the month with no argument. Still synchronous: one
// Claude call per category over headlines already in the database — a dozen quick calls, not
// the tens of minutes a full category sweep with web search takes.
app.post('/api/generate/period/:period', async (req, res) => {
  try {
    const raw = String(req.params.period || '').toLowerCase();
    const period = raw === 'weekly' ? 'Weekly' : raw === 'monthly' ? 'Monthly' : null;
    if (!period) return res.status(400).json({ error: 'period must be weekly or monthly' });

    if (!(await isGenerationEnabled())) {
      return res.status(423).json({ error: 'Generation is currently paused from the admin dashboard.' });
    }

    const endDay = req.body?.day || getTodayDate();
    const language = req.body?.language || 'en';
    const results = await generatePeriodRecap(period, endDay, language);
    if (!results) {
      return res.json({ status: 'skipped', message: `No digests found in the ${period.toLowerCase()} window ending ${endDay} — nothing to recap.` });
    }
    res.json({ status: 'ok', period, day: endDay, language, categories: results.length, results });
  } catch (error) {
    console.error('Period recap failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/generate/:timeSlot', async (req, res) => {
  try {
    const timeSlot = req.params.timeSlot;
    const day = req.query.day || null; // e.g. ?day=2026-05-10
    const slot = TIME_SLOTS.find(s => s.label.toLowerCase() === timeSlot.toLowerCase());
    if (!slot) return res.status(400).json({ error: 'Invalid time slot' });
    const targetDay = day || getTodayDate();
    res.json({ status: 'accepted', message: `News generation started for ${slot.label} on ${targetDay}`, timestamp: new Date().toISOString() });
    generateAllNewsForTimeSlot(slot.label, targetDay).catch(err => console.error(`Background generation failed for ${slot.label}:`, err.message));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/generate/:timeSlot', async (req, res) => {
  try {
    const timeSlot = req.params.timeSlot;
    const day = req.body?.day || null;
    const language = req.body?.language || 'en';
    const category = req.body?.category || null; // optional: generate a single category
    const slot = TIME_SLOTS.find(s => s.label.toLowerCase() === timeSlot.toLowerCase());

    if (!slot) {
      return res.status(400).json({ error: 'Invalid time slot' });
    }

    // Arabic is Morning-only
    if (language === 'ar' && slot.label !== 'Morning') {
      return res.status(400).json({ error: 'Arabic generation is only available for the Morning slot' });
    }

    // Global pause switch — covers scheduled runs, the watchdog's self-correct, and
    // manual "Generate Now" / regenerate clicks alike. One switch, no silent exceptions:
    // turn it back on to run anything, including a one-off regenerate.
    if (!(await isGenerationEnabled())) {
      return res.status(423).json({ error: 'Generation is currently paused from the admin dashboard. Turn it back on to generate news.' });
    }

    // Narrower Evening-only switch — only applies to calls the caller marks as
    // automated (the GitHub Actions cron and the watchdog both send auto:true).
    // Manual "Generate Evening" clicks from the admin dashboard never set this flag,
    // so they still work while automated Evening runs are paused.
    const isAuto = req.body?.auto === true;
    if (isAuto && slot.label === 'Evening' && !(await isEveningAutoEnabled())) {
      return res.json({ status: 'skipped', message: 'Automated Evening generation is currently disabled from the admin dashboard.' });
    }

    const targetDay = day || getTodayDate();
    const categories = category ? [category] : null;
    const langLabel = language === 'ar' ? ' [AR]' : '';
    const catLabel = category ? ` (${category})` : ' (all categories)';

    // Fire-and-forget — respond immediately so Render's proxy doesn't time out the
    // connection (it closes connections with no response after ~60-90 s).
    // The generation loop self-pings /health every 10 min to keep the dyno alive.
    res.json({
      status: 'started',
      message: `News generation started for ${slot.label}${langLabel}${catLabel} on ${targetDay}`,
      timestamp: new Date().toISOString()
    });
    generateAllNewsForTimeSlot(slot.label, targetDay, language, categories)
      .catch(err => console.error(`Generation failed for ${slot.label}${langLabel}:`, err.message));
  } catch (error) {
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});




// ==========================================
// ENDPOINT: ENSURE PROFILE (passwordless OTP)
// Called right after a successful Supabase email-OTP verification. The OTP flow
// creates the auth.users row but not our app `users` row, so we upsert it here
// (service role, bypasses RLS) and return the profile.
// ==========================================
app.post('/api/auth/ensure-profile', async (req, res) => {
  try {
    const { user_id, email } = req.body;
    if (!user_id || !email) {
      return res.status(400).json({ error: 'user_id and email are required' });
    }

    const { data: existing } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', user_id)
      .maybeSingle();

    if (existing) {
      // Make sure an OTP-verified user is marked verified.
      if (existing.verification_status !== 'verified') {
        await supabaseAdmin.from('users').update({ verification_status: 'verified' }).eq('id', user_id);
        existing.verification_status = 'verified';
      }
      return res.json({ profile: existing, created: false });
    }

    const { data: created, error: insertError } = await supabaseAdmin
      .from('users')
      .insert({ id: user_id, email, verification_status: 'verified' })
      .select('*')
      .single();

    if (insertError) {
      console.error('ensure-profile insert error:', insertError);
      return res.status(500).json({ error: insertError.message });
    }

    return res.json({ profile: created, created: true });
  } catch (error) {
    console.error('ensure-profile error:', error);
    res.status(500).json({ error: error.message });
  }
});


// ── Metrics feature flags — split so one doesn't drag the other along ────────
// HEARTBEAT_ENABLED: in-memory only, no Supabase writes, safe at any traffic volume —
//   powers "who's online" in the admin dashboard.
// BEHAVIORAL_TRACKING_ENABLED: writes a row to `behavioral_metrics` per tracked event
//   (story opens, page views, etc.) — this is what maxed out the Supabase plan before.
//   Leave off unless you're deliberately re-enabling behavioral analytics and are ready
//   for the write volume/cost that comes with it.
const HEARTBEAT_ENABLED = true;
const BEHAVIORAL_TRACKING_ENABLED = false;

// ── In-memory active sessions ─────────────────────────────────────────────────
// Map: sessionId → { userId: string|null, lastSeen: ms }
// Sessions expire after 120s of silence; cleaned up every 2 minutes.
// This is intentionally in-memory — no DB writes for heartbeats, restarts reset
// to 0 but the counter rebuilds within one heartbeat cycle (60s).
const _activeSessions = new Map();
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [sid, s] of _activeSessions) {
    if (s.lastSeen < cutoff) _activeSessions.delete(sid);
  }
}, 120_000);

// Heartbeat — called by every browser tab every 60s (guests + signed-in users)
app.post('/api/metrics/heartbeat', (req, res) => {
  if (!HEARTBEAT_ENABLED) return res.json({ ok: true, disabled: true });
  const { sessionId, userId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  _activeSessions.set(sessionId, { userId: userId || null, lastSeen: Date.now() });
  res.json({ ok: true });
});

// ==========================================
// ENDPOINT 4: TRACK BEHAVIORAL METRICS
// ==========================================
app.post('/api/metrics/track', async (req, res) => {
  if (!BEHAVIORAL_TRACKING_ENABLED) return res.json({ success: true, disabled: true });
  try {
    const {
      userId, 
      eventType, 
      pageName, 
      category, 
      day, 
      time, 
      duration_seconds,
      metadata 
    } = req.body;

    if (!userId || !eventType) {
      return res.status(400).json({ 
        error: 'userId and eventType are required' 
      });
    }

    console.log(`📊 Tracking event: ${eventType} for user ${userId.substring(0, 8)}...`);

    // Insert metric
    const { error } = await supabaseAdmin
      .from('behavioral_metrics')
      .insert({
        user_id: userId,
        event_type: eventType,
        page_name: pageName || null,
        category_selected: category || null,
        day_selected: day || null,
        time_selected: time || null,
        duration_seconds: duration_seconds || null,
        metadata: metadata || null,
        created_at: new Date().toISOString()
      });

    if (error) {
      console.error('Metric tracking failed:', error);
      return res.status(500).json({ 
        error: 'Failed to track metric' 
      });
    }

    console.log(`✓ Event tracked: ${eventType}`);

    res.json({ 
      success: true,
      message: 'Metric tracked'
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ADMIN DASHBOARD
// ==========================================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

app.get('/admin/api/overview', async (req, res) => {
  try {
    const today = getTodayDate();
    const now   = new Date();

    // ── Period boundaries ─────────────────────────────────────────────────────
    // "Today" uses UAE midnight (UTC+4). All others use UTC calendar boundaries.
    const todayStart   = new Date(today + 'T00:00:00+04:00').toISOString();
    const weekStartD   = new Date(); weekStartD.setUTCHours(0,0,0,0);
    const dow          = weekStartD.getUTCDay(); // 0=Sun
    weekStartD.setUTCDate(weekStartD.getUTCDate() - (dow === 0 ? 6 : dow - 1));
    const weekStart    = weekStartD.toISOString();
    const monthStart   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const quarterStart = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth()/3)*3, 1)).toISOString();
    const yearStart    = new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();

    // Last 7 calendar days in UAE timezone
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (6 - i));
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(d);
    });

    // ── Parallel queries ──────────────────────────────────────────────────────
    const [
      { count: totalSignups },
      { count: todaySignups },
      { count: weekSignups },
      { count: monthSignups },
      { count: quarterSignups },
      { count: yearSignups },
      { count: totalVerified },
      { count: todayVerified },
      { count: weekVerified },
      { count: monthVerified },
      { count: quarterVerified },
      { count: yearVerified },
      { data: activeNowData },
      { data: genRows },
      { data: metricRows },
      { data: newsRows },
      { data: storyReadRows },
      { data: usersWithFeeds },
      { data: storyCounts },
    ] = await Promise.all([
      // Signups
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).gte('created_at', todayStart),
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).gte('created_at', weekStart),
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).gte('created_at', monthStart),
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).gte('created_at', quarterStart),
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).gte('created_at', yearStart),
      // Verified
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).eq('verification_status', 'verified'),
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).eq('verification_status', 'verified').gte('created_at', todayStart),
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).eq('verification_status', 'verified').gte('created_at', weekStart),
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).eq('verification_status', 'verified').gte('created_at', monthStart),
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).eq('verification_status', 'verified').gte('created_at', quarterStart),
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).eq('verification_status', 'verified').gte('created_at', yearStart),
      // Active now (last 5 min)
      supabaseAdmin.from('behavioral_metrics').select('user_id').gte('created_at', new Date(Date.now() - 5*60*1000).toISOString()),
      // Generation status – last 7 days, no __completed__ rows
      supabaseAdmin.from('news_summaries').select('category, day, time_slot, language, generated_at').in('day', last7Days).neq('category', '__completed__'),
      // Behavioral metrics – category selections with event type (last 30 days only)
      supabaseAdmin.from('behavioral_metrics').select('category_selected, event_type, created_at').not('category_selected', 'is', null).gte('created_at', new Date(Date.now() - 30*24*60*60*1000).toISOString()),
      // News summaries – for generated count + sources (last 30 days; no full source_articles blob)
      supabaseAdmin.from('news_summaries').select('category, language, generated_at').neq('category', '__completed__').gte('generated_at', new Date(Date.now() - 30*24*60*60*1000).toISOString()),
      // Story reads – event_type='story_read' for read rate (last 30 days only)
      supabaseAdmin.from('behavioral_metrics').select('user_id, category_selected, day_selected, metadata, created_at').eq('event_type', 'story_read').gte('created_at', new Date(Date.now() - 30*24*60*60*1000).toISOString()),
      // Users with feed categories – for read rate denominator
      supabaseAdmin.from('users').select('id, feed_categories, user_feeds').not('feed_categories', 'is', null),
      // News summaries story counts – denominator for read rate
      supabaseAdmin.from('news_summaries').select('category, day, story_count, language, generated_at').not('story_count', 'is', null).neq('category', '__completed__'),
    ]);

    // ── Active now ────────────────────────────────────────────────────────────
    const activeNow = new Set((activeNowData || []).map(r => r.user_id)).size;

    // ── Generation grid (7 days × Morning/Evening × EN/AR) ───────────────────
    const genGrid = {};
    last7Days.forEach(day => {
      genGrid[day] = {
        Morning: { en: false, ar: false },
        Evening: { en: false, ar: false },
      };
    });
    (genRows || []).forEach(r => {
      if (genGrid[r.day]?.[r.time_slot]) {
        genGrid[r.day][r.time_slot][r.language === 'ar' ? 'ar' : 'en'] = true;
      }
    });

    // ── Top categories helper ─────────────────────────────────────────────────
    const buildTopCats = (rows) => {
      const counts = {};
      (rows || []).forEach(m => {
        if (!m.category_selected) return;
        if (!counts[m.category_selected]) counts[m.category_selected] = { total: 0, read: 0, audio: 0 };
        counts[m.category_selected].total++;
        const et = (m.event_type || '').toLowerCase();
        if (et.includes('play') || et.includes('audio') || et.includes('narrat')) counts[m.category_selected].audio++;
        else counts[m.category_selected].read++;
      });
      return Object.entries(counts)
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 15)
        .map(([category, v]) => ({ category, total: v.total, read: v.read, audio: v.audio }));
    };

    const topCats = {
      today:   buildTopCats((metricRows || []).filter(m => m.created_at >= todayStart)),
      week:    buildTopCats((metricRows || []).filter(m => m.created_at >= weekStart)),
      month:   buildTopCats((metricRows || []).filter(m => m.created_at >= monthStart)),
      quarter: buildTopCats((metricRows || []).filter(m => m.created_at >= quarterStart)),
      year:    buildTopCats((metricRows || []).filter(m => m.created_at >= yearStart)),
      total:   buildTopCats(metricRows),
    };

    // ── News generated per category helper ───────────────────────────────────
    const buildNewsPerCat = (rows) => {
      const counts = {};
      (rows || []).forEach(s => {
        if (!counts[s.category]) counts[s.category] = { en: 0, ar: 0 };
        if (s.language === 'ar') counts[s.category].ar++;
        else counts[s.category].en++;
      });
      return Object.entries(counts)
        .sort((a, b) => (b[1].en + b[1].ar) - (a[1].en + a[1].ar))
        .map(([category, v]) => ({ category, en: v.en, ar: v.ar, total: v.en + v.ar }));
    };

    const newsPerCat = {
      today:   buildNewsPerCat((newsRows || []).filter(s => s.generated_at >= todayStart)),
      week:    buildNewsPerCat((newsRows || []).filter(s => s.generated_at >= weekStart)),
      month:   buildNewsPerCat((newsRows || []).filter(s => s.generated_at >= monthStart)),
      quarter: buildNewsPerCat((newsRows || []).filter(s => s.generated_at >= quarterStart)),
      year:    buildNewsPerCat((newsRows || []).filter(s => s.generated_at >= yearStart)),
      total:   buildNewsPerCat(newsRows),
    };

    // ── Sources: count totals + rank outlets by citation frequency ───────────
    const buildSources = (rows) => {
      let en = 0, ar = 0;
      // outletMap: { name: { en, ar, domain } }
      // domain is extracted from the first article URL seen for that outlet
      const outletMap = {};

      (rows || []).forEach(s => {
        const articles = Array.isArray(s.source_articles) ? s.source_articles : [];
        const isAr = s.language === 'ar';
        articles.forEach(a => {
          const name = (a.source || '').trim();
          if (!name) return;
          if (isAr) ar++; else en++;
          if (!outletMap[name]) {
            let domain = null;
            try { domain = new URL(a.url || '').hostname.replace(/^www\./, ''); } catch {}
            outletMap[name] = { en: 0, ar: 0, domain };
          }
          if (isAr) outletMap[name].ar++; else outletMap[name].en++;
        });
      });

      const outlets = Object.entries(outletMap)
        .map(([outlet, v]) => ({ outlet, en: v.en, ar: v.ar, total: v.en + v.ar, domain: v.domain || null }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 50); // top 50 outlets

      return { en, ar, total: en + ar, outlets };
    };

    const sources = {
      today:   buildSources((newsRows || []).filter(s => s.generated_at >= todayStart)),
      week:    buildSources((newsRows || []).filter(s => s.generated_at >= weekStart)),
      month:   buildSources((newsRows || []).filter(s => s.generated_at >= monthStart)),
      quarter: buildSources((newsRows || []).filter(s => s.generated_at >= quarterStart)),
      year:    buildSources((newsRows || []).filter(s => s.generated_at >= yearStart)),
      total:   buildSources(newsRows),
    };

    // ── Read rate ─────────────────────────────────────────────────────────────
    // For each user with a custom feed, compute: unique stories read / total
    // stories available in their deduplicated feed categories for the period.
    // Dedup categories: if the same category appears in multiple feeds, count once.
    // Story index stored in metadata.story_index (or page_name as fallback).
    //
    // Run in Supabase first: ALTER TABLE news_summaries ADD COLUMN IF NOT EXISTS story_count integer;
    const computeReadRate = (readsInPeriod, countsInPeriod, users) => {
      // Build: { 'category::day': story_count }
      const availMap = {};
      (countsInPeriod || []).forEach(n => {
        const key = `${n.category}::${n.day}`;
        // Take max across EN/AR (same category+day should have same count)
        availMap[key] = Math.max(availMap[key] || 0, n.story_count || 0);
      });

      let totalReads = 0, totalAvail = 0, userCount = 0;
      const userRates = [];

      (users || []).forEach(u => {
        // Deduplicate categories across all feeds for this user
        const cats = new Set();
        if (Array.isArray(u.feed_categories)) u.feed_categories.forEach(c => cats.add(c));
        if (Array.isArray(u.user_feeds)) {
          u.user_feeds.forEach(feed => {
            if (Array.isArray(feed.categories)) feed.categories.forEach(c => cats.add(c));
          });
        }
        if (cats.size === 0) return;

        // Unique stories this user read (deduplicated by category+day+storyIndex)
        const readSet = new Set();
        (readsInPeriod || [])
          .filter(r => r.user_id === u.id && cats.has(r.category_selected))
          .forEach(r => {
            const idx = r.metadata?.story_index ?? r.page_name ?? '?';
            readSet.add(`${r.category_selected}::${r.day_selected}::${idx}`);
          });

        // Available stories: sum story_count for user's categories across days in period
        let avail = 0;
        for (const [key, count] of Object.entries(availMap)) {
          const cat = key.split('::')[0];
          if (cats.has(cat)) avail += count;
        }

        if (avail > 0) {
          totalReads += readSet.size;
          totalAvail += avail;
          userCount++;
          userRates.push(readSet.size / avail);
        }
      });

      const avgRate = userRates.length > 0
        ? Math.round((userRates.reduce((a, b) => a + b, 0) / userRates.length) * 10000) / 100
        : 0;
      const aggRate = totalAvail > 0 ? Math.round(totalReads / totalAvail * 10000) / 100 : 0;
      return { avgRate, aggRate, reads: totalReads, available: totalAvail, users: userCount };
    };

    const filterReads   = (start) => (storyReadRows || []).filter(r => r.created_at >= start);
    const filterCounts  = (start) => (storyCounts   || []).filter(n => n.generated_at >= start);

    const readRate = {
      today:   computeReadRate(filterReads(todayStart),   filterCounts(todayStart),   usersWithFeeds),
      week:    computeReadRate(filterReads(weekStart),    filterCounts(weekStart),    usersWithFeeds),
      month:   computeReadRate(filterReads(monthStart),   filterCounts(monthStart),   usersWithFeeds),
      quarter: computeReadRate(filterReads(quarterStart), filterCounts(quarterStart), usersWithFeeds),
      year:    computeReadRate(filterReads(yearStart),    filterCounts(yearStart),    usersWithFeeds),
      total:   computeReadRate(storyReadRows,             storyCounts,                usersWithFeeds),
    };

    // ── Feed category popularity ──────────────────────────────────────────────
    // Count how many times each category appears across all users' custom feeds.
    // Intentionally double-counts: if a user has "World News" in two separate
    // feeds, World News is counted twice for that user.
    // Sources: user_feeds (named custom feeds) + feed_categories (main feed slot).
    const feedCatCounts = {};
    (usersWithFeeds || []).forEach(u => {
      // Named custom feeds (user_feeds): each feed is counted separately
      if (Array.isArray(u.user_feeds)) {
        u.user_feeds.forEach(feed => {
          if (Array.isArray(feed.categories)) {
            feed.categories.forEach(cat => {
              feedCatCounts[cat] = (feedCatCounts[cat] || 0) + 1;
            });
          }
        });
      }
      // Main feed slot (feed_categories): treated as one feed
      if (Array.isArray(u.feed_categories) && u.feed_categories.length > 0) {
        u.feed_categories.forEach(cat => {
          feedCatCounts[cat] = (feedCatCounts[cat] || 0) + 1;
        });
      }
    });

    const feedCatRanked = Object.entries(feedCatCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => ({ category, count }));

    res.json({
      signups:  { today: todaySignups||0, week: weekSignups||0, month: monthSignups||0, quarter: quarterSignups||0, year: yearSignups||0, total: totalSignups||0 },
      verified: { today: todayVerified||0, week: weekVerified||0, month: monthVerified||0, quarter: quarterVerified||0, year: yearVerified||0, total: totalVerified||0 },
      activeNow, last7Days, genGrid, topCats, newsPerCat, sources, readRate, feedCatRanked,
      // Legacy fields — used by other admin tabs
      users: { total: totalSignups||0, new_7d: weekSignups||0, verified: totalVerified||0 },
      active_users: activeNow,
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Lightweight active-now endpoint — polled every 30s by the admin dashboard
// Uses the in-memory _activeSessions map; no DB query needed.
app.get('/admin/api/active-now', (req, res) => {
  const cutoff = Date.now() - 90_000; // 90s window
  let guests = 0, signedIn = 0;
  for (const [, s] of _activeSessions) {
    if (s.lastSeen >= cutoff) {
      if (s.userId) signedIn++; else guests++;
    }
  }
  res.json({ guests, signedIn, total: guests + signedIn, ts: new Date().toISOString() });
});

app.get('/admin/api/news', async (req, res) => {
  try {
    const { day, timeSlot, language, category } = req.query;
    let query = supabaseAdmin.from('news_summaries').select('*').order('generated_at', { ascending: false }).limit(200);
    if (day)      query = query.eq('day', day);
    if (timeSlot) query = query.eq('time_slot', timeSlot);
    if (language) query = query.eq('language', language);
    if (category) query = query.eq('category', category);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/admin/api/users', async (req, res) => {
  try {
    const { data: users, error } = await supabaseAdmin.from('users').select('id, email, created_at, verification_status').order('created_at', { ascending: false });
    if (error) throw error;

    const { data: cats } = await supabaseAdmin.from('custom_categories').select('user_id');
    const catCount = {};
    cats?.forEach(c => { catCount[c.user_id] = (catCount[c.user_id] || 0) + 1; });

    // Fetch only the most-recent event per user — limit to last 90 days to cap egress
    const { data: lastActivity } = await supabaseAdmin.from('behavioral_metrics').select('user_id, created_at').gte('created_at', new Date(Date.now() - 90*24*60*60*1000).toISOString()).order('created_at', { ascending: false }).limit(5000);
    const lastSeen = {};
    lastActivity?.forEach(e => { if (!lastSeen[e.user_id]) lastSeen[e.user_id] = e.created_at; });

    const result = (users || []).map(u => ({
      ...u,
      custom_category_count: catCount[u.id] || 0,
      last_active: lastSeen[u.id] || null
    }));

    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/admin/api/behavior', async (req, res) => {
  try {
    const today = getTodayDate();
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Limit to last 30 days — prevents full-table scan as the table grows
    const { data: allEvents } = await supabaseAdmin.from('behavioral_metrics').select('user_id, event_type, category_selected, day_selected, time_selected, created_at').gte('created_at', new Date(Date.now() - 30*24*60*60*1000).toISOString()).order('created_at', { ascending: false });

    const total_events  = allEvents?.length || 0;
    const unique_users  = new Set(allEvents?.map(e => e.user_id)).size;
    const events_today  = allEvents?.filter(e => e.created_at?.startsWith(today)).length || 0;

    // Category counts
    const catCounts = {};
    allEvents?.forEach(e => { if (e.category_selected) catCounts[e.category_selected] = (catCounts[e.category_selected] || 0) + 1; });
    const top_categories = Object.entries(catCounts).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([category, views]) => ({ category, views }));

    // Events by day (last 7 days)
    const dayBuckets = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      dayBuckets[d.toISOString().split('T')[0]] = 0;
    }
    allEvents?.forEach(e => {
      const day = e.created_at?.split('T')[0];
      if (day && dayBuckets[day] !== undefined) dayBuckets[day]++;
    });
    const events_by_day = Object.entries(dayBuckets).map(([date, count]) => ({ date, count }));

    // Enrich recent events with user email
    const recentIds = [...new Set(allEvents?.slice(0, 50).map(e => e.user_id).filter(Boolean))];
    const { data: userEmails } = await supabaseAdmin.from('users').select('id, email').in('id', recentIds.length ? recentIds : ['00000000-0000-0000-0000-000000000000']);
    const emailMap = {};
    userEmails?.forEach(u => { emailMap[u.id] = u.email; });

    const recent_events = (allEvents || []).slice(0, 50).map(e => ({ ...e, user_email: emailMap[e.user_id] || null }));

    res.json({ total_events, unique_users, events_today, top_categories, events_by_day, recent_events });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/admin/api/usage', async (req, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    const { data: allUsage }    = await supabaseAdmin.from('api_usage').select('*').order('created_at', { ascending: false });
    const { data: monthUsage }  = await supabaseAdmin.from('api_usage').select('estimated_cost_usd, token_cost_usd, search_cost_usd, input_tokens, output_tokens, web_searches').gte('created_at', monthStart);
    const { data: recentUsage } = await supabaseAdmin.from('api_usage').select('*').gte('created_at', fourteenDaysAgo).order('created_at', { ascending: false });

    const total_input_tokens   = allUsage?.reduce((s,r) => s + (r.input_tokens||0), 0) || 0;
    const total_output_tokens  = allUsage?.reduce((s,r) => s + (r.output_tokens||0), 0) || 0;
    const total_web_searches   = allUsage?.reduce((s,r) => s + (r.web_searches||0), 0) || 0;
    const cost_all_time        = allUsage?.reduce((s,r) => s + (r.estimated_cost_usd||0), 0) || 0;
    const cost_this_month      = monthUsage?.reduce((s,r) => s + (r.estimated_cost_usd||0), 0) || 0;
    const token_cost_this_month  = monthUsage?.reduce((s,r) => s + (r.token_cost_usd||0), 0) || 0;
    const search_cost_this_month = monthUsage?.reduce((s,r) => s + (r.search_cost_usd||0), 0) || 0;
    const searches_this_month  = monthUsage?.reduce((s,r) => s + (r.web_searches||0), 0) || 0;
    const runs_this_month      = monthUsage?.length || 0;
    const avg_cost_per_run     = runs_this_month ? cost_this_month / runs_this_month : 0;
    const avg_searches_per_run = runs_this_month ? searches_this_month / runs_this_month : 0;

    // Daily cost buckets (last 14 days) — split token vs search
    const dayBuckets = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      dayBuckets[d.toISOString().split('T')[0]] = { total: 0, tokens: 0, search: 0 };
    }
    recentUsage?.forEach(r => {
      const day = r.created_at?.split('T')[0];
      if (day && dayBuckets[day] !== undefined) {
        dayBuckets[day].total  += (r.estimated_cost_usd || 0);
        dayBuckets[day].tokens += (r.token_cost_usd || r.estimated_cost_usd || 0);
        dayBuckets[day].search += (r.search_cost_usd || 0);
      }
    });
    const by_day = Object.entries(dayBuckets).map(([date, c]) => ({
      date,
      cost:   parseFloat(c.total.toFixed(6)),
      tokens: parseFloat(c.tokens.toFixed(6)),
      search: parseFloat(c.search.toFixed(6))
    }));

    res.json({
      total_input_tokens, total_output_tokens, total_web_searches,
      cost_all_time, cost_this_month, runs_this_month,
      token_cost_this_month, search_cost_this_month, searches_this_month,
      avg_cost_per_run, avg_searches_per_run,
      by_day, recent_runs: (allUsage || []).slice(0, 100)
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── Audit agent — status, toggle, flagged digests ───────────────────────────
// Regeneration for a flagged row reuses the existing POST /api/generate/:timeSlot
// endpoint (pass day/language/category) rather than a new one — it already does
// exactly this and now runs the audit again on the fresh digest.
app.get('/admin/api/audit/status', async (req, res) => {
  try {
    const enabled = await isAuditEnabled();
    res.json({ enabled, persisted: !appSettingsTableMissing });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/admin/api/audit/toggle', async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const result = await setAuditEnabled(enabled);
    res.json({ enabled, ...result });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── Generation pause switch — blocks scheduled, watchdog, and manual triggers alike
// while off. See the check in POST /api/generate/:timeSlot and the generationEnabled
// field on GET /api/generation-status (read by the watchdog workflow).
app.get('/admin/api/generation/status', async (req, res) => {
  try {
    const enabled = await isGenerationEnabled();
    res.json({ enabled, persisted: !appSettingsTableMissing });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/admin/api/generation/toggle', async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const result = await setGenerationEnabled(enabled);
    res.json({ enabled, ...result });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── Automated-Evening-only switch — narrower than the master pause above. See the
// `auto` flag check in POST /api/generate/:timeSlot.
app.get('/admin/api/generation/evening-auto/status', async (req, res) => {
  try {
    const enabled = await isEveningAutoEnabled();
    res.json({ enabled, persisted: !appSettingsTableMissing });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/admin/api/generation/evening-auto/toggle', async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const result = await setEveningAutoEnabled(enabled);
    res.json({ enabled, ...result });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/admin/api/audit', async (req, res) => {
  try {
    const { day } = req.query; // optional — omit to see the last 300 audited digests across all days
    let query = supabaseAdmin
      .from('news_summaries')
      .select('id, category, day, time_slot, language, generated_at, audit_result')
      .not('audit_result', 'is', null)
      .order('generated_at', { ascending: false });
    query = day ? query.eq('day', day) : query.limit(300);
    const { data, error } = await query;
    if (error) throw error;

    const rows = data || [];
    const flagged = rows.filter(r => r.audit_result?.passed === false);
    const passed  = rows.filter(r => r.audit_result?.passed === true);
    res.json({
      flagged_count: flagged.length,
      passed_count: passed.length,
      flagged: flagged.map(r => ({
        id: r.id, category: r.category, day: r.day, time_slot: r.time_slot, language: r.language,
        generated_at: r.generated_at,
        flags: r.audit_result?.flags || [],
        checked_at: r.audit_result?.checked_at || null,
      })),
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── TTS cache — stats + retention cleanup ───────────────────────────────────
// Files are named by content hash (md5 of the script text), not by day/category —
// there's no date in the filename, so age has to come from Supabase Storage's own
// created_at per object. The day picker only ever shows the last 7 days (see
// daysOfWeek in App.js), so any audio older than that is already unreachable from
// the app — a 14-day default leaves a safety margin without being a set-and-forget
// automatic deletion. Always manual, always dry-run-first: see the admin UI.
async function listAllTTSCacheFiles() {
  const all = [];
  const limit = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabaseAdmin.storage.from('tts-cache').list('', { limit, offset });
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < limit) break;
    offset += limit;
  }
  return all;
}

app.get('/admin/api/tts-cache/stats', async (req, res) => {
  try {
    const files = await listAllTTSCacheFiles();
    const totalBytes = files.reduce((s, f) => s + (f.metadata?.size || 0), 0);
    res.json({ fileCount: files.length, totalBytes });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/admin/api/tts-cache/cleanup', async (req, res) => {
  try {
    const days = Number(req.body?.days) > 0 ? Number(req.body.days) : 14;
    const dryRun = req.body?.dryRun !== false; // default true — caller must explicitly pass false to actually delete
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const files = await listAllTTSCacheFiles();
    const stale = files.filter(f => new Date(f.created_at).getTime() < cutoff);
    const totalBytes = stale.reduce((s, f) => s + (f.metadata?.size || 0), 0);

    if (dryRun) {
      return res.json({ dryRun: true, days, fileCount: stale.length, totalBytes });
    }

    // Supabase's remove() takes a flat array of paths — batch to stay well under
    // any request-size limit.
    let deleted = 0;
    for (let i = 0; i < stale.length; i += 500) {
      const batch = stale.slice(i, i + 500).map(f => f.name);
      const { error } = await supabaseAdmin.storage.from('tts-cache').remove(batch);
      if (error) throw error;
      deleted += batch.length;
    }
    res.json({ dryRun: false, days, fileCount: deleted, totalBytes });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==========================================
// ENDPOINT: SAVE EMAIL PREFERENCES
// ==========================================
// ── Read a user's own settings ───────────────────────────────────────────────
// Saving goes through the backend (service role); reading used to go straight from the
// browser to Supabase on the anon key, which only works while a Supabase auth session is
// live. The app's own idea of "signed in" is the newsdigest_user blob in localStorage, which
// never expires — so once the Supabase session lapsed, the read was unauthorised, returned
// null, and the caller silently fell back to whatever that device had stored. Change your
// topics on the phone, open the laptop, see the laptop's old list.
//
// Reading here makes it symmetric with the write and removes the silent-fallback path.
app.get('/api/user/preferences', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const [prefRes, catRes] = await Promise.all([
      supabaseAdmin.from('users').select('feed_categories, news_language').eq('id', userId).maybeSingle(),
      supabaseAdmin.from('custom_categories').select('category_name, category_description')
        .eq('user_id', userId).is('deleted_at', null),
    ]);
    if (prefRes.error) throw prefRes.error;
    if (catRes.error)  throw catRes.error;

    res.json({
      // null (not []) when the row has never been written, so the client can tell
      // "no saved preference" from "saved an empty list" and fall back correctly.
      feedCategories:   prefRes.data?.feed_categories ?? null,
      newsLanguage:     prefRes.data?.news_language ?? null,
      customCategories: (catRes.data || []).map(c => ({
        name: c.category_name,
        description: c.category_description || c.category_name,
      })),
    });
  } catch (error) {
    console.error('Error reading user preferences:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/user/feed-categories', async (req, res) => {
  try {
    const { userId, categories } = req.body;
    if (!userId || !Array.isArray(categories)) {
      return res.status(400).json({ error: 'userId and categories array are required' });
    }
    const { error } = await supabaseAdmin
      .from('users')
      .update({ feed_categories: categories })
      .eq('id', userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving feed categories:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/user/news-language', async (req, res) => {
  try {
    const { userId, language } = req.body;
    if (!userId || !['en', 'ar'].includes(language)) {
      return res.status(400).json({ error: "userId and language ('en' or 'ar') are required" });
    }
    const { error } = await supabaseAdmin
      .from('users')
      .update({ news_language: language })
      .eq('id', userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving news language:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Debug: synchronously run generateNews and return result or error
app.get('/admin/api/raw-content', async (req, res) => {
  const { category, day, timeSlot } = req.query;
  const { data } = await supabaseAdmin.from('news_summaries').select('content')
    .eq('category', category || 'World News')
    .eq('day', day || getTodayDate())
    .eq('time_slot', timeSlot || 'Morning')
    .maybeSingle();
  res.json({ content: data?.content || null });
});

app.get('/admin/api/test-claude', async (req, res) => {
  try {
    const result = await callClaude('Say "ok" and nothing else.', 10, 0);
    res.json({ ok: true, model: 'claude-haiku-4-5-20251001', response: result?.content?.[0]?.text });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /admin/api/debug-context?category=UAE — runs Serper + ranking (NO Claude),
// returns the top-ranked articles with their tier/local classification so the
// regional local-first ordering can be verified cheaply.
// GET /admin/api/audit-region?country=Lebanon — discovers a country's tier-1
// outlets (via Claude), classifies each by whether Serper/Google returns its
// fresh ENGLISH coverage, and auto-detects each one's RSS feed. Produces the
// report used to decide which outlets need direct-RSS vs Serper site: targeting.
// Costs ~1 Serper call per outlet (one-off audit, not per generation).
app.get('/admin/api/audit-region', async (req, res) => {
  try {
    const country = req.query.country || 'Lebanon';
    const day = req.query.day || null; // null → recent window (lenient indexing test)

    // 1. Claude enumerates the tier-1 outlet roster.
    const rosterPrompt = `List the most important tier-1 news outlets for ${country} — national news agencies, major newspapers, and major news websites (include both English and Arabic-primary outlets). For each, give the primary domain, the English-edition domain or subdomain if one exists (else null), whether it is the national news agency, and its primary language.
Respond with ONLY a JSON array (no markdown, no prose), max 18 items:
[{"name":"Annahar","domain":"annahar.com","english_domain":"en.annahar.com","is_agency":false,"primary_language":"ar"}]`;
    const cl = await callClaude(rosterPrompt, 1500, 1);
    let txt = (cl.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    txt = txt.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let roster;
    try { roster = JSON.parse(txt); } catch { return res.json({ ok: false, error: 'Claude did not return valid JSON', raw: txt.slice(0, 500) }); }
    if (!Array.isArray(roster)) return res.json({ ok: false, error: 'roster not an array', raw: txt.slice(0, 500) });

    // 2 + 3. Classify each outlet via Serper, then auto-detect its RSS feed.
    const outlets = [];
    for (const o of roster.slice(0, 18)) {
      const testDomain = o.english_domain || o.domain;
      const serper = { count: 0, en_titles: 0, ar_titles: 0, sample: [] };
      try {
        const r = await serperSearch(`site:${testDomain}`, 10, day, 'us', 'en');
        const items = r.news || [];
        serper.count = items.length;
        for (const it of items) (titleIsArabic(it.title) ? serper.ar_titles++ : serper.en_titles++);
        serper.sample = items.slice(0, 3).map(it => ({ t: (it.title || '').slice(0, 48), d: it.date || '' }));
      } catch {}

      const hasEnglish = !!o.english_domain || o.primary_language === 'en';
      let classification;
      if (serper.en_titles >= 2)      classification = 'serper_ok';   // Google indexes its English coverage
      else if (hasEnglish)            classification = 'rss_needed';  // has English, but Serper can't retrieve it
      else                            classification = 'arabic_only'; // no English edition → Arabic run only

      // Discover RSS for anything English-capable or the national agency.
      const rss = (hasEnglish || o.is_agency) ? await discoverRssFeed(o.english_domain || o.domain) : null;

      outlets.push({
        name: o.name, domain: o.domain, english_domain: o.english_domain || null,
        is_agency: !!o.is_agency, primary_language: o.primary_language || '',
        classification, serper, rss_feed: rss,
      });
      await new Promise(r => setTimeout(r, 250)); // gentle pacing
    }

    const summary = outlets.reduce((m, o) => { m[o.classification] = (m[o.classification] || 0) + 1; return m; }, {});
    res.json({ country, day: day || 'recent', count: outlets.length, summary, outlets });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});
// ── Completeness audit ───────────────────────────────────────────────────────
// The Compare tab measures lane 4's marginal contribution, which is a cost question, not a
// completeness one — comparing the system against one of its own funnels cannot tell you
// what all of them missed together. That needs a yardstick from outside the pipeline.
//
// GDELT is the only real candidate: it monitors hundreds of thousands of sources, updates
// every 15 minutes, is free, and — crucially — is not a lane here, so its blind spots are
// not ours. Its weakness is that it has no authority ranking at all, which would make it
// useless as a source and makes it ideal as an auditor: we never publish a word of it, we
// only ask whether a story lots of outlets covered is missing from what we published.
//
// "Big" is measured the way it should be: the number of DISTINCT DOMAINS carrying a story.
// One outlet writing five times is not a big story; forty outlets writing once is.
const GDELT_QUERIES = {
  'World News':   '(war OR ceasefire OR summit OR election OR crisis)',
  'Politics':     '(parliament OR election OR government OR minister OR policy)',
  'Business':     '(markets OR earnings OR economy OR inflation OR merger)',
  'Technology':   '(technology OR software OR chips OR smartphone OR platform)',
  'Science':      '(research OR study OR space OR climate OR discovery)',
  'Health':       '(health OR disease OR hospital OR vaccine OR treatment)',
  'Sports':       '(match OR tournament OR championship OR transfer)',
  'Entertainment':'(film OR music OR streaming OR celebrity OR award)',
  'AI':           '("artificial intelligence" OR "machine learning" OR chatbot)',
  'Crypto':       '(bitcoin OR cryptocurrency OR blockchain OR ethereum)',
  'Football':     '(football OR soccer OR "premier league" OR "champions league")',
  'Basketball':   '(basketball OR NBA)',
  'UAE':          '("United Arab Emirates" OR Dubai OR "Abu Dhabi")',
  'KSA':          '("Saudi Arabia" OR Riyadh OR Jeddah)',
  'QAT':          '(Qatar OR Doha)',
  'LEB':          '(Lebanon OR Beirut)',
};

const STOPISH = new Set(['the','and','for','with','from','that','this','have','been','will','after','over','into','their','says','said','amid','more','than','what','when','about','which','were','they','could','would']);
const sigTokens = (t) => (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOPISH.has(w));

app.get('/admin/api/completeness', async (req, res) => {
  try {
    const category = req.query.category || 'World News';
    const day = req.query.day || getTodayDate();
    const timeSlot = req.query.timeSlot === 'Evening' ? 'Evening' : 'Morning';
    const hours = req.query.hours || '24';

    // What we actually published.
    const { data: row, error } = await supabaseAdmin
      .from('news_summaries')
      .select('content, generated_at')
      .eq('category', category).eq('day', day).eq('time_slot', timeSlot).eq('language', 'en')
      .is('user_id', null).is('shared_key', null).maybeSingle();
    if (error) throw error;
    const published = (row?.content || '').split('\n')
      .filter(l => /^##\s+/.test(l) && !/Sources/i.test(l))
      .map(l => l.replace(/^##\s+/, '').trim());

    // What the world covered, per an index that is not ours.
    const q = GDELT_QUERIES[category] || category;
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q + ' sourcelang:english')}`
              // 75, not 250: GDELT throttles large requests as "high traffic" and returns a
              // plain-text 429. 75 comes back reliably and is plenty to rank the day's
              // biggest clusters, which is all this needs.
              + `&mode=artlist&maxrecords=75&timespan=${encodeURIComponent(hours + 'h')}&format=json&sort=hybridrel`;
    // One request every 5 seconds is GDELT's published limit, so a throttled response is
    // expected rather than exceptional — wait it out once rather than failing the check.
    let gdelt = null;
    for (let attempt = 0; attempt < 3 && gdelt === null; attempt++) {
      if (attempt) await new Promise(r2 => setTimeout(r2, 6000));
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RadioNewsBot/1.0)' }, signal: AbortSignal.timeout(25000) });
        const text = await r.text();
        gdelt = JSON.parse(text).articles || [];
      } catch { gdelt = null; }
    }
    if (gdelt === null) {
      return res.json({ category, day, timeSlot, publishedStories: published.length,
        error: 'GDELT did not answer after three tries — it rate-limits to one request every 5 seconds' });
    }

    // Cluster GDELT's articles, then rank clusters by how many distinct DOMAINS carry them.
    const clusters = [];
    for (const a of gdelt) {
      const toks = new Set(sigTokens(a.title));
      if (toks.size < 3) continue;
      const hit = clusters.find(c => [...toks].filter(t => c.tokens.has(t)).length >= 3);
      if (hit) { hit.domains.add(a.domain); hit.titles.push(a.title); toks.forEach(t => hit.tokens.add(t)); }
      else clusters.push({ tokens: toks, domains: new Set([a.domain]), titles: [a.title] });
    }
    const big = clusters
      .map(c => ({ outlets: c.domains.size, title: c.titles[0], tokens: c.tokens, domains: [...c.domains].slice(0, 6) }))
      .filter(c => c.outlets >= 3)
      .sort((a, b) => b.outlets - a.outlets)
      .slice(0, 15);

    // Did we publish it? Same token overlap test, against our own headlines.
    const pubToks = published.map(h => new Set(sigTokens(h)));
    const scored = big.map(c => {
      const covered = pubToks.some(p => [...c.tokens].filter(t => p.has(t)).length >= 2);
      return { title: c.title, outlets: c.outlets, domains: c.domains, covered };
    });

    const missed = scored.filter(x => !x.covered);
    res.json({
      category, day, timeSlot,
      generatedAt: row?.generated_at || null,
      publishedStories: published.length,
      gdeltArticles: gdelt.length,
      bigEvents: scored.length,
      covered: scored.length - missed.length,
      missRate: scored.length ? Math.round(missed.length / scored.length * 100) : 0,
      events: scored,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Coverage gap ─────────────────────────────────────────────────────────────
// "How do I know we have every tier-one outlet?" cannot be answered in the affirmative —
// the registry is hand-assembled and always will be. What can be answered is how big the
// gap is and what is in it.
//
// Every article Serper has returned is stored in source_articles. Rank the outlets that
// appear there but are NOT in the registry, by how often they turn up. Real outlets rise
// to the top of that list and obvious noise stays visibly noise, so the judgement call is
// reduced to reading a ranked list rather than trying to recall the world's newspapers.
app.get('/admin/api/coverage', async (req, res) => {
  try {
    const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const { data, error } = await supabaseAdmin
      .from('news_summaries')
      .select('category, day, source_articles')
      .gte('day', since)
      .is('user_id', null).is('shared_key', null)
      .not('source_articles', 'is', null);
    if (error) throw error;

    const seen = new Map();   // domain → { name, count, cats:Set, sample }
    let total = 0, inRegistry = 0;
    for (const row of data || []) {
      let arts = row.source_articles;
      if (typeof arts === 'string') { try { arts = JSON.parse(arts); } catch { continue; } }
      for (const a of arts || []) {
        total++;
        if (sourceForUrl(a.url)) { inRegistry++; continue; }
        let host = '';
        try { host = new URL(a.url).hostname.replace(/^www\./, ''); } catch { continue; }
        const e = seen.get(host) || { domain: host, name: a.source || host, count: 0, cats: new Set(), sample: a.title || '' };
        e.count++; e.cats.add(row.category);
        seen.set(host, e);
      }
    }

    const candidates = [...seen.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 60)
      .map(e => ({ domain: e.domain, name: e.name, count: e.count, categories: [...e.cats].sort(), sample: e.sample.slice(0, 90) }));

    res.json({
      days, since,
      registrySize: TIER1_SOURCES.length,
      articlesSeen: total,
      inRegistry,
      inRegistryPct: total ? Math.round(inRegistry / total * 100) : 0,
      distinctOutletsMissing: seen.size,
      candidates,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Retrieval comparison ─────────────────────────────────────────────────────
// Runs both retrieval paths over the same category, at the same moment, and reports what
// each found. The point is to retire Serper with evidence rather than enthusiasm: if the
// corpus lanes never miss anything Serper catches, that is a number, not an argument.
//
// Costs a handful of Serper credits per run, so it is on-demand from the dashboard only.
app.get('/admin/api/compare', async (req, res) => {
  try {
    const category = req.query.category || 'World News';
    const language = req.query.language === 'ar' ? 'ar' : 'en';
    const timeSlot = req.query.timeSlot === 'Evening' ? 'Evening' : 'Morning';
    const day = req.query.day || getTodayDate();
    const withSerper = req.query.serper !== 'false';

    const isRegional = REGIONAL_CATEGORIES_SET.has(category);
    const catQuery = language === 'ar'
      ? (ARABIC_CATEGORY_QUERIES[category] || category)
      : (CATEGORY_SEARCH_QUERIES[category] || category);

    const t0 = Date.now();
    const [corpus, serper] = await Promise.all([
      // Lanes 1–3 only by default: a comparison where one side contains the other measures
      // nothing, and it would bill Serper twice. `corpusSerper=1` turns lane 4 on inside the
      // corpus, which is how we test whether Serper's real publisher URLs can supply the
      // article text that lanes 2 and 3 structurally cannot.
      buildCorpusContext(category, day, language, timeSlot, req.query.corpusSerper === '1')
        .then(r => ({ ...r, ms: Date.now() - t0 }))
        .catch(e => ({ error: e.message, articles: [], stats: {}, ms: Date.now() - t0 })),
      withSerper
        ? buildSearchContext(catQuery, day, language, isRegional, category)
            .then(r => ({ ...r, ms: Date.now() - t0 })).catch(e => ({ error: e.message, articles: [], ms: Date.now() - t0 }))
        : Promise.resolve({ articles: [], skipped: true, ms: 0 }),
    ]);

    // What each found that the other did not — matched on a normalised title, since the
    // two paths return different URLs for the same article (publisher link vs redirect).
    const norm = t => (t || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, '').slice(0, 60);
    const cKeys = new Set((corpus.articles || []).map(a => norm(a.title)));
    const sKeys = new Set((serper.articles || []).map(a => norm(a.title)));
    const onlyCorpus = (corpus.articles || []).filter(a => !sKeys.has(norm(a.title)));
    const onlySerper = (serper.articles || []).filter(a => !cKeys.has(norm(a.title)));
    const both = (corpus.articles || []).filter(a => sKeys.has(norm(a.title)));

    // Serper's pool graded against the same tier-one rule the corpus enforces at ingestion.
    let serperNonTier1 = 0;
    for (const a of serper.articles || []) if (!sourceForUrl(a.url)) serperNonTier1++;

    const med = arr => { const l = arr.slice().sort((x, y) => x - y); return l.length ? l[Math.floor(l.length / 2)] : 0; };

    res.json({
      category, language, timeSlot, day,
      corpus: {
        error: corpus.error || null,
        count: (corpus.articles || []).length,
        stats: corpus.stats || {},
        medianTextByLane: (corpus.stats || {}).medianTextByLane || {},
        medianTextChars: med((corpus.articles || []).map(a => (a.snippet || '').length)),
        outlets: [...new Set((corpus.articles || []).map(a => a.source))].sort(),
        ms: corpus.ms || 0,
      },
      serper: {
        error: serper.error || null, skipped: !!serper.skipped,
        count: (serper.articles || []).length,
        nonTier1: serperNonTier1,
        nonTier1Pct: (serper.articles || []).length ? Math.round(serperNonTier1 / serper.articles.length * 100) : 0,
        medianTextChars: med((serper.articles || []).map(a => (a.snippet || '').length)),
        outlets: [...new Set((serper.articles || []).map(a => a.source))].sort(),
        ms: serper.ms || 0,
      },
      overlap: { both: both.length, onlyCorpus: onlyCorpus.length, onlySerper: onlySerper.length },
      // What adding Serper as lane 4 would actually contribute: its tier-one articles that
      // lanes 1–3 did not already have. This is the number that justifies the extra credits.
      lane4: {
        tier1Total: (serper.articles || []).length - serperNonTier1,
        newToCorpus: onlySerper.filter(a => !!sourceForUrl(a.url)).length,
      },
      // Full article list on request — needed to ask questions like "for each story we
      // could not read, was the same story available from an outlet that sends text?"
      corpusArticles: req.query.full === '1' ? (corpus.articles || []) : undefined,
      // The two lists that decide whether Serper can be retired.
      samples: {
        onlyCorpus: onlyCorpus.slice(0, 12).map(a => ({ title: a.title, source: a.source, lane: a.lane, outletCount: a.outletCount })),
        onlySerper: onlySerper.slice(0, 12).map(a => ({ title: a.title, source: a.source, tier1: !!sourceForUrl(a.url) })),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Config inspector ─────────────────────────────────────────────────────────
// Everything that decides what a category searches for and how its digest is written, read
// from the live constants rather than restated — so this page cannot drift from what the
// generator actually does. If a rule shows here, that is the rule being sent.
app.get('/admin/api/config', (req, res) => {
  try {
    const dateLabel = 'September 10, 2026';   // a sample label, so queries render as they will
    const rows = DEFAULT_CATEGORIES.map(category => {
      const isRegional = REGIONAL_CATEGORIES_SET.has(category);
      const baseQuery  = CATEGORY_SEARCH_QUERIES[category] || category;

      // Rebuild the exact query list buildSearchContext would produce for this category.
      let queries, queryStyle;
      if (category === 'World News') {
        queries = WORLD_NEWS_ANGLE_QUERIES(dateLabel); queryStyle = 'angles';
      } else if (category === 'Politics') {
        queries = POLITICS_ANGLE_QUERIES(baseQuery, dateLabel); queryStyle = 'angles';
      } else if (isRegional) {
        const h  = REGIONAL_QUERY_HINTS[category] || { agency: '', outlets: '' };
        const rs = REGION_SUBJECT[category] || baseQuery;
        const sites = [...(NATIONAL_AGENCIES[category] || []), ...localTier1En(category)].slice(0, 9);
        const siteFilter = sites.map(d => `site:${d}`).join(' OR ');
        const localOnly  = localTier1En(category).slice(0, 6).map(d => `site:${d}`).join(' OR ');
        queries = [
          `${baseQuery} ${dateLabel}`,
          `${baseQuery} breaking latest`,
          `${rs} news ${h.outlets} ${dateLabel}`,
          siteFilter ? `${rs} (${siteFilter})` : `${rs} ${h.agency} ${dateLabel}`,
          localOnly ? `${rs} (${localOnly})` : `${baseQuery} politics economy diplomacy security`,
          `${rs} business economy sports culture entertainment lifestyle education health weather ${dateLabel}`,
        ];
        queryStyle = 'regional';
      } else if (CATEGORY_ANGLE_QUERIES[category]) {
        queries = CATEGORY_ANGLE_QUERIES[category](dateLabel); queryStyle = 'angles';
      } else {
        queries = [
          `${baseQuery} news ${dateLabel}`,
          `${baseQuery} breaking update latest`,
          `${baseQuery} analysis reaction development`,
          `${baseQuery} top stories today ${dateLabel}`,
          `${baseQuery} major announcement impact`,
        ];
        queryStyle = 'suffixes';
      }

      return {
        category,
        isRegional,
        queryStyle,
        baseQuery,
        arabicQuery: ARABIC_CATEGORY_QUERIES[category] || null,
        generatedInArabic: !!ARABIC_CATEGORY_QUERIES[category],
        queries,
        phase2: 'up to 3 adaptive follow-ups (English only)',
        resultsPerQuery: 30,
        storyCountGuide: isRegional ? '6–10' : '6–9',
        prioritisation: isRegional ? 'local-first (5 rules)' : 'tier-1 echo (4 rules)',
        regionGate: isRegional ? (REGION_SUBJECT[category] || null) : null,
        spreadRule: !isRegional ? (SPREAD_RULES[category] || null) : null,
        rssFeeds: (REGIONAL_RSS[category] || []).map(f => ({ name: f.name, url: f.url })),
        nationalAgency: NATIONAL_AGENCIES[category] || [],
        localOutlets: LOCAL_TIER1[category]?.all || [],
      };
    });

    res.json({
      generatedAt: new Date().toISOString(),
      model: 'claude-haiku-4-5-20251001',
      timeSlots: TIME_SLOTS.map(t => `${t.label} (${t.time})`),
      rssMaxAgeHours: RSS_MAX_AGE_HOURS,
      swipeBatchNote: 'Serper: 5–6 phase-1 queries + up to 3 phase-2, 30 results each',
      tier1DomainCount: TIER1_DOMAINS.size,
      categories: rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// GET /admin/api/debug-serper?q=...&day=YYYY-MM-DD — runs the SAME query against
// Serper's /news and /search endpoints so we can see what each returns (e.g.
// whether a small English edition shows in web search but not Google News).
app.get('/admin/api/debug-serper', async (req, res) => {
  try {
    const q = req.query.q || 'Lebanon news';
    const day = req.query.day || null;
    let tbs = 'qdr:2d';
    if (day) {
      const d  = new Date(day + 'T12:00:00Z');
      const d1 = new Date(d); d1.setUTCDate(d1.getUTCDate() - 1);
      const fmt = x => `${String(x.getUTCMonth()+1).padStart(2,'0')}/${String(x.getUTCDate()).padStart(2,'0')}/${x.getUTCFullYear()}`;
      tbs = `cdr:1,cd_min:${fmt(d1)},cd_max:${fmt(d)}`;
    }
    // `num` is a parameter because it turned out to matter: a day-pinned query that cannot
    // fill the requested count is where out-of-window results come from, so comparing the
    // same query at two sizes is the whole diagnostic.
    const num = Math.min(100, Math.max(1, parseInt(req.query.num, 10) || 20));
    const call = async (path) => {
      const r = await fetch(`https://google.serper.dev/${path}`, {
        method: 'POST',
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, num, gl: 'us', hl: 'en', tbs }),
      });
      if (!r.ok) return { httpError: r.status };
      const j = await r.json();
      const items = j.news || j.organic || [];
      const stale = items.filter(it => /week|month|year/i.test(it.date || '')).length;
      return {
        count: items.length,
        staleCount: stale,
        all: items.map(it => ({ date: it.date || '', source: it.source || '', title: (it.title || '').slice(0, 70) })),
      };
    };
    const [news, search] = await Promise.all([call('news'), call('search')]);
    res.json({ q, day, tbs, num, news, search });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.get('/admin/api/debug-context', async (req, res) => {
  try {
    const category = req.query.category || 'UAE';
    const day = req.query.day || getTodayDate();
    const language = req.query.language || 'en';
    const isRegional = REGIONAL_CATEGORIES_SET.has(category);
    const categoryQuery = language === 'ar'
      ? (ARABIC_CATEGORY_QUERIES[category] || category)
      : (CATEGORY_SEARCH_QUERIES[category] || category);
    const { articles } = await buildSearchContext(categoryQuery, day, language, isRegional, category);
    const region = isRegional ? category : null;
    const classify = (url) => {
      if (region && isNationalAgency(url, region))            return 'NATIONAL_AGENCY';
      if (region && isLocalSource(url, region))               return 'LOCAL_TIER1';
      if (isTier1(url))                                       return 'INTL_TIER1';
      return 'other';
    };
    res.json({
      category, day, region,
      count: articles.length,
      ranked: articles.slice(0, 20).map((a, i) => ({
        rank: i + 1, source: a.source, class: classify(a.url), title: a.title, url: a.url,
      })),
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/admin/api/debug-generate', async (req, res) => {
  const { category, day, timeSlot } = req.body;
  try {
    const { summary: content } = await generateNews(category || 'test', day || getTodayDate(), timeSlot || 'Evening');
    res.json({ ok: true, contentLength: content.length, preview: content.slice(0, 300) });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/admin/api/test-email', async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'to is required' });
  try {
    const result = await resend.emails.send({
      from: process.env.FROM_EMAIL || 'noreply@resend.dev',
      to,
      subject: 'Test email from The Rundown',
      html: '<p>If you received this, Resend delivery is working.</p>',
    });
    res.json({ ok: true, result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── TTS stream endpoint — returns audio bytes directly, no Supabase CDN round-trip ──
// Cache hit:  downloads from Supabase (~300ms), streams to client
// Cache miss: pipes Unreal Speech /stream response chunk-by-chunk to client (~200ms to first byte),
//             uploads to Supabase in the background so the next request is a fast cache hit
app.post('/api/tts-stream', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });

  const voiceId = process.env.UNREALSPEECH_VOICE_ID || 'Scarlett';
  const key = crypto.createHash('md5').update(`${voiceId}:${text.trim()}`).digest('hex');
  const fileName = `${key}.mp3`;

  res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'public, max-age=604800');

  // Check cache
  try {
    const { data: cached } = await supabaseAdmin.storage.from('tts-cache').download(fileName);
    if (cached) {
      const buf = Buffer.from(await cached.arrayBuffer());
      return res.send(buf);
    }
  } catch {}

  // Cache miss — stream Unreal Speech /stream directly (≤1000 chars only; falls back for longer)
  const trimmed = text.trim();
  const apiKey = process.env.UNREALSPEECH_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'UNREALSPEECH_API_KEY not set' });

  try {
    if (trimmed.length <= 1000) {
      const unrealRes = await fetch('https://api.v7.unrealspeech.com/stream', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ Text: trimmed, VoiceId: voiceId, Bitrate: '192k', Speed: '0', Pitch: '1' }),
      });
      if (!unrealRes.ok) {
        const errBody = await unrealRes.text().catch(() => '');
        throw new Error(`Unreal Speech ${unrealRes.status}: ${errBody}`);
      }

      // Pipe stream to client while collecting bytes for Supabase cache
      const chunks = [];
      const reader = unrealRes.body.getReader();
      const pump = async () => {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          const buf = Buffer.concat(chunks);
          supabaseAdmin.storage.from('tts-cache').upload(fileName, buf, { contentType: 'audio/mpeg', upsert: false }).catch(() => {});
          return;
        }
        chunks.push(Buffer.from(value));
        res.write(value);
        pump();
      };
      return pump();
    }

    // Long text: fall back to buffered approach
    const audioBuffer = await callUnrealSpeech(trimmed);
    supabaseAdmin.storage.from('tts-cache').upload(fileName, audioBuffer, { contentType: 'audio/mpeg', upsert: false }).catch(() => {});
    return res.send(audioBuffer);
  } catch (err) {
    console.error('TTS stream error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'TTS stream failed', detail: err.message });
  }
});

// News generation is triggered exclusively by GitHub Actions via the
// /api/generate/:timeSlot HTTP endpoints — no in-process cron jobs.
// This prevents duplicate runs if the server happens to be warm at schedule time.

// ─────────────────────────────────────────────────────────────────────────────
// SOCIAL FEATURES
// ─────────────────────────────────────────────────────────────────────────────

// Helper: normalize a headline to a stable short key (mirrors frontend headlineKey)
function storyKey(headline) {
  return (headline || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().slice(0, 50);
}

// Helper: generate a unique username from an email address
async function generateUsername(email) {
  const base = (email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
  let username = base;
  let attempt = 0;
  while (attempt < 30) {
    const { data } = await supabaseAdmin.from('users').select('id').eq('username', username).maybeSingle();
    if (!data) return username; // available
    attempt++;
    username = attempt <= 9 ? `${base}${attempt}` : `${base}${Math.random().toString(36).slice(2, 5)}`;
  }
  return `${base}${Date.now().toString(36).slice(-4)}`;
}

// POST /api/social/setup-username
// Called after signup / first sign-in if the user has no username yet.
app.post('/api/social/setup-username', async (req, res) => {
  const { user_id, email } = req.body;
  if (!user_id || !email) return res.status(400).json({ error: 'Missing user_id or email' });
  // Check if already has a username
  const { data: existing } = await supabaseAdmin.from('users').select('username, display_name, avatar_color').eq('id', user_id).single();
  if (existing?.username) return res.json({ username: existing.username, display_name: existing.display_name, avatar_color: existing.avatar_color });
  const username = await generateUsername(email);
  const display_name = (email.split('@')[0] || username).replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const colors = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6'];
  const avatar_color = colors[Math.abs(username.charCodeAt(0) + (username.charCodeAt(1) || 0)) % colors.length];
  await supabaseAdmin.from('users').update({ username, display_name, avatar_color }).eq('id', user_id);
  res.json({ username, display_name, avatar_color });
});

// GET /api/social/profile/:username — public profile with saves + counts
app.get('/api/social/profile/:username', async (req, res) => {
  const { username } = req.params;
  const { requesterId } = req.query; // optional: caller's user_id to check if following
  const { data: profile, error } = await supabaseAdmin.from('users')
    .select('id, username, display_name, avatar_color')
    .eq('username', username).eq('verification_status', 'verified').maybeSingle();
  if (error || !profile) return res.status(404).json({ error: 'User not found' });

  const [savesRes, followerRes, followingRes, isFollowingRes] = await Promise.all([
    supabaseAdmin.from('user_saves').select('*').eq('user_id', profile.id).order('saved_at', { ascending: false }),
    supabaseAdmin.from('user_follows').select('*', { count: 'exact', head: true }).eq('following_id', profile.id),
    supabaseAdmin.from('user_follows').select('*', { count: 'exact', head: true }).eq('follower_id', profile.id),
    requesterId
      ? supabaseAdmin.from('user_follows').select('id').eq('follower_id', requesterId).eq('following_id', profile.id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  res.json({
    ...profile,
    saves: savesRes.data || [],
    followerCount: followerRes.count || 0,
    followingCount: followingRes.count || 0,
    isFollowing: !!isFollowingRes.data,
  });
});

// POST /api/social/follow
app.post('/api/social/follow', async (req, res) => {
  const { follower_id, following_id } = req.body;
  if (!follower_id || !following_id || follower_id === following_id) return res.status(400).json({ error: 'Invalid' });
  const { error } = await supabaseAdmin.from('user_follows')
    .upsert({ follower_id, following_id }, { onConflict: 'follower_id,following_id', ignoreDuplicates: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// DELETE /api/social/follow/:followingId  (body: { user_id })
app.delete('/api/social/follow/:followingId', async (req, res) => {
  const { followingId } = req.params;
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
  await supabaseAdmin.from('user_follows').delete().eq('follower_id', user_id).eq('following_id', followingId);
  res.json({ ok: true });
});

// GET /api/social/following?userId=
app.get('/api/social/following', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.json([]);
  const { data } = await supabaseAdmin.from('user_follows')
    .select('following_id, users!user_follows_following_id_fkey(id, username, display_name, avatar_color)')
    .eq('follower_id', userId);
  res.json((data || []).map(r => r.users).filter(Boolean));
});

// GET /api/social/followers?userId=
// GET /api/social/circle/saves?userId=
// Returns saves by people the user follows, grouped and sorted by recency.
app.get('/api/social/circle/saves', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.json([]);
  const { data: follows } = await supabaseAdmin.from('user_follows').select('following_id').eq('follower_id', userId);
  if (!follows?.length) return res.json([]);
  const followingIds = follows.map(f => f.following_id);

  const { data: saves } = await supabaseAdmin.from('user_saves')
    .select('*, users!user_saves_user_id_fkey(id, username, display_name, avatar_color)')
    .in('user_id', followingIds)
    .order('saved_at', { ascending: false })
    .limit(200);

  if (!saves?.length) return res.json([]);

  // Dedupe by story_key; attach list of who saved each
  const storyMap = {};
  saves.forEach(s => {
    const key = s.story_key;
    if (!storyMap[key]) storyMap[key] = { category: s.category, story_index: s.story_index, headline: s.headline, preview: s.preview, story_key: key, savers: [], latest_at: s.saved_at };
    if (s.users) storyMap[key].savers.push(s.users);
    if (s.saved_at > storyMap[key].latest_at) storyMap[key].latest_at = s.saved_at;
  });

  const result = Object.values(storyMap).sort((a, b) => new Date(b.latest_at) - new Date(a.latest_at));
  res.json(result);
});

// GET /api/social/circle/popular?userId=
// Returns reads by people the user follows, grouped by story_key, sorted by reader count.
app.get('/api/social/circle/popular', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.json([]);
  const { data: follows } = await supabaseAdmin.from('user_follows').select('following_id').eq('follower_id', userId);
  if (!follows?.length) return res.json([]);
  const followingIds = follows.map(f => f.following_id);

  const { data: reads } = await supabaseAdmin.from('user_reads')
    .select('story_key, category, story_index, user_id')
    .in('user_id', followingIds)
    .limit(500);

  if (!reads?.length) return res.json([]);

  const countMap = {};
  reads.forEach(r => {
    if (!countMap[r.story_key]) countMap[r.story_key] = { story_key: r.story_key, category: r.category, story_index: r.story_index, readerIds: new Set() };
    countMap[r.story_key].readerIds.add(r.user_id);
  });

  const result = Object.values(countMap)
    .map(s => ({ story_key: s.story_key, category: s.category, story_index: s.story_index, circleCount: s.readerIds.size }))
    .sort((a, b) => b.circleCount - a.circleCount);
  res.json(result);
});

// POST /api/saves/sync — save a story to Supabase
// day + content_snapshot let saved stories render as their own feed (My Saves)
// and power the global Interesting feed, independent of the current day's news.
app.post('/api/saves/sync', async (req, res) => {
  const { user_id, category, story_index, headline, preview, day, content_snapshot } = req.body;
  if (!user_id || !category || story_index === undefined || !headline) return res.status(400).json({ error: 'Missing required fields' });
  const key = storyKey(headline);
  const { data, error } = await supabaseAdmin.from('user_saves').upsert({
    user_id, category, story_index, headline, preview: preview || '', story_key: key,
    day: day || null, content_snapshot: content_snapshot || null,
    saved_at: new Date().toISOString(),
  }, { onConflict: 'user_id,story_key' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/saves/remove — unsave a story from Supabase
app.post('/api/saves/remove', async (req, res) => {
  const { user_id, headline } = req.body;
  if (!user_id || !headline) return res.status(400).json({ error: 'Missing user_id or headline' });
  const key = storyKey(headline);
  await supabaseAdmin.from('user_saves').delete().eq('user_id', user_id).eq('story_key', key);
  res.json({ ok: true });
});

// GET /api/saves?userId= — fetch all saves for a user
app.get('/api/saves', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.json([]);
  const { data } = await supabaseAdmin.from('user_saves').select('*').eq('user_id', userId).order('saved_at', { ascending: false });
  res.json(data || []);
});

// GET /api/saves/interesting — global "most interesting" stories across ALL users.
// Grouped by story_key, counted by distinct savers, sorted by count desc.
// Returns one content_snapshot per story so it can render as a feed.
app.get('/api/saves/interesting', async (req, res) => {
  const { data, error } = await supabaseAdmin.from('user_saves')
    .select('story_key, category, story_index, headline, preview, day, content_snapshot, user_id')
    .order('saved_at', { ascending: false })
    .limit(3000);
  if (error) return res.status(500).json({ error: error.message });

  const map = {};
  (data || []).forEach(s => {
    if (!map[s.story_key]) {
      map[s.story_key] = {
        story_key: s.story_key, category: s.category, story_index: s.story_index,
        headline: s.headline, preview: s.preview, day: s.day,
        content_snapshot: s.content_snapshot, savers: new Set(),
      };
    }
    const e = map[s.story_key];
    e.savers.add(s.user_id);
    // Backfill snapshot/day from any saver that has it
    if (!e.content_snapshot && s.content_snapshot) e.content_snapshot = s.content_snapshot;
    if (!e.day && s.day) e.day = s.day;
  });

  const result = Object.values(map)
    .map(e => ({
      story_key: e.story_key, category: e.category, story_index: e.story_index,
      headline: e.headline, preview: e.preview, day: e.day,
      content_snapshot: e.content_snapshot, count: e.savers.size,
    }))
    .sort((a, b) => b.count - a.count);
  res.json(result);
});

// POST /api/reads/sync — record that the user read a story
app.post('/api/reads/sync', async (req, res) => {
  const { user_id, category, story_index, headline } = req.body;
  if (!user_id || !category || story_index === undefined || !headline) return res.status(400).json({ error: 'Missing required fields' });
  const key = storyKey(headline);
  await supabaseAdmin.from('user_reads').upsert({
    user_id, story_key: key, category, story_index, read_at: new Date().toISOString(),
  }, { onConflict: 'user_id,story_key', ignoreDuplicates: true });
  res.json({ ok: true });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎉 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`⏰ Timezone: Asia/Dubai (UAE)`);
  console.log(`📅 Scheduled via GitHub Actions (no in-process cron)\n`);
});