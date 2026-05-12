import express from 'express';
import cron from 'node-cron';
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
  'Health'
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
function getTodayDate() {
  const now = new Date();
  const uaeDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Dubai' }));
  return uaeDate.toISOString().split('T')[0];
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

  // 3. Pre-process: normalize all heading+URL variants into ## [Title](url)
  const normalizeHeading = (line) => {
    const m = line.match(/^(#{1,3} )(.+)$/);
    if (!m) return line;
    const [, hashes, text] = m;
    if (/^\[.+\]\(https?:\/\/[^)]+\)\s*$/.test(text)) return line; // already clean
    const urlMatch = text.match(/(https?:\/\/[^\s)]+)/);
    if (!urlMatch) return line;
    const url = urlMatch[1];
    const title = text.replace(urlMatch[0], '').replace(/[()[\]]/g, '').replace(/\s+/g, ' ').trim();
    return `${hashes}[${title || url}](${url})`;
  };

  const fixedLines = mainContent
    .split('\n')
    .reduce((acc, line) => {
      const trimmed = line.trim();
      if (/^https?:\/\/\S+$/.test(trimmed) && acc.length > 0) {
        const prev = acc[acc.length - 1];
        const m = prev.match(/^(#{1,3} )(.+)$/);
        if (m && !m[2].includes('](')) {
          acc[acc.length - 1] = `${m[1]}[${m[2].trim()}](${trimmed})`;
          return acc;
        }
      }
      acc.push(/^#{1,3} /.test(line) ? normalizeHeading(line) : line);
      return acc;
    }, [])
    .join('\n')
    .replace(/^https?:\/\/\S+$/gm, '');

  // 4. Render stories
  const bodyHtml = fixedLines
    // Fix ## alone on its own line
    .replace(/^(#{1,3})\s*\n(?!\s*\n)/gm, '$1 ')
    // Fix missing [ in ## Title](URL) — backward compat for old stored content
    .replace(/^(#{1,3} )(?!\[)([^\n]+\]\(https?:\/\/)/gm, '$1[$2')
    // Remove orphaned punctuation lines and stray bare URLs
    .replace(/^[-*.]\s*$/gm, '')
    .replace(/^https?:\/\/\S+$/gm, '')
    // Coverage line — row of source badges (must come before **bold** replacement)
    .replace(/^\*\*Coverage:\*\*\s*(.+)$/gm, (_, links) => {
      const badges = [...links.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].map(([, text, url]) => {
        let domain = '';
        try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch {}
        return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:2px 8px 2px 5px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:999px;text-decoration:none;margin:2px 3px 2px 0;font-size:11px;font-weight:600;color:#374151;"><img src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" width="10" height="10" style="border-radius:2px;opacity:0.85;vertical-align:middle;margin-right:3px;" />${text}</a>`;
      }).join('');
      return `<div style="margin:4px 0 10px;">${badges}</div>`;
    })
    // Perspectives differ — amber callout (must come before **bold** replacement)
    .replace(/^\*\*Perspectives differ:\*\*\s*(.+)$/gm, (_, text) =>
      `<div style="margin:4px 0 10px;font-size:12px;color:#92400e;line-height:1.55;background:#fffbeb;padding:8px 10px;border-radius:6px;border-left:3px solid #f59e0b;"><span style="font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;color:#b45309;">Perspectives differ</span>&nbsp;&nbsp;${text}</div>`
    )
    .replace(/^\*\*Why this matters:\*\*\s*(.+)$/gm, (_, text) =>
      `<div style="margin:4px 0 14px;font-size:13px;color:#9ca3af;line-height:1.55;font-style:italic;"><span style="font-style:normal;font-weight:700;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;">Why this matters</span>&nbsp;&nbsp;${text}</div>`
    )
    .replace(/\*\*(.+?)\*\*/g, '<strong style="font-weight:700;color:#111827;">$1</strong>')
    .replace(/_(.*?)_/g, '<em style="color:#9ca3af;font-style:italic;">$1</em>')
    // Linked heading ## [Title](URL) — backward compat for old stored content
    .replace(/^#{1,3} \[(.+?)\]\(([^)\s]+)\)/gm, (_, text, url) => {
      let domain = '';
      try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch {}
      const sourceLine = domain
        ? `<div style="display:flex;align-items:center;gap:5px;margin-bottom:4px;"><img src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" width="12" height="12" style="border-radius:2px;opacity:0.85;" /><span style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.04em;">${domain}</span></div>`
        : '';
      return `<div style="margin:18px 0 5px;padding-top:12px;border-top:1px solid #f3f4f6;">${sourceLine}<a href="${url}" target="_blank" rel="noopener noreferrer" style="font-size:15px;font-weight:800;color:#111827;text-decoration:underline;text-decoration-color:#d1d5db;line-height:1.3;">${text}</a></div>`;
    })
    // Plain heading — new format (synthesized headline, no URL)
    .replace(/^#{1,3} (.+)$/gm, (_, text) =>
      `<div style="font-size:15px;font-weight:800;color:#111827;margin:18px 0 4px;padding-top:12px;border-top:1px solid #f3f4f6;line-height:1.3;">${text}</div>`
    )
    .replace(/^[-*] (.+)$/gm, (_, text) =>
      `<div style="margin:4px 0 4px 10px;padding-left:8px;border-left:2px solid #e5e7eb;color:#374151;font-size:13px;line-height:1.55;">${text}</div>`
    )
    .replace(/\n\n+/g, '<div style="height:4px;"></div>')
    .replace(/\n/g, '');

  // 4. Source cards — 2-column table for email client compatibility
  let sourcesHtml = '';
  if (sourceLinks.length > 0) {
    const rows = [];
    for (let i = 0; i < sourceLinks.length; i += 2) {
      const pair = [sourceLinks[i], sourceLinks[i + 1]].filter(Boolean);
      const cells = pair.map(s => {
        const domain = getDomain(s.url);
        return `<td width="50%" style="padding:4px;vertical-align:top;">
          <a href="${s.url}" target="_blank" rel="noopener noreferrer" style="display:block;padding:8px 10px;background:#fafafa;border:1px solid #f0f0f0;border-radius:8px;text-decoration:none;">
            <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${domain}</div>
            <div style="font-size:12px;font-weight:600;color:#1e293b;line-height:1.35;">${s.title}</div>
            <div style="font-size:10px;color:#6366f1;font-weight:600;margin-top:5px;">Read article ↗</div>
          </a>
        </td>`;
      }).join('');
      rows.push(`<tr>${cells}</tr>`);
    }
    sourcesHtml = `<div style="margin-bottom:18px;">
      <p style="margin:0 0 8px;font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.07em;">Sources</p>
      <table width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join('')}</table>
      <div style="border-top:1px solid #f3f4f6;margin-top:14px;"></div>
    </div>`;
  }

  // 5. Top note
  const topNoteHtml = topNote
    ? `<p style="font-style:italic;color:#9ca3af;font-size:12px;margin:0 0 14px;line-height:1.5;">${topNote.replace(/^_+|_+$/g, '').replace(/\*\*(.+?)\*\*/g, '<strong style="color:#6b7280;font-weight:700;">$1</strong>')}</p>`
    : '';

  return topNoteHtml + sourcesHtml + bodyHtml;
}

// Function to generate news using Claude API (with retry on 429)
// Map broad category names to richer search queries that surface fresh results
const CATEGORY_SEARCH_QUERIES = {
  'Technology':    'latest technology news Apple Google Meta Microsoft AI gadgets announcements',
  'Business':      'latest business markets economy finance corporate news',
  'Politics':      'latest politics government elections policy legislation news',
  'Sports':        'latest sports results scores transfers breaking news',
  'Entertainment': 'latest entertainment movies music celebrity film television news',
  'Science':       'latest science research discoveries space climate health news',
  'Health':        'latest health medicine medical research pandemic wellness news',
  'World News':    'top global breaking news world events today',
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

async function serperSearch(query, num = 10) {
  const res = await fetch('https://google.serper.dev/news', {
    method: 'POST',
    headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num, gl: 'us', hl: 'en' })
  });
  if (!res.ok) return { news: [] };
  return res.json();
}

async function buildSearchContext(categoryQuery) {
  const queries = [
    `${categoryQuery} news today`,
    `${categoryQuery} latest breaking news`,
    `${categoryQuery} analysis update`,
  ];
  const results = await Promise.all(queries.map(q => serperSearch(q, 10).catch(() => ({ news: [] }))));
  const seen = new Set();
  const articles = [];
  results.forEach(r => {
    (r.news || []).forEach(item => {
      if (item.link && !seen.has(item.link) && !item.link.includes('wikipedia.org')) {
        seen.add(item.link);
        articles.push(item);
      }
    });
  });
  return articles.map((item, i) =>
    `[${i + 1}] Title: ${item.title}\nSource: ${item.source || ''}\nDate: ${item.date || 'recent'}\nURL: ${item.link}\nSummary: ${item.snippet || ''}`
  ).join('\n\n');
}

async function generateNews(category, day, timeSlot, retries = 3, searchQuery = null) {
  const categoryQuery = searchQuery || CATEGORY_SEARCH_QUERIES[category] || (category === 'All' ? 'top breaking news today' : category);
  const dayInfo = day === getTodayDate() ? 'today' : `on ${day}`;

  console.log(`Generating news for ${category} on ${day} at ${timeSlot}`);

  // Fetch search results via Serper (3 queries)
  const searchContext = await buildSearchContext(categoryQuery);
  const serper_searches = 3;
  const serper_cost = serper_searches * 0.001;

  const prompt = `You are a news analyst. Below are recent news articles about "${categoryQuery}" published ${dayInfo} (${day}). Synthesize them into a news digest.

SEARCH RESULTS:
${searchContext}

For each major story group, use this EXACT format — no introduction, no preamble:

## Synthesized neutral headline (your own words, not copied from any single source)
**Coverage:** [Outlet Name](exact-article-url) · [Outlet Name](exact-article-url) · [Outlet Name](exact-article-url)
- Key fact or development
- Another key detail
- For contested claims: "According to [source]..." or "[Party X] claims... while [Party Y] argues..."
**Perspectives differ:** Only if outlets genuinely frame the story differently — describe how. Omit if consistent.
**Why this matters:** One or two sentences on significance.

Write 5–7 grouped stories from the results above. Group articles covering the same story together. Coverage must use real URLs from the search results provided. After all stories:

## Sources
- [Article title](URL)

Rules: Start with the first ## heading — no preamble. Headline is plain text — no URL on the ## line. Always include **Coverage:** immediately after each ##. Complete all sentences. Never use Wikipedia as a source — skip any Wikipedia URLs entirely.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (response.status === 429 && retries > 0) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '65', 10);
    console.log(`⏳ Rate limited. Waiting ${retryAfter}s (${retries} retries left)...`);
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    return generateNews(category, day, timeSlot, retries - 1, searchQuery);
  }

  if (!response.ok) {
    const errData = await response.json();
    throw new Error(`Claude API error: ${response.status} - ${JSON.stringify(errData)}`);
  }

  const data = await response.json();
  const rawSummary = data.content.filter(item => item.type === "text").map(item => item.text).join("\n");

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
  const summary = (usefulSentence ? `_${usefulSentence}_\n\n` : '') + fixedHeadings;

  // Track usage
  if (data.usage) {
    const { input_tokens, output_tokens } = data.usage;
    const token_cost_usd = (input_tokens / 1_000_000) * 0.8 + (output_tokens / 1_000_000) * 4;
    const search_cost_usd = serper_cost;
    const estimated_cost_usd = token_cost_usd + search_cost_usd;
    supabaseAdmin.from('api_usage').insert({
      service: 'anthropic', model: 'claude-haiku-4-5-20251001',
      input_tokens, output_tokens,
      web_searches: serper_searches, search_cost_usd, token_cost_usd, estimated_cost_usd,
      category, time_slot: timeSlot,
      created_at: new Date().toISOString()
    }).then(({ error }) => {
      if (error) console.warn('Could not track API usage:', error.message);
    }, err => console.warn('Could not track API usage:', err.message));
  }

  return summary;
}

// Function to store news in Supabase
async function storeNews(category, day, timeSlot, content, userId = null, sharedKey = null) {
  try {
    const generated_at = new Date().toISOString();

    let query = supabaseAdmin
      .from('news_summaries')
      .select('id')
      .eq('category', category)
      .eq('day', day)
      .eq('time_slot', timeSlot);

    if (sharedKey) {
      query = query.eq('shared_key', sharedKey).is('user_id', null);
    } else if (userId) {
      query = query.eq('user_id', userId).is('shared_key', null);
    } else {
      query = query.is('user_id', null).is('shared_key', null);
    }

    const { data: existing } = await query.maybeSingle();

    let error;
    if (existing) {
      ({ error } = await supabaseAdmin
        .from('news_summaries')
        .update({ content, generated_at })
        .eq('id', existing.id));
    } else {
      const row = { category, day, time_slot: timeSlot, content, generated_at };
      if (sharedKey) {
        row.shared_key = sharedKey;
      } else if (userId) {
        row.user_id = userId;
      }
      ({ error } = await supabaseAdmin.from('news_summaries').insert(row));
    }

    if (error) throw new Error(`Supabase error: ${error.message}`);

    console.log(`✅ Stored news for ${category} on ${day} at ${timeSlot}${userId ? ` (user ${userId})` : ''}${sharedKey ? ` (shared_key: ${sharedKey})` : ''}`);
  } catch (error) {
    console.error(`Error storing news in Supabase:`, error);
    throw error;
  }
}

// Send digest emails to all users opted in for a given time slot
async function sendNewsDigestEmails(timeSlot, day) {
  try {
    const timeSlotKey = timeSlot.toLowerCase();

    // Fetch all verified users
    const { data: users, error: usersError } = await supabaseAdmin
      .from('users')
      .select('id, email, email_preferences')
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
        const userCategories = Array.isArray(prefs.categories) && prefs.categories.length
          ? prefs.categories
          : DEFAULT_CATEGORIES;

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
          subject: `Your ${timeSlot} Rundown — ${formattedDate}`,
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

// Function to generate all news for a time slot
async function generateAllNewsForTimeSlot(timeSlot) {
  console.log(`\n🚀 Starting news generation for ${timeSlot} time slot...`);
  const today = getTodayDate();
  
  for (const category of DEFAULT_CATEGORIES) {
    try {
      const content = await generateNews(category, today, timeSlot);
      await storeNews(category, today, timeSlot, content);
      
      // Delay between API calls to stay within rate limits (30k tokens/min)
      await new Promise(resolve => setTimeout(resolve, 15000));
    } catch (error) {
      console.error(`Failed to generate/store news for ${category}:`, error.message);
      // Continue with next category even if one fails
    }
  }
  
  console.log(`✨ Completed news generation for ${timeSlot} time slot\n`);

  // Email digest to opted-in users
  await sendNewsDigestEmails(timeSlot, today);
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
      const newsContent = await generateNews(category, day, 'Daily', 3, description || category);
      await storeNews(category, day, 'Daily', newsContent, null, sharedKey);
      await supabaseAdmin.from('users').update({ last_generated_date: todayUAE }).eq('id', user_id);
      console.log(`✓ Custom category news saved: ${category} (shared_key: ${sharedKey})`);
    } catch (err) { console.error('Custom category generation error:', err.message); }
  })();
});

// Manual trigger endpoint — supports both GET (browser) and POST (Cloud Scheduler)
app.get('/api/generate/:timeSlot', async (req, res) => {
  try {
    const timeSlot = req.params.timeSlot;
    const slot = TIME_SLOTS.find(s => s.label.toLowerCase() === timeSlot.toLowerCase());
    if (!slot) return res.status(400).json({ error: 'Invalid time slot' });
    res.json({ status: 'accepted', message: `News generation started for ${slot.label}`, timestamp: new Date().toISOString() });
    generateAllNewsForTimeSlot(slot.label).catch(err => console.error(`Background generation failed for ${slot.label}:`, err.message));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/generate/:timeSlot', async (req, res) => {
  try {
    const timeSlot = req.params.timeSlot;
    const slot = TIME_SLOTS.find(s => s.label.toLowerCase() === timeSlot.toLowerCase());
    
    if (!slot) {
      return res.status(400).json({ error: 'Invalid time slot' });
    }

    // Respond immediately so Cloud Scheduler doesn't timeout
    res.json({
      status: 'accepted',
      message: `News generation started for ${slot.label}`,
      timestamp: new Date().toISOString()
    });

    // Run generation in background
    generateAllNewsForTimeSlot(slot.label).catch(err =>
      console.error(`Background generation failed for ${slot.label}:`, err.message)
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
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const [
      { count: totalUsers },
      { count: newUsers },
      { count: verifiedUsers },
      { data: todayNews },
      { data: usersWithPrefs },
      { data: recentActivity },
      { data: catMetrics }
    ] = await Promise.all([
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).gte('created_at', sevenDaysAgo.toISOString()),
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).eq('verification_status', 'verified'),
      supabaseAdmin.from('news_summaries').select('category, time_slot, generated_at').eq('day', today),
      supabaseAdmin.from('users').select('email_preferences').not('email_preferences', 'is', null),
      supabaseAdmin.from('behavioral_metrics').select('user_id').gte('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString()),
      supabaseAdmin.from('behavioral_metrics').select('category_selected').not('category_selected', 'is', null)
    ]);

    const emailSubs = { night: 0, morning: 0, noon: 0, afternoon: 0, evening: 0 };
    usersWithPrefs?.forEach(u => {
      Object.keys(emailSubs).forEach(slot => {
        const pref = u.email_preferences?.[slot];
        // handles: boolean true, { enabled: true }, or new flat format where slot key is boolean
        if (pref === true || pref?.enabled === true) emailSubs[slot]++;
      });
    });

    const activeUsers = new Set(recentActivity?.map(r => r.user_id)).size;

    const catCounts = {};
    catMetrics?.forEach(m => { if (m.category_selected) catCounts[m.category_selected] = (catCounts[m.category_selected] || 0) + 1; });
    const topCategories = Object.entries(catCounts).sort((a,b) => b[1]-a[1]).slice(0, 8).map(([category, views]) => ({ category, views }));

    const newsStatus = {};
    DEFAULT_CATEGORIES.forEach(cat => {
      newsStatus[cat] = {};
      TIME_SLOTS.forEach(slot => {
        const item = todayNews?.find(n => n.category === cat && n.time_slot === slot.label);
        newsStatus[cat][slot.label] = item ? { generated: true, at: item.generated_at } : { generated: false };
      });
    });

    res.json({
      users:          { total: totalUsers || 0, new_7d: newUsers || 0, verified: verifiedUsers || 0 },
      news:           { total_today: todayNews?.length || 0, expected: DEFAULT_CATEGORIES.length * TIME_SLOTS.length, status: newsStatus },
      email_subs:     emailSubs,
      active_users:   activeUsers,
      top_categories: topCategories
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/admin/api/news', async (req, res) => {
  try {
    const { day, timeSlot, category } = req.query;
    let query = supabaseAdmin.from('news_summaries').select('*').order('generated_at', { ascending: false }).limit(200);
    if (day)      query = query.eq('day', day);
    if (timeSlot) query = query.eq('time_slot', timeSlot);
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
    const content = await generateNews(category || 'test', day || getTodayDate(), timeSlot || 'Evening');
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

// ── TTS endpoint (ElevenLabs with Supabase Storage cache) ──
app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });

  const key = crypto.createHash('md5').update(text.trim()).digest('hex');
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

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ElevenLabs not configured' });

  const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

  try {
    const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text: text.trim(),
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.35, use_speaker_boost: true },
      }),
    });

    if (!elRes.ok) {
      const errText = await elRes.text();
      console.error('ElevenLabs error:', elRes.status, errText);
      return res.status(502).json({ error: 'ElevenLabs request failed' });
    }

    const audioBuffer = Buffer.from(await elRes.arrayBuffer());

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

// Schedule news generation for each time slot (Dubai timezone)
TIME_SLOTS.forEach(slot => {
  cron.schedule(slot.cronTime, () => {
    console.log(`⏰ Cron triggered: ${slot.label}`);
    generateAllNewsForTimeSlot(slot.label).catch(err =>
      console.error(`Cron generation failed for ${slot.label}:`, err.message)
    );
  }, { timezone: 'Asia/Dubai' });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎉 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`⏰ Timezone: Asia/Dubai (UAE)\n`);
  console.log('📅 Scheduled cron jobs:');
  TIME_SLOTS.forEach(slot => {
    console.log(`   - ${slot.label}: ${slot.cronTime}`);
  });
  console.log('\n');
});