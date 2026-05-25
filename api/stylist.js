import { createClient } from "@supabase/supabase-js";
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
  "created_at"
].join(", ");

// =========================================================
// Codex grounding — Methodology §5.0 city overlays + §5 occasion entries.
// Source of truth: /Vesti_Methodology_v0.1.md. Embedded verbatim here so
// the serverless function is self-contained (no runtime file reads).
// When the methodology updates, re-sync these constants by hand.
// =========================================================

const CITY_OVERLAYS = {
  Beirut: `Beirut (codex baseline):
- Climate: Mediterranean. Hot/humid summer (Jun–Sep), mild wet winter (Dec–Feb). Coastal humidity matters; mountain venues drop 8–12°C from city.
- Light: Levantine sun is brighter and warmer than Northern European reference photos — apply "one shade darker" correction.
- Dress register: warm/social rather than buttoned-up. Open-collar shirt with soft jacket is acceptable across most "smart" occasions.
- Black-shoe defaults read normally; brown shoes the wedding-guest signal.`,

  Dubai: `Dubai overlay (apply ON TOP of Beirut baseline):
- Climate: desert. Outdoor anything May–Oct is heat-prohibitive — assume air-conditioned interiors as the default venue type. AC-first weight rule: around 250 g/m² year-round indoors, drop under 250 only for genuine outdoor day events. This OVERRIDES the "summer = lighter" rule.
- Light: harsh, high-UV. Stay one shade darker than Beirut defaults; off-white and stone palettes lift better than pure white in daytime photos.
- Dress register: more formal than Beirut for equivalent occasions. Business meetings default to suit + tie even where Beirut would accept a soft jacket.
- Local rules: respect modesty conventions in mixed/family settings. Linen is fine but linen jackets to client meetings are not.
- Brand availability: Joseph Eid bespoke ships to UAE; Beirut-only retail references should be substituted with Dubai equivalents.`,

  "New York": `New York overlay (apply ON TOP of Beirut baseline):
- Climate: four-season. Wide swing — humid summer (Jun–Aug, Beirut-comparable), genuine cold winter (Dec–Feb, Beirut never gets there). Outerwear becomes load-bearing Nov–Mar. Layering (overshirt over shirt, knit under blazer) is the default move where Beirut would skip the extra layer.
- Light: cooler, more diffuse than Levantine sun. The "one shade darker" correction does NOT apply — colors render closer to catalog. Mid grey reads as mid grey, not washed-out.
- Dress register: industry-dependent. Finance/legal/consulting still default to suit + tie; tech/creative is jacket-optional even at senior levels. The codex's "soft jacket + open collar" Beirut default lands well in NY creative contexts but reads under-dressed in NY finance.
- Cultural occasions: Lebanese diaspora occasions follow Beirut entries below. Mainstream American occasions (Thanksgiving, summer Hamptons wedding, business-casual Friday) are NOT in the codex yet — flag this gap to the user rather than improvise.
- Brand availability: Joseph Eid does not have NY presence; rely on remote-fit Beirut bespoke or substitute with US-equivalent menswear (Drakes, Hertling, Alden).`
};

// Priority rule from §5.0 "How to apply":
// Climate (fabric weight, layering) wins; everything else (color, register)
// defers to the §5 entry. Reflected in the prompt below.

const CODEX_OCCASIONS = `OCCASION ENTRIES (Beirut-baseline defaults):

Lebanese summer mountain wedding (Faraya, Broummana, Ehden — Jun–Sep, outdoor evening):
Light-to-mid grey suit, fresco/open-weave wool under 250 g/m². White or pale blue shirt. Pastel or muted tie. Brown or burgundy oxfords/derbies, matched belt. No three-piece. Single pleat trouser, no break or quarter break.

Beirut indoor wedding (hotel ballroom, AC, year-round, evening):
Navy suit, mid-weight wool ~250 g/m². White shirt. Burgundy/deep green/navy-and-silver tie. Black oxfords, matched black belt. Three-piece acceptable here only in summer (aggressive AC). White pocket square folded flat.

Khaleeji wedding (Saudi/Emirati/Qatari host, Lebanese guest):
Path A: charcoal or midnight navy three-piece, mid-to-heavy wool, white shirt, dark tie, black oxfords. Path B (only if Gulf-regular and own a thobe and host welcomes traditional dress): white summer-weight thobe, plain ghutra, no agal unless local custom calls for it. Better a sharp Western suit than a poorly fitted thobe.

Majlis (Gulf evening reception — Lebanese guest):
Thobe if Gulf-regular and own one. Otherwise: charcoal or dark grey suit, white shirt, no tie, black or dark brown loafers. Avoid notch lapels with a tieless shirt.

Dubai/Riyadh business summer:
Mid grey or navy suit in tropical wool or fresco, under 250 g/m². White or pale blue shirt. Tie required for first meetings, optional for follow-ups depending on industry. Black oxfords. No three-piece. NO linen jackets to client meetings.

Funeral (not family of the deceased):
Dark charcoal grey or midnight navy suit, white shirt, plain black tie, black oxfords, black belt. White pocket square optional.
Funeral (family of the deceased or pallbearer): Full black suit, white shirt, black tie, black shoes. Only context where all-black is correct.

Casual Friday (Mar Mikhael, Hamra, Gemmayze):
Dark wash jeans or chinos in stone/olive, plain white or pale tee/polo, optional unstructured navy or olive blazer, white minimalist sneakers (Common Projects Achilles, Axel Arigato Clean 90, Zegna Triple Stitch) or brown loafers. No suit, no tie. White sneakers means MINIMALIST leather sneakers, never athletic silhouettes.

Iftar (Ramadan evening meal):
Lebanon (host's home or Beirut restaurant): dark navy or charcoal soft jacket, white or pale shirt open at collar, dark trousers, brown loafers. No tie. Warm/social register.
UAE/Saudi (host's home, hotel iftar tent, business iftar): full suit (charcoal or midnight navy, mid-weight wool), white shirt, restrained tie (navy/burgundy/deep green), black oxfords. Err on more formal.

Business travel (multi-day, mixed climate):
Default kit: one navy suit (mid weight, 250 g/m²), one mid grey trouser, two white shirts, one pale blue shirt, one navy tie, one burgundy tie, one pair black oxfords, one pair brown loafers, belts to match. Add a single sport coat if the trip includes a casual evening.

Birthday dinner (adult, restaurant):
Dark trouser, soft jacket (navy/charcoal/olive), open-collar shirt, no tie, loafers or derbies. Upscale venue (Em Sherif, Liza, Indigo on the Roof) → add tie + switch to oxfords.

Engagement party (Lebanese — Christian or Muslim, evening):
Navy suit (~250 g/m²), white or pale blue shirt, restrained tie (burgundy/dark green/navy with subtle pattern), black or dark brown oxfords. NO three-piece — engagement is one register below the wedding itself. White pocket square folded flat.
Variation summer outdoor mountain estate: mid grey replaces navy, tan or burgundy loafers replace black oxfords.

Baptism — as godfather (parrain):
Charcoal grey two-piece suit (mid-to-heavy wool), white shirt, restrained tie (silver-grey/pale blue/burgundy), black oxfords. White pocket square. Three-piece optional upgrade.
Baptism — as guest: navy or mid grey two-piece, white or pale blue shirt, restrained tie, brown or black oxfords.

University graduation — graduate: navy suit, white shirt, navy or burgundy tie, black oxfords.
University graduation — parent of graduate: charcoal suit, white shirt, dark tie. Slightly more formal than the graduate. Pocket square appropriate.

Condolences (azza / حضور العزاء):
Dark grey or charcoal trouser, dark grey or navy soft jacket (unstructured or lightly structured), white shirt, no tie, black or dark brown oxfords. NO pocket square. NO watch beyond a plain leather strap. Distinct from the funeral itself — full suit-and-tie reads as still-funeral; jeans-and-shirt reads as not taking the visit seriously.

Name day (يوم العيد — Christian saint's day):
Navy or charcoal soft jacket, white or pale shirt, no tie unless host's family is older/formal, dark trousers, brown loafers. Smart-casual register.

Summer beach club lunch (Edde Sands, La Plage, Lazy B, Sporting):
Linen or cotton trouser in white/stone/navy; linen short-sleeve shirt or fine-knit polo in white/pale blue/sage; minimalist white leather sneakers; tortoise sunglasses. Optional unstructured linen jacket in stone or navy if dinner extends. Sneakers are the natural choice for adult men of any age in this context.

Christmas dinner at family home:
Dark trouser (chinos in stone/navy/charcoal), button-down shirt (white/pale blue/subtle pattern) or fine-knit polo, optional unstructured blazer (navy/charcoal) if host's family older/traditional. Loafers or clean leather sneakers. No tie required.
Variation older/traditional families (grandparents hosting): lift to navy soft jacket + tie.

Easter Mass and family lunch (Catholic or Orthodox):
Chinos or dark trousers, button-down shirt or fine knit polo, optional blazer for the Mass itself. Brown or dark dress shoes (loafers acceptable). Mass register one notch above Christmas dinner due to religious context. Lent-color rule (no bright colors during 40 days before Easter) is no longer widely observed — do NOT enforce by default.

Hospital visit:
Dark trouser (charcoal/grey/navy), soft button-down shirt (white or pale), no tie, navy or grey blazer if visit is to an older relative or someone in private rooms. Brown loafers or dark dress shoes.

Casual errands:
Plain or lightly graphic tee (formality 1-2) in white, grey, or charcoal; dark-wash jeans or stone/olive chinos; minimalist white leather sneakers. No jacket, no collar required. The most relaxed occasion in the codex — a clean tee is the correct default here, not a fallback.

Weekend brunch:
A notch above errands: fine-knit polo or short-sleeve linen shirt over chinos in stone/olive, or a crisp plain tee under an unstructured overshirt. Minimalist sneakers or brown loafers. Relaxed but considered — appropriate for being seen socially. No tie, jacket optional.`;

// Build the system prompt for a given city. Beirut overlay is the baseline;
// Dubai/NY layer on top. Token-efficient: only the relevant city overlay
// is sent, not all three.
function buildSystemPrompt(city, weatherLine) {
  const overlay = CITY_OVERLAYS[city] || CITY_OVERLAYS.Beirut;
  return `You are the AI stylist for Vesti, a men's wardrobe app for Lebanese men (and the Lebanese diaspora). You pick outfits from the user's existing closet for a given occasion, grounded in the Vesti methodology reference below.

CITY CONTEXT (${city || "Beirut — default"}):
${overlay}

${weatherLine ? weatherLine + "\n\n" : ""}${CODEX_OCCASIONS}

PRIORITY RULES:
1. If the city is Beirut, use the matching entry as written.
2. If Dubai, apply the Dubai overlay on top — climate weight rule is the highest-priority override (AC-first 250 g/m² indoors).
3. If New York, apply the NY overlay; for occasions outside the Lebanese-cultural set, surface "we don't have a calibrated default for this in your city yet" in reasoning.
4. When in doubt between Beirut default and city overlay: climate (fabric weight, layering) wins; everything else (color, register) defers to the Beirut entry.
5. If the user's stated occasion isn't covered above, reason from the closest entry + city overlay. Name the gap in reasoning.

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
- REJECTED PIECES: If a list of rejected garment ids is provided, the user disliked those pieces in a previous attempt. Never include a rejected id in your items, even if it would otherwise be a strong pick.`;
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
      error: {
        code: "missing_env",
        message: "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in Vercel env vars."
      }
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
