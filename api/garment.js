import { getServiceClient } from "../lib/supabase.js";
import { resolveUser } from "../lib/auth.js";
import { hexToLab, labDistance } from "../lib/color-distance.js";
import Anthropic from "@anthropic-ai/sdk";

// =========================================================
// POST /api/garment?action=<name>
// Auth: Authorization: Bearer <supabase_access_token>
//
// One router that replaces six separate garment-mutation endpoints so the
// deployment stays under the Vercel Hobby 12-serverless-function cap. Each
// action below is the exact logic of its former standalone endpoint; only the
// method check, env load, and auth resolve are hoisted up here (shared by all).
//
// Actions (body shape unchanged from the old endpoints):
//   delete-garment  { garment_id }
//   update-garment  { garment_id, updates }
//   confirm-dupe    { candidate_id, dupe_of_id, confidence }
//   find-dupes      { candidate_ids: [...] }
//   link-suit       { garment_ids: [...], unlink? }
//   pair-garment    { garment_id }
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   ANTHROPIC_API_KEY   (pair-garment only)
// =========================================================

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: { code: "method_not_allowed", message: "POST only" } });
  }

  const action = (req.query?.action || req.body?.action || "").toString();

  const { supabase, envErr } = getServiceClient();
  if (envErr) return res.status(500).json({ error: envErr });

  const { userId, err } = await resolveUser(req, supabase);
  if (err) return res.status(401).json({ error: err });

  switch (action) {
    case "delete-garment": return deleteGarment(req, res, supabase, userId);
    case "update-garment": return updateGarment(req, res, supabase, userId);
    case "confirm-dupe":   return confirmDupe(req, res, supabase, userId);
    case "find-dupes":     return findDupes(req, res, supabase, userId);
    case "link-suit":      return linkSuit(req, res, supabase, userId);
    case "pair-garment":   return pairGarment(req, res, supabase, userId);
    default:
      return res.status(400).json({ error: { code: "unknown_action", message: `unknown action: ${action}` } });
  }
}

// =========================================================
// action: delete-garment   (was POST /api/delete-garment)
// =========================================================
async function deleteGarment(req, res, supabase, userId) {
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
    return res.status(500).json({ error: { code: "delete_failed", message: deleteErr.message } });
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

// =========================================================
// action: update-garment   (was POST /api/update-garment)
// =========================================================
// Builds a 2-3 word display label from current attrs, e.g. "beige cotton shirt".
// Skips fabric when null/empty/"other" so we don't get awkward "blue other shirt".
function buildLabelUpdate(color, fabric, category) {
  const parts = [];
  if (color    && String(color).trim())    parts.push(String(color).trim().toLowerCase());
  const fab = fabric && String(fabric).trim().toLowerCase();
  if (fab && fab !== "other") parts.push(fab);
  if (category && String(category).trim()) parts.push(String(category).trim().toLowerCase());
  return parts.join(" ");
}

async function updateGarment(req, res, supabase, userId) {
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
  // resulting attrs.
  const attrChanged = patch.color !== undefined || patch.fabric !== undefined || patch.category !== undefined;
  if (!userTypedName && attrChanged) {
    const nextColor    = patch.color    ?? existing.color;
    const nextFabric   = patch.fabric   ?? existing.fabric;
    const nextCategory = patch.category ?? existing.category;
    const label = buildLabelUpdate(nextColor, nextFabric, nextCategory);
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
    return res.status(500).json({ error: { code: "update_failed", message: updateErr.message } });
  }

  // ── Log corrections ───────────────────────────────────────────────────────
  // Capture what the vision model got wrong (old value) vs what the user fixed
  // it to (new value), one row per changed field. Non-fatal: swallow errors.
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

// =========================================================
// action: confirm-dupe   (was POST /api/confirm-dupe)
// =========================================================
const VALID_CONFIDENCE = new Set(["strong", "borderline"]);

async function confirmDupe(req, res, supabase, userId) {
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

  // ── Thumbnail upgrade (non-fatal): promote candidate thumb onto original
  // only when the original has none. Never clobbers an existing thumb.
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

// =========================================================
// action: find-dupes   (was POST /api/find-dupes)
// =========================================================
const STRONG_DELTA = 10;
const BORDERLINE_DELTA = 20;
const MAX_CANDIDATES_DUPE = 50;

// Two garments with clearly different patterns are not the same piece, even if
// their dominant colour matches. Only block when BOTH patterns are known.
function patternsConflict(a, b) {
  const na = (a || "").trim().toLowerCase();
  const nb = (b || "").trim().toLowerCase();
  if (!na || !nb || na === "other" || nb === "other") return false;
  return na !== nb;
}

// Build a short, user-friendly name for the matched garment.
function buildLabelDupe(row) {
  const cat = String(row.subcategory || row.category || "").trim().toLowerCase();
  const color = row.color ? String(row.color).trim().toLowerCase() : "";
  const fab = row.fabric ? String(row.fabric).trim().toLowerCase() : "";
  const parts = [];
  if (color && !cat.includes(color)) parts.push(color);
  if (fab && fab !== "other" && !cat.includes(fab)) parts.push(fab);
  if (cat) parts.push(cat);
  return parts.join(" ") || row.description || "this piece";
}

async function findDupes(req, res, supabase, userId) {
  const { candidate_ids } = req.body || {};
  if (!Array.isArray(candidate_ids) || candidate_ids.length === 0) {
    return res.status(400).json({ error: { code: "missing_candidates", message: "candidate_ids must be a non-empty array" } });
  }
  if (candidate_ids.length > MAX_CANDIDATES_DUPE) {
    return res.status(400).json({ error: { code: "too_many_candidates", message: `max ${MAX_CANDIDATES_DUPE} per call` } });
  }

  // ── Step 1: load the candidate rows. Must belong to the caller; must have a hex.
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

  // ── Step 2: load the rest of the user's closet (same categories as candidates).
  const candidateCategories = [...new Set(candidates.map(c => c.category).filter(Boolean))];
  if (candidateCategories.length === 0) {
    return res.status(200).json({ matches: candidate_ids.map(id => ({ candidate_id: id, match: null })) });
  }

  const candidateIdSet = new Set(candidates.map(c => c.id));

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
  const matches = candidates.map((cand) => {
    const result = { candidate_id: cand.id, candidate_thumb_url: cand.thumb_url ?? null, match: null };

    // (a) Hex path.
    if (cand.dominant_hex) {
      const candLab = hexToLab(cand.dominant_hex);
      if (candLab) {
        const poolC = poolByCategory.get(cand.category);
        if (poolC && poolC.length > 0) {
          let best = null;
          for (const entry of poolC) {
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
                name: buildLabelDupe(best.entry.row),
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
      // Hex existed but no Lab match within threshold — trust the color signal.
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
      name: buildLabelDupe(textMatch),
      thumb_url: textMatch.thumb_url,
      category: textMatch.category,
      hex: textMatch.dominant_hex,
      distance: null,                  // text match — no Lab distance
      confidence: "borderline",        // always surface for user confirmation
    };
    return result;
  });

  // ── Also include candidates that weren't found as null matches.
  const foundIds = new Set(candidates.map(c => c.id));
  for (const id of candidate_ids) {
    if (!foundIds.has(id)) matches.push({ candidate_id: id, match: null });
  }

  return res.status(200).json({ matches });
}

// =========================================================
// action: link-suit   (was POST /api/link-suit)
// =========================================================
const MIN_PIECES = 2;
const MAX_PIECES = 6;

async function linkSuit(req, res, supabase, userId) {
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

  // ── Link: assign one shared suit_set_id to all pieces (last-write-wins).
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

// =========================================================
// action: pair-garment   (was POST /api/pair-garment)
// =========================================================
const PAIR_MODEL = "claude-haiku-4-5-20251001";
const PAIR_MAX_TOKENS = 256;
const MAX_CANDIDATES_PAIR = 40;

const GARMENT_COLUMNS = "id, category, subcategory, color, description, thumb_url, created_at";

const CAT_GROUPS = {
  shirt: "top", tshirt: "top", polo: "top", sweater: "top",
  pants: "bottom", jeans: "bottom", chinos: "bottom", shorts: "bottom",
  blazer: "layer", jacket: "layer", coat: "layer",
  shoes: "shoe", sneakers: "shoe", boots: "shoe",
  accessory: "accessory"
};

function catGroup(category) {
  return CAT_GROUPS[(category || "").toLowerCase().trim()] || "other";
}

const PAIR_SYSTEM = `You are a wardrobe stylist. Given a target garment, build a complementary outfit by picking 2-3 garments from DIFFERENT category groups than the target. Ground picks in colour harmony, formality match, and occasion versatility for a Lebanese man.

Category groups:
- top: shirt, tshirt, polo, sweater
- bottom: pants, jeans, chinos, shorts
- layer: blazer, jacket, coat
- shoe: shoes, sneakers, boots
- accessory: accessory

Cross-category pairing rules (STRICT — never return the same group as the target):
- target is a top    → pick from bottom + shoe (optionally add layer or accessory)
- target is a bottom → pick from top + shoe (optionally add layer)
- target is a layer  → pick from top + bottom + shoe
- target is shoes    → pick from top + bottom
- target is accessory → pick from top + bottom or shoe

Return strict JSON only — no prose, no markdown fences:
{ "pairs": [{ "garment_id": "...", "reason": "one sentence under 8 words" }] }

Additional rules:
- garment_id MUST be an id from the closet list. Do not invent ids.
- reason: what it adds to the outfit, 8 words max.
- Return 2-3 pairs. If fewer candidates exist, return fewer.`;

function compact(g) {
  const out = { id: g.id };
  if (g.category) out.category = g.category;
  if (g.subcategory) out.subcategory = g.subcategory;
  if (g.color) out.color = g.color;
  if (g.description) out.description = g.description;
  return out;
}

async function pairGarment(req, res, supabase, userId) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: { code: "missing_env", message: "ANTHROPIC_API_KEY must be set in Vercel env vars." }
    });
  }

  const { garment_id } = req.body || {};
  if (!garment_id) {
    return res.status(400).json({ error: { code: "missing_garment_id", message: "garment_id is required" } });
  }

  const { data: garments, error: garmentsErr } = await supabase
    .from("garments")
    .select(GARMENT_COLUMNS)
    .eq("user_id", userId)
    .is("dupe_of_garment_id", null)        // dupes are invisible to the pairing engine
    .order("created_at", { ascending: false })
    .limit(MAX_CANDIDATES_PAIR);

  if (garmentsErr) {
    return res.status(500).json({
      error: { code: "select_failed", message: garmentsErr.message, details: garmentsErr.details ?? null }
    });
  }

  const target = (garments || []).find(g => String(g.id) === String(garment_id));
  if (!target) {
    return res.status(404).json({
      error: { code: "not_found", message: "Garment not found or not owned by this user" }
    });
  }

  const candidates = (garments || []).filter(g => String(g.id) !== String(garment_id));
  if (candidates.length === 0) {
    return res.status(200).json({ pairs: [] });
  }

  const userMessage = [
    "Target garment: " + JSON.stringify(compact(target)),
    "",
    "Closet (excluding target): " + JSON.stringify(candidates.map(compact))
  ].join("\n");

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let parsed;
  try {
    const response = await anthropic.messages.create({
      model: PAIR_MODEL,
      max_tokens: PAIR_MAX_TOKENS,
      system: PAIR_SYSTEM,
      messages: [{ role: "user", content: userMessage }]
    });
    const text = response.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (err) {
    console.error("pair-garment model call failed:", err);
    return res.status(502).json({
      error: { code: "pair_failed", message: err.message || String(err) }
    });
  }

  // Hallucination guard + same-category filter.
  const candidateIds = new Set(candidates.map(g => String(g.id)));
  const candidateById = new Map(candidates.map(g => [String(g.id), g]));
  const targetGroup = catGroup(target.category);
  const rawPairs = Array.isArray(parsed?.pairs) ? parsed.pairs : [];
  const pairs = [];
  for (const p of rawPairs) {
    if (!p || typeof p !== "object") continue;
    const gid = p.garment_id != null ? String(p.garment_id) : null;
    if (!gid || !candidateIds.has(gid)) continue;
    if (catGroup(candidateById.get(gid)?.category) === targetGroup) continue;
    const reason = typeof p.reason === "string" ? p.reason.trim() : "";
    const pairedG = candidateById.get(gid);
    pairs.push({ garment_id: gid, reason, category: pairedG?.category || "", subcategory: pairedG?.subcategory || "" });
    if (pairs.length >= 3) break;
  }

  return res.status(200).json({ pairs });
}
