import { getServiceClient } from "../lib/supabase.js";
import { resolveUser } from "../lib/auth.js";

// =========================================================
// POST /api/link-suit
// Auth: Authorization: Bearer <supabase_access_token>
//
// Link garments into a suit set (e.g. a blazer + its matching trousers) so the
// stylist recommends them together and never pairs one half of a suit with a
// non-matching piece. A suit is just N garment rows sharing one suit_set_id.
//
// Body (link):   { garment_ids: [uuid, uuid, ...] }   — 2..MAX pieces
// Body (unlink): { garment_ids: [uuid, ...], unlink: true }
//
// All garments must belong to the caller — verified in one round-trip so a
// client cannot link or unlink someone else's pieces.
//
// Returns:
//   link:   { ok: true, suit_set_id, garment_ids }
//   unlink: { ok: true, suit_set_id: null, garment_ids }
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// =========================================================

const MIN_PIECES = 2;
const MAX_PIECES = 6;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: { code: "method_not_allowed", message: "POST only" } });
  }

  const { supabase, envErr } = getServiceClient();
  if (envErr) return res.status(500).json({ error: envErr });

  const { userId, err } = await resolveUser(req, supabase);
  if (err) return res.status(401).json({ error: err });

  const { garment_ids, unlink } = req.body || {};

  // De-dupe and validate the id list.
  const ids = Array.isArray(garment_ids)
    ? [...new Set(garment_ids.filter((x) => typeof x === "string" && x.trim()))]
    : [];

  if (unlink) {
    if (ids.length < 1) {
      return res.status(400).json({ error: { code: "missing_garments", message: "garment_ids must be a non-empty array" } });
    }
  } else {
    if (ids.length < MIN_PIECES) {
      return res.status(400).json({ error: { code: "too_few_pieces", message: `a suit needs at least ${MIN_PIECES} pieces` } });
    }
    if (ids.length > MAX_PIECES) {
      return res.status(400).json({ error: { code: "too_many_pieces", message: `max ${MAX_PIECES} pieces per suit` } });
    }
  }

  // Verify EVERY id belongs to the caller before touching anything.
  const { data: owned, error: ownErr } = await supabase
    .from("garments")
    .select("id, user_id")
    .in("id", ids)
    .eq("user_id", userId);

  if (ownErr) {
    return res.status(500).json({ error: { code: "ownership_check_failed", message: ownErr.message } });
  }
  if (!owned || owned.length !== ids.length) {
    return res.status(403).json({ error: { code: "forbidden", message: "All garments must belong to the caller" } });
  }

  // ── Unlink: clear suit_set_id on the given pieces.
  if (unlink) {
    const { error: clearErr } = await supabase
      .from("garments")
      .update({ suit_set_id: null })
      .in("id", ids)
      .eq("user_id", userId);
    if (clearErr) {
      return res.status(500).json({ error: { code: "unlink_failed", message: clearErr.message } });
    }
    return res.status(200).json({ ok: true, suit_set_id: null, garment_ids: ids });
  }

  // ── Link: assign one shared suit_set_id to all pieces. If any piece was
  // already in a suit, it is reassigned to this new set (last-write-wins).
  const suit_set_id = crypto.randomUUID();
  const { error: linkErr } = await supabase
    .from("garments")
    .update({ suit_set_id })
    .in("id", ids)
    .eq("user_id", userId);
  if (linkErr) {
    return res.status(500).json({ error: { code: "link_failed", message: linkErr.message } });
  }

  return res.status(200).json({ ok: true, suit_set_id, garment_ids: ids });
}
