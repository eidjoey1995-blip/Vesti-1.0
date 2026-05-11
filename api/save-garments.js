import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

// =========================================================
// POST /api/save-garments
// Auth: Authorization: Bearer <supabase_access_token>
// Body: { city?, source_photo_url?, garments[] }
//
// user_id is resolved from the JWT — not accepted in the body.
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// =========================================================

// =========================================================
// Background removal via Replicate RMBG-1.4.
// briaai/rmbg-1.4 is a community model — must use the
// version-pinned endpoint POST /v1/predictions with an
// explicit { version } field. The hash is fetched once per
// cold start and cached so it stays current without a deploy.
// =========================================================

// Module-level cache — survives across requests on the same warm instance.
let _rmbgVersionHash = null;

async function fetchRmbgVersion(token) {
  if (_rmbgVersionHash) return _rmbgVersionHash;
  const res = await fetch("https://api.replicate.com/v1/models/briaai/rmbg-1.4", {
    headers: { "Authorization": "Token " + token }
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn("rmbg model fetch HTTP", res.status, body);
    return null;
  }
  const data = await res.json();
  const hash = data?.latest_version?.id ?? null;
  if (hash) _rmbgVersionHash = hash;
  return hash;
}

// Extract the PNG output URL from a prediction object.
function rmbgOutputUrl(p) {
  const raw = Array.isArray(p?.output) ? p.output[0] : p?.output;
  return typeof raw === "string" ? raw : null;
}

async function removeBackground(imageUrl) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return null;

  // Step A: resolve version hash (cached after first call).
  let version;
  try {
    version = await fetchRmbgVersion(token);
  } catch (err) {
    console.warn("rmbg version fetch error:", err.message);
    return null;
  }
  if (!version) return null;

  // Step B: submit prediction.
  const ENDPOINT = "https://api.replicate.com/v1/predictions";
  console.log("rmbg request", { url: ENDPOINT, hasToken: !!token, version, imageUrl });

  let prediction;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": "Token " + token,
        "Content-Type": "application/json",
        "Prefer": "wait=5"
      },
      body: JSON.stringify({ version, input: { image: imageUrl } })
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn("rmbg submit HTTP", res.status, body);
      return null;
    }
    prediction = await res.json();
  } catch (err) {
    console.warn("rmbg submit error:", err.message);
    return null;
  }

  // Step C: fast path — Prefer: wait=5 may have resolved it already.
  if (prediction?.status === "succeeded") {
    const url = rmbgOutputUrl(prediction);
    if (!url) return null;
    const pngRes = await fetch(url);
    if (!pngRes.ok) return null;
    return Buffer.from(await pngRes.arrayBuffer());
  }

  if (prediction?.status === "failed" || prediction?.status === "canceled") {
    console.warn("rmbg prediction", prediction.status, prediction.error || "");
    return null;
  }

  // Step C: async path — poll urls.get every 500ms, max 16 attempts (8s).
  const pollUrl = prediction?.urls?.get;
  if (!pollUrl) {
    console.warn("rmbg: no urls.get in response", JSON.stringify(prediction));
    return null;
  }

  for (let attempt = 0; attempt < 16; attempt++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const pollRes = await fetch(pollUrl, {
        headers: { "Authorization": "Token " + token }
      });
      if (!pollRes.ok) {
        const body = await pollRes.text();
        console.warn("rmbg poll HTTP", pollRes.status, body);
        return null;
      }
      const poll = await pollRes.json();
      if (poll.status === "succeeded") {
        const url = rmbgOutputUrl(poll);
        if (!url) return null;
        const pngRes = await fetch(url);
        if (!pngRes.ok) return null;
        return Buffer.from(await pngRes.arrayBuffer());
      }
      if (poll.status === "failed" || poll.status === "canceled") {
        console.warn("rmbg prediction", poll.status, poll.error || "");
        return null;
      }
    } catch (pollErr) {
      console.warn("rmbg poll error:", pollErr.message);
      return null;
    }
  }
  console.warn("rmbg polling timed out after 8s");
  return null;
}

async function resolveUser(req, supabase) {
  const auth = (req.headers.authorization || "").trim();
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    return { userId: null, email: null, err: { code: "unauthorized", message: "Authorization header required" } };
  }
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return { userId: null, email: null, err: { code: "unauthorized", message: error?.message || "Invalid token" } };
  }
  return { userId: user.id, email: user.email, err: null };
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
      error: { code: "missing_env", message: "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in Vercel env vars." }
    });
  }

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { userId, email, err } = await resolveUser(req, supabase);
  if (err) return res.status(401).json({ error: err });

  const { source_photo_url, garments, city, photoBase64 } = req.body || {};

  if (!Array.isArray(garments) || garments.length === 0) {
    return res.status(400).json({ error: { code: "missing_garments", message: "garments must be a non-empty array" } });
  }

  // Whitelist city to the BETA cohort cities.
  const ALLOWED_CITIES = new Set(["Beirut", "Dubai", "New York"]);
  const cityClean = (typeof city === "string" && ALLOWED_CITIES.has(city)) ? city : null;

  // Ensure profile row exists (idempotent upsert). Include city when provided.
  try {
    const profileRow = { id: userId, display_name: (email || "").split("@")[0] };
    if (cityClean) profileRow.city = cityClean;
    const { error: profileErr } = await supabase
      .from("profiles")
      .upsert(profileRow, { onConflict: "id" });
    if (profileErr) {
      if (cityClean && /city/i.test(profileErr.message || "")) {
        delete profileRow.city;
        await supabase.from("profiles").upsert(profileRow, { onConflict: "id" });
      } else {
        console.warn("profile upsert warning:", profileErr.message);
      }
    }
  } catch (e) {
    console.warn("profile upsert warning:", e?.message || e);
  }

  // Normalize incoming image: bake EXIF rotation, convert HEIC/PNG/WebP → JPEG.
  // Must happen before the crop block so coordinates from segment-garments
  // (which normalizes the same way) align with the pixels we're cutting from.
  let normalizedImgBuf = null;
  if (photoBase64 && typeof photoBase64 === "string") {
    const rawBuf = Buffer.from(photoBase64, "base64");
    try {
      normalizedImgBuf = await sharp(rawBuf).rotate().jpeg({ quality: 90 }).toBuffer();
    } catch (normErr) {
      const isHeic = rawBuf.length >= 12 && rawBuf.slice(4, 8).toString("ascii") === "ftyp";
      if (isHeic) {
        return res.status(415).json({
          error: { code: "unsupported_media_type", message: "HEIC conversion failed — please convert to JPEG and try again." }
        });
      }
      console.warn("image normalization failed, using raw buffer:", normErr.message);
      normalizedImgBuf = rawBuf;
    }
  }

  // Crop garment thumbnails from the normalized flatlay.
  const thumbUrls = {};
  if (normalizedImgBuf) {
    try {
      const imgBuf = normalizedImgBuf;
      const meta = await sharp(imgBuf).metadata();
      const imgW = meta.width || 1;
      const imgH = meta.height || 1;

      for (let i = 0; i < garments.length; i++) {
        const g = garments[i];
        const bbox = g.raw_response?.bbox || g.bbox;
        if (!bbox || typeof bbox.x !== "number") continue;
        try {
          const rawLeft   = Math.round(bbox.x * imgW);
          const rawTop    = Math.round(bbox.y * imgH);
          const rawWidth  = Math.round(bbox.w * imgW);
          const rawHeight = Math.round(bbox.h * imgH);
          // Inset each side by 4% of the bbox dimension to shed loose background pixels.
          const insetX = Math.floor(rawWidth  * 0.04);
          const insetY = Math.floor(rawHeight * 0.04);
          const left   = Math.max(0, rawLeft + insetX);
          const top    = Math.max(0, rawTop  + insetY);
          const width  = Math.max(1, Math.min(imgW - left, rawWidth  - 2 * insetX));
          const height = Math.max(1, Math.min(imgH - top,  rawHeight - 2 * insetY));
          const cropJpeg = await sharp(imgBuf)
            .extract({ left, top, width, height })
            .resize(400, 400, { fit: "cover", position: "centre" })
            .jpeg({ quality: 82 })
            .toBuffer();

          const ts = Date.now();
          let finalBuf = cropJpeg;
          let fileName = `${userId}/${ts}_${i}.jpg`;
          let contentType = "image/jpeg";

          // Background removal: upload crop to a temp public URL, run RMBG-1.4,
          // fall back to JPEG on any failure so garment save is never blocked.
          if (process.env.REPLICATE_API_TOKEN) {
            const tempName = `${userId}/tmp_${ts}_${i}.jpg`;
            const { error: tempErr } = await supabase.storage
              .from("garment-thumbs")
              .upload(tempName, cropJpeg, { contentType: "image/jpeg", upsert: false });

            if (!tempErr) {
              const { data: { publicUrl: tempUrl } } = supabase.storage
                .from("garment-thumbs")
                .getPublicUrl(tempName);

              const pngBuf = await removeBackground(tempUrl);
              if (pngBuf) {
                finalBuf = pngBuf;
                fileName = `${userId}/${ts}_${i}.png`;
                contentType = "image/png";
              } else {
                console.warn(`rmbg skipped for garment ${i}, falling back to JPEG`);
              }

              // Clean up temp — fire-and-forget, never blocks the response.
              supabase.storage.from("garment-thumbs").remove([tempName]).catch(() => {});
            }
          }

          const { error: upErr } = await supabase.storage
            .from("garment-thumbs")
            .upload(fileName, finalBuf, { contentType, upsert: false });

          if (!upErr) {
            const { data: { publicUrl } } = supabase.storage
              .from("garment-thumbs")
              .getPublicUrl(fileName);
            thumbUrls[i] = publicUrl;
          }
        } catch (cropErr) {
          console.warn(`thumb crop failed for garment ${i}:`, cropErr.message);
        }
      }
    } catch (imgErr) {
      console.warn("thumb generation skipped:", imgErr.message);
    }
  }

  const rows = garments.map((g, i) => ({
    user_id: userId,
    category: g.category ?? "other",
    subcategory: g.subcategory ?? null,
    color: g.color ?? null,
    pattern: g.pattern ?? null,
    formality_score: typeof g.formality_score === "number" ? g.formality_score : null,
    description: g.description ?? null,
    fabric: g.fabric ?? null,
    fabric_confirmed: !!g.fabric_confirmed,
    brand: g.brand ?? null,
    source_photo_url: source_photo_url ?? null,
    raw_response: g.raw_response ?? g,
    segment_index: i,
    thumb_url: thumbUrls[i] ?? null,
  }));

  const { data, error } = await supabase
    .from("garments")
    .insert(rows)
    .select("id, segment_index");

  if (error) {
    return res.status(500).json({
      error: { code: "insert_failed", message: error.message, details: error.details ?? null }
    });
  }

  return res.status(200).json({ user_id: userId, saved: data });
}
