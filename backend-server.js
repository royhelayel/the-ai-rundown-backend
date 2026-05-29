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
];

const TIME_SLOTS = [
  { value: 'morning', label: 'Morning', time: '6 AM', cronTime: '0 6 * * *' },
  { value: 'evening', label: 'Evening', time: '6 PM', cronTime: '0 18 * * *' },
];


// === Authentication & Email Imports ===
import { createClient } from '@supabase/supabase-js';
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

function formatDateForEmail(dateStr) {
  const date = new Date(dateStr + 'T00:00:00Z');
  return date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
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
  'al-akhbar.com', 'annahar.com', 'lbci.com.lb', 'mtv.com.lb', 'nna-leb.gov.lb',
  'albayan.ae', 'alkhaleej.ae', 'emaratalyoum.com', 'wam.ae',
  'alyaum.com', 'okaz.com.sa', 'sabq.org', 'aleqt.com',
  'al-sharq.com', 'peninsulaqatar.com',
]);

function isTier1(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return TIER1_DOMAINS.has(host) || [...TIER1_DOMAINS].some(d => host.endsWith('.' + d));
  } catch { return false; }
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

function computeEchoScores(articles) {
  const tokenize = (title) =>
    (title || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOP_WORDS.has(w));

  const tokenSets = articles.map(a => new Set(tokenize(a.title)));

  return articles.map((article, i) => {
    const tier1Sources = new Set();
    const allSources   = new Set([article.source || `src_${i}`]);

    // Count this article's own source as tier-1 if applicable
    if (isTier1(article.link)) tier1Sources.add(article.source || `src_${i}`);

    for (let j = 0; j < articles.length; j++) {
      if (i === j) continue;
      const sharedTokens = [...tokenSets[i]].filter(t => tokenSets[j].has(t)).length;
      if (sharedTokens >= 2) {
        const src = articles[j].source || `source_${j}`;
        allSources.add(src);
        if (isTier1(articles[j].link)) tier1Sources.add(src);
      }
    }

    return {
      tier1Count: tier1Sources.size,  // tier-1 outlets covering same story (≥ 0)
      totalCount: allSources.size,    // all outlets covering same story (≥ 1)
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
  } else {
    // Diversified suffixes — each pulls a different slice of results vs. near-identical variants
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
  const mergeIntoMaps = (rawResults, scoreMap, itemMap) => {
    rawResults.forEach(r => {
      (r.news || []).forEach((item, idx) => {
        if (!item.link || item.link.includes('wikipedia.org')) return;
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

  // ── Phase 2: Adaptive follow-up queries (English non-regional only) ───────
  // Claude Haiku looks at Phase 1 headlines and generates 3 targeted follow-up
  // queries aimed at important stories the initial broad queries likely missed.
  if (!isRegional && language === 'en' && Object.keys(scoreMap).length > 0) {
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

  // ── Fallback: if date-pinned search returned nothing, retry with a wider 7-day window ──
  if (Object.keys(scoreMap).length === 0 && day) {
    console.warn(`⚠️  Date-pinned search returned 0 results for "${categoryQuery}" — retrying with 7-day window`);
    const fallbackResults = await Promise.all(
      queries.slice(0, 3).map(q => serperSearch(q, numPerQuery, null, gl, hl).catch(() => ({ news: [] })))
    );
    mergeIntoMaps(fallbackResults, scoreMap, itemMap);
  }

  if (Object.keys(scoreMap).length === 0) {
    throw new Error(`Serper returned no results for "${categoryQuery}" — API key may be invalid or rate-limited`);
  }

  const urlList = Object.keys(scoreMap);
  const articleList = urlList.map(url => itemMap[url]);

  // Compute tier-1-aware echo scores: splits outlets into tier-1 vs non-tier-1
  const echoScores = computeEchoScores(articleList);
  const echoMap = {};
  urlList.forEach((url, i) => { echoMap[url] = echoScores[i]; });

  // Final sort — three signals in descending priority:
  //
  //   1. Tier-1 echo  (+15 per tier-1 outlet covering the same story)
  //      The strongest signal: Reuters + BBC + Bloomberg covering the same event
  //      means it's globally significant, regardless of Google's US-optimised rank.
  //
  //   2. Non-tier-1 echo  (+3 per additional outlet)
  //      Supporting signal: broad coverage matters but niche blogs shouldn't dominate.
  //
  //   3. Article is from a tier-1 outlet  (+8)
  //      Prefer the Reuters version of a story over a blog repost of the same story.
  //
  //   4. Google position score  (tiebreaker only — small values, US-biased so kept light)
  //      Breaks ties between otherwise equal articles without reintroducing US bias.
  const sorted = urlList
    .sort((a, b) => {
      const ea = echoMap[a], eb = echoMap[b];
      const scoreA = ea.tier1Count * 15
                   + (ea.totalCount - ea.tier1Count) * 3
                   + (isTier1(a) ? 8 : 0)
                   + scoreMap[a];
      const scoreB = eb.tier1Count * 15
                   + (eb.totalCount - eb.tier1Count) * 3
                   + (isTier1(b) ? 8 : 0)
                   + scoreMap[b];
      return scoreB - scoreA;
    })
    .map(url => itemMap[url]);

  // Format context — annotate stories so Claude immediately knows coverage breadth.
  // Labels now distinguish tier-1 coverage from generic multi-outlet coverage.
  const context = sorted.map((item, i) => {
    const url    = item.link;
    const echo   = echoMap[url] || { tier1Count: 0, totalCount: 1 };
    const t1     = echo.tier1Count;
    const total  = echo.totalCount;
    const label  = t1 >= 3   ? `[${total} OUTLETS — ${t1} TIER-1 — MAJOR STORY] `
                 : t1 >= 1   ? `[${total} OUTLETS — ${t1} TIER-1] `
                 : total >= 4 ? `[${total} OUTLETS — MAJOR STORY] `
                 : total >= 2 ? `[${total} OUTLETS] `
                 : '';
    return `${label}[${i + 1}] Title: ${item.title}\nSource: ${item.source || ''}\nDate: ${item.date || 'recent'}\nURL: ${url}\nSummary: ${item.snippet || ''}`;
  }).join('\n\n');

  // Return both formatted context (for Claude) and raw article metadata (for audit storage)
  const articles = sorted.map(item => ({
    title:    item.title    || '',
    source:   item.source   || '',
    date:     item.date     || '',
    url:      item.link     || '',
    snippet:  item.snippet  || '',
    imageUrl: item.imageUrl || '',
  }));

  return { context, articles };
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

  // Regional categories (UAE/KSA/QAT/LEB) have a smaller media ecosystem — single-source
  // stories from any outlet are acceptable, and we target more stories per digest.
  const storyCountInstruction = isRegional
    ? 'Write 7–10 grouped stories from the results above.'
    : 'Write 5–8 grouped stories from the results above.';

  const singleSourceRule = isRegional
    ? '4. Single-source stories are acceptable for regional news — include any story that is newsworthy regardless of how many outlets covered it.'
    : '4. Single-source stories should only be included if clearly significant and from a tier-1 outlet.';

  const prompt = `You are a news analyst. Below are news articles about "${categoryQuery}" retrieved specifically for ${dayInfo} (${day}). Synthesize them into a detailed news digest.${arabicInstruction}

SEARCH RESULTS:
${searchContext}

For each major story group, use this EXACT format — no introduction, no preamble:

## Synthesized neutral headline (your own words, not copied from any single source)
**Coverage:** [Outlet Name](exact-article-url) · [Outlet Name](exact-article-url) · [Outlet Name](exact-article-url) · [Outlet Name](exact-article-url) · ...
- Key fact or development, with context and nuance
- Another key detail — include numbers, names, and specifics where available
- Additional relevant detail or background
- For contested claims: "According to [source]..." or "[Party X] claims... while [Party Y] argues..."
**Perspectives differ:** Only include when at least two different outlets, parties, or experts genuinely frame the story differently — one sentence describing the contrast. Omit if only one source covers the story, or if all sources are fully aligned.
**Why this matters:** One or two sentences on broader significance and implications.

${storyCountInstruction} PRIORITISATION RULES:
1. Articles labelled with TIER-1 outlets (e.g. [3 OUTLETS — 3 TIER-1 — MAJOR STORY]) are globally significant — always include these first.
2. Articles with broad multi-outlet coverage (e.g. [4 OUTLETS — MAJOR STORY]) are widely reported — include these unless clearly less important than tier-1 stories.
3. Prefer stories covered by multiple outlets over single-source stories.
${singleSourceRule}
Group articles covering the same story together. Coverage must use real URLs from the search results provided. After all stories, include a sources section:

## Sources
- [Full article headline](exact-article-url)

Rules: Start with the first ## heading — no preamble. Headline is plain text — no URL on the ## line. Always include **Coverage:** immediately after each ##. CRITICAL: In **Coverage:**, list EVERY outlet from the search results that covers this story — do NOT truncate to 2 or 3. If 5 outlets covered it, list all 5. If 8 covered it, list all 8. In **## Sources**, list every article URL used across all stories with its full headline as the link text. Complete all sentences. Never use Wikipedia as a source — skip any Wikipedia URLs entirely.`;

  const data = await callClaude(prompt, 5000);
  const rawSummary = data.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  const summary = cleanRawSummary(rawSummary);

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

## [Headline: same story as digest, 5–8 words, plain text]
- One key fact — short, direct sentence under 20 words.
- Second key detail — short, direct sentence under 20 words.
- Third point if critical — short, direct sentence under 20 words.
**Summary:** Write 3–4 complete sentences here. Go deeper than the bullets — add context, background, and nuance from the digest. Cover additional angles or details the bullets omit. This is the paragraph a reader wants when they want the full story. (REQUIRED — always include for every story.)
**Why this matters:** One sentence, maximum impact.
**Perspectives differ:** Include this line only if the digest includes it for this story — condense to one punchy sentence. Omit entirely if not applicable.

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

// Function to store news in Supabase
async function storeNews(category, day, timeSlot, content, userId = null, sharedKey = null, storiesContent = null, sourceArticles = null, language = 'en') {
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

// Send digest emails to all users opted in for a given time slot
async function sendNewsDigestEmails(timeSlot, day) {
  try {
    const timeSlotKey = timeSlot.toLowerCase();

    // Fetch all verified users (include feed_categories so My Rundown can be expanded)
    const { data: users, error: usersError } = await supabaseAdmin
      .from('users')
      .select('id, email, email_preferences, feed_categories')
      .eq('verification_status', 'verified');

    if (usersError || !users?.length) return;

    // Support old { morning: true }, intermediate { morning: { enabled: true } }, and new flat { morning: true, categories: [] }
    const optedIn = users.filter(u => {
      const pref = u.email_preferences?.[timeSlotKey];
      return pref === true || pref?.enabled === true;
    });

    if (!optedIn.length) {
      console.log(`📭 No users opted in for ${timeSlot} digest`);
      return;
    }

    console.log(`📧 Sending ${timeSlot} digest to ${optedIn.length} user(s)...`);

    // Fetch all default category news for this slot/day (fetch all, filter per user)
    const { data: newsItems } = await supabaseAdmin
      .from('news_summaries')
      .select('category, content')
      .eq('day', day)
      .eq('time_slot', timeSlot)
      .in('category', DEFAULT_CATEGORIES);

    if (!newsItems?.length) {
      console.log(`No news found for ${timeSlot} digest`);
      return;
    }

    const WEBSITE_URL = process.env.REACT_APP_URL || 'https://the-ai-rundown-frontend.vercel.app';
    const formattedDate = formatDateForEmail(day);

    for (const user of optedIn) {
      try {
        // Determine which categories this user wants (new flat format stores categories at top level)
        const prefs = user.email_preferences || {};
        let rawCategories = Array.isArray(prefs.categories) && prefs.categories.length
          ? prefs.categories
          : DEFAULT_CATEGORIES;

        // Expand 'My Rundown' to the user's saved feed categories; remove it if no feed set
        const feedCats = Array.isArray(user.feed_categories) && user.feed_categories.length
          ? user.feed_categories
          : [];
        const userCategories = rawCategories.flatMap(cat => {
          if (cat === 'My Rundown') return feedCats.length ? feedCats : [];
          return [cat];
        }).filter((cat, i, arr) => arr.indexOf(cat) === i); // dedupe

        // Filter and sort news to user's chosen categories
        const sorted = userCategories
          .map(cat => newsItems.find(n => n.category === cat))
          .filter(Boolean);

        if (!sorted.length) {
          console.log(`  ⏭️  Skipping ${user.email} — none of their categories have news`);
          continue;
        }

        const emailHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0">
<tr><td align="center" style="padding:24px 16px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

<tr><td style="background:linear-gradient(135deg,#6366f1 0%,#ec4899 100%);border-radius:12px 12px 0 0;padding:28px 32px;">
  <p style="margin:0;font-size:22px;font-weight:900;color:white;letter-spacing:-0.02em;">✦ The Rundown</p>
  <p style="margin:8px 0 0;font-size:14px;color:rgba(255,255,255,0.82);">${timeSlot} Digest &nbsp;·&nbsp; ${formattedDate}</p>
</td></tr>

<tr><td style="background:white;padding:20px 32px 16px;">
  <a href="${WEBSITE_URL}" style="display:inline-block;padding:10px 22px;background:linear-gradient(135deg,#6366f1,#ec4899);color:white;text-decoration:none;border-radius:999px;font-weight:700;font-size:13px;">View on Website →</a>
</td></tr>
<tr><td style="background:white;padding:0 32px;"><hr style="border:none;border-top:1px solid #f3f4f6;margin:0;"></td></tr>

${sorted.map(item => `
<tr><td style="background:white;padding:24px 32px 20px;">
  <h2 style="margin:0 0 10px;font-size:17px;font-weight:800;color:#111827;letter-spacing:-0.02em;">${item.category}</h2>
  <div style="font-size:14px;line-height:1.75;color:#374151;">${markdownToEmailHtml(item.content)}</div>
</td></tr>
<tr><td style="background:white;padding:0 32px;"><hr style="border:none;border-top:1px solid #f3f4f6;margin:0;"></td></tr>
`).join('')}

<tr><td style="background:#faf8ff;padding:24px 32px;border-top:3px solid #6366f1;">
  <p style="margin:0 0 6px;font-size:14px;font-weight:800;color:#6366f1;">Want news on your specific topics?</p>
  <p style="margin:0 0 14px;font-size:13px;color:#64748b;line-height:1.6;">Custom categories (your favourite team, company, or niche topic) are generated on demand and won't appear in this email. Log in and click any custom category to generate it instantly.</p>
  <a href="${WEBSITE_URL}" style="display:inline-block;padding:9px 20px;border:1.5px solid #6366f1;color:#6366f1;text-decoration:none;border-radius:999px;font-weight:700;font-size:12px;background:white;">Generate Custom News →</a>
</td></tr>

<tr><td style="background:#f5f7fa;border-radius:0 0 12px 12px;padding:16px 32px;text-align:center;">
  <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
    You're receiving this because you subscribed to ${timeSlot} digests on The Rundown.<br>
    <a href="${WEBSITE_URL}" style="color:#6366f1;text-decoration:none;font-weight:600;">Manage your preferences</a>
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

        await resend.emails.send({
          from: process.env.FROM_EMAIL || 'noreply@resend.dev',
          to: user.email,
          subject: `The Rundown — ${timeSlot} · ${formattedDate}`,
          html: emailHtml
        });
        console.log(`  ✉️  Sent to ${user.email} (${sorted.length} categories)`);
      } catch (err) {
        console.error(`  ✗ Failed for ${user.email}:`, err.message);
      }
    }

    console.log(`✅ ${timeSlot} digest sent to ${optedIn.length} user(s)`);
  } catch (error) {
    console.error('Error sending digest emails:', error.message);
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
  const { summary: digestContent, sourceArticles } = await generateNews(category, targetDay, timeSlot, 3, null, null, language);

  let storiesContent = null;
  if (GENERATE_STORIES_CONTENT) {
    try {
      storiesContent = await generateStoriesContent(category, targetDay, timeSlot, digestContent, language);
    } catch (err) {
      console.warn(`Stories generation failed for ${category}, falling back to digest:`, err.message);
    }
  }

  await storeNews(category, targetDay, timeSlot, digestContent, null, null, storiesContent, sourceArticles, language);

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
async function generateAllNewsForTimeSlot(timeSlot, day = null, language = 'en', categories = null) {
  const targetDay = day || getTodayDate();
  const targetCategories = categories || DEFAULT_CATEGORIES;
  const langLabel = language === 'ar' ? ' [AR]' : '';
  const startedAt = new Date();

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

  const succeeded   = [];
  const failed      = []; // [{ category, error }]

  // ── Main generation pass ─────────────────────────────────────────────────
  for (const category of targetCategories) {
    try {
      await generateAndStoreCategory(category, targetDay, timeSlot, language);
      succeeded.push(category);
      console.log(`  ✅ ${category}${langLabel}`);
    } catch (error) {
      console.error(`  ❌ ${category}${langLabel}: ${error.message}`);
      failed.push({ category, error: error.message });
    }
    // Delay between categories to stay within rate limits
    await new Promise(resolve => setTimeout(resolve, 15000));
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
    await supabaseAdmin.from('generation_logs').insert({
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
    });
    console.log(`📝 Generation log saved (${durationSeconds}s, ${totalSucceeded}/${targetCategories.length} ok)`);
  } catch (err) {
    console.warn(`Could not save generation log:`, err.message);
  }

  // ── Digest emails (today only, not backfills, English only) ───────────────
  if (targetDay === getTodayDate() && language === 'en') {
    await sendNewsDigestEmails(timeSlot, targetDay);
  } else if (language === 'ar') {
    console.log(`⏭️  Skipping email send — Arabic digest emails not yet configured`);
  } else {
    console.log(`⏭️  Skipping email send — ${targetDay} is not today`);
  }
}

// Cloud Scheduler will trigger the /api/generate/:timeSlot endpoints
// No local cron jobs needed on Cloud Run

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

app.get('/api/categories/suggestions', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 3) return res.json([]);

    const embedding = await generateEmbedding(q);
    if (!embedding) return res.json([]);

    const { data, error } = await supabaseAdmin.rpc('search_similar_categories', {
      query_embedding: embedding,
      similarity_threshold: 0.65,
      match_count: 5
    });

    if (error) throw error;
    res.json((data || []).map(r => ({ description: r.category_description, shared_key: r.shared_key })));
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

    const targetDay = day || getTodayDate();
    const categories = category ? [category] : null;
    const langLabel = language === 'ar' ? ' [AR]' : '';
    const catLabel = category ? ` (${category})` : ' (all categories)';

    // Respond immediately so Cloud Scheduler doesn't timeout
    res.json({
      status: 'accepted',
      message: `News generation started for ${slot.label}${langLabel}${catLabel} on ${targetDay}`,
      timestamp: new Date().toISOString()
    });

    // Run generation in background
    generateAllNewsForTimeSlot(slot.label, targetDay, language, categories).catch(err =>
      console.error(`Background generation failed for ${slot.label}${langLabel}:`, err.message)
    );
  } catch (error) {
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Endpoint to get news from Supabase
app.get('/api/news/:category/:day/:timeSlot', async (req, res) => {
  try {
    const { category, day, timeSlot } = req.params;
    
    const { data, error } = await supabaseAdmin
      .from('news_summaries')
      .select('*')
      .eq('category', category)
      .eq('day', day)
      .eq('time_slot', timeSlot)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    if (!data) {
      return res.status(404).json({ 
        error: 'News not found',
        message: 'This news summary has not been generated yet'
      });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to get all news for a day
app.get('/api/news/day/:day', async (req, res) => {
  try {
    const { day } = req.params;
    
    const { data, error } = await supabaseAdmin
      .from('news_summaries')
      .select('*')
      .eq('day', day);

    if (error) {
      throw error;
    }

    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ENDPOINT 1: SEND VERIFICATION EMAIL
// ==========================================
app.post('/api/auth/send-verification', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ 
        error: 'Email and password are required' 
      });
    }

    console.log(`📧 Processing sign-up for ${email}`);

    // === CHECK IF USER ALREADY EXISTS ===
    const { data: existingUser, error: checkError } = await supabaseAdmin
      .from('users')
      .select('id, verification_status')
      .eq('email', email)
      .single();

    let userId;

    let isResend = false;

    if (existingUser) {
      console.log('✓ User already exists:', existingUser.id);
      userId = existingUser.id;

      if (existingUser.verification_status === 'verified') {
        return res.status(400).json({
          error: 'This email is already verified. Please sign in instead.'
        });
      }
      isResend = true;
    } else {
      // === CREATE USER IN SUPABASE AUTH ===
      console.log('Creating new Auth user...');
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email: email,
        password: password,
        email_confirm: false
      });

      if (authError) {
        if (authError.message.includes('already been registered')) {
          // User exists in Auth but not in users table
          const { data: authUsers, error: listError } = await supabaseAdmin.auth.admin.listUsers();
          if (!listError) {
            const foundUser = authUsers.users.find(u => u.email === email);
            if (foundUser) {
              userId = foundUser.id;
              console.log('✓ Found existing Auth user:', userId);
              
              // Create profile if it doesn't exist
              const { error: insertError } = await supabaseAdmin
                .from('users')
                .insert({
                  id: userId,
                  email: email,
                  verification_status: 'pending'
                });
              
              if (insertError && !insertError.message.includes('duplicate')) {
                console.error('Profile creation failed:', insertError);
              }
            }
          }
        } else {
          console.error('Auth creation failed:', authError);
          return res.status(500).json({ 
            error: 'Failed to create account',
            details: authError.message 
          });
        }
      } else {
        userId = authData.user.id;
        console.log('✓ User created in Auth:', userId);

        // === CREATE USER PROFILE ===
        const { error: profileError } = await supabaseAdmin
          .from('users')
          .insert({
            id: userId,
            email: email,
            verification_status: 'pending'
          });

        if (profileError) {
          console.error('Profile creation failed:', profileError);
          return res.status(500).json({ 
            error: 'Failed to create user profile',
            details: profileError.message 
          });
        }
        console.log('✓ User profile created');
      }
    }

    // === GENERATE TOKEN ===
    const verificationToken = Math.random().toString(36).substring(2, 15) + 
                              Math.random().toString(36).substring(2, 15);
    
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    const { error: tokenError } = await supabaseAdmin
      .from('users')
      .update({
        verification_token: verificationToken,
        verification_token_expires_at: expiresAt.toISOString()
      })
      .eq('id', userId);

    if (tokenError) {
      console.error('Token storage failed:', tokenError);
      return res.status(500).json({ 
        error: 'Failed to create verification token',
        details: tokenError.message 
      });
    }

    console.log('✓ Token generated');

    // === SEND EMAIL ===
    const verificationLink = `${process.env.REACT_APP_URL}/verify-email?token=${verificationToken}&email=${encodeURIComponent(email)}`;
    
    const result = await resend.emails.send({
      from: process.env.FROM_EMAIL || 'noreply@resend.dev',
      to: email,
      subject: 'Verify your email - The Rundown',
      html: `
        <h2>Welcome to The Rundown!</h2>
        <p>Click the link below to verify your email and complete your sign-up:</p>
        <a href="${verificationLink}" style="padding: 10px 20px; background: #6366f1; color: white; text-decoration: none; border-radius: 5px; display: inline-block;">
          Verify Email
        </a>
        <p>Or copy this link: <br>${verificationLink}</p>
        <p>This link expires in 24 hours.</p>
      `
    });

    if (result.error) {
      console.error('Email send failed:', result.error);
      return res.status(500).json({ 
        error: 'Failed to send verification email',
        details: result.error.message 
      });
    }

    console.log('✓ Verification email sent');

    res.json({
      success: true,
      message: 'Verification email sent',
      userId: userId,
      resent: isResend
    });

  } catch (error) {
    console.error('Sign-up endpoint error:', error);
    res.status(500).json({ 
      error: 'Failed during sign-up',
      details: error.message 
    });
  }
});



// ==========================================
// ENDPOINT 2: VERIFY EMAIL TOKEN
// ==========================================
app.post('/api/auth/verify-email', async (req, res) => {
  try {
    const { token, email } = req.body;

    if (!token || !email) {
      return res.status(400).json({ 
        error: 'Token and email are required' 
      });
    }

    console.log(`🔐 Verifying email token for ${email}`);

    // Find user with this token
    const { data: user, error: findError } = await supabaseAdmin
      .from('users')
      .select('id, verification_token, verification_token_expires_at')
      .eq('email', email)
      .single();

    if (findError || !user) {
      console.error('User not found:', findError);
      return res.status(401).json({ 
        error: 'Invalid email or token' 
      });
    }

    // Check if token matches
    if (user.verification_token !== token) {
      console.error('Token mismatch');
      return res.status(401).json({ 
        error: 'Invalid verification token' 
      });
    }

    // Check if token expired
    const now = new Date();
    const expiresAt = new Date(user.verification_token_expires_at);
    
    if (now > expiresAt) {
      console.error('Token expired');
      return res.status(401).json({ 
        error: 'Verification link expired',
        code: 'TOKEN_EXPIRED'
      });
    }

    console.log(`✓ Token verified for user ${user.id}`);

    // Update user's verification status
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({
        verification_status: 'verified',
        email_verified_at: new Date().toISOString(),
        verification_token: null,
        verification_token_expires_at: null
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('Database update failed:', updateError);
      return res.status(500).json({ error: 'Failed to verify email' });
    }

    console.log(`✓ User ${user.id} marked as verified`);

    // Track metric
    try {
      await supabaseAdmin
        .from('behavioral_metrics')
        .insert({
          user_id: user.id,
          event_type: 'email_verified',
          metadata: { email },
          created_at: new Date().toISOString()
        });
    } catch (err) {
      console.warn('Could not track metric:', err.message);
    }

    res.json({ 
      success: true, 
      message: 'Email verified successfully',
      userId: user.id
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});



// ==========================================
// ENDPOINT 3: RESEND VERIFICATION EMAIL
// ==========================================
app.post('/api/auth/resend-verification', async (req, res) => {
  try {
    const { email, userId } = req.body;

    if (!email || !userId) {
      return res.status(400).json({ 
        error: 'Email and userId are required' 
      });
    }

    console.log(`🔄 Resending verification email to ${email}`);

    // Check if already verified
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('verification_status')
      .eq('id', userId)
      .single();

    if (user?.verification_status === 'verified') {
      return res.status(400).json({ 
        error: 'Email already verified'
      });
    }

    // Generate new token
    const verificationToken = Math.random().toString(36).substring(2, 15) + 
                              Math.random().toString(36).substring(2, 15);
    
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    // Store token
    const { error: tokenError } = await supabaseAdmin
      .from('users')
      .update({
        verification_token: verificationToken,
        verification_token_expires_at: expiresAt.toISOString()
      })
      .eq('id', userId);

    if (tokenError) {
      return res.status(500).json({ 
        error: 'Failed to generate verification token' 
      });
    }

    // Build link and send email
    const verificationLink = `${process.env.REACT_APP_URL}/verify-email?token=${verificationToken}&email=${encodeURIComponent(email)}`;

    const { error: emailError } = await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to: email,
      subject: '✨ Verify Your Email - The Rundown (Resend)',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #f5f7fa;">
          <div style="background: white; padding: 40px; border-radius: 12px;">
            <h2 style="color: #6366f1; margin-top: 0;">Verification Email Resent</h2>
            <p style="color: #64748b;">Here's your verification link (valid for 24 hours):</p>
            <div style="margin: 30px 0;">
              <a href="${verificationLink}" style="background: linear-gradient(135deg, #6366f1 0%, #ec4899 100%); color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">
                Verify Email
              </a>
            </div>
          </div>
        </div>
      `
    });

    if (emailError) {
      return res.status(500).json({ 
        error: 'Failed to send email' 
      });
    }

    console.log(`✓ Resend verification email sent to ${email}`);

    res.json({ 
      success: true, 
      message: 'Verification email resent successfully' 
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

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
  const { sessionId, userId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  _activeSessions.set(sessionId, { userId: userId || null, lastSeen: Date.now() });
  res.json({ ok: true });
});

// ==========================================
// ENDPOINT 4: TRACK BEHAVIORAL METRICS
// ==========================================
app.post('/api/metrics/track', async (req, res) => {
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
      // Behavioral metrics – category selections with event type
      supabaseAdmin.from('behavioral_metrics').select('category_selected, event_type, created_at').not('category_selected', 'is', null),
      // News summaries – for generated count + sources
      supabaseAdmin.from('news_summaries').select('category, language, generated_at, source_articles').neq('category', '__completed__'),
      // Story reads – event_type='story_read' for read rate
      supabaseAdmin.from('behavioral_metrics').select('user_id, category_selected, day_selected, metadata, created_at').eq('event_type', 'story_read'),
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

    res.json({
      signups:  { today: todaySignups||0, week: weekSignups||0, month: monthSignups||0, quarter: quarterSignups||0, year: yearSignups||0, total: totalSignups||0 },
      verified: { today: todayVerified||0, week: weekVerified||0, month: monthVerified||0, quarter: quarterVerified||0, year: yearVerified||0, total: totalVerified||0 },
      activeNow, last7Days, genGrid, topCats, newsPerCat, sources, readRate,
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
    const { data: users, error } = await supabaseAdmin.from('users').select('id, email, created_at, verification_status, email_preferences').order('created_at', { ascending: false });
    if (error) throw error;

    const { data: cats } = await supabaseAdmin.from('custom_categories').select('user_id');
    const catCount = {};
    cats?.forEach(c => { catCount[c.user_id] = (catCount[c.user_id] || 0) + 1; });

    const { data: lastActivity } = await supabaseAdmin.from('behavioral_metrics').select('user_id, created_at').order('created_at', { ascending: false });
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

    const { data: allEvents } = await supabaseAdmin.from('behavioral_metrics').select('user_id, event_type, category_selected, day_selected, time_selected, created_at').order('created_at', { ascending: false });

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

// ==========================================
// ENDPOINT: SAVE EMAIL PREFERENCES
// ==========================================
app.put('/api/user/email-preferences', async (req, res) => {
  try {
    const { userId, preferences } = req.body;
    if (!userId || !preferences) {
      return res.status(400).json({ error: 'userId and preferences are required' });
    }
    const { error } = await supabaseAdmin
      .from('users')
      .update({ email_preferences: preferences })
      .eq('id', userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving email preferences:', error.message);
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

app.post('/admin/api/debug-generate', async (req, res) => {
  const { category, day, timeSlot } = req.body;
  try {
    const { summary: content } = await generateNews(category || 'test', day || getTodayDate(), timeSlot || 'Evening');
    res.json({ ok: true, contentLength: content.length, preview: content.slice(0, 300) });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Send digest emails for an existing slot/day without regenerating news
app.post('/admin/api/send-digest', async (req, res) => {
  const { timeSlot, day } = req.body;
  if (!timeSlot) return res.status(400).json({ error: 'timeSlot is required (Morning or Evening)' });
  const targetDay = day || getTodayDate();
  try {
    res.json({ ok: true, message: `Sending ${timeSlot} digest emails for ${targetDay}…` });
    await sendNewsDigestEmails(timeSlot, targetDay);
  } catch (err) {
    console.error('Manual send-digest error:', err.message);
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

// ── TTS URL endpoint: returns a signed Supabase CDN URL so the browser streams audio
//    directly (no Render bandwidth), and generates + caches audio if not yet cached. ──
app.post('/api/tts-url', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });

  const voiceId = process.env.UNREALSPEECH_VOICE_ID || 'Scarlett';
  const key = crypto.createHash('md5').update(`${voiceId}:${text.trim()}`).digest('hex');
  const fileName = `${key}.mp3`;

  try {
    // Check existence via list (metadata only, no file download)
    const { data: files } = await supabaseAdmin.storage
      .from('tts-cache')
      .list('', { limit: 1, search: key });
    const cached = !!(files?.some(f => f.name === fileName));

    if (!cached) {
      // Not in cache — generate with Unreal Speech then upload
      const audioBuffer = await callUnrealSpeech(text.trim());
      await supabaseAdmin.storage.from('tts-cache')
        .upload(fileName, audioBuffer, { contentType: 'audio/mpeg', upsert: false })
        .catch(() => {}); // ignore duplicate upload race
    }

    // Return a signed URL valid for 1 hour — browser fetches audio directly from CDN
    const { data: signedData, error: signErr } = await supabaseAdmin.storage
      .from('tts-cache')
      .createSignedUrl(fileName, 3600);

    if (signErr || !signedData?.signedUrl) {
      return res.status(500).json({ error: 'Failed to create signed URL' });
    }

    res.json({ url: signedData.signedUrl, cached });
  } catch (err) {
    console.error('TTS-URL error:', err.message);
    return res.status(500).json({ error: 'TTS URL failed' });
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

// ── TTS endpoint (Unreal Speech with Supabase Storage cache) ──
app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });

  const voiceId = process.env.UNREALSPEECH_VOICE_ID || 'Scarlett';
  const key = crypto.createHash('md5').update(`${voiceId}:${text.trim()}`).digest('hex');
  const fileName = `${key}.mp3`;

  try {
    // Check cache first
    const { data: cached, error: cacheErr } = await supabaseAdmin.storage
      .from('tts-cache')
      .download(fileName);

    if (cached && !cacheErr) {
      const buf = Buffer.from(await cached.arrayBuffer());
      res.set('Content-Type', 'audio/mpeg');
      res.set('Cache-Control', 'public, max-age=604800');
      return res.send(buf);
    }
  } catch {}

  try {
    const audioBuffer = await callUnrealSpeech(text.trim());

    // Cache in Supabase Storage (fire-and-forget)
    supabaseAdmin.storage.from('tts-cache')
      .upload(fileName, audioBuffer, { contentType: 'audio/mpeg', upsert: false })
      .catch(() => {});

    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=604800');
    return res.send(audioBuffer);
  } catch (err) {
    console.error('TTS error:', err.message);
    return res.status(500).json({ error: 'TTS failed' });
  }
});

// News generation is triggered exclusively by GitHub Actions via the
// /api/generate/:timeSlot HTTP endpoints — no in-process cron jobs.
// This prevents duplicate runs if the server happens to be warm at schedule time.

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎉 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`⏰ Timezone: Asia/Dubai (UAE)`);
  console.log(`📅 Scheduled via GitHub Actions (no in-process cron)\n`);
});