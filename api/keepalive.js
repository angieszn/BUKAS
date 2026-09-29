// Vercel cron: GET /api/keepalive, once a day (see vercel.json).
// Free Supabase projects pause after a week with no database activity.
// Bukas is meant to be opened rarely, so this makes one tiny request a day
// to keep the project awake. It reads nothing: row-level security returns
// an empty list to an unauthenticated request.

module.exports = async (req, res) => {
  let url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_ANON_KEY || '').trim();
  try { if (url) url = new URL(url).origin; } catch (e) {}
  if (!url || !key) { res.statusCode = 503; res.end('not configured'); return; }
  try {
    const r = await fetch(url + '/rest/v1/entries?select=id&limit=1', {
      // apikey alone works with both legacy anon keys and new publishable keys.
      headers: { apikey: key }
    });
    res.statusCode = r.ok ? 200 : 502;
    res.end(r.ok ? 'awake' : 'supabase responded ' + r.status);
  } catch (e) {
    res.statusCode = 502;
    res.end('unreachable');
  }
};
