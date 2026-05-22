import { createClient } from "@supabase/supabase-js";

// =========================================================
// GET  /api/update-profile   → { profile: { daily_register } }
// POST /api/update-profile   → { ok: true }
// Auth: Authorization: Bearer <supabase_access_token>
//
// POST body: { daily_register?: "casual"|"smart-casual"|"business" }
// Strict whitelist — unknown fields are silently ignored, not written.
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// =========================================================

const VALID_DAILY_REGISTER = new Set(["casual", "smart-casual", "business"]);

async function resolveUser(req, supabase) {
  const auth = (req.headers.authorization || "").trim();
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    return { userId: null, err: { code: "unauthorized", message: "Authorization header required" } };
  }
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return { userId: null, err: { code: "unauthorized", message: error?.message || "Invalid token" } };
  }
  return { userId: user.id, err: null };
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: { code: "method_not_allowed", message: "GET or POST only" } });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({
      error: { code: "missing_env", message: "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in Vercel env vars." }
    });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { userId, err } = await resolveUser(req, supabase);
  if (err) return res.status(401).json({ error: err });

  // ── GET: read profile ──────────────────────────────────────────────────────
  if (req.method === "GET") {
    const { data, error: readErr } = await supabase
      .from("profiles")
      .select("daily_register")
      .eq("id", userId)
      .maybeSingle();

    if (readErr) {
      return res.status(500).json({ error: { code: "select_failed", message: readErr.message } });
    }

    return res.status(200).json({
      profile: { daily_register: data?.daily_register || "smart-casual" }
    });
  }

  // ── POST: update profile ───────────────────────────────────────────────────
  const body = req.body || {};
  const patch = {};

  if (typeof body.daily_register === "string" && VALID_DAILY_REGISTER.has(body.daily_register)) {
    patch.daily_register = body.daily_register;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: { code: "no_valid_updates", message: "No valid updatable fields provided" } });
  }

  const { error: updateErr } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", userId);

  if (updateErr) {
    return res.status(500).json({ error: { code: "update_failed", message: updateErr.message } });
  }

  return res.status(200).json({ ok: true });
}
