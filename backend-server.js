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

// Lowercased display names for every tier-1 domain that has an entry in OUTLET_NAMES.
// Built lazily after OUTLET_NAMES is defined; used only when the URL is a Google redirect.
let _tier1DisplayNames = null;
function tier1DisplayNames() {
  if (!_tier1DisplayNames) {
    _tier1DisplayNames = new Set(
      Object.entries(OUTLET_NAMES)
        .filter(([domain]) => TIER1_DOMAINS.has(domain) || [...TIER1_DOMAINS].some(d => domain.endsWith('.' + d)))
        .map(([, name]) => name.toLowerCase())
    );
  }
  return _tier1DisplayNames;
}

// sourceName is optional; only consulted when the URL is a Google News redirect so that
// tier-1 outlets whose links arrive as google.com/goto?url=… are not misclassified.
function isTier1(url, sourceName = '') {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (TIER1_DOMAINS.has(host) || [...TIER1_DOMAINS].some(d => host.endsWith('.' + d))) return true;
  } catch {}
  if (sourceName && isGoogleRedirect(url)) {
    return tier1DisplayNames().has(sourceName.toLowerCase());
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
// An outlet is "local" regardless of the language it publishes in.
function isLocalSource(url, region) {
  return hostMatches(url, NATIONAL_AGENCIES[region]) || hostMatches(url, LOCAL_TIER1[region]?.all || []);
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
    if (region && isLocalSource(article.link, region)) localSources.add(article.source || `src_${i}`);

    for (let j = 0; j < articles.length; j++) {
      if (i === j) continue;
      const sharedTokens = [...tokenSets[i]].filter(t => tokenSets[j].has(t)).length;
      if (sharedTokens >= 2) {
        const src = articles[j].source || `source_${j}`;
        allSources.add(src);
        if (isTier1(articles[j].link, articles[j].source)) tier1Sources.add(src);
        if (region && isLocalSource(articles[j].link, region)) localSources.add(src);
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

  if (Object.keys(scoreMap).length === 0) {
    throw new Error(`Serper returned no results for "${categoryQuery}" — API key may be invalid or rate-limited`);
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
      if (isLocalSource(url, region)) {
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
      if (isLocalSource(url, region)) {
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
function filterCoverageTier1(content) {
  return content.replace(
    /(\*\*Coverage:\*\*)(.*)/g,
    (_, label, rest) => {
      const links = [...rest.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)];
      const tier1Links = links.filter(([, , url]) => isTier1(url));
      const kept = tier1Links.length > 0 ? tier1Links : links.slice(0, 2);
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

  const prompt = `You are a news analyst. Below are news articles about "${categoryQuery}" retrieved specifically for ${dayInfo} (${day}). Synthesize them into a detailed news digest.${regionGate}${arabicInstruction}

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
  const summary = filterCoverageTier1(cleanRawSummary(rawSummary));

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

// In-memory fallback so the toggle works today even before `app_settings` exists —
// see the SQL note this ships with. Once that table exists, this becomes a warm cache
// only; the source of truth is always the Supabase read.
let auditEnabledFallback = false;
let appSettingsTableMissing = false;

async function isAuditEnabled() {
  if (appSettingsTableMissing) return auditEnabledFallback;
  try {
    const { data, error } = await supabaseAdmin.from('app_settings').select('value').eq('key', 'audit_enabled').maybeSingle();
    if (error) {
      if (error.code === 'PGRST205' || error.code === '42P01') {
        appSettingsTableMissing = true;
        console.warn(`⚠️  'app_settings' table not found — audit toggle is in-memory only until it's created. Run in Supabase:\n  CREATE TABLE IF NOT EXISTS app_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz DEFAULT now());`);
      }
      return auditEnabledFallback;
    }
    const enabled = data?.value === true || data?.value?.enabled === true;
    auditEnabledFallback = enabled; // keep the fallback warm in case the table disappears mid-run
    return enabled;
  } catch {
    return auditEnabledFallback;
  }
}

async function setAuditEnabled(enabled) {
  auditEnabledFallback = enabled;
  try {
    const { error } = await supabaseAdmin.from('app_settings').upsert({ key: 'audit_enabled', value: { enabled }, updated_at: new Date().toISOString() });
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

// Generate a short spoken "category briefing" — a synthesis of the whole category's
// top stories (~90-120 words) for a quick read or ~90s listen at the category level.
async function generateBriefing(category, day, timeSlot, digestContent, language = 'en') {
  console.log(`Generating briefing for ${category} on ${day} at ${timeSlot}${language === 'ar' ? ' [AR]' : ''}`);

  const arabicInstruction = language === 'ar'
    ? `\n\nWrite the entire briefing in Modern Standard Arabic (اللغة العربية الفصحى).`
    : '';

  const prompt = `You are a news anchor writing a short spoken briefing that catches a listener up on the "${category}" section.${arabicInstruction}

Below is today's full digest for this section:

${digestContent}

Write ONE cohesive briefing of about 90–120 words that ties together the most important stories — what is happening and why it matters — as if delivering a quick on-air catch-up.
Rules: Flowing prose in one or two short paragraphs. NO headings, NO bullet points, NO markdown, NO source names or URLs. Lead with the single biggest story, then weave in the other top themes. Do not enumerate every story — synthesise. Conversational and clear, meant to be read aloud. Start immediately with the briefing text — no preamble, no title.`;

  const data = await callClaude(prompt, 600);
  const text = data.content.filter(item => item.type === 'text').map(item => item.text).join('\n').trim();

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
  const { summary: digestContent, sourceArticles, searchContext } = await generateNews(category, targetDay, timeSlot, 3, null, null, language);

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
async function generateAllNewsForTimeSlot(timeSlot, day = null, language = 'en', categories = null) {
  const targetDay = day || getTodayDate();
  // Arabic default run: skip any category with no Arabic query rather than falling
  // through to CATEGORY_SEARCH_QUERIES's generic `|| category` fallback, which would
  // search Serper for the literal English category name (e.g. "AI") as Arabic content.
  const targetCategories = categories || (language === 'ar' ? DEFAULT_CATEGORIES.filter(c => ARABIC_CATEGORY_QUERIES[c]) : DEFAULT_CATEGORIES);
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

  clearInterval(keepAliveTimer);
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


// ── Metrics feature flag — set to true to re-enable ──────────────────────────
const METRICS_ENABLED = false;

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
  if (!METRICS_ENABLED) return res.json({ ok: true, disabled: true });
  const { sessionId, userId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  _activeSessions.set(sessionId, { userId: userId || null, lastSeen: Date.now() });
  res.json({ ok: true });
});

// ==========================================
// ENDPOINT 4: TRACK BEHAVIORAL METRICS
// ==========================================
app.post('/api/metrics/track', async (req, res) => {
  if (!METRICS_ENABLED) return res.json({ success: true, disabled: true });
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
    const { data: users, error } = await supabaseAdmin.from('users').select('id, email, created_at, verification_status, email_preferences').order('created_at', { ascending: false });
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
    const call = async (path) => {
      const r = await fetch(`https://google.serper.dev/${path}`, {
        method: 'POST',
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, num: 20, gl: 'us', hl: 'en', tbs }),
      });
      if (!r.ok) return { httpError: r.status };
      const j = await r.json();
      const items = j.news || j.organic || [];
      return { count: items.length, sample: items.slice(0, 8).map(it => ({ title: it.title, link: it.link, date: it.date || '' })) };
    };
    const [news, search] = await Promise.all([call('news'), call('search')]);
    res.json({ q, day, tbs, news, search });
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