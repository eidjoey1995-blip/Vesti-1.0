// GET /api/auth-config
// Returns the public Supabase config (URL + anon key) for client-side use.
// Anon key is safe to expose but keeping it out of source code lets us rotate
// it in Vercel without a deploy.
export default function handler(req, res) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return res.status(500).json({
      error: { code: "missing_env", message: "SUPABASE_URL and SUPABASE_ANON_KEY must be set." }
    });
  }
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
  return res.status(200).json({ url, anonKey });
}
