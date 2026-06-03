import { createClient } from "@supabase/supabase-js";
import { hexToLab, labDistance } from "../lib/color-distance.js";

// =========================================================
// POST /api/find-dupes
// Auth: Authorization: Bearer <supabase_access_token>
// Body: { candidate_ids: [uuid, uuid, ...] }
//
// For each candidate (a just-saved garment), look at the
// user's existing closet — same category, has a hex, not
// already marked as a dupe, and not one of the candidates
// itself — find the closest Lab-distance match, and classify:
//   ΔE < 10  → strong   ("Same as your X?")
//   ΔE < 20  → borderline ("Maybe the same as your X?")
//   else     → null      (no prompt — keep both)
//
// Returns:
//   { matches: [{
//       candidate_id,
//       match: { id, name, thumb_url, category, hex, distance, confidence } | null
//     }, ...]
//   }
//
// Zero token cost — pure pixel math on hexes already in the DB.
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// =========================================================

const STRONG_DELTA = 10;
const BORDERLINE_DELTA = 20;
const MAX_CANDIDATES = 50;

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

// Build a short, user-friendly name for the matched garment.
// Mirrors the buildLabel pattern in update-garment.js so the UI
// can read straight from this without further processing.
function buildLabel(row) {
  const parts = [];
  if (row.color    && String(row.color).trim())    parts.push(String(row.color).trim().toLowerCase());
  const fab = row.fabric && String(row.fabric).trim().toLowerCase();
  if (fab && fab !== "other") parts.push(fab);
  const cat = row.subcategory || row.category;
  if (cat && String(cat).trim()) parts.push(String(cat).trim().toLowerCase());
  return parts.join(" ") || row.description || "this piece";
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

  const { candidate_ids } = req.body || {};
  if (!Array.isArray(candidate_ids) || candidate_ids.length === 0) {
    return res.status(400).json({ error: { code: "missing_candidates", message: "candidate_ids must be a non-empty array" } });
  }
  if (candidate_ids.length > MAX_CANDIDATES) {
    return res.status(400).json({ error: { code: "too_many_candidates", message: `max ${MAX_CANDIDATES} per call` } });
  }

  // ── Step 1: load the candidate rows. Must belong to the caller; must have a hex.
  // Skip anything already resolved as a dupe — find-dupes is idempotent for safety.
  // thumb_url is returned in the response so the UI can show candidate-vs-match
  // side-by-side; without it, batch uploaders can't tell which piece is being asked about.
  const { data: candidates, error: candErr } = await supabase
    .from("garments")
    .select("id, category, subcategory, dominant_hex, thumb_url")
    .in("id", candidate_ids)
    .eq("user_id", userId)
    .is("dupe_of_garment_id", null);

  if (candErr) {
    return res.status(500).json({ error: { code: "candidates_select_failed", message: candErr.message } });
  }
  if (!candidates || candidates.length === 0) {
    return res.status(200).json({ matches: [] });
  }

  // ── Step 2: load the rest of the user's closet (same categories as candidates,
  //          exclude the candidates themselves, exclude already-marked dupes,
  //          require a hex).
  const candidateCategories = [...new Set(candidates.map(c => c.category).filter(Boolean))];
  if (candidateCategories.length === 0) {
    return res.status(200).json({ matches: candidate_ids.map(id => ({ candidate_id: id, match: null })) });
  }

  const candidateIdSet = new Set(candidates.map(c => c.id));

  const { data: pool, error: poolErr } = await supabase
    .from("garments")
    .select("id, category, subcategory, color, fabric, description, thumb_url, dominant_hex")
    .eq("user_id", userId)
    .in("category", candidateCategories)
    .is("dupe_of_garment_id", null)
    .not("dominant_hex", "is", null);

  if (poolErr) {
    return res.status(500).json({ error: { code: "pool_select_failed", message: poolErr.message } });
  }

  // ── Step 3: pre-compute Lab for every pool row so we don't do it N times per candidate.
  const poolByCategory = new Map();
  for (const row of (pool || [])) {
    if (candidateIdSet.has(row.id)) continue;        // skip candidates themselves
    const lab = hexToLab(row.dominant_hex);
    if (!lab) continue;
    if (!poolByCategory.has(row.category)) poolByCategory.set(row.category, []);
    poolByCategory.get(row.category).push({ row, lab });
  }

  // ── Step 4: for each candidate, find the closest pool entry in the same category.
  const matches = candidates.map((cand) => {
    const result = { candidate_id: cand.id, candidate_thumb_url: cand.thumb_url ?? null, match: null };
    if (!cand.dominant_hex) return result;

    const candLab = hexToLab(cand.dominant_hex);
    if (!candLab) return result;

    const pool = poolByCategory.get(cand.category);
    if (!pool || pool.length === 0) return result;

    let best = null;
    for (const entry of pool) {
      const d = labDistance(candLab, entry.lab);
      if (best === null || d < best.distance) {
        best = { distance: d, entry };
      }
    }
    if (!best) return result;

    let confidence = null;
    if (best.distance < STRONG_DELTA) confidence = "strong";
    else if (best.distance < BORDERLINE_DELTA) confidence = "borderline";

    if (!confidence) return result;

    result.match = {
      id: best.entry.row.id,
      name: buildLabel(best.entry.row),
      thumb_url: best.entry.row.thumb_url,
      category: best.entry.row.category,
      hex: best.entry.row.dominant_hex,
      distance: Math.round(best.distance * 10) / 10,    // 1 decimal place for readability
      confidence,
    };
    return result;
  });

  // ── Also include candidates that weren't found (e.g. wrong user, deleted) as null matches.
  const foundIds = new Set(candidates.map(c => c.id));
  for (const id of candidate_ids) {
    if (!foundIds.has(id)) matches.push({ candidate_id: id, match: null });
  }

  return res.status(200).json({ matches });
}
