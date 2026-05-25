import { createClient } from "@supabase/supabase-js";

// =========================================================
// POST /api/swipe
// Auth: Authorization: Bearer <supabase_access_token>
// Body: { outfit_id, signal: "yes" | "no" | "refresh",
//         rejected_garment_ids?: (number|string)[] }
//
// rejected_garment_ids is optional and only meaningful with
// signal "no" — it records which specific pieces of the outfit
// the user flagged as wrong, so a later increment can swap
// only those while keeping the rest.
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// =========================================================

const VALID_SIGNALS = new Set(["yes", "no", "refresh"]);

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
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: { code: "method_not_allowed", message: "POST only" } });
  }

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    return res.status(500).json({
      error: { code: "missing_env", message: "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in Vercel env vars." }
    });
  }

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { userId, err } = await resolveUser(req, supabase);
  if (err) return res.status(401).json({ error: err });

  const { outfit_id, signal, rejected_garment_ids } = req.body || {};

  if (typeof outfit_id !== "number" && typeof outfit_id !== "string") {
    return res.status(400).json({ error: { code: "missing_outfit_id", message: "outfit_id is required" } });
  }
  if (!VALID_SIGNALS.has(signal)) {
    return res.status(400).json({
      error: { code: "invalid_signal", message: "signal must be one of: yes, no, refresh" }
    });
  }

  // Optional: which specific garments the user flagged as wrong. Accept only a
  // clean array of id primitives; anything else is treated as "none provided".
  let rejectedIds = null;
  if (rejected_garment_ids != null) {
    if (!Array.isArray(rejected_garment_ids)) {
      return res.status(400).json({
        error: { code: "invalid_rejected_garment_ids", message: "rejected_garment_ids must be an array" }
      });
    }
    const cleaned = rejected_garment_ids.filter(
      id => typeof id === "number" || typeof id === "string"
    );
    rejectedIds = cleaned.length > 0 ? cleaned : null;
  }

  const row = { user_id: userId, outfit_id, signal };
  if (rejectedIds) row.rejected_garment_ids = rejectedIds;

  const { data, error } = await supabase
    .from("swipes")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    return res.status(500).json({
      error: { code: "insert_failed", message: error.message, details: error.details ?? null }
    });
  }

  return res.status(200).json({ ok: true, swipe_id: data.id, user_id: userId });
}
