#!/usr/bin/env node
// scripts/audit-shoe-thumbs.js
//
// Audit (and optionally clean up) shoe garment rows whose stored thumb is
// obviously not the declared color — e.g. a marble-floor crop saved on a
// "white" sneaker before the color sanity gate existed in save-garments.js.
//
// Dry-run by default: lists every offender, prints the ΔE, no writes.
// Pass --apply to null out thumb_url + dominant_hex on those rows so the
// UI falls back to the placeholder instead of surfacing the bad photo.
//
// Usage:
//   SUPABASE_URL=https://xxx.supabase.co \
//   SUPABASE_SERVICE_KEY=service_role_key \
//   node scripts/audit-shoe-thumbs.js            # dry-run, prints offenders
//   node scripts/audit-shoe-thumbs.js --apply    # null out thumb_url/dominant_hex

import { createClient } from "@supabase/supabase-js";
import { colorDistance } from "../lib/color-sanity.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("ERROR: set SUPABASE_URL and SUPABASE_SERVICE_KEY before running.");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
// Same threshold as the live save-garments gate. Keep them in lockstep so
// "what the audit drops" matches "what the gate would have dropped".
const COLOR_GATE_THRESHOLD = 25;
// Same regex as the live save-garments gate. Drift here means rows the gate
// already accepted look like offenders to the audit (or vice-versa).
const COLOR_GATED_CATEGORY = /(shoe|shoes|sneakers|boots|sandals|loafers|trainers|low.?top|high.?top)/i;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  console.log("=== Vesti shoe-thumb color audit ===");
  console.log(APPLY ? "Mode: APPLY (will null out offenders)\n" : "Mode: dry-run (no writes)\n");

  // Pull every garment row with a thumb and a declared color — we need both to
  // compute ΔE. Rows without thumb_url are already in the desired state.
  const { data: rows, error } = await supabase
    .from("garments")
    .select("id, user_id, category, subcategory, color, dominant_hex, thumb_url, created_at")
    .not("thumb_url", "is", null)
    .not("dominant_hex", "is", null)
    .not("color", "is", null);

  if (error) {
    console.error("Failed to fetch garments:", error.message);
    process.exit(1);
  }

  console.log(`Scanned ${rows.length} candidate row(s) with hex+color set.\n`);

  const offenders = [];
  for (const r of rows) {
    const catText = r.subcategory || r.category || "";
    if (!COLOR_GATED_CATEGORY.test(catText)) continue;
    const dE = colorDistance(r.dominant_hex, r.color);
    if (dE === null) continue;            // unknown color word — skip rather than guess
    if (dE > COLOR_GATE_THRESHOLD) offenders.push({ ...r, dE });
  }

  offenders.sort((a, b) => b.dE - a.dE);

  console.log("=== OFFENDERS ===");
  if (offenders.length === 0) {
    console.log("(none) — every shoe row passes the color gate.");
    process.exit(0);
  }
  for (const o of offenders) {
    const uidShort = (o.user_id || "").slice(0, 8);
    const idShort  = (o.id || "").slice(0, 8);
    console.log(
      `  ΔE=${o.dE.toFixed(1).padStart(5)}  hex=${o.dominant_hex}  color="${o.color}"  ` +
      `cat=${o.subcategory || o.category}  user=${uidShort}  garment=${idShort}  ` +
      `created=${o.created_at}`
    );
  }
  console.log(`\nTotal offenders: ${offenders.length}\n`);

  if (!APPLY) {
    console.log("Dry-run complete. Re-run with --apply to null out thumb_url + dominant_hex on these rows.");
    process.exit(0);
  }

  // Apply: null out thumb_url + dominant_hex so UI falls back to the placeholder.
  // We do NOT delete the storage object — the row is the source of truth for whether
  // the file is referenced; leaving it allows future restoration if we're wrong.
  console.log("Applying writes...");
  let updated = 0;
  for (const o of offenders) {
    const { error: updErr } = await supabase
      .from("garments")
      .update({ thumb_url: null, dominant_hex: null })
      .eq("id", o.id);
    if (updErr) {
      console.error(`  FAILED garment=${o.id.slice(0, 8)}: ${updErr.message}`);
    } else {
      updated++;
    }
  }
  console.log(`\nDone. ${updated}/${offenders.length} row(s) updated.`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
