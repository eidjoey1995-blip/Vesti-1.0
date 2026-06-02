import { createClient } from "@supabase/supabase-js";

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
  // them is missing or owned by someone else.
  const { data: owned, error: ownErr } = await supabase
    .from("garments")
    .select("id, user_id")
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

  return res.status(200).json({ ok: true, candidate_id, dupe_of_id, confidence });
}
