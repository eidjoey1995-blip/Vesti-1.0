import { getServiceClient } from "../lib/supabase.js";
import { resolveUser } from "../lib/auth.js";
import { CITY_OVERLAYS, CODEX_OCCASIONS } from "../lib/codex.js";
import Anthropic from "@anthropic-ai/sdk";

// =========================================================
// POST /api/stylist
// V1 BETA stylist — picks an outfit from the user's existing closet
// for a given occasion, grounded in the Vesti methodology codex.
// Powers the stylist-result screen.
//
// Increment plan (see memory/project_stylist_increments.md):
//   1. Skeleton — auth, profile read, garment read, hardcoded outfit. ✅
//   2. Real Claude pick (minimal prompt). ✅
//   3. Inject codex methodology §5 + §5.0 city overlays. ✅
//   4. Persist outfit to `outfits` table, return outfit_id. ✅
//   5. Wire stylist + stylist-result screens in app.html (#55).  ← next session
//
// Auth: Authorization: Bearer <supabase_access_token>
// user_id is resolved from the JWT — not accepted in the body.
//
// Request: POST {
//   occasion: string,
//   avoid_garment_ids?: (number|string)[],   // recently worn — soft rotation hint
//   keep_garment_ids?: (number|string)[],    // pieces the user locked — MUST appear in result
//   rejected_garment_ids?: (number|string)[] // pieces the user disliked — MUST NOT appear
// }
// keep/rejected power per-garment "try again with the rest" regeneration.
// Response 200: {
//   outfit_id,            // uuid of persisted row in `outfits` (null if persistence failed)
//   outfit: { items: [{garment_id, role}], reasoning },
//   occasion,
//   city
// }
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   ANTHROPIC_API_KEY  ← already used by /api/segment-garments
// =========================================================

// Cap on garments sent to the model. Prevents prompt blowup for testers
// with large closets; ordered newest-first so recent additions are favored.
const MAX_GARMENTS = 80;

const STYLIST_MODEL = "claude-sonnet-4-6";
const STYLIST_MAX_TOKENS = 1024;

const GARMENT_COLUMNS = [
  "id",
  "category",
  "subcategory",
  "color",
  "pattern",
  "formality_score",
  "description",
  "fabric",
  "brand",
  "thumb_url",
  "suit_set_id",
  "created_at"
].join(", ");


// Build the system prompt for a given city. Beirut overlay is the baseline;
// Dubai/Riyadh/NY layer on top. Token-efficient: only the relevant city
// overlay is sent, not all four.
function buildSystemPrompt(city, weatherLine) {
  const overlay = CITY_OVERLAYS[city] || CITY_OVERLAYS.Beirut;
  return `You are the AI stylist for Vesti, a men's wardrobe app for Lebanese men (and the Lebanese diaspora). You pick outfits from the user's existing closet for a given occasion, grounded in the Vesti methodology reference below.

CITY CONTEXT (${city || "Beirut — default"}):
${overlay}

${weatherLine ? weatherLine + "\n\n" : ""}${CODEX_OCCASIONS}

PRIORITY RULES:
1. If the city is Beirut, use the matching entry as written.
2. If Dubai, apply the Dubai overlay on top — climate weight rule is the highest-priority override (AC-first 250 g/m² indoors).
3. If Riyadh, apply the Riyadh overlay on top — AC-first weight rule (250–280 g/m²) plus a stricter formality/modesty register than Dubai. Lebanese guests default to Western suit; thobe optional only if Gulf-regular.
4. If New York, apply the NY overlay; for occasions outside the Lebanese-cultural set, surface "we don't have a calibrated default for this in your city yet" in reasoning.
5. When in doubt between Beirut default and city overlay: climate (fabric weight, layering) wins; everything else (color, register) defers to the Beirut entry.
6. If the user's stated occasion isn't covered above, reason from the closest entry + city overlay. Name the gap in reasoning.

USER-FACING TONE FOR the reasoning field:
- Speak directly to the user as their stylist. Plain language. No jargon.
- Do NOT use the words "codex," "methodology," "entry," "overlay," "section," or "§". Do not cite internal references.
- 2-3 sentences max. Mention the occasion and why these pieces work for it.

OUTPUT FORMAT (strict JSON only — no prose, no markdown fences):
{
  "items": [
    { "garment_id": "<id from closet>", "role": "top|bottom|layer|shoe|accessory" }
  ],
  "reasoning": "2-3 sentence stylist note in plain language."
}

OUTPUT RULES:
- garment_id MUST be one of the ids in the closet provided. Do not invent ids.
- Aim for one top, one bottom, one shoe, and optionally one layer + one accessory (3-5 items total).
- Prefer pieces whose formality_score and fabric weight fit the occasion + city.
- If the closet lacks something essential (e.g. no shoes), pick the closest substitute and name the gap explicitly in reasoning.
- ROTATION: If a list of recently-worn garment ids is provided, prefer different garments so the user sees variety day to day. Only repeat a recently-worn piece when the closet has no suitable alternative for the occasion — appropriateness always beats novelty, but when good alternatives exist, rotate.
- LOCKED PIECES: If a list of locked garment ids is provided, the user has explicitly kept those pieces from a previous outfit. You MUST include every locked id in your items exactly as given. Build the rest of the outfit around them — fill only the remaining roles with fresh picks that work with the locked pieces. Never drop or substitute a locked piece.
- REJECTED PIECES: If a list of rejected garment ids is provided, the user disliked those pieces in a previous attempt. Never include a rejected id in your items, even if it would otherwise be a strong pick.
- SUIT SETS: Some garments carry a "suit" tag (e.g. "S1"). Every piece sharing the same suit tag is one matched suit and must be worn together. If you include ANY piece with a suit tag, include EVERY piece that shares that tag, and never pair a suit piece with a non-matching piece in the same role (e.g. never put a suit jacket with non-suit trousers). If a suit does not fit the occasion, use none of its pieces.`;
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

async function fetchWeather(city) {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey || !city) return null;
  try {
    const r = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&units=metric&appid=${apiKey}`
    );
    if (!r.ok) return null;
    const j = await r.json();
    const temp = j?.main?.temp != null ? Math.round(j.main.temp) : null;
    const conditions = (j?.weather?.[0]?.description || j?.weather?.[0]?.main || "").toLowerCase();
    if (temp === null || !conditions) return null;
    return { temp, conditions, humidity: j?.main?.humidity ?? null };
  } catch {
    return null;
  }
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

  const { occasion, avoid_garment_ids, keep_garment_ids, rejected_garment_ids } = req.body || {};
  if (!occasion || typeof occasion !== "string" || occasion.trim().length === 0) {
    return res.status(400).json({ error: { code: "missing_occasion", message: "occasion is required" } });
  }

  // Normalize avoid list — soft preference only; model still sees full closet.
  const avoidIds = Array.isArray(avoid_garment_ids)
    ? avoid_garment_ids.map((id) => String(id)).filter(Boolean)
    : [];

  // keep_garment_ids: pieces the user explicitly kept from a previous outfit —
  // the model MUST include these. rejected_garment_ids: pieces the user flagged
  // as wrong on a thumbs-down — the model must NOT include these. Both power
  // the per-garment "try again with the rest" regeneration flow.
  const keepIds = Array.isArray(keep_garment_ids)
    ? [...new Set(keep_garment_ids.map((id) => String(id)).filter(Boolean))]
    : [];
  const rejectedIds = Array.isArray(rejected_garment_ids)
    ? [...new Set(rejected_garment_ids.map((id) => String(id)).filter(Boolean))]
    : [];

  // Profile read — city is the codex overlay key. Non-fatal if missing.
  let city = null;
  try {
    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("city")
      .eq("id", userId)
      .maybeSingle();
    if (profileErr) {
      console.warn("profile read warning:", profileErr.message);
    } else if (profile && typeof profile.city === "string") {
      city = profile.city;
    }
  } catch (err) {
    console.warn("profile read warning:", err?.message || err);
  }

  // Closet read + weather fetch in parallel — weather is non-fatal.
  const [{ data: garments, error: garmentsErr }, weather] = await Promise.all([
    supabase
      .from("garments")
      .select(GARMENT_COLUMNS)
      .eq("user_id", userId)
      .is("dupe_of_garment_id", null)        // never style with a confirmed-dupe garment
      .order("created_at", { ascending: false })
      .limit(MAX_GARMENTS),
    fetchWeather(city)
  ]);

  if (garmentsErr) {
    return res.status(500).json({
      error: { code: "select_failed", message: garmentsErr.message, details: garmentsErr.details ?? null }
    });
  }

  if (!garments || garments.length === 0) {
    return res.status(409).json({
      error: { code: "empty_closet", message: "no garments in closet — finish onboarding first" }
    });
  }

  // Short, token-cheap suit labels (e.g. "S1") for the prompt. Only real suits
  // count — a suit_set_id with a single surviving piece (its partner was deleted
  // or is a dupe) is not a suit and gets no tag.
  const suitCounts = new Map();
  for (const g of garments) {
    if (g.suit_set_id) suitCounts.set(g.suit_set_id, (suitCounts.get(g.suit_set_id) || 0) + 1);
  }
  const suitCode = new Map();
  let _suitN = 0;
  for (const g of garments) {
    const sid = g.suit_set_id;
    if (sid && suitCounts.get(sid) >= 2 && !suitCode.has(sid)) suitCode.set(sid, "S" + (++_suitN));
  }

  // Build compact garment payload for the model — strip nulls, keep only
  // the fields a stylist actually needs to make a pick. Cuts prompt size.
  const compactGarments = garments.map((g) => {
    const out = { id: g.id };
    if (g.category) out.category = g.category;
    if (g.subcategory) out.subcategory = g.subcategory;
    if (g.color) out.color = g.color;
    if (g.pattern && g.pattern !== "solid") out.pattern = g.pattern;
    if (typeof g.formality_score === "number") out.formality = g.formality_score;
    if (g.fabric) out.fabric = g.fabric;
    if (g.description) out.description = g.description;
    if (g.suit_set_id && suitCode.has(g.suit_set_id)) out.suit = suitCode.get(g.suit_set_id);
    return out;
  });

  const userMessageParts = [
    `Occasion: ${occasion.trim()}`,
    `City: ${city || "unknown"}`,
    "",
    "Closet (JSON):",
    JSON.stringify(compactGarments)
  ];
  if (avoidIds.length > 0) {
    userMessageParts.push(`\nRecently worn (last few days), rotate away from these where possible: ${JSON.stringify(avoidIds)}`);
  }
  if (keepIds.length > 0) {
    userMessageParts.push(`\nLocked pieces — the user kept these from a previous outfit. You MUST include every one of these ids in your items: ${JSON.stringify(keepIds)}`);
  }
  if (rejectedIds.length > 0) {
    userMessageParts.push(`\nRejected pieces — the user disliked these. Do NOT include any of these ids in your items: ${JSON.stringify(rejectedIds)}`);
  }
  const userMessage = userMessageParts.join("\n");

  const weatherLine = weather
    ? `Current weather in ${city}: ${weather.temp}°C, ${weather.conditions}. Favor fabrics and layers appropriate for this — lightweight cotton/linen above 28°C, layered knits 15-22°C, outerwear below 15°C, avoid suede/light colors if rain.`
    : null;

  // Call Claude with codex-grounded system prompt.
  let parsed;
  try {
    const response = await anthropic.messages.create({
      model: STYLIST_MODEL,
      max_tokens: STYLIST_MAX_TOKENS,
      system: buildSystemPrompt(city, weatherLine),
      messages: [{ role: "user", content: userMessage }]
    });
    const text = response.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (err) {
    console.error("stylist model call failed:", err);
    return res.status(502).json({
      error: { code: "stylist_failed", message: err.message || String(err) }
    });
  }

  // Validate model output: drop any garment_id not in the closet (hallucination guard).
  const closetIds = new Set(garments.map((g) => String(g.id)));
  const rejectedSet = new Set(rejectedIds);
  const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];
  const items = [];
  const seenIds = new Set();
  for (const it of rawItems) {
    if (!it || typeof it !== "object") continue;
    const gid = it.garment_id != null ? String(it.garment_id) : null;
    if (!gid || !closetIds.has(gid)) continue;
    // Hard guard: never let a rejected piece through, even if the model picked it.
    if (rejectedSet.has(gid)) continue;
    if (seenIds.has(gid)) continue;
    seenIds.add(gid);
    const role = typeof it.role === "string" ? it.role : null;
    items.push({ garment_id: gid, role });
  }

  // Locked-piece guarantee: any kept id the model dropped is re-inserted so the
  // user's explicit keep is always honored. Role is recovered from the garment
  // category where possible (top/bottom/shoe), else left null.
  if (keepIds.length > 0) {
    const garmentById = new Map(garments.map((g) => [String(g.id), g]));
    const roleFromCategory = (cat) => {
      const c = (cat || "").toLowerCase();
      if (["shoes", "sneakers", "boots"].includes(c)) return "shoe";
      if (["pants", "jeans", "chinos", "shorts"].includes(c)) return "bottom";
      if (["jacket", "blazer", "coat", "sweater"].includes(c)) return "layer";
      if (["shirt", "tshirt", "polo"].includes(c)) return "top";
      if (c === "accessory") return "accessory";
      return null;
    };
    for (const kid of keepIds) {
      if (!closetIds.has(kid) || seenIds.has(kid)) continue;
      seenIds.add(kid);
      const g = garmentById.get(kid);
      items.push({ garment_id: kid, role: roleFromCategory(g?.category) });
    }
  }
  // ── Suit-set integrity guard (deterministic — the real protection) ──────────
  // A suit is N garments sharing a suit_set_id. The prompt asks the model to keep
  // a suit together, but we don't trust that. If the outfit touches ANY piece of
  // a suit, we force the whole suit in and evict any non-suit piece occupying a
  // role the suit fills (so a suit jacket can never go out with random trousers).
  if (items.length > 0) {
    const garmentById = new Map(garments.map((g) => [String(g.id), g]));
    // Role of a garment, tolerant of phrase subcategories like "navy dress trousers".
    const suitRole = (g) => {
      const s = ((g?.category || "") + " " + (g?.subcategory || "")).toLowerCase();
      if (/trouser|pant|chino|jean|short/.test(s)) return "bottom";
      if (/blazer|jacket|coat|waistcoat|\bvest\b|suit/.test(s)) return "layer";
      if (/shoe|loafer|sneaker|boot|oxford|derby/.test(s)) return "shoe";
      if (/shirt|tee|polo/.test(s)) return "top";
      return null;
    };

    // Real suits only (>=2 pieces in the closet).
    const setMembers = new Map();
    for (const g of garments) {
      if (!g.suit_set_id) continue;
      const sid = String(g.suit_set_id);
      if (!setMembers.has(sid)) setMembers.set(sid, []);
      setMembers.get(sid).push(String(g.id));
    }
    for (const [sid, m] of setMembers) if (m.length < 2) setMembers.delete(sid);

    const memberToSet = new Map();
    for (const [sid, m] of setMembers) for (const id of m) memberToSet.set(id, sid);

    const activated = new Set();
    for (const it of items) {
      const sid = memberToSet.get(it.garment_id);
      if (sid) activated.add(sid);
    }

    const keepSet = new Set(keepIds);
    const dropMembers = (memberSet) => {
      for (let i = items.length - 1; i >= 0; i--) {
        if (memberSet.has(items[i].garment_id)) items.splice(i, 1);
      }
    };

    for (const sid of activated) {
      const members = setMembers.get(sid);
      const memberSet = new Set(members);
      const memberRoles = new Set(members.map((id) => suitRole(garmentById.get(id))).filter(Boolean));

      // A rejected suit piece means we can't show the suit intact — pull it all
      // rather than display half a suit.
      if (members.some((id) => rejectedSet.has(id))) { dropMembers(memberSet); continue; }

      // A locked non-suit piece in a colliding role outranks the suit (the user
      // just locked it this turn). Drop the suit orphan instead of the lock.
      const lockedCollision = items.some((it) =>
        !memberSet.has(it.garment_id) &&
        keepSet.has(it.garment_id) &&
        memberRoles.has(suitRole(garmentById.get(it.garment_id)))
      );
      if (lockedCollision) { dropMembers(memberSet); continue; }

      // Evict any non-suit piece occupying a role the suit fills.
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (memberSet.has(it.garment_id)) continue;
        if (memberRoles.has(suitRole(garmentById.get(it.garment_id)))) items.splice(i, 1);
      }
      // Ensure every suit piece is present.
      const present = new Set(items.map((it) => it.garment_id));
      for (const id of members) {
        if (present.has(id)) continue;
        items.push({ garment_id: id, role: suitRole(garmentById.get(id)) });
      }
    }
  }

  // Belt-and-suspenders: strip any internal jargon Claude leaked into user-facing text.
  const rawReasoning = typeof parsed?.reasoning === "string" ? parsed.reasoning : "";
  const reasoning = rawReasoning
    .replace(/\b(the\s+)?codex(\s+(entry|section|reference))?\b/gi, "this kind of occasion")
    .replace(/\bmethodology\b/gi, "guide")
    .replace(/§\s*\d+(\.\d+)?/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // === Increment 4: persist outfit so swipes (#53) can reference it later ===
  // Non-fatal: a persistence failure shouldn't block the user from seeing
  // their outfit. outfit_id stays null and the UI handles that gracefully.
  let outfitId = null;
  if (items.length > 0) {
    try {
      const insertRow = {
        user_id: userId,
        occasion: occasion.trim(),
        garment_ids: items.map((it) => it.garment_id),
        rationale: reasoning,
        context: city || null
      };
      const { data: outfitRow, error: outfitErr } = await supabase
        .from("outfits")
        .insert(insertRow)
        .select("id")
        .single();
      if (outfitErr) {
        // Schema-drift fallbacks: rationale may be named `reasoning`, or context
        // may not accept plain text. Retry progressively narrower.
        console.warn("outfit insert warning:", outfitErr.message);
        if (/rationale/i.test(outfitErr.message || "")) {
          delete insertRow.rationale;
          insertRow.reasoning = reasoning;
          const { data: r2, error: e2 } = await supabase
            .from("outfits").insert(insertRow).select("id").single();
          if (!e2 && r2) outfitId = r2.id;
          else if (e2) console.warn("outfit insert retry warning:", e2.message);
        }
      } else if (outfitRow) {
        outfitId = outfitRow.id;
      }
    } catch (err) {
      console.warn("outfit insert exception:", err?.message || err);
    }
  }

  return res.status(200).json({
    outfit_id: outfitId,
    outfit: { items, reasoning },
    occasion: occasion.trim(),
    city
  });
}
