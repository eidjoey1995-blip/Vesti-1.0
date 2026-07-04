import { getServiceClient } from "../lib/supabase.js";
import { resolveUser } from "../lib/auth.js";

// =========================================================
// POST /api/confirm-dupe
// Auth: Authorization: Bearer <supabase_access_token>
// Body: {
//   candidate_id:    uuid (the newly-uploaded garment),
//   dupe_of_id:      uuid (the existing garment it duplicates),
//   confidence:      "strong" | "borderline"
// }
//
// Marks `candidate_id` as a duplicate of `dupe_of_id`. After
// this, get-closet hides the candidate from the grid view
// (the user still has the existing garment they pointed at).
//
// Both garments must belong to the caller — we verify that
// in a single round-trip so cross-user dupe marking is not
// possible even if the client tries.
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// =========================================================

const VALID_CONFIDENCE = new Set(["strong", "borderline"]);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: { code: "method_not_allowed", message: "POST only" } });
  }

  const { supabase, envErr } = getServiceClient();
  if (envErr) return res.status(500).json({ error: envErr });

  const { userId, err } = await resolveUser(req, supabase);
  if (err) return res.status(401).json({ error: err });

  const { candidate_id, dupe_of_id, confidence } = req.body || {};

  if (!candidate_id || typeof candidate_id !== "string") {
    return res.status(400).json({ error: { code: "missing_candidate", message: "candidate_id is required" } });
  }
  if (!dupe_of_id || typeof dupe_of_id !== "string") {
    return res.status(400).json({ error: { code: "missing_dupe_of", message: "dupe_of_id is required" } });
  }
  if (candidate_id === dupe_of_id) {
    return res.status(400).json({ error: { code: "self_dupe", message: "A garment cannot be a duplicate of itself" } });
  }
  if (!VALID_CONFIDENCE.has(confidence)) {
    return res.status(400).json({ error: { code: "invalid_confidence", message: "confidence must be 'strong' or 'borderline'" } });
  }

  // Verify BOTH garments belong to the caller before we touch anything.
  // One query, two rows expected — if we get fewer than 2 back, one of
  // them is missing or owned by someone else. We also pull thumb_url so we
  // can upgrade the original's thumbnail when the new photo is sharper.
  const { data: owned, error: ownErr } = await supabase
    .from("garments")
    .select("id, user_id, thumb_url")
    .in("id", [candidate_id, dupe_of_id])
    .eq("user_id", userId);

  if (ownErr) {
    return res.status(500).json({ error: { code: "ownership_check_failed", message: ownErr.message } });
  }
  if (!owned || owned.length !== 2) {
    return res.status(403).json({ error: { code: "forbidden", message: "Both garments must belong to the caller" } });
  }

  const { error: updateErr } = await supabase
    .from("garments")
    .update({
      dupe_of_garment_id: dupe_of_id,
      dupe_confidence: confidence,
    })
    .eq("id", candidate_id)
    .eq("user_id", userId);

  if (updateErr) {
    return res.status(500).json({ error: { code: "update_failed", message: updateErr.message } });
  }

  // ── Thumbnail upgrade ───────────────────────────────────────────────────
  // Worn-first flow: the duplicate is usually a fresh close-up, so its cutout
  // is often sharper than the original's (which may be a tiny crop from a
  // full-body mirror shot). If the candidate produced a thumb and the original
  // has none, promote the candidate's thumb onto the original so the kept
  // garment shows the better image. Only fills a gap — never clobbers an
  // existing original thumb — to stay safe and low-usage. Non-fatal: a failure
  // here must not undo the dupe marking, so errors are swallowed.
  let thumb_upgraded = false;
  try {
    const candidate = owned.find((g) => g.id === candidate_id);
    const original  = owned.find((g) => g.id === dupe_of_id);
    const candThumb = candidate?.thumb_url && String(candidate.thumb_url).trim();
    const origHasThumb = original?.thumb_url && String(original.thumb_url).trim();
    if (candThumb && !origHasThumb) {
      const { error: thumbErr } = await supabase
        .from("garments")
        .update({ thumb_url: candThumb })
        .eq("id", dupe_of_id)
        .eq("user_id", userId);
      if (thumbErr) console.warn("confirm-dupe thumb upgrade failed (non-fatal):", thumbErr.message);
      else thumb_upgraded = true;
    }
  } catch (e) {
    console.warn("confirm-dupe thumb upgrade error (non-fatal):", e?.message || e);
  }

  return res.status(200).json({ ok: true, candidate_id, dupe_of_id, confidence, thumb_upgraded });
}
