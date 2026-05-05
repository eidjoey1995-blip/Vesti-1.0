import { createClient } from "@supabase/supabase-js";

// =========================================================
// POST /api/save-garments
// Persists segmented garments to the `garments` table.
//
// Spike auth model (V1 BETA pre-auth):
//   Client sends `email`. We upsert a Supabase auth user with
//   that email (admin createUser, email_confirm=true), then
//   insert garments under that user_id. Next iteration swaps
//   this for proper Supabase Auth + JWT validation.
//
// Env vars required (Vercel Project Settings → Environment Variables):
//   SUPABASE_URL                 e.g. https://tmgftqnekispazjfnqxw.supabase.co
//   SUPABASE_SERVICE_KEY         (do NOT use anon key — RLS would block)
// =========================================================

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

  const { email, source_photo_url, garments, city } = req.body || {};

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: { code: "missing_email", message: "email is required" } });
  }
  if (!Array.isArray(garments) || garments.length === 0) {
    return res.status(400).json({ error: { code: "missing_garments", message: "garments must be a non-empty array" } });
  }
  // Whitelist city to the BETA cohort cities. Unknown values fall through silently.
  // Codex assumptions per city flagged in docs/methodology §5b notes (#46).
  const ALLOWED_CITIES = new Set(["Beirut", "Dubai", "New York"]);
  const cityClean = (typeof city === "string" && ALLOWED_CITIES.has(city)) ? city : null;

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Resolve or create the user.
  let userId;
  try {
    // Try to find existing user by email.
    const { data: existing, error: listErr } = await supabase.auth.admin.listUsers();
    if (listErr) throw listErr;
    const match = existing?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) {
      userId = match.id;
    } else {
      const { data: created, error: createErr } = await supabase.auth.admin.createUser({
        email,
        email_confirm: true
      });
      if (createErr) throw createErr;
      userId = created.user.id;
    }
  } catch (err) {
    return res.status(500).json({
      error: { code: "auth_user_resolve_failed", message: err.message || String(err) }
    });
  }

  // Ensure profile row exists (idempotent upsert). Include city when provided.
  // If profiles.city column is missing in the DB, the upsert errors — caught + logged
  // so onboarding still succeeds (garment insert is the user-visible win).
  try {
    const profileRow = { id: userId, display_name: email.split("@")[0] };
    if (cityClean) profileRow.city = cityClean;
    const { error: profileErr } = await supabase
      .from("profiles")
      .upsert(profileRow, { onConflict: "id" });
    if (profileErr) {
      // If failure is specifically about city column, retry without it so we still create the profile.
      if (cityClean && /city/i.test(profileErr.message || "")) {
        delete profileRow.city;
        await supabase.from("profiles").upsert(profileRow, { onConflict: "id" });
      } else {
        console.warn("profile upsert warning:", profileErr.message);
      }
    }
  } catch (err) {
    // Non-fatal — keep going.
    console.warn("profile upsert warning:", err?.message || err);
  }

  // Build garment rows.
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

  return res.status(200).json({
    user_id: userId,
    saved: data
  });
}
