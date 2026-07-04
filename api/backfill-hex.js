import { getServiceClient } from "../lib/supabase.js";
import { extractDominantHex } from "../lib/dominant-hex.js";

export const maxDuration = 60;

// =========================================================
// GET /api/backfill-hex?secret=<BACKFILL_SECRET>&limit=200
//
// One-shot maintenance endpoint: walks every garment with
// thumb_url set + dominant_hex null, fetches the thumb,
// runs extractDominantHex, writes the result back.
//
// Safe to re-run — the WHERE filter naturally skips anything
// already processed. After every garment in the table has a
// hex, calls return { processed: 0 } and do nothing.
//
// Auth: query param ?secret=<BACKFILL_SECRET>. The secret
// must match process.env.BACKFILL_SECRET exactly. If the env
// var is not set, the endpoint refuses to run.
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   BACKFILL_SECRET            (set this once in Vercel; any random string)
// =========================================================

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "GET only" });
  }

  // ── Auth gate ──────────────────────────────────────────────────────────────
  const expected = process.env.BACKFILL_SECRET;
  if (!expected) {
    return res.status(500).json({ error: "BACKFILL_SECRET env var not set — refusing to run" });
  }
  const supplied = (req.query?.secret || "").toString();
  if (supplied !== expected) {
    return res.status(401).json({ error: "Invalid secret" });
  }

  const { supabase, envErr } = getServiceClient();
  if (envErr) return res.status(500).json({ error: envErr });

  // ── Parse limit ────────────────────────────────────────────────────────────
  let limit = DEFAULT_LIMIT;
  if (req.query?.limit !== undefined) {
    const n = parseInt(req.query.limit, 10);
    if (Number.isFinite(n) && n > 0) limit = Math.min(n, MAX_LIMIT);
  }

  // ── Fetch candidates ───────────────────────────────────────────────────────
  const { data: candidates, error: selectErr } = await supabase
    .from("garments")
    .select("id, thumb_url")
    .is("dominant_hex", null)
    .not("thumb_url", "is", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (selectErr) {
    return res.status(500).json({ error: "select failed: " + selectErr.message });
  }

  if (!candidates || candidates.length === 0) {
    // Also report whether the table is fully backfilled.
    const { count } = await supabase
      .from("garments")
      .select("id", { count: "exact", head: true })
      .is("dominant_hex", null);
    return res.status(200).json({
      processed: 0,
      updated: 0,
      remaining: count ?? 0,
      message: count ? `Nothing to process this run, but ${count} rows still have no thumb_url.` : "All garments are backfilled."
    });
  }

  // ── Process sequentially to keep memory low + stay under Replicate-friendly load.
  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const g of candidates) {
    try {
      const thumbRes = await fetch(g.thumb_url);
      if (!thumbRes.ok) {
        skipped++;
        errors.push({ id: g.id, reason: `thumb fetch HTTP ${thumbRes.status}` });
        continue;
      }
      const buf = Buffer.from(await thumbRes.arrayBuffer());
      const hex = await extractDominantHex(buf);
      if (!hex) {
        skipped++;
        errors.push({ id: g.id, reason: "no extractable colour (all bg pixels?)" });
        continue;
      }
      const { error: updErr } = await supabase
        .from("garments")
        .update({ dominant_hex: hex })
        .eq("id", g.id);
      if (updErr) {
        skipped++;
        errors.push({ id: g.id, reason: "update failed: " + updErr.message });
        continue;
      }
      updated++;
    } catch (err) {
      skipped++;
      errors.push({ id: g.id, reason: err?.message || String(err) });
    }
  }

  // ── Tell caller how many still need work so they know whether to re-run.
  const { count: remaining } = await supabase
    .from("garments")
    .select("id", { count: "exact", head: true })
    .is("dominant_hex", null)
    .not("thumb_url", "is", null);

  return res.status(200).json({
    processed: candidates.length,
    updated,
    skipped,
    remaining: remaining ?? 0,
    errors: errors.slice(0, 20),         // cap error list so the response stays small
    message: (remaining ?? 0) === 0
      ? "All garments with thumbs are backfilled."
      : `Run again to process the remaining ${remaining}.`
  });
}
