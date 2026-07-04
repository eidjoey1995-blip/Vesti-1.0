import { getServiceClient } from "../lib/supabase.js";
import { resolveUser } from "../lib/auth.js";

// =========================================================
// POST /api/update-garment
// Auth: Authorization: Bearer <supabase_access_token>
// Body: { garment_id, updates: { name?, category?, sub_category?, color?,
//                                formality_score?, pattern?, fabric? } }
//
// Verifies ownership, then updates only the allowed fields.
// Server-controlled fields (id, user_id, thumb_url, bbox,
// source_photo_url, created_at) are never touched.
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// =========================================================

// Builds a 2-3 word display label from current attrs, e.g. "beige cotton shirt".
// Skips fabric when null/empty/"other" so we don't get awkward "blue other shirt".
function buildLabel(color, fabric, category) {
  const parts = [];
  if (color    && String(color).trim())    parts.push(String(color).trim().toLowerCase());
  const fab = fabric && String(fabric).trim().toLowerCase();
  if (fab && fab !== "other") parts.push(fab);
  if (category && String(category).trim()) parts.push(String(category).trim().toLowerCase());
  return parts.join(" ");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: { code: "method_not_allowed", message: "POST only" } });
  }

  const { supabase, envErr } = getServiceClient();
  if (envErr) return res.status(500).json({ error: envErr });

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
  const userTypedName = typeof updates.name === "string" && updates.name.trim().length > 0;
  if (userTypedName) patch.description = updates.name.trim();
  if (typeof updates.category === "string" && updates.category.trim()) patch.category = updates.category.trim();
  if (typeof updates.sub_category === "string" && updates.sub_category.trim()) patch.subcategory = updates.sub_category.trim();
  if (typeof updates.color === "string" && updates.color.trim()) patch.color = updates.color.trim();
  if (Number.isInteger(updates.formality_score) && updates.formality_score >= 1 && updates.formality_score <= 5) {
    patch.formality_score = updates.formality_score;
  }
  const VALID_PATTERNS = new Set(["solid", "striped", "check", "plaid", "printed", "other"]);
  if (typeof updates.pattern === "string" && VALID_PATTERNS.has(updates.pattern)) {
    patch.pattern = updates.pattern;
  }
  const VALID_FABRICS = new Set([
    "cotton", "linen", "wool", "cashmere", "denim",
    "leather", "suede", "silk", "synthetic", "other"
  ]);
  if (typeof updates.fabric === "string" && VALID_FABRICS.has(updates.fabric)) {
    patch.fabric = updates.fabric;
    patch.fabric_confirmed = true; // user-confirmed via edit panel
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: { code: "no_valid_updates", message: "No updatable fields provided" } });
  }

  // Verify ownership AND fetch current values so we can regenerate the
  // description label when color/fabric/category change without a custom name.
  const { data: existing, error: fetchErr } = await supabase
    .from("garments")
    .select("id, user_id, color, fabric, category, subcategory, pattern, formality_score, description, source_photo_url, thumb_url")
    .eq("id", garment_id)
    .single();

  if (fetchErr || !existing) {
    return res.status(404).json({ error: { code: "not_found", message: "Garment not found" } });
  }
  if (existing.user_id !== userId) {
    return res.status(403).json({ error: { code: "forbidden", message: "Garment not owned by this user" } });
  }

  // If the user didn't type a custom name but changed any of the attributes
  // that the displayed label is built from, regenerate description from the
  // resulting attrs. Without this, "Beige LINEN Shirt" stays on the tile
  // even after the user corrects fabric to cotton.
  const attrChanged = patch.color !== undefined || patch.fabric !== undefined || patch.category !== undefined;
  if (!userTypedName && attrChanged) {
    const nextColor    = patch.color    ?? existing.color;
    const nextFabric   = patch.fabric   ?? existing.fabric;
    const nextCategory = patch.category ?? existing.category;
    const label = buildLabel(nextColor, nextFabric, nextCategory);
    if (label) {
      patch.description = label;
      patch.subcategory = label; // legacy tile fallback also reads this
    }
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

  // ── Log corrections ───────────────────────────────────────────────────────
  // Capture what the vision model got wrong (old value) vs what the user fixed
  // it to (new value), one row per changed field. This is the training fuel for
  // better prompts / few-shot examples / future fingerprinting. Auto-regenerated
  // description/subcategory are intentionally NOT logged — only fields the user
  // explicitly changed count as a correction. Non-fatal: a logging failure must
  // never break the user's edit, so errors are swallowed.
  try {
    const norm = (v) => (v === null || v === undefined) ? null : String(v).trim().toLowerCase();
    const fieldMap = [
      ["category",        updates.category,                       existing.category],
      ["subcategory",     updates.sub_category,                   existing.subcategory],
      ["color",           updates.color,                          existing.color],
      ["pattern",         updates.pattern,                        existing.pattern],
      ["fabric",          updates.fabric,                         existing.fabric],
      ["formality_score", updates.formality_score,                existing.formality_score],
      ["name",            userTypedName ? updates.name : undefined, existing.description],
    ];
    const corrections = [];
    for (const [field, rawNew, rawOld] of fieldMap) {
      if (rawNew === undefined || rawNew === null) continue;        // user didn't touch this field
      if (typeof rawNew === "string" && !rawNew.trim()) continue;   // blank = no change
      if (norm(rawNew) === norm(rawOld)) continue;                  // value unchanged
      corrections.push({
        user_id: userId,
        garment_id,
        field,
        old_value: (rawOld === null || rawOld === undefined) ? null : String(rawOld),
        new_value: String(rawNew).trim(),
        source_photo_url: existing.source_photo_url || null,
        thumb_url: existing.thumb_url || null,
      });
    }
    if (corrections.length) {
      const { error: logErr } = await supabase.from("garment_corrections").insert(corrections);
      if (logErr) console.warn("garment_corrections insert failed (non-fatal):", logErr.message);
      else console.log(`logged ${corrections.length} correction(s) for garment ${garment_id}: ${corrections.map(c => c.field).join(", ")}`);
    }
  } catch (logErr) {
    console.warn("garment_corrections log failed (non-fatal):", logErr?.message || logErr);
  }

  return res.status(200).json({ garment: updated });
}
