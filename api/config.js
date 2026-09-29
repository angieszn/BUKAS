// Vercel serverless function: GET /api/config
// Hands the browser your Supabase URL and anon key from Vercel's
// environment variables, so they never have to be committed to the repo.
// (The anon key is designed to be public — row-level security is what
// protects the data — this just keeps configuration out of the code.)

module.exports = (req, res) => {
  let url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_ANON_KEY || '').trim();
  try { if (url) url = new URL(url).origin; } catch (e) {}
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (!url || !key) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: 'SUPABASE_URL and SUPABASE_ANON_KEY are not set in Vercel.' }));
    return;
  }
  res.statusCode = 200;
  res.end(JSON.stringify({ SUPABASE_URL: url, SUPABASE_ANON_KEY: key }));
};
