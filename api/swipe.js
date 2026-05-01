import { createClient } from "@supabase/supabase-js";

// =========================================================
// POST /api/swipe
// Records a yes/no/refresh signal on an outfit recommendation.
//
// Body: { email, outfit_id, signal: "yes" | "no" | "refresh" }
//
// Spike auth model (V1 BETA pre-auth): client sends `email`,
// we resolve to user_id via supabase.auth.admin.listUsers and
// insert into the `swipes` table. Same pattern as save-garments.
//
// Env vars (existing Vercel convention):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// =========================================================

const VALID_SIGNALS = new Set(["yes", "no", "refresh"]);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: { code: "method_not_allowed", message: "POST only" } });
  }

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    return res.status(500).json({
      error: {
        code: "missing_env",
        message: "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in Vercel env vars."
      }
    });
  }

  const { email, outfit_id, signal } = req.body || {};

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: { code: "missing_email", message: "email is required" } });
  }
  if (typeof outfit_id !== "number" && typeof outfit_id !== "string") {
    return res.status(400).json({ error: { code: "missing_outfit_id", message: "outfit_id is required" } });
  }
  if (!VALID_SIGNALS.has(signal)) {
    return res.status(400).json({
      error: {
        code: "invalid_signal",
        message: "signal must be one of: yes, no, refresh"
      }
    });
  }

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Resolve user_id from email (same pattern as save-garments).
  let userId;
  try {
    const { data: existing, error: listErr } = await supabase.auth.admin.listUsers();
    if (listErr) throw listErr;
    const match = existing?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (!match) {
      return res.status(404).json({
        error: { code: "user_not_found", message: "No user with that email. Complete onboarding first." }
      });
    }
    userId = match.id;
  } catch (err) {
    return res.status(500).json({
      error: { code: "auth_user_resolve_failed", message: err.message || String(err) }
    });
  }

  // Insert the swipe row.
  const { data, error } = await supabase
    .from("swipes")
    .insert({
      user_id: userId,
      outfit_id: outfit_id,
      signal: signal
    })
    .select("id")
    .single();

  if (error) {
    return res.status(500).json({
      error: { code: "insert_failed", message: error.message, details: error.details ?? null }
    });
  }

  return res.status(200).json({
    ok: true,
    swipe_id: data.id,
    user_id: userId
  });
}
