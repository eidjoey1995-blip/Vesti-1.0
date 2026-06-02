import { createClient } from "@supabase/supabase-js";

// =========================================================
// GET /api/get-stats
// Auth: Authorization: Bearer <supabase_access_token>
//
// Returns { garments_count, outfits_count, days_active }
//   garments_count — rows in garments for this user
//   outfits_count  — rows in outfits for this user
//   days_active    — days since earliest garment creation (inclusive)
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// =========================================================

async function resolveUser(req, supabase) {
  const auth = (req.headers.authorization || "").trim();
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    return { userId: null, err: { code: "unauthorized", message: "Authorization header required" } };
  }
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    console.error("get-stats resolveUser failed", {
      error: error?.message,
      tokenPrefix: token.slice(0, 20) + "...",
    });
    return { userId: null, err: { code: "unauthorized", message: error?.message || "Invalid token" } };
  }
  return { userId: user.id, err: null };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: { code: "method_not_allowed", message: "GET only" } });
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

  // Hard guard: never run unfiltered queries if userId is falsy for any reason.
  if (!userId) {
    console.error("get-stats: userId is falsy after resolveUser — refusing unfiltered query");
    return res.status(401).json({ error: { code: "unauthorized", message: "Could not determine user identity" } });
  }

  // Run all three queries in parallel.
  const [garmentsRes, outfitsRes, firstGarmentRes] = await Promise.all([
    supabase
      .from("garments")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("dupe_of_garment_id", null),    // stat must match what user sees in closet
    supabase
      .from("outfits")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId),
    supabase
      .from("garments")
      .select("created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle()
  ]);

  if (garmentsRes.error) {
    console.error("get-stats garments query failed", { error: garmentsRes.error.message, userId });
    return res.status(500).json({
      error: { code: "select_failed", message: garmentsRes.error.message }
    });
  }

  if (outfitsRes.error) {
    console.error("get-stats outfits query failed", { error: outfitsRes.error.message, userId });
    return res.status(500).json({
      error: { code: "select_failed", message: outfitsRes.error.message }
    });
  }

  const garmentsCount = garmentsRes.count ?? 0;
  const outfitsCount = outfitsRes.count ?? 0;

  let daysActive = 0;
  if (!firstGarmentRes.error && firstGarmentRes.data?.created_at) {
    const first = new Date(firstGarmentRes.data.created_at);
    daysActive = Math.max(1, Math.floor((Date.now() - first.getTime()) / 86_400_000) + 1);
  }

  return res.status(200).json({
    garments_count: garmentsCount,
    outfits_count: outfitsCount,
    days_active: daysActive
  });
}
