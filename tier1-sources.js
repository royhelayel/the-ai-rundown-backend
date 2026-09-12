// ── The tier-one registry ────────────────────────────────────────────────────
//
// The single list of outlets this product is willing to publish. Everything about
// retrieval follows from it: an outlet not here is never fetched, never stored and
// therefore never citable. That is the point — tier-one stops being a filter applied to
// search results after the fact (which is how the Killeen Daily Herald and Open.kg got
// printed as sources) and becomes a property of how we fetch.
//
// Per outlet:
//   domain      canonical host, used for identity and for site: queries
//   name        display name
//   lang        'en' | 'ar'
//   cats        categories this outlet serves — [] means "general", usable by any category
//   feed        its own RSS/Atom URL, when it still publishes one → LANE 1
//               null → LANE 2 (ask Google News for this outlet by name)
//   gl          country edition to use for its lane-2 query
//   fetch       may we read the article body? From the outlet's own robots.txt,
//               checked 12 Sep 2026. false means they named a crawler we'd be using.
//   note        why, when the answer is no
//
// Verified live on 11–12 September 2026. `feed: null` here means the feed was tested and
// found dead or blocked, not that nobody looked.

export const TIER1_SOURCES = [
  // ── Global wires and broadsheets (English) ───────────────────────────────
  { domain: 'theguardian.com',   name: 'The Guardian',  lang: 'en', gl: 'US', fetch: true,
    cats: { 'World News': 'https://www.theguardian.com/world/rss',
            'Politics':   'https://www.theguardian.com/politics/rss',
            'Business':   'https://www.theguardian.com/uk/business/rss',
            'Technology': 'https://www.theguardian.com/uk/technology/rss',
            'Sports':     'https://www.theguardian.com/uk/sport/rss',
            'Entertainment':'https://www.theguardian.com/uk/culture/rss',
            'Science':    'https://www.theguardian.com/science/rss',
            'Health':     'https://www.theguardian.com/society/health/rss',
            'Football':   'https://www.theguardian.com/football/rss' } },

  { domain: 'bbc.co.uk',         name: 'BBC News',      lang: 'en', gl: 'GB', fetch: true,
    cats: { 'World News': 'https://feeds.bbci.co.uk/news/world/rss.xml',
            'Politics':   'https://feeds.bbci.co.uk/news/politics/rss.xml',
            'Business':   'https://feeds.bbci.co.uk/news/business/rss.xml',
            'Technology': 'https://feeds.bbci.co.uk/news/technology/rss.xml',
            'Sports':     'https://feeds.bbci.co.uk/sport/rss.xml',
            'Football':   'https://feeds.bbci.co.uk/sport/football/rss.xml',
            'Basketball': 'https://feeds.bbci.co.uk/sport/basketball/rss.xml' } },

  { domain: 'aljazeera.com',     name: 'Al Jazeera',    lang: 'en', gl: 'QA', fetch: true,
    cats: { 'World News': 'https://www.aljazeera.com/xml/rss/all.xml', 'QAT': null } },

  { domain: 'npr.org',           name: 'NPR',           lang: 'en', gl: 'US', fetch: true,
    cats: { 'World News': 'https://feeds.npr.org/1004/rss.xml',
            'Politics':   'https://feeds.npr.org/1014/rss.xml',
            'Business':   'https://feeds.npr.org/1006/rss.xml',
            'Health':     'https://feeds.npr.org/1128/rss.xml' } },

  { domain: 'france24.com',      name: 'France 24',     lang: 'en', gl: 'FR', fetch: true,
    cats: { 'World News': 'https://www.france24.com/en/rss' } },
  { domain: 'dw.com',            name: 'DW',            lang: 'en', gl: 'DE', fetch: true,
    cats: { 'World News': 'https://rss.dw.com/rdf/rss-en-world' } },
  { domain: 'skynews.com',       name: 'Sky News',      lang: 'en', gl: 'GB', fetch: true,
    cats: { 'World News': 'https://feeds.skynews.com/feeds/rss/world.xml' } },
  { domain: 'politico.com',      name: 'Politico',      lang: 'en', gl: 'US', fetch: true,
    cats: { 'Politics': 'https://rss.politico.com/politics-news.xml' } },
  { domain: 'cnbc.com',          name: 'CNBC',          lang: 'en', gl: 'US', fetch: true,
    cats: { 'Business': 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147' } },

  // Reuters and AP closed their public feeds — reachable only through Google, by name.
  { domain: 'reuters.com',       name: 'Reuters',       lang: 'en', gl: 'US', fetch: false,
    note: 'no public feed since 2020; body fetch not attempted',
    cats: { 'World News': null, 'Business': null, 'Politics': null } },
  { domain: 'apnews.com',        name: 'AP News',       lang: 'en', gl: 'US', fetch: false,
    note: 'no public feed; body fetch not attempted',
    cats: { 'World News': null, 'Business': null, 'Politics': null } },

  // ── US and UK broadsheets and broadcasters ───────────────────────────────
  // These were all in the original TIER1_DOMAINS and absent from the first draft of this
  // registry, which is exactly the gap the coverage report is meant to surface. Feeds
  // tested 12 Sep; the ones without a working feed fall to lane 2 like anyone else.
  { domain: 'nytimes.com',       name: 'The New York Times', lang: 'en', gl: 'US', fetch: true,
    cats: { 'World News': 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
            'Business':   'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',
            'Technology': 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',
            'Science':    'https://rss.nytimes.com/services/xml/rss/nyt/Science.xml',
            'Health':     'https://rss.nytimes.com/services/xml/rss/nyt/Health.xml',
            'Politics':   null, 'Sports': null } },
  { domain: 'cnn.com',           name: 'CNN',           lang: 'en', gl: 'US', fetch: true,
    cats: { 'World News': 'http://rss.cnn.com/rss/edition_world.rss', 'Politics': null, 'Business': null } },
  { domain: 'cbsnews.com',       name: 'CBS News',      lang: 'en', gl: 'US', fetch: true,
    cats: { 'World News': 'https://www.cbsnews.com/latest/rss/world', 'Politics': null } },
  { domain: 'nbcnews.com',       name: 'NBC News',      lang: 'en', gl: 'US', fetch: true,
    cats: { 'World News': 'https://feeds.nbcnews.com/nbcnews/public/world', 'Politics': null } },
  { domain: 'abcnews.go.com',    name: 'ABC News',      lang: 'en', gl: 'US', fetch: true,
    cats: { 'World News': 'https://abcnews.go.com/abcnews/internationalheadlines', 'Politics': null, 'Business': null } },
  { domain: 'axios.com',         name: 'Axios',         lang: 'en', gl: 'US', fetch: true,
    cats: { 'Politics': 'https://api.axios.com/feed/', 'Business': null, 'Technology': null } },
  { domain: 'time.com',          name: 'Time',          lang: 'en', gl: 'US', fetch: true,
    cats: { 'World News': 'https://time.com/feed/', 'Health': null, 'Science': null } },
  { domain: 'fortune.com',       name: 'Fortune',       lang: 'en', gl: 'US', fetch: true,
    cats: { 'Business': 'https://fortune.com/feed/', 'Crypto': null } },
  { domain: 'businessinsider.com', name: 'Business Insider', lang: 'en', gl: 'US', fetch: true,
    cats: { 'Business': 'https://www.businessinsider.com/rss', 'Technology': null } },
  { domain: 'usatoday.com',      name: 'USA Today',     lang: 'en', gl: 'US', fetch: true,
    cats: { 'World News': null, 'Health': null, 'Entertainment': null } },
  { domain: 'wired.com',         name: 'WIRED',         lang: 'en', gl: 'US', fetch: true,
    cats: { 'Technology': 'https://www.wired.com/feed/rss', 'AI': null, 'Science': null } },
  { domain: 'engadget.com',      name: 'Engadget',      lang: 'en', gl: 'US', fetch: true,
    cats: { 'Technology': 'https://www.engadget.com/rss.xml' } },
  { domain: 'theatlantic.com',   name: 'The Atlantic',  lang: 'en', gl: 'US', fetch: true,
    cats: { 'Politics': null, 'World News': null } },
  { domain: 'forbes.com',        name: 'Forbes',        lang: 'en', gl: 'US', fetch: true,
    cats: { 'Business': null, 'Technology': null, 'Crypto': null, 'AI': null } },
  { domain: 'nature.com',        name: 'Nature',        lang: 'en', gl: 'GB', fetch: true,
    cats: { 'Science': null } },
  { domain: 'healthline.com',    name: 'Healthline',    lang: 'en', gl: 'US', fetch: true, cats: { 'Health': null } },
  { domain: 'webmd.com',         name: 'WebMD',         lang: 'en', gl: 'US', fetch: true, cats: { 'Health': null } },

  // Paywalled — lane 2 only. Their own feeds are behind the wall, and we never fetch
  // bodies from them, so these contribute headlines and the fact that they ran the story.
  { domain: 'wsj.com',           name: 'The Wall Street Journal', lang: 'en', gl: 'US', fetch: false,
    note: 'paywalled — headlines only, never fetched',
    cats: { 'Business': null, 'World News': null, 'Politics': null, 'Technology': null } },
  { domain: 'ft.com',            name: 'Financial Times', lang: 'en', gl: 'GB', fetch: false,
    note: 'paywalled — headlines only, never fetched',
    cats: { 'Business': null, 'World News': null } },
  { domain: 'bloomberg.com',     name: 'Bloomberg',     lang: 'en', gl: 'US', fetch: false,
    note: 'paywalled — headlines only, never fetched',
    cats: { 'Business': null, 'Technology': null, 'Crypto': null } },
  { domain: 'economist.com',     name: 'The Economist', lang: 'en', gl: 'GB', fetch: false,
    note: 'paywalled — headlines only, never fetched',
    cats: { 'World News': null, 'Business': null } },
  { domain: 'washingtonpost.com', name: 'The Washington Post', lang: 'en', gl: 'US', fetch: false,
    note: 'paywalled — headlines only, never fetched',
    cats: { 'World News': 'https://feeds.washingtonpost.com/rss/world', 'Politics': null } },

  // ── National wires. No working feeds; lane 2 reaches all of them. ────────
  { domain: 'wam.ae',            name: 'WAM',           lang: 'en', gl: 'AE', fetch: true, cats: { 'UAE': null } },
  { domain: 'spa.gov.sa',        name: 'SPA',           lang: 'en', gl: 'SA', fetch: true, cats: { 'KSA': null } },
  { domain: 'qna.org.qa',        name: 'QNA',           lang: 'en', gl: 'QA', fetch: true, cats: { 'QAT': null } },
  { domain: 'nna-leb.gov.lb',    name: 'NNA',           lang: 'en', gl: 'LB', fetch: true, cats: { 'LEB': null } },

  // ── Lebanese broadcasters and remaining regional press ──────────────────
  { domain: 'lbcgroup.tv',       name: 'LBCI',          lang: 'en', gl: 'LB', fetch: true, cats: { 'LEB': null } },
  { domain: 'mtv.com.lb',        name: 'MTV Lebanon',   lang: 'en', gl: 'LB', fetch: true, cats: { 'LEB': null } },
  { domain: 'argaam.com',        name: 'Argaam',        lang: 'en', gl: 'SA', fetch: true, cats: { 'KSA': null, 'Business': null } },
  { domain: 'alyaum.com',        name: 'اليوم',          lang: 'ar', gl: 'SA', fetch: true, cats: { 'KSA': null } },
  { domain: 'aleqt.com',         name: 'الاقتصادية',     lang: 'ar', gl: 'SA', fetch: true, cats: { 'KSA': null, 'Business': null } },

  // ── Specialist (English) ─────────────────────────────────────────────────
  { domain: 'arstechnica.com',   name: 'Ars Technica',  lang: 'en', gl: 'US', fetch: true,
    cats: { 'Technology': 'https://feeds.arstechnica.com/arstechnica/index' } },
  { domain: 'theverge.com',      name: 'The Verge',     lang: 'en', gl: 'US', fetch: true,
    cats: { 'Technology': 'https://www.theverge.com/rss/index.xml' } },
  { domain: 'techcrunch.com',    name: 'TechCrunch',    lang: 'en', gl: 'US', fetch: true,
    cats: { 'Technology': 'https://techcrunch.com/feed/',
            'AI':         'https://techcrunch.com/category/artificial-intelligence/feed/' } },
  { domain: 'venturebeat.com',   name: 'VentureBeat',   lang: 'en', gl: 'US', fetch: true,
    cats: { 'AI': null } },
  { domain: 'skysports.com',     name: 'Sky Sports',    lang: 'en', gl: 'GB', fetch: true,
    cats: { 'Sports': 'https://www.skysports.com/rss/12040',
            'Football': 'https://www.skysports.com/rss/11095' } },
  { domain: 'espn.com',          name: 'ESPN',          lang: 'en', gl: 'US', fetch: true,
    cats: { 'Basketball': 'https://www.espn.com/espn/rss/nba/news', 'Sports': null } },
  { domain: 'variety.com',       name: 'Variety',       lang: 'en', gl: 'US', fetch: true,
    cats: { 'Entertainment': 'https://variety.com/feed/' } },
  { domain: 'hollywoodreporter.com', name: 'The Hollywood Reporter', lang: 'en', gl: 'US', fetch: true,
    cats: { 'Entertainment': 'https://www.hollywoodreporter.com/feed/' } },
  { domain: 'deadline.com',      name: 'Deadline',      lang: 'en', gl: 'US', fetch: true,
    cats: { 'Entertainment': 'https://deadline.com/feed/' } },
  { domain: 'sciencenews.org',   name: 'Science News',  lang: 'en', gl: 'US', fetch: true,
    cats: { 'Science': 'https://www.sciencenews.org/feed' } },
  { domain: 'phys.org',          name: 'Phys.org',      lang: 'en', gl: 'US', fetch: true,
    cats: { 'Science': 'https://phys.org/rss-feed/' } },
  { domain: 'scientificamerican.com', name: 'Scientific American', lang: 'en', gl: 'US', fetch: true,
    cats: { 'Science': 'https://www.scientificamerican.com/platform/syndication/rss/' } },
  { domain: 'statnews.com',      name: 'STAT',          lang: 'en', gl: 'US', fetch: true,
    cats: { 'Health': 'https://www.statnews.com/feed/' } },
  { domain: 'coindesk.com',      name: 'CoinDesk',      lang: 'en', gl: 'US', fetch: true,
    cats: { 'Crypto': 'https://www.coindesk.com/arc/outboundfeeds/rss/' } },
  { domain: 'cointelegraph.com', name: 'Cointelegraph', lang: 'en', gl: 'US', fetch: true,
    cats: { 'Crypto': 'https://cointelegraph.com/rss' } },

  // ── Regional, English. Almost none still publish a feed — lane 2 carries them. ──
  { domain: 'gulfnews.com',      name: 'Gulf News',     lang: 'en', gl: 'AE', fetch: true,  cats: { 'UAE': null } },
  { domain: 'khaleejtimes.com',  name: 'Khaleej Times', lang: 'en', gl: 'AE', fetch: false,
    note: 'robots.txt: "# Block Claude (Anthropic)" — ClaudeBot and anthropic-ai disallowed',
    cats: { 'UAE': null } },
  { domain: 'thenationalnews.com', name: 'The National', lang: 'en', gl: 'AE', fetch: true, cats: { 'UAE': null } },
  { domain: 'arabianbusiness.com', name: 'Arabian Business', lang: 'en', gl: 'AE', fetch: true, cats: { 'UAE': null } },
  { domain: 'arabnews.com',      name: 'Arab News',     lang: 'en', gl: 'SA', fetch: true,
    cats: { 'KSA': 'https://www.arabnews.com/rss.xml' } },
  { domain: 'saudigazette.com.sa', name: 'Saudi Gazette', lang: 'en', gl: 'SA', fetch: true,
    cats: { 'KSA': 'https://saudigazette.com.sa/rssFeed/74' } },
  { domain: 'gulf-times.com',    name: 'Gulf Times',    lang: 'en', gl: 'QA', fetch: true,  cats: { 'QAT': null } },
  { domain: 'thepeninsulaqatar.com', name: 'The Peninsula', lang: 'en', gl: 'QA', fetch: false,
    note: 'robots.txt disallows CCBot', cats: { 'QAT': null } },
  { domain: 'dohanews.co',       name: 'Doha News',     lang: 'en', gl: 'QA', fetch: true,
    cats: { 'QAT': 'https://dohanews.co/feed/' } },
  { domain: 'naharnet.com',      name: 'Naharnet',      lang: 'en', gl: 'LB', fetch: true,
    note: 'its own atom feed stopped resolving — lane 2 replaces it', cats: { 'LEB': null } },
  { domain: 'nowlebanon.com',    name: 'NOW Lebanon',   lang: 'en', gl: 'LB', fetch: true,
    cats: { 'LEB': 'https://nowlebanon.com/feed/' } },
  { domain: 'lorientlejour.com', name: "L'Orient Today", lang: 'en', gl: 'LB', fetch: true, cats: { 'LEB': null } },
  { domain: 'dailystar.com.lb',  name: 'The Daily Star', lang: 'en', gl: 'LB', fetch: true, cats: { 'LEB': null } },

  // ── Arabic. Lane 2 carries nearly all of it — Arabic outlets have abandoned RSS
  //    even more thoroughly than the English Gulf ones, but Google indexes them all.
  { domain: 'aljazeera.net',     name: 'الجزيرة',        lang: 'ar', gl: 'EG', fetch: false,
    note: 'robots.txt disallows ClaudeBot and anthropic-ai outright',
    cats: { 'World News': null, 'Politics': null, 'Business': null, 'QAT': null } },
  { domain: 'alarabiya.net',     name: 'العربية',        lang: 'ar', gl: 'SA', fetch: true,
    cats: { 'World News': null, 'Politics': null, 'Business': null, 'KSA': null } },
  { domain: 'aawsat.com',        name: 'الشرق الأوسط',   lang: 'ar', gl: 'SA', fetch: true,
    cats: { 'World News': null, 'Politics': null, 'KSA': null } },
  { domain: 'skynewsarabia.com', name: 'سكاي نيوز عربية', lang: 'ar', gl: 'AE', fetch: true,
    cats: { 'World News': null, 'Politics': null, 'UAE': null } },
  { domain: 'al-akhbar.com',     name: 'الأخبار',        lang: 'ar', gl: 'LB', fetch: true, cats: { 'LEB': null } },
  { domain: 'annahar.com',       name: 'النهار',         lang: 'ar', gl: 'LB', fetch: true,
    cats: { 'LEB': 'https://www.annahar.com/rss' } },
  { domain: 'albayan.ae',        name: 'البيان',         lang: 'ar', gl: 'AE', fetch: true, cats: { 'UAE': null } },
  { domain: 'emaratalyoum.com',  name: 'الإمارات اليوم', lang: 'ar', gl: 'AE', fetch: true, cats: { 'UAE': null } },
  { domain: 'alkhaleej.ae',      name: 'الخليج',         lang: 'ar', gl: 'AE', fetch: true, cats: { 'UAE': null } },
  { domain: 'okaz.com.sa',       name: 'عكاظ',           lang: 'ar', gl: 'SA', fetch: true, cats: { 'KSA': null } },
  { domain: 'sabq.org',          name: 'سبق',            lang: 'ar', gl: 'SA', fetch: false,
    note: 'robots.txt disallows ClaudeBot', cats: { 'KSA': null } },
  { domain: 'al-sharq.com',      name: 'الشرق',          lang: 'ar', gl: 'QA', fetch: true, cats: { 'QAT': null } },
  { domain: 'bbc.com',           name: 'BBC عربي',       lang: 'ar', gl: 'GB', fetch: true,
    cats: { 'World News': 'https://feeds.bbci.co.uk/arabic/rss.xml' } },
];

// ── Lane 3: Google's own section feeds ───────────────────────────────────────
// Editorially ranked, and the only compliant route to Reuters and AP. Advisory: it is the
// one lane where somebody else picks the stories, so it supplements rather than decides.
// Google has eight sections; these are the categories that map onto them.
export const GOOGLE_SECTIONS = {
  'World News':    'WORLD',
  'Business':      'BUSINESS',
  'Technology':    'TECHNOLOGY',
  'Entertainment': 'ENTERTAINMENT',
  'Sports':        'SPORTS',
  'Science':       'SCIENCE',
  'Health':        'HEALTH',
};

// Every domain on the list, for the ingestion-time allowlist check.
export const TIER1_DOMAIN_SET = new Set(TIER1_SOURCES.map(s => s.domain));

// Outlets serving one category in one language. A source with `cats` entries for the
// category qualifies; the value is its feed URL (lane 1) or null (lane 2).
export function sourcesFor(category, language = 'en') {
  return TIER1_SOURCES
    .filter(s => s.lang === language && Object.prototype.hasOwnProperty.call(s.cats, category))
    .map(s => ({ ...s, feed: s.cats[category] || null, lane: s.cats[category] ? 1 : 2 }));
}

// Is this URL from an outlet we are allowed to read the body of? Used by lane 4 only.
export function mayFetchBody(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const src = TIER1_SOURCES.find(s => host === s.domain || host.endsWith('.' + s.domain));
    return !!src && src.fetch === true;
  } catch { return false; }
}

// Which registry entry a URL belongs to — null means it is not tier-one and must be dropped.
export function sourceForUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return TIER1_SOURCES.find(s => host === s.domain || host.endsWith('.' + s.domain)) || null;
  } catch { return null; }
}
