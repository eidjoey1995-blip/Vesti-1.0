import { createClient } from "@supabase/supabase-js";

// =========================================================
// POST /api/save-garments
// Auth: Authorization: Bearer <supabase_access_token>
// Body: { city?, source_photo_url?, garments[] }
//
// user_id is resolved from the JWT — not accepted in the body.
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// =========================================================

async function resolveUser(req, supabase) {
  const auth = (req.headers.authorization || "").trim();
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    return { userId: null, email: null, err: { code: "unauthorized", message: "Authorization header required" } };
  }
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return { userId: null, email: null, err: { code: "unauthorized", message: error?.message || "Invalid token" } };
  }
  return { userId: user.id, email: user.email, err: null };
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

  const { userId, email, err } = await resolveUser(req, supabase);
  if (err) return res.status(401).json({ error: err });

  const { source_photo_url, garments, city } = req.body || {};

  if (!Array.isArray(garments) || garments.length === 0) {
    return res.status(400).json({ error: { code: "missing_garments", message: "garments must be a non-empty array" } });
  }

  // Whitelist city to the BETA cohort cities.
  const ALLOWED_CITIES = new Set(["Beirut", "Dubai", "New York"]);
  const cityClean = (typeof city === "string" && ALLOWED_CITIES.has(city)) ? city : null;

  // Ensure profile row exists (idempotent upsert). Include city when provided.
  try {
    const profileRow = { id: userId, display_name: (email || "").split("@")[0] };
    if (cityClean) profileRow.city = cityClean;
    const { error: profileErr } = await supabase
      .from("profiles")
      .upsert(profileRow, { onConflict: "id" });
    if (profileErr) {
      if (cityClean && /city/i.test(profileErr.message || "")) {
        delete profileRow.city;
        await supabase.from("profiles").upsert(profileRow, { onConflict: "id" });
      } else {
        console.warn("profile upsert warning:", profileErr.message);
      }
    }
  } catch (e) {
    console.warn("profile upsert warning:", e?.message || e);
  }

  const rows = garments.map((g, i) => ({
    user_id: userId,
    category: g.category ?? "other",
    subcategory: g.subcategory ?? null,
    color: g.color ?? null,
    pattern: g.pattern ?? null,
    formality_score: typeof g.formality_score === "number" ? g.formality_score : null,
    description: g.description ?? null,
    fabric: g.fabric ?? null,
    fabric_confirmed: !!g.fabric_confirmed,
    brand: g.brand ?? null,
    source_photo_url: source_photo_url ?? null,
    raw_response: g.raw_response ?? g,
    segment_index: i
  }));

  const { data, error } = await supabase
    .from("garments")
    .insert(rows)
    .select("id, segment_index");

  if (error) {
    return res.status(500).json({
      error: { code: "insert_failed", message: error.message, details: error.details ?? null }
    });
  }

  return res.status(200).json({ user_id: userId, saved: data });
}
