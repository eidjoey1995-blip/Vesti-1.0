import { getServiceClient } from "../lib/supabase.js";
import { resolveUser } from "../lib/auth.js";

// =========================================================
// POST /api/delete-garment
// Auth: Authorization: Bearer <supabase_access_token>
// Body: { garment_id }
//
// Verifies the garment belongs to the authenticated user,
// removes storage objects (thumb + flatlay), then deletes the row.
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// =========================================================

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: { code: "method_not_allowed", message: "POST only" } });
  }

  const { supabase, envErr } = getServiceClient();
  if (envErr) return res.status(500).json({ error: envErr });

  const { userId, err } = await resolveUser(req, supabase);
  if (err) return res.status(401).json({ error: err });

  const { garment_id } = req.body || {};
  if (!garment_id) {
    return res.status(400).json({ error: { code: "missing_garment_id", message: "garment_id is required" } });
  }

  // Fetch the row first to verify ownership and get storage paths.
  const { data: garment, error: fetchErr } = await supabase
    .from("garments")
    .select("id, user_id, thumb_url, source_photo_url")
    .eq("id", garment_id)
    .eq("user_id", userId)
    .single();

  if (fetchErr || !garment) {
    return res.status(404).json({ error: { code: "not_found", message: "Garment not found or not owned by this user" } });
  }

  // Remove storage objects — non-fatal if they don't exist.
  if (garment.thumb_url) {
    try {
      // Public URL format: .../storage/v1/object/public/garment-thumbs/<path>
      const thumbPath = garment.thumb_url.split("/garment-thumbs/")[1];
      if (thumbPath) {
        await supabase.storage.from("garment-thumbs").remove([decodeURIComponent(thumbPath)]);
      }
    } catch (e) {
      console.warn("thumb storage removal warning:", e?.message || e);
    }
  }

  if (garment.source_photo_url) {
    try {
      const flatPath = garment.source_photo_url.split("/flatlays/")[1];
      if (flatPath) {
        await supabase.storage.from("flatlays").remove([decodeURIComponent(flatPath)]);
      }
    } catch (e) {
      console.warn("flatlay storage removal warning:", e?.message || e);
    }
  }

  // Delete the row.
  const { error: deleteErr } = await supabase
    .from("garments")
    .delete()
    .eq("id", garment_id)
    .eq("user_id", userId);

  if (deleteErr) {
    return res.status(500).json({
      error: { code: "delete_failed", message: deleteErr.message }
    });
  }

  // Cascade: delete any outfits this user owns that reference the deleted
  // garment. garment_ids is a uuid[] column; .contains() maps to the @> operator.
  // Non-fatal — garment deletion succeeds regardless of whether cascade works.
  try {
    const { data: orphaned, error: fetchOrphanErr } = await supabase
      .from("outfits")
      .select("id")
      .eq("user_id", userId)
      .contains("garment_ids", [garment_id]);

    if (fetchOrphanErr) {
      console.warn("delete-garment: orphan outfits fetch warning:", fetchOrphanErr.message);
    } else if (orphaned && orphaned.length > 0) {
      const orphanIds = orphaned.map((o) => o.id);
      const { error: deleteOrphanErr } = await supabase
        .from("outfits")
        .delete()
        .in("id", orphanIds)
        .eq("user_id", userId);

      if (deleteOrphanErr) {
        console.warn("delete-garment: orphan outfits delete warning:", deleteOrphanErr.message);
      } else {
        console.log(`delete-garment: cascaded ${orphanIds.length} orphan outfits for user ${userId}`);
      }
    }
  } catch (e) {
    console.warn("delete-garment: orphan cascade exception:", e?.message || e);
  }

  return res.status(200).json({ success: true });
}
