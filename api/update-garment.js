import { createClient } from "@supabase/supabase-js";

// =========================================================
// POST /api/update-garment
// Auth: Authorization: Bearer <supabase_access_token>
// Body: { garment_id, updates: { name?, category?, sub_category?, color? } }
//
// Verifies ownership, then updates only the allowed fields.
// Server-controlled fields (id, user_id, thumb_url, bbox,
// source_photo_url, created_at) are never touched.
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// =========================================================

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

  const { garment_id, updates } = req.body || {};

  if (!garment_id) {
    return res.status(400).json({ error: { code: "missing_garment_id", message: "garment_id is required" } });
  }
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    return res.status(400).json({ error: { code: "missing_updates", message: "updates must be a non-null object" } });
  }

  // Map client field names to DB column names; strip server-controlled fields.
  const patch = {};
  if (typeof updates.name === "string" && updates.name.trim()) patch.description = updates.name.trim();
  if (typeof updates.category === "string" && updates.category.trim()) patch.category = updates.category.trim();
  if (typeof updates.sub_category === "string" && updates.sub_category.trim()) patch.subcategory = updates.sub_category.trim();
  if (typeof updates.color === "string" && updates.color.trim()) patch.color = updates.color.trim();

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: { code: "no_valid_updates", message: "No updatable fields provided" } });
  }

  // Verify ownership.
  const { data: existing, error: fetchErr } = await supabase
    .from("garments")
    .select("id, user_id")
    .eq("id", garment_id)
    .single();

  if (fetchErr || !existing) {
    return res.status(404).json({ error: { code: "not_found", message: "Garment not found" } });
  }
  if (existing.user_id !== userId) {
    return res.status(403).json({ error: { code: "forbidden", message: "Garment not owned by this user" } });
  }

  const { data: updated, error: updateErr } = await supabase
    .from("garments")
    .update(patch)
    .eq("id", garment_id)
    .eq("user_id", userId)
    .select()
    .single();

  if (updateErr) {
    return res.status(500).json({
      error: { code: "update_failed", message: updateErr.message }
    });
  }

  return res.status(200).json({ garment: updated });
}
