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

const FOUNDATIONAL_MEN = [
  {
    category: "shirt",
    aliases: ["overshirt"],
    expected: 3,
    title: "Foundational shirts.",
    why: "A foundational closet starts at three shirts so you can rotate without the same one twice in a week. Add solid white, light blue, and a softer neutral and 80% of the calendar is covered."
  },
  {
    category: "trouser",
    aliases: ["trousers", "chinos", "pants"],
    expected: 2,
    title: "Two-pair trouser base.",
    why: "One pair of trousers means you wear them every other day. Two — one tailored, one casual chino — and they each last twice as long while doubling your outfit count."
  },
  {
    category: "blazer",
    aliases: ["jacket", "suit", "overshirt"],
    expected: 1,
    title: "One layer that finishes a look.",
    why: "An overshirt or unstructured blazer is the difference between dressed and put-together. One piece, navy or oat, layers over almost everything you already own."
  },
  {
    category: "shoe",
    aliases: ["shoes", "derby", "oxford", "loafer"],
    expected: 2,
    title: "Two-shoe rotation.",
    why: "One smart pair (derby or loafer) and one casual (sneaker or suede) covers every occasion in the codex without compromise on either side."
  },
  {
    category: "watch",
    aliases: ["accessory"],
    expected: 1,
    title: "A finishing detail.",
    why: "A single watch (or steel cufflinks) reads finished across 70% of the closet. Small piece, large signal — especially for client-facing days."
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
    let have = counts.get(f.category) || 0;
    for (const a of f.aliases || []) have += counts.get(a) || 0;
    if (have < f.expected) {
      out.push({ category: f.category, current: have, expected: f.expected, title: f.title, why: f.why });
    }
  }
  return out;
}
