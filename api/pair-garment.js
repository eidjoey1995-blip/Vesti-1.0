import { getServiceClient } from "../lib/supabase.js";
import { resolveUser } from "../lib/auth.js";
import Anthropic from "@anthropic-ai/sdk";

// =========================================================
// POST /api/pair-garment
// Auth: Authorization: Bearer <supabase_access_token>
// Body: { garment_id }
//
// Returns 2–3 garments from the user's closet that pair well
// with the target garment, each with a short one-line reason.
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   ANTHROPIC_API_KEY
// =========================================================

// Haiku: fast + cheap for a call that fires on every item-detail open.
const PAIR_MODEL = "claude-haiku-4-5-20251001";
const PAIR_MAX_TOKENS = 256;
const MAX_CANDIDATES = 40;

const GARMENT_COLUMNS = "id, category, subcategory, color, description, thumb_url, created_at";

// Category groups used to enforce cross-category pairing in the prompt and post-filter.
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: { code: "method_not_allowed", message: "POST only" } });
  }

  const { supabase, envErr } = getServiceClient();
  if (envErr) return res.status(500).json({ error: envErr });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: { code: "missing_env", message: "ANTHROPIC_API_KEY must be set in Vercel env vars." }
    });
  }


  const { userId, err: authErr } = await resolveUser(req, supabase);
  if (authErr) return res.status(401).json({ error: authErr });

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
    .limit(MAX_CANDIDATES);

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
    // Drop same-category-group suggestions regardless of what the LLM returned.
    if (catGroup(candidateById.get(gid)?.category) === targetGroup) continue;
    const reason = typeof p.reason === "string" ? p.reason.trim() : "";
    const pairedG = candidateById.get(gid);
    pairs.push({ garment_id: gid, reason, category: pairedG?.category || "", subcategory: pairedG?.subcategory || "" });
    if (pairs.length >= 3) break;
  }

  return res.status(200).json({ pairs });
}
