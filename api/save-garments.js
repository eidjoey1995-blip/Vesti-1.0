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
// Env vars required (Vercel Project Settings â Environment Variables):
//   SUPABASE_URL                 e.g. https://tmgftqnekispazjfnqxw.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    (do NOT use anon key â RLS would block)
// =========================================================

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: { code: "method_not_allowed", message: "POST only" } });
  }

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return res.status(500).json({
      error: {
        code: "missing_env",
        message: "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in Vercel env vars."
      }
    });
  }

  const { email, source_photo_url, garments } = req.body || {};

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: { code: "missing_email", message: "email is required" } });
  }
  if (!Array.isArray(garments) || garments.length === 0) {
    return res.status(400).json({ error: { code: "missing_garments", message: "garments must be a non-empty array" } });
  }

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

  // Ensure profile row exists (idempotent upsert).
  try {
    await supabase
      .from("profiles")
      .upsert({ id: userId, display_name: email.split("@")[0] }, { onConflict: "id" });
  } catch (err) {
    // Non-fatal â keep going.
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
