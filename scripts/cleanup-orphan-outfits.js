#!/usr/bin/env node
// scripts/cleanup-orphan-outfits.js
//
// One-time cleanup: delete outfit rows that reference garments which no
// longer exist in the garments table.
//
// Usage:
//   SUPABASE_URL=https://xxx.supabase.co \
//   SUPABASE_SERVICE_KEY=service_role_key  \
//   node scripts/cleanup-orphan-outfits.js
//
// Safe to re-run — idempotent (second run will find 0 orphans and exit).

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("ERROR: set SUPABASE_URL and SUPABASE_SERVICE_KEY before running.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  console.log("=== Vesti orphan-outfits cleanup ===\n");

  // ── Step 1: Introspect schema via a sample row ─────────────────────────────
  console.log("Step 1: Inspecting outfits table schema...");
  const { data: sample, error: sampleErr } = await supabase
    .from("outfits")
    .select("*")
    .limit(1)
    .maybeSingle();

  if (sampleErr) {
    console.error("Cannot read outfits table:", sampleErr.message);
    process.exit(1);
  }
  if (!sample) {
    console.log("outfits table is empty — nothing to clean up.");
    process.exit(0);
  }

  const cols = Object.keys(sample);
  console.log("  Columns detected:", cols.join(", "));

  // Prefer garment_ids (the column written by /api/stylist.js).
  // Fall back to other plausible names in case of schema drift.
  const CANDIDATE_COLS = ["garment_ids", "garments_jsonb", "garment_list"];
  const garmentRefCol = CANDIDATE_COLS.find((c) => cols.includes(c));

  if (!garmentRefCol) {
    console.error(
      `\nCould not find a garment-reference column. Expected one of: ${CANDIDATE_COLS.join(", ")}.` +
      "\nIf outfits use a join table (outfit_garments), update this script to handle that."
    );
    process.exit(1);
  }
  console.log(`  Using garment reference column: "${garmentRefCol}"\n`);

  // ── Step 2: Fetch all outfits ──────────────────────────────────────────────
  console.log("Step 2: Fetching all outfits...");
  const { data: outfits, error: outfitsErr } = await supabase
    .from("outfits")
    .select(`id, user_id, created_at, ${garmentRefCol}`);

  if (outfitsErr) {
    console.error("Failed to fetch outfits:", outfitsErr.message);
    process.exit(1);
  }
  console.log(`  Fetched ${outfits.length} outfit row(s).`);

  // ── Step 3: Fetch all live garment IDs into a Set ─────────────────────────
  console.log("Step 3: Fetching all live garment IDs...");
  const { data: garments, error: garmentsErr } = await supabase
    .from("garments")
    .select("id");

  if (garmentsErr) {
    console.error("Failed to fetch garments:", garmentsErr.message);
    process.exit(1);
  }
  const liveIds = new Set(garments.map((g) => g.id));
  console.log(`  ${liveIds.size} live garment(s) in the garments table.\n`);

  // ── Step 4: Identify orphaned outfits ─────────────────────────────────────
  const orphanedIds = [];
  // per-user stats: { total, orphaned }
  const byUser = {};

  for (const outfit of outfits) {
    const uid = outfit.user_id ?? "(no user_id)";
    byUser[uid] ??= { total: 0, orphaned: 0 };
    byUser[uid].total++;

    const raw = outfit[garmentRefCol];

    // Normalise: column may be uuid[] or jsonb array of id strings/objects.
    let refs = [];
    if (Array.isArray(raw)) {
      refs = raw.map((r) =>
        r && typeof r === "object" ? (r.id ?? r.garment_id ?? null) : r
      ).filter(Boolean);
    }

    // An outfit is orphaned when it references at least one garment that is
    // no longer in the garments table. Outfits with zero refs are left alone
    // (they may be in-progress or from a schema migration).
    const isOrphan = refs.length > 0 && refs.some((id) => !liveIds.has(id));
    if (isOrphan) {
      orphanedIds.push(outfit.id);
      byUser[uid].orphaned++;
    }
  }

  // ── Step 5: Print before-summary ──────────────────────────────────────────
  console.log("=== BEFORE CLEANUP ===");
  console.log(`Total outfits  : ${outfits.length}`);
  console.log(`Orphaned outfits: ${orphanedIds.length}`);
  console.log("\nPer-user breakdown:");
  for (const [uid, { total, orphaned }] of Object.entries(byUser)) {
    const short = uid.length > 16 ? uid.slice(0, 16) + "…" : uid;
    console.log(`  ${short}  →  ${total} total, ${orphaned} orphaned`);
  }
  console.log();

  if (orphanedIds.length === 0) {
    console.log("Nothing to delete. Table is clean.");
    process.exit(0);
  }

  // ── Step 6: Delete in batches of 100 ──────────────────────────────────────
  console.log(`Deleting ${orphanedIds.length} orphaned outfit(s)...`);
  let deleted = 0;
  for (const batch of chunk(orphanedIds, 100)) {
    const { error: delErr } = await supabase
      .from("outfits")
      .delete()
      .in("id", batch);

    if (delErr) {
      console.error(`  Delete error on batch starting at index ${deleted}:`, delErr.message);
      process.exit(1);
    }
    deleted += batch.length;
    console.log(`  Deleted ${batch.length} (running total: ${deleted})`);
  }

  // ── Step 7: Verify remaining count ────────────────────────────────────────
  const { count: remaining } = await supabase
    .from("outfits")
    .select("*", { count: "exact", head: true });

  console.log("\n=== AFTER CLEANUP ===");
  console.log(`Deleted         : ${deleted}`);
  console.log(`Remaining rows  : ${remaining ?? "unknown"}`);
  console.log("\nDone. Re-run to verify idempotency (should report 0 orphaned).");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
