import { getServiceClient } from "../lib/supabase.js";
import { resolveUser } from "../lib/auth.js";
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

// Two garments with clearly different patterns (e.g. solid vs plaid) are not the
// same piece, even if their dominant colour matches. Only block when BOTH
// patterns are known and meaningful — if either is missing or "other", we can't
// trust it, so we fall back to colour alone rather than risk missing a real dupe.
function patternsConflict(a, b) {
  const na = (a || "").trim().toLowerCase();
  const nb = (b || "").trim().toLowerCase();
  if (!na || !nb || na === "other" || nb === "other") return false;
  return na !== nb;
}

// Build a short, user-friendly name for the matched garment.
// Mirrors the buildLabel pattern in update-garment.js so the UI
// can read straight from this without further processing.
function buildLabel(row) {
  const cat = String(row.subcategory || row.category || "").trim().toLowerCase();
  const color = row.color ? String(row.color).trim().toLowerCase() : "";
  const fab = row.fabric ? String(row.fabric).trim().toLowerCase() : "";
  const parts = [];
  // The vision subcategory is often already a full phrase that includes the
  // colour and fabric (e.g. "navy dress trousers", "grey check blazer"). Only
  // prepend colour/fabric when the phrase doesn't already contain them —
  // otherwise we get "navy navy dress trousers".
  if (color && !cat.includes(color)) parts.push(color);
  if (fab && fab !== "other" && !cat.includes(fab)) parts.push(fab);
  if (cat) parts.push(cat);
  return parts.join(" ") || row.description || "this piece";
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
    .select("id, category, subcategory, color, pattern, dominant_hex, thumb_url")
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

  // No hex filter on the pool — we want null-hex entries available for the
  // text-fallback path (when a candidate's thumb was dropped by the color
  // sanity gate, both candidate and existing entry can have null hex).
  const { data: pool, error: poolErr } = await supabase
    .from("garments")
    .select("id, category, subcategory, color, fabric, pattern, description, thumb_url, dominant_hex")
    .eq("user_id", userId)
    .in("category", candidateCategories)
    .is("dupe_of_garment_id", null);

  if (poolErr) {
    return res.status(500).json({ error: { code: "pool_select_failed", message: poolErr.message } });
  }

  // ── Step 3: two indexes per category.
  //   poolByCategory     — pre-computed Lab for hex-based matching
  //   poolByCategoryAll  — every pool row (incl. null hex) for text-fallback
  const poolByCategory = new Map();
  const poolByCategoryAll = new Map();
  for (const row of (pool || [])) {
    if (candidateIdSet.has(row.id)) continue;        // skip candidates themselves
    if (!poolByCategoryAll.has(row.category)) poolByCategoryAll.set(row.category, []);
    poolByCategoryAll.get(row.category).push(row);

    const lab = hexToLab(row.dominant_hex);
    if (!lab) continue;
    if (!poolByCategory.has(row.category)) poolByCategory.set(row.category, []);
    poolByCategory.get(row.category).push({ row, lab });
  }

  // ── Step 4: for each candidate, find the closest pool entry in the same category.
  // Two paths:
  //   (a) Hex path — Lab distance against pool entries that have a hex. Existing logic.
  //   (b) Text fallback — when the candidate has no hex (color sanity gate dropped its
  //       thumb), match against any pool entry with the same subcategory + color text.
  //       Surfaces as "borderline" so the user confirms. Without this, gated-out items
  //       would silently create duplicate closet rows.
  const matches = candidates.map((cand) => {
    const result = { candidate_id: cand.id, candidate_thumb_url: cand.thumb_url ?? null, match: null };

    // (a) Hex path.
    if (cand.dominant_hex) {
      const candLab = hexToLab(cand.dominant_hex);
      if (candLab) {
        const pool = poolByCategory.get(cand.category);
        if (pool && pool.length > 0) {
          let best = null;
          for (const entry of pool) {
            // Different pattern (solid vs plaid etc.) = not the same garment,
            // regardless of how close the colour is.
            if (patternsConflict(cand.pattern, entry.row.pattern)) continue;
            const d = labDistance(candLab, entry.lab);
            if (best === null || d < best.distance) {
              best = { distance: d, entry };
            }
          }
          if (best) {
            let confidence = null;
            if (best.distance < STRONG_DELTA) confidence = "strong";
            else if (best.distance < BORDERLINE_DELTA) confidence = "borderline";

            if (confidence) {
              result.match = {
                id: best.entry.row.id,
                name: buildLabel(best.entry.row),
                thumb_url: best.entry.row.thumb_url,
                category: best.entry.row.category,
                hex: best.entry.row.dominant_hex,
                distance: Math.round(best.distance * 10) / 10,
                confidence,
              };
              return result;
            }
          }
        }
      }
      // Hex existed but no Lab match within threshold — trust the color signal,
      // don't fall through to text matching (would over-match distinct garments).
      return result;
    }

    // (b) Text fallback — candidate has no hex.
    const candSub = (cand.subcategory || "").trim().toLowerCase();
    const candColor = (cand.color || "").trim().toLowerCase();
    if (!candSub || !candColor) return result;

    const fullPool = poolByCategoryAll.get(cand.category);
    if (!fullPool || fullPool.length === 0) return result;

    const textMatch = fullPool.find((row) => {
      const rSub = (row.subcategory || "").trim().toLowerCase();
      const rColor = (row.color || "").trim().toLowerCase();
      if (patternsConflict(cand.pattern, row.pattern)) return false;
      return rSub === candSub && rColor === candColor;
    });
    if (!textMatch) return result;

    result.match = {
      id: textMatch.id,
      name: buildLabel(textMatch),
      thumb_url: textMatch.thumb_url,
      category: textMatch.category,
      hex: textMatch.dominant_hex,
      distance: null,                  // text match — no Lab distance
      confidence: "borderline",        // always surface for user confirmation
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
