import { createClient } from "@supabase/supabase-js";
import { maskGarment } from "../lib/grounded-sam.js";

export const maxDuration = 60;

// =========================================================
// POST /api/reprocess-garment
// Admin-style endpoint — re-runs grounded_sam on an existing
// garment's source photo and overwrites its thumb_url.
//
// Body: { email: string, garment_id: string }
// Response 200: { ok: true, thumb_url: string }
// Response 4xx/5xx: { ok: false, error: string }
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   REPLICATE_API_TOKEN
// =========================================================

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "POST only" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY" });
  }
  if (!process.env.REPLICATE_API_TOKEN) {
    return res.status(500).json({ ok: false, error: "REPLICATE_API_TOKEN not set" });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { email, garment_id } = req.body || {};
  if (!email || typeof email !== "string") {
    return res.status(400).json({ ok: false, error: "email is required" });
  }
  if (!garment_id || typeof garment_id !== "string") {
    return res.status(400).json({ ok: false, error: "garment_id is required" });
  }

  // Step 1: Resolve user_id from email via admin API.
  let userId;
  try {
    const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000, page: 1 });
    if (listErr) return res.status(500).json({ ok: false, error: listErr.message });
    const user = users.find(u => u.email === email);
    if (!user) return res.status(404).json({ ok: false, error: `No user found for email: ${email}` });
    userId = user.id;
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }

  // Step 2: Fetch garment row and verify ownership.
  const { data: garment, error: fetchErr } = await supabase
    .from("garments")
    .select("id, user_id, source_photo_url, category, subcategory, thumb_url")
    .eq("id", garment_id)
    .single();

  if (fetchErr || !garment) {
    return res.status(404).json({ ok: false, error: fetchErr?.message || "Garment not found" });
  }
  if (garment.user_id !== userId) {
    return res.status(403).json({ ok: false, error: "Garment does not belong to this user" });
  }
  if (!garment.source_photo_url) {
    return res.status(400).json({ ok: false, error: "Garment has no source_photo_url — cannot reprocess" });
  }

  // Steps 3 + 4: Build the SAM prompt and re-run maskGarment.
  const label = garment.subcategory || garment.category || "clothing";
  const category = garment.subcategory || garment.category || "";

  let pngBuf;
  try {
    pngBuf = await maskGarment(garment.source_photo_url, label, "", category);
  } catch (err) {
    return res.status(502).json({ ok: false, error: err?.message || String(err) });
  }
  if (!pngBuf) {
    return res.status(502).json({ ok: false, error: "maskGarment returned null — SAM failed or mask was empty" });
  }

  // Step 5: Upload — overwrite existing storage path when possible, otherwise mint a new one.
  let fileName;
  if (garment.thumb_url) {
    const marker = "/garment-thumbs/";
    const idx = garment.thumb_url.indexOf(marker);
    if (idx !== -1) fileName = garment.thumb_url.slice(idx + marker.length);
  }
  if (!fileName) {
    fileName = `${userId}/${Date.now()}_reprocess.png`;
  }

  const { error: upErr } = await supabase.storage
    .from("garment-thumbs")
    .upload(fileName, pngBuf, { contentType: "image/png", upsert: true });

  if (upErr) {
    return res.status(500).json({ ok: false, error: `Storage upload failed: ${upErr.message}` });
  }

  const { data: { publicUrl } } = supabase.storage
    .from("garment-thumbs")
    .getPublicUrl(fileName);

  // Step 6: Write new thumb_url back to the garments row.
  const { error: updateErr } = await supabase
    .from("garments")
    .update({ thumb_url: publicUrl })
    .eq("id", garment_id);

  if (updateErr) {
    return res.status(500).json({ ok: false, error: `DB update failed: ${updateErr.message}` });
  }

  return res.status(200).json({ ok: true, thumb_url: publicUrl });
}
