// Vercel cron: GET /api/keepalive, once a day (see vercel.json).
// Free Supabase projects pause after a week with no database activity.
// Bukas is meant to be opened rarely, so this makes one tiny request a day
// to keep the project awake. It reads nothing: row-level security returns
// an empty list to an unauthenticated request.

module.exports = async (req, res) => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) { res.statusCode = 503; res.end('not configured'); return; }
  try {
    const r = await fetch(url.replace(/\/$/, '') + '/rest/v1/entries?select=id&limit=1', {
      headers: { apikey: key, Authorization: 'Bearer ' + key }
    });
    res.statusCode = r.ok ? 200 : 502;
    res.end(r.ok ? 'awake' : 'supabase responded ' + r.status);
  } catch (e) {
    res.statusCode = 502;
    res.end('unreachable');
  }
};
