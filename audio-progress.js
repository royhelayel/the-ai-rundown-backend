export function mergeAudioRanges(...groups) {
  const sorted = groups.flat().filter(r => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite) && r[1] > r[0])
    .map(([a, b]) => [Math.max(0, a), Math.min(1, b)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of sorted) { const last = out[out.length - 1]; if (last && a <= last[1] + .00001) last[1] = Math.max(last[1], b); else out.push([a, b]); }
  return out;
}
export function safeAudioRecord(row) {
  if (!row || typeof row.key !== 'string' || row.key.length > 600 || !/^\d{4}-\d{2}-\d{2}$/.test(row.day || '') || !['Daily','Weekly','Monthly'].includes(row.period) || !['en','ar'].includes(row.language) || typeof row.category !== 'string' || row.category.length > 150) return null;
  const ranges = mergeAudioRanges(Array.isArray(row.ranges) ? row.ranges.slice(0, 1000) : []);
  const completed = ranges.reduce((sum, [a, b]) => sum + b - a, 0) + 1e-8 >= .7;
  return { key: row.key, day: row.day, period: row.period, language: row.language, category: row.category,
    signature: String(row.signature || '').slice(0,100), position: Math.max(0, Math.min(1, Number(row.position) || 0)), ranges, completed,
    duration: Math.max(0, Math.min(36000, Number(row.duration) || 0)), speed: Math.max(.5, Math.min(3, Number(row.speed) || 1)),
    queueKeys: (Array.isArray(row.queueKeys) ? row.queueKeys : []).filter(k => typeof k === 'string' && k.length <= 600).slice(0,40),
    missingCount: Math.max(0, Math.min(40, Number(row.missingCount) || 0)), finished: row.finished === true, started: row.started === true,
    mixCompleted: row.mixCompleted === true, updatedAt: Math.min(Date.now(), Math.max(0, Number(row.updatedAt) || Date.now())) };
}
export function mergeAudioRecords(records, previous = []) {
  const all = new Map(previous.map(r => [r.content_key, r.data]));
  for (const r of records) {
    const prior = all.get(r.key) || {};
    const latest = (prior.updatedAt || 0) > r.updatedAt ? prior : r;
    const ranges = mergeAudioRanges(prior.ranges || [], r.ranges);
    all.set(r.key, { ...latest, ranges, completed: ranges.reduce((sum,[a,b]) => sum+b-a,0)+1e-8 >= .7, mixCompleted: !!prior.mixCompleted });
  }
  return records.map(r => {
    const merged = all.get(r.key);
    // A completion claim is valid only when every recording in that mix reached 70%.
    if (merged.queueKeys?.length && merged.queueKeys.every(k => all.get(k)?.completed)) merged.mixCompleted = true;
    return { content_key: r.key, data: merged };
  });
}
export function registerAudioProgressRoutes(app, supabase) {
  // Serialise each user's writes so simultaneous device syncs cannot overwrite coverage.
  const pending = new Map();
  const serial = async (id, run) => {
    const previous = pending.get(id) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    pending.set(id, current);
    await previous;
    try { return await run(); }
    finally { release(); if (pending.get(id) === current) pending.delete(id); }
  };
  const user = async req => {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return null;
    const { data, error } = await supabase.auth.getUser(token);
    return !error ? data?.user?.id : null;
  };
  app.get('/api/audio-progress', async (req, res) => {
    try {
      const id = await user(req); if (!id) return res.status(401).json({ error: 'Sign in required' });
      const { data, error } = await supabase.from('user_audio_progress').select('content_key,data').eq('user_id', id).order('updated_at', { ascending: false }).limit(120);
      if (error) throw error;
      res.set('Cache-Control','no-store').json((data || []).map(r => ({ ...r.data, key: r.content_key })));
    } catch (e) { console.warn('Audio progress unavailable:', e.message); res.status(503).json({ error: 'Progress sync temporarily unavailable' }); }
  });
  app.post('/api/audio-progress', async (req, res) => {
    try {
      const id = await user(req); if (!id) return res.status(401).json({ error: 'Sign in required' });
      if (!Array.isArray(req.body?.records) || req.body.records.length > 120) return res.status(400).json({ error: 'Invalid progress records' });
      const records = req.body.records.map(safeAudioRecord); if (records.some(r => !r)) return res.status(400).json({ error: 'Invalid progress record' });
      if (!records.length) return res.json({ ok: true });
      await serial(id, async () => {
        const keys = [...new Set(records.flatMap(r => [r.key, ...r.queueKeys]))];
        const { data: previous, error: readError } = await supabase.from('user_audio_progress').select('content_key,data').eq('user_id', id).in('content_key', keys);
        if (readError) throw readError;
        const rows = mergeAudioRecords(records, previous || []).map(r => ({ ...r, user_id: id, updated_at: new Date().toISOString() }));
        const { error } = await supabase.from('user_audio_progress').upsert(rows, { onConflict: 'user_id,content_key' });
        if (error) throw error;
      });
      res.json({ ok: true });
    } catch (e) { console.warn('Audio progress sync unavailable. Apply user-audio-progress.sql if the table is missing:', e.message); res.status(503).json({ error: 'Progress sync temporarily unavailable' }); }
  });
}
