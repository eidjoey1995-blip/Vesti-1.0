import { createClient } from "@supabase/supabase-js";

// =========================================================
// GET /api/get-closet
// Auth: Authorization: Bearer <supabase_access_token>
// Query params: limit?, cursor?, category?
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// =========================================================

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const SELECT_COLUMNS = [
  "id",
  "category",
  "subcategory",
  "color",
  "pattern",
  "formality_score",
  "description",
  "fabric",
  "fabric_confirmed",
  "brand",
  "thumb_url",
  "source_photo_url",
  "segment_index",
  "created_at"
].join(", ");

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

  const { limit, cursor, category } = req.query || {};

  let lim = DEFAULT_LIMIT;
  if (limit !== undefined) {
    const n = parseInt(limit, 10);
    if (Number.isNaN(n) || n < 1) {
      return res.status(400).json({ error: { code: "invalid_limit", message: "limit must be a positive integer" } });
    }
    lim = Math.min(n, MAX_LIMIT);
  }

  let query = supabase
    .from("garments")
    .select(SELECT_COLUMNS)
    .eq("user_id", userId)
    .is("dupe_of_garment_id", null)     // hide rows the user has confirmed as duplicates
    .order("created_at", { ascending: false })
    .limit(lim);

  if (cursor && typeof cursor === "string") query = query.lt("created_at", cursor);
  if (category && typeof category === "string") query = query.eq("category", category);

  const { data, error } = await query;

  if (error) {
    return res.status(500).json({
      error: { code: "select_failed", message: error.message, details: error.details ?? null }
    });
  }

  const nextCursor = data.length === lim ? data[data.length - 1].created_at : null;

  return res.status(200).json({ garments: data, next_cursor: nextCursor });
}
