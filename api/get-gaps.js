import { createClient } from "@supabase/supabase-js";

// =========================================================
// GET /api/get-gaps
// Auth: Authorization: Bearer <supabase_access_token>
//
// Foundational baseline = Methodology §5b "Lebanese man's foundational closet."
// For BETA we hardcode minimum counts per category.
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// =========================================================

// Terms must match the category values that segment-garments instructs Claude to return:
// "shirt" | "tshirt" | "polo" | "sweater" | "jacket" | "blazer" | "coat" |
// "pants" | "jeans" | "chinos" | "shorts" | "shoes" | "sneakers" | "boots" |
// "accessory" | "other"
const FOUNDATIONAL_MEN = [
  {
    terms: ["shirt", "tshirt", "polo", "sweater"],
    expected: 3,
    title: "Foundational shirts.",
    why: "A rotation of three shirts covers a working week without repetition — one white, one light blue, one neutral. Those three alongside the trousers you already own cover 80% of the calendar without a new outfit."
  },
  {
    terms: ["pants", "chinos", "jeans", "shorts"],
    expected: 2,
    title: "Two-pair trouser base.",
    why: "One tailored chino and one casual jean double your outfit count and halve wear on both. The minimum for a working wardrobe that rotates cleanly."
  },
  {
    terms: ["blazer", "jacket", "coat"],
    expected: 1,
    title: "No mid-layer.",
    why: "An unstructured blazer or jacket is the piece that moves an outfit from casual to put-together. One piece — navy or sand — layers over almost everything in the closet and doubles the read of every shirt you own."
  },
  {
    terms: ["shoes", "sneakers", "boots"],
    expected: 2,
    title: "Two-shoe rotation.",
    why: "One smart pair (loafer or derby) and one clean sneaker cover every occasion in the codex. Without both, you're either overdressed or underdressed — no middle ground for brunch-to-boardroom days."
  },
  {
    terms: ["accessory"],
    expected: 1,
    title: "No finishing detail.",
    why: "A watch, bracelet, or steel cufflinks reads finished across 70% of the closet. Small piece, large signal — especially on client-facing days where every visible detail lands."
  }
];

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

  const { data, error } = await supabase
    .from("garments")
    .select("category")
    .eq("user_id", userId);

  if (error) {
    return res.status(500).json({
      error: { code: "select_failed", message: error.message, details: error.details ?? null }
    });
  }

  const counts = new Map();
  for (const row of data || []) {
    const k = (row.category || "").toLowerCase().trim();
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  return res.status(200).json({
    gaps: buildGaps(counts),
    total_garments: data ? data.length : 0
  });
}

function buildGaps(counts) {
  const out = [];
  for (const f of FOUNDATIONAL_MEN) {
    const termSet = new Set(f.terms);
    let have = 0;
    for (const [k, v] of counts) {
      if (termSet.has(k)) have += v;
    }
    if (have < f.expected) {
      out.push({ category: f.terms[0], current: have, expected: f.expected, title: f.title, why: f.why });
    }
  }
  return out;
}
