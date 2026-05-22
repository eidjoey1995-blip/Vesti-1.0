import { createClient } from "@supabase/supabase-js";

// =========================================================
// GET /api/todays-outfit
// Auth: Authorization: Bearer <supabase_access_token>
//
// Returns (or generates) the user's daily outfit for today.
// Caches the generated outfit by writing for_date on the
// outfits row so re-fetches within the same day are instant.
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// =========================================================

const REGISTER_TO_OCCASION = {
  "casual":       "a casual everyday day out",
  "smart-casual": "an everyday smart-casual day",
  "business":     "a typical business workday",
};

// =========================================================
// TODO (Increment 3): fill in real milestone logic.
// For now returns a zero-progress stub so the response
// shape is stable for the UI wiring increment.
// =========================================================
function computeMilestone(_garmentIds) {
  return { percent: 0, full: false, groups: [], next: null };
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
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: { code: "method_not_allowed", message: "GET only" } });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({
      error: { code: "missing_env", message: "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in Vercel env vars." }
    });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { userId, err } = await resolveUser(req, supabase);
  if (err) return res.status(401).json({ error: err });

  // TODO: this uses UTC date, not the user's local day. Beirut is UTC+2 (UTC+3
  // in summer), so UTC midnight rolls over 2-3 hours before the user's midnight.
  // A future increment should accept a ?tz= query param or derive from city.
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

  // ── 1. Read profile: daily_register + city ─────────────────────────────────
  let daily_register = "smart-casual";
  let city = null;
  try {
    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("daily_register, city")
      .eq("id", userId)
      .maybeSingle();
    if (profileErr) {
      console.warn("todays-outfit: profile read warning:", profileErr.message);
    } else if (profile) {
      if (typeof profile.daily_register === "string" && profile.daily_register) {
        daily_register = profile.daily_register;
      }
      if (typeof profile.city === "string") city = profile.city;
    }
  } catch (e) {
    console.warn("todays-outfit: profile read exception:", e?.message || e);
  }

  // ── 2. Check cache: does an outfit row already exist for today? ────────────
  let outfitRow = null;
  {
    const { data, error: cacheErr } = await supabase
      .from("outfits")
      .select("id, garment_ids, rationale, reasoning, occasion, context")
      .eq("user_id", userId)
      .eq("for_date", today)
      .limit(1)
      .maybeSingle();
    if (cacheErr) {
      console.warn("todays-outfit: cache read warning:", cacheErr.message);
    } else if (data) {
      outfitRow = data;
    }
  }

  // ── 3. Generate if no cached outfit ───────────────────────────────────────
  if (!outfitRow) {
    const occasion = REGISTER_TO_OCCASION[daily_register] || REGISTER_TO_OCCASION["smart-casual"];

    // Call the internal stylist endpoint. Build the base URL from the
    // incoming request's host so this works on both Vercel and local dev.
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
    const host  = req.headers.host;
    const stylistUrl = `${proto}://${host}/api/stylist`;

    let stylistJson;
    try {
      const stylistRes = await fetch(stylistUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": req.headers.authorization || "",
        },
        body: JSON.stringify({ occasion }),
      });
      stylistJson = await stylistRes.json().catch(() => ({}));

      if (!stylistRes.ok) {
        // Empty closet is a known non-error state — surface it gracefully.
        if (stylistJson?.error?.code === "empty_closet") {
          return res.status(200).json({
            date: today,
            outfit: null,
            empty_closet: true,
            milestone: computeMilestone([]),
          });
        }
        return res.status(502).json({
          error: { code: "stylist_failed", message: stylistJson?.error?.message || ("stylist HTTP " + stylistRes.status) }
        });
      }
    } catch (e) {
      return res.status(502).json({
        error: { code: "stylist_failed", message: e?.message || String(e) }
      });
    }

    const outfitId = stylistJson?.outfit_id;
    if (outfitId) {
      const { error: stampErr } = await supabase
        .from("outfits")
        .update({ for_date: today })
        .eq("id", outfitId)
        .eq("user_id", userId);
      if (stampErr) {
        console.warn("todays-outfit: for_date stamp warning:", stampErr.message);
      }

      // Re-fetch the full row so we have garment_ids and reasoning.
      const { data: freshRow, error: freshErr } = await supabase
        .from("outfits")
        .select("id, garment_ids, rationale, reasoning, occasion, context")
        .eq("id", outfitId)
        .maybeSingle();
      if (freshErr) {
        console.warn("todays-outfit: fresh row read warning:", freshErr.message);
      }
      outfitRow = freshRow || null;
    }

    // If stylist succeeded but returned no outfit_id (e.g. persistence failed),
    // fall back to assembling what we can from the stylist response directly.
    if (!outfitRow && stylistJson?.outfit) {
      outfitRow = {
        id: null,
        garment_ids: (stylistJson.outfit.items || []).map(it => it.garment_id).filter(Boolean),
        rationale: stylistJson.outfit.reasoning || null,
        reasoning: null,
        occasion,
        context: city,
      };
    }
  }

  // ── 4. Hydrate garment rows ────────────────────────────────────────────────
  const garmentIds = Array.isArray(outfitRow?.garment_ids) ? outfitRow.garment_ids : [];
  let hydratedItems = [];
  if (garmentIds.length > 0) {
    const { data: garmentRows, error: garmentErr } = await supabase
      .from("garments")
      .select("id, category, subcategory, color, thumb_url, description")
      .in("id", garmentIds)
      .eq("user_id", userId);
    if (garmentErr) {
      console.warn("todays-outfit: garment hydration warning:", garmentErr.message);
    } else if (garmentRows) {
      // Preserve the order stored in garment_ids.
      const byId = new Map(garmentRows.map(g => [String(g.id), g]));
      hydratedItems = garmentIds.map(id => byId.get(String(id))).filter(Boolean);
    }
  }

  // rationale column may have been saved as either "rationale" or "reasoning"
  // depending on which schema-drift path stylist.js took.
  const reasoningText = outfitRow?.rationale || outfitRow?.reasoning || "";

  return res.status(200).json({
    date: today,
    outfit: {
      items: hydratedItems,
      reasoning: reasoningText,
    },
    milestone: computeMilestone(garmentIds),
  });
}
