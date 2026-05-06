import { createClient } from "@supabase/supabase-js";
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

const PAIR_SYSTEM = `You are a wardrobe stylist. Given a target garment and a closet, pick 2-3 garments that pair well with the target. Ground picks in colour harmony, formality match, and occasion versatility for a Lebanese man.

Return strict JSON only — no prose, no markdown fences:
{ "pairs": [{ "garment_id": "...", "reason": "one sentence under 8 words" }] }

Rules:
- garment_id MUST be an id from the closet list. Do not invent ids.
- reason: what it adds to the pairing, 8 words max.
- Return 2-3 pairs. If fewer than 2 candidates exist, return fewer.`;

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

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    return res.status(500).json({
      error: { code: "missing_env", message: "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in Vercel env vars." }
    });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: { code: "missing_env", message: "ANTHROPIC_API_KEY must be set in Vercel env vars." }
    });
  }

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

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

  // Hallucination guard: only pass back ids that exist in the candidate set.
  const candidateIds = new Set(candidates.map(g => String(g.id)));
  const rawPairs = Array.isArray(parsed?.pairs) ? parsed.pairs : [];
  const pairs = [];
  for (const p of rawPairs) {
    if (!p || typeof p !== "object") continue;
    const gid = p.garment_id != null ? String(p.garment_id) : null;
    if (!gid || !candidateIds.has(gid)) continue;
    const reason = typeof p.reason === "string" ? p.reason.trim() : "";
    pairs.push({ garment_id: gid, reason });
    if (pairs.length >= 3) break;
  }

  return res.status(200).json({ pairs });
}
