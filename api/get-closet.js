import { createClient } from "@supabase/supabase-js";

// =========================================================
// GET /api/get-closet
// Lists the user's catalogued garments.
//
// Spike auth model (V1 BETA pre-auth):
//   Client sends `email` as query param. We resolve it to a
//   Supabase auth user_id via admin.listUsers, then select
//   from `garments` filtered by user_id, newest first.
//   Replaced by JWT auth + RLS in #62.
//
// Query params:
//   email    (required)       — user identifier
//   limit    (optional, 1-200, default 50)
//   cursor   (optional ISO ts) — return rows with created_at < cursor
//   category (optional)        — filter by garment category (shirt, etc.)
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// =========================================================

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Columns returned to the client. Keep in sync with the closet UI in app.html.
// Excludes raw_response (heavy, internal) and source_photo_url (per-garment thumb_url
// is what the closet grid uses; source photo is referenced from item-detail later).
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

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: { code: "method_not_allowed", message: "GET only" } });
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

  const { email, limit, cursor, category } = req.query || {};

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: { code: "missing_email", message: "email is required" } });
  }

  // Parse + clamp limit.
  let lim = DEFAULT_LIMIT;
  if (limit !== undefined) {
    const n = parseInt(limit, 10);
    if (Number.isNaN(n) || n < 1) {
      return res.status(400).json({ error: { code: "invalid_limit", message: "limit must be a positive integer" } });
    }
    lim = Math.min(n, MAX_LIMIT);
  }

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Resolve user_id from email (same pattern as save-garments + swipe).
  let userId;
  try {
    const { data: existing, error: listErr } = await supabase.auth.admin.listUsers();
    if (listErr) throw listErr;
    const match = existing?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (!match) {
      // Empty closet for unknown user is the right answer here — onboarding may
      // not have completed yet. Return 200 with empty array rather than 404 so
      // the UI can render its empty state instead of an error toast.
      return res.status(200).json({ garments: [], next_cursor: null });
    }
    userId = match.id;
  } catch (err) {
    return res.status(500).json({
      error: { code: "auth_user_resolve_failed", message: err.message || String(err) }
    });
  }

  // Build query.
  let query = supabase
    .from("garments")
    .select(SELECT_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(lim);

  if (cursor && typeof cursor === "string") {
    query = query.lt("created_at", cursor);
  }
  if (category && typeof category === "string") {
    query = query.eq("category", category);
  }

  const { data, error } = await query;

  if (error) {
    return res.status(500).json({
      error: { code: "select_failed", message: error.message, details: error.details ?? null }
    });
  }

  // next_cursor: created_at of the last row, IF we returned a full page (probable more rows behind).
  const nextCursor = data.length === lim ? data[data.length - 1].created_at : null;

  return res.status(200).json({
    garments: data,
    next_cursor: nextCursor
  });
}
