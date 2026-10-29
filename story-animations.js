import { ANIMATION_BUCKET, ANIMATION_VERSION, animationKey, animationPrompt, cleanAnimationText, validateAnimation } from './story-animation-schema.js';

export function createStoryAnimations({ supabase, callModel, parseStories, sentences, logger = console }) {
  const cache = new Map(), pending = new Map(), activeKeys = new Set();
  const stats = { generated: 0, cached: 0, failed: 0, queued: 0, active: 0, blocked: null, complete: false };
  let bucketReady, draining = false;
  const remember = (key, value) => { if (cache.size >= 1600) cache.delete(cache.keys().next().value); cache.set(key, value); return value; };
  const prepareBucket = () => bucketReady ||= (async () => {
    const { error } = await supabase.storage.createBucket(ANIMATION_BUCKET, { public: false, allowedMimeTypes: ['application/json'], fileSizeLimit: 100000 });
    if (error && !/already exists|duplicate/i.test(error.message || '')) throw new Error(`Animation storage unavailable: ${error.message}`);
  })();
  async function read(text) {
    const key = animationKey(text);
    if (cache.has(key)) return cache.get(key);
    const { data } = await supabase.storage.from(ANIMATION_BUCKET).download(key);
    if (!data) return null;
    try {
      const stored = JSON.parse(await data.text());
      if (stored.text !== cleanAnimationText(text) || stored.version !== ANIMATION_VERSION) return null;
      if (stored.retryAfter && Date.now() >= stored.retryAfter) return null;
      if (stored.plan) stored.plan = validateAnimation(stored.plan, stored.text);
      return remember(key, stored);
    } catch { return null; }
  }
  async function write(text, body) {
    const key = animationKey(text);
    const record = { ...body, version: ANIMATION_VERSION, text: cleanAnimationText(text), updatedAt: new Date().toISOString() };
    const { error } = await supabase.storage.from(ANIMATION_BUCKET).upload(key, Buffer.from(JSON.stringify(record)), { contentType: 'application/json', upsert: true });
    if (error) throw new Error(`Animation could not be saved: ${error.message}`);
    return remember(key, record);
  }
  async function generate(item) {
    const stored = await read(item.text);
    if (stored?.plan || stored?.retryAfter > Date.now()) { stats.cached++; return; }
    let problem = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await callModel(animationPrompt(item.text, problem), 2600, 0,
        { ...item.meta, contentType: 'story_animation' });
      const raw = (response.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
      try {
        if (response.stop_reason === 'max_tokens') throw new Error('Drawing was truncated; use fewer, simpler shapes and shorter paths');
        const plan = validateAnimation(JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')), item.text);
        await write(item.text, { status: 'ready', plan });
        stats.generated++; return;
      } catch (e) { problem = e.message; }
    }
    await write(item.text, { status: 'unavailable', retryAfter: Date.now() + 24 * 3600e3 });
    throw new Error(problem);
  }
  async function drain() {
    if (draining || !pending.size || stats.blocked) return;
    draining = true; stats.complete = false;
    try {
      await prepareBucket();
      const worker = async () => {
        while (pending.size && !stats.blocked) {
          const [key, item] = pending.entries().next().value; pending.delete(key);
          stats.active++; activeKeys.add(key);
          try { await generate(item); }
          catch (error) {
            stats.failed++;
            logger.warn(`Animation failed (${item.meta.category}): ${error.message}`);
            if (/credit balance|authentication|api key|401|403|429|storage|saved/i.test(error.message)) stats.blocked = error.message.slice(0, 160);
          } finally { stats.active--; activeKeys.delete(key); }
        }
      };
      await Promise.all([worker(), worker()]);
    } catch (e) { stats.blocked = e.message; logger.warn(e.message); }
    finally { draining = false; stats.complete = !pending.size && !stats.active; }
  }
  function enqueue(text, meta = {}) {
    const clean = cleanAnimationText(text);
    if (!clean || clean.length > 10000) return;
    const key = animationKey(clean);
    if (pending.has(key) || activeKeys.has(key) || cache.get(key)?.plan) return;
    pending.set(key, { text: clean, meta }); stats.queued++;
  }
  function rowUpdates(row) {
    let sourceMap = row.briefing_sources;
    if (typeof sourceMap === 'string') { try { sourceMap = JSON.parse(sourceMap); } catch { sourceMap = null; } }
    const recap = cleanAnimationText(row.briefing || (['Weekly','Monthly'].includes(row.time_slot) ? row.content : ''));
    const matched = Array.isArray(sourceMap) && sourceMap.length && sourceMap.every(p => typeof p?.text === 'string')
      && cleanAnimationText(sourceMap.map(p => p.text).join(' ')) === recap;
    const updates = recap ? (matched ? sourceMap.map(p => p.text) : sentences(recap)) : [];
    const stories = ['Morning','Evening','Daily'].includes(row.time_slot) ? parseStories(row) : [];
    return { updates, stories: stories.map(s => typeof s === 'string' ? s : s.summary).filter(Boolean) };
  }
  function queueRows(rows) {
    // Current daily recaps first, then their full briefs, then older editions. The queue
    // only receives published rows from the server; consumer lookup never generates.
    const ordered = [...rows].filter(r => r.category && !r.category.startsWith('__') && !r.user_id && !r.shared_key)
      .sort((a,b) => String(b.day).localeCompare(String(a.day)));
    for (const row of ordered) {
      const meta = { category: row.category, day: row.day, timeSlot: row.time_slot, language: row.language || 'en' };
      rowUpdates(row).updates.forEach(text => enqueue(text, meta));
    }
    for (const row of ordered) {
      const meta = { category: row.category, day: row.day, timeSlot: row.time_slot, language: row.language || 'en' };
      rowUpdates(row).stories.forEach(text => enqueue(text, meta));
    }
    void drain();
  }
  async function queueEdition(category, day, timeSlot, language) {
    const { data, error } = await supabase.from('news_summaries').select('category,day,time_slot,language,content,stories_content,briefing,briefing_sources')
      .eq('category', category).eq('day', day).eq('time_slot', timeSlot).eq('language', language).is('user_id', null).is('shared_key', null);
    if (error) { logger.warn(`Animation edition lookup failed: ${error.message}`); return; }
    queueRows(data || []);
  }
  async function backfill() {
    // Covers the seven available dates, anchored to the latest completed edition just
    // like the app. Period briefs are separate so last month's date is not filtered out.
    const { data: completed } = await supabase.from('news_summaries').select('day').eq('category','__completed__').order('day',{ascending:false}).limit(1);
    const end = completed?.[0]?.day;
    if (!end) return;
    const start = new Date(`${end}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - 6);
    const cols = 'category,day,time_slot,language,content,stories_content,briefing,briefing_sources';
    const [daily, periods] = await Promise.all([
      supabase.from('news_summaries').select(cols).gte('day',start.toISOString().slice(0,10)).lte('day',end).in('time_slot',['Morning','Evening','Daily']).is('user_id',null).is('shared_key',null).limit(1000),
      supabase.from('news_summaries').select(cols).in('time_slot',['Weekly','Monthly']).is('user_id',null).is('shared_key',null).order('day',{ascending:false}).limit(64),
    ]);
    if (daily.error || periods.error) { stats.blocked = daily.error?.message || periods.error?.message; return; }
    queueRows([...(daily.data || []),...(periods.data || [])]);
    logger.log(`Animation backfill queued ${pending.size} published updates (${start.toISOString().slice(0,10)}–${end}).`);
  }
  function register(app) {
    app.post('/api/story-animations/lookup', async (req,res) => {
      const texts = req.body?.texts;
      if (!Array.isArray(texts) || texts.length > 16 || texts.some(t => typeof t !== 'string' || t.length > 10000)) return res.status(400).json({ error: 'Supply up to 16 update texts' });
      try {
        const entries = await Promise.all(texts.map(async text => {
          const stored = await read(text);
          return { text: cleanAnimationText(text), status: stored?.plan ? 'ready' : stats.blocked || stored?.status === 'unavailable' ? 'unavailable' : 'pending', plan: stored?.plan || null };
        }));
        res.set('Cache-Control','no-store'); res.json({ version: ANIMATION_VERSION, entries });
      } catch { res.status(503).json({ error: 'Animations could not be loaded' }); }
    });
    app.get('/api/story-animations/status', (req,res) => res.json({ ...stats, pending: pending.size, blocked: !!stats.blocked }));
  }
  return { register, backfill, queueEdition, queueRows, rowUpdates, read, stats, drain };
}
