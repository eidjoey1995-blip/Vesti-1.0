import { getServiceClient } from "../lib/supabase.js";
import { resolveUser } from "../lib/auth.js";
import sharp from "sharp";
import { maskGarment } from "../lib/grounded-sam.js";
import { extractDominantHex } from "../lib/dominant-hex.js";
import { colorDistance, whiteLightnessFail } from "../lib/color-sanity.js";

// Categories we trust the color sanity gate on. Scoped to shoes for now —
// shoes were the chronic offender (elevator marble walls bleeding into the
// fallback crop). Expand once we've watched a few uploads in prod.
const COLOR_GATED_CATEGORY = /(shoe|shoes|sneakers|boots|sandals|loafers|trainers|low.?top|high.?top)/i;
const COLOR_GATE_THRESHOLD = 25; // CIE76 ΔE — "obviously different colors" to a human eye

export const maxDuration = 60;

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
// Background removal via Replicate 851-labs/background-remover.
// Community model — must use the version-pinned endpoint
// POST /v1/predictions with an explicit { version } field.
// The hash is fetched once per cold start and cached so it
// stays current without a deploy.
// =========================================================

// Module-level cache — survives across requests on the same warm instance.
let _rmbgVersionHash = null;

async function fetchRmbgVersion(token) {
  if (_rmbgVersionHash) return _rmbgVersionHash;
  const res = await fetch("https://api.replicate.com/v1/models/851-labs/background-remover", {
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

  // Step B: submit prediction (single retry on 429).
  const ENDPOINT = "https://api.replicate.com/v1/predictions";
  const submitHeaders = {
    "Authorization": "Token " + token,
    "Content-Type": "application/json",
    "Prefer": "wait=5"
  };
  const submitBody = JSON.stringify({ version, input: { image: imageUrl } });
  console.log("rmbg request", { url: ENDPOINT, hasToken: !!token, version, imageUrl });

  let prediction;
  try {
    let res = await fetch(ENDPOINT, { method: "POST", headers: submitHeaders, body: submitBody });

    if (res.status === 429) {
      let retryAfterSec = 5;
      try {
        const errJson = await res.json();
        const parsed = Number(errJson?.retry_after);
        if (Number.isFinite(parsed) && parsed > 0) retryAfterSec = parsed;
      } catch (_) {}
      retryAfterSec = Math.min(retryAfterSec, 8);
      console.warn("rmbg 429 throttled, retrying in", retryAfterSec, "seconds");
      await new Promise(r => setTimeout(r, retryAfterSec * 1000));
      res = await fetch(ENDPOINT, { method: "POST", headers: submitHeaders, body: submitBody });
      if (!res.ok) {
        const body = await res.text();
        console.warn("rmbg retry exhausted", res.status, body);
        return null;
      }
    } else if (!res.ok) {
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

async function handleReprocess(req, res, supabase) {
  const { garment_id } = req.body || {};
  if (!garment_id || typeof garment_id !== "string") {
    return res.status(400).json({ ok: false, error: "garment_id is required" });
  }
  if (!process.env.REPLICATE_API_TOKEN) {
    return res.status(500).json({ ok: false, error: "REPLICATE_API_TOKEN not set" });
  }

  // Step 1: Resolve user_id from the Bearer JWT — same pattern as get-closet.
  const auth = (req.headers.authorization || "").trim();
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: "Authorization header required" });
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ ok: false, error: authErr?.message || "Invalid token" });
  }
  const userId = user.id;

  // Step 2: Fetch garment row — filter by both id and user_id so the query
  // itself enforces ownership (same pattern as get-closet's WHERE user_id = userId).
  const { data: garment, error: fetchErr } = await supabase
    .from("garments")
    .select("id, user_id, source_photo_url, category, subcategory, thumb_url")
    .eq("id", garment_id)
    .eq("user_id", userId)
    .single();

  if (fetchErr || !garment) {
    return res.status(404).json({ ok: false, error: fetchErr?.message || "Garment not found" });
  }
  if (!garment.source_photo_url) {
    return res.status(400).json({ ok: false, error: "Garment has no source_photo_url — cannot reprocess" });
  }

  // Steps 3 + 4: Re-run maskGarment with the same prompt pattern as save-garments.
  const label = garment.subcategory || garment.category || "clothing";
  const category = garment.subcategory || garment.category || "";

  let pngBuf;
  try {
    pngBuf = await maskGarment(garment.source_photo_url, label, "", category);
  } catch (err) {
    return res.status(502).json({ ok: false, error: err?.message || String(err) });
  }
  if (!pngBuf) {
    return res.status(502).json({ ok: false, error: "maskGarment returned null — SAM failed or mask was empty" });
  }

  // Step 5: Overwrite existing storage path when possible, otherwise mint a new one.
  let fileName;
  if (garment.thumb_url) {
    const marker = "/garment-thumbs/";
    const idx = garment.thumb_url.indexOf(marker);
    if (idx !== -1) fileName = garment.thumb_url.slice(idx + marker.length);
  }
  if (!fileName) {
    fileName = `${userId}/${Date.now()}_reprocess.png`;
  }

  const { error: upErr } = await supabase.storage
    .from("garment-thumbs")
    .upload(fileName, pngBuf, { contentType: "image/png", upsert: true });

  if (upErr) {
    return res.status(500).json({ ok: false, error: `Storage upload failed: ${upErr.message}` });
  }

  const { data: { publicUrl } } = supabase.storage
    .from("garment-thumbs")
    .getPublicUrl(fileName);

  // Recompute dominant_hex from the regenerated thumb so dedup stays in sync
  // with whatever the user just decided the garment actually looks like.
  const dominantHex = await extractDominantHex(pngBuf);

  // Step 6: Write new thumb_url back to the garments row.
  const updatePatch = { thumb_url: publicUrl };
  if (dominantHex) updatePatch.dominant_hex = dominantHex;
  const { error: updateErr } = await supabase
    .from("garments")
    .update(updatePatch)
    .eq("id", garment_id);

  if (updateErr) {
    return res.status(500).json({ ok: false, error: `DB update failed: ${updateErr.message}` });
  }

  return res.status(200).json({ ok: true, thumb_url: publicUrl });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: { code: "method_not_allowed", message: "POST only" } });
  }

  const { supabase, envErr } = getServiceClient();
  if (envErr) return res.status(500).json({ error: envErr });

  if ((req.body || {}).mode === "reprocess") return handleReprocess(req, res, supabase);

  const { userId, email, err } = await resolveUser(req, supabase);
  if (err) return res.status(401).json({ error: err });

  let { source_photo_url, garments, city, photoBase64 } = req.body || {};

  if (!Array.isArray(garments) || garments.length === 0) {
    return res.status(400).json({ error: { code: "missing_garments", message: "garments must be a non-empty array" } });
  }

  // Whitelist city to the BETA cohort cities.
  const ALLOWED_CITIES = new Set(["Beirut", "Dubai", "Riyadh", "New York"]);
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

  // If the frontend didn't supply a source URL (onboarding sends null), upload the
  // normalized buffer once so grounded_sam has a public URL to fetch.
  if (normalizedImgBuf && !source_photo_url && process.env.REPLICATE_API_TOKEN) {
    const srcName = `tmp_${userId}_source_${Date.now()}.jpg`;
    const { error: srcUpErr } = await supabase.storage
      .from("garment-thumbs")
      .upload(srcName, normalizedImgBuf, { contentType: "image/jpeg", upsert: false });
    if (!srcUpErr) {
      const { data: { publicUrl: srcUrl } } = supabase.storage
        .from("garment-thumbs")
        .getPublicUrl(srcName);
      source_photo_url = srcUrl;
    } else {
      console.warn("source photo upload failed, grounded_sam will be skipped:", srcUpErr.message);
    }
  }

  // Per-garment thumbnail generation: grounded_sam primary, bbox-crop+RMBG fallback.
  const thumbUrls = {};

  // Pre-compute image dimensions once — used only by the legacy crop fallback.
  let _legacyImgW = 1, _legacyImgH = 1, _legacyImgReady = false;
  if (normalizedImgBuf) {
    try {
      const meta = await sharp(normalizedImgBuf).metadata();
      _legacyImgW = meta.width || 1;
      _legacyImgH = meta.height || 1;
      _legacyImgReady = true;
    } catch (imgErr) {
      console.warn("thumb generation skipped:", imgErr.message);
    }
  }

  const BODY_PARTS = "head, face, hair";

  const thumbResults = await Promise.all(garments.map(async (g, i) => {
    const label = g.subcategory || g.category || "clothing";
    const ts = Date.now();

    // PRIMARY: grounded_sam on the full source photo URL.
    if (source_photo_url && process.env.REPLICATE_API_TOKEN) {
      const negativePrompt = "";
      try {
        const pngBuf = await maskGarment(source_photo_url, label, negativePrompt, g.subcategory || g.category || "");
        if (pngBuf) {
          const fileName = `${userId}/${ts}_${i}.png`;
          const { error: upErr } = await supabase.storage
            .from("garment-thumbs")
            .upload(fileName, pngBuf, { contentType: "image/png", upsert: false });
          if (!upErr) {
            const { data: { publicUrl } } = supabase.storage
              .from("garment-thumbs")
              .getPublicUrl(fileName);
            const dominantHex = await extractDominantHex(pngBuf);
            console.log(`path=grounded-sam label=${label} hex=${dominantHex || "—"}`);
            return [i, { url: publicUrl, hex: dominantHex }];
          }
        }
      } catch (gsamErr) {
        console.log(`grounded-sam: unexpected error for "${label}":`, gsamErr.message);
      }
    }

    // FALLBACK: existing bbox crop + RMBG path — logic unchanged.
    if (!normalizedImgBuf || !_legacyImgReady) return [i, { url: null, hex: null }];

    const bbox = g.raw_response?.bbox || g.bbox;
    if (!bbox || typeof bbox.x !== "number") return [i, { url: null, hex: null }];

    try {
      const imgW = _legacyImgW;
      const imgH = _legacyImgH;
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
      const cropJpeg = await sharp(normalizedImgBuf)
        .extract({ left, top, width, height })
        .resize(400, 400, { fit: "cover", position: "centre" })
        .jpeg({ quality: 82 })
        .toBuffer();

      let finalBuf = cropJpeg;
      let fileName = `${userId}/${ts}_${i}.jpg`;
      let contentType = "image/jpeg";
      let legacyPath = "legacy-jpeg";

      // Background removal: upload crop to a temp public URL, run 851-labs/background-remover,
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
            // Guard against RMBG erasing low-contrast subjects (e.g. grey suede on
            // a neutral background): inspect the alpha channel before accepting the PNG.
            let subjectFraction = 1; // default: assume good if inspection fails
            try {
              const { data: alphaRaw, info } = await sharp(pngBuf)
                .extractChannel("alpha")
                .raw()
                .toBuffer({ resolveWithObject: true });
              const totalPixels = info.width * info.height;
              let visiblePixels = 0;
              for (let p = 0; p < alphaRaw.length; p++) {
                if (alphaRaw[p] > 20) visiblePixels++;
              }
              subjectFraction = totalPixels > 0 ? visiblePixels / totalPixels : 0;
            } catch (alphaErr) {
              console.warn(`rmbg alpha check failed for garment ${i}:`, alphaErr.message);
            }

            if (subjectFraction >= 0.05) {
              finalBuf = pngBuf;
              fileName = `${userId}/${ts}_${i}.png`;
              contentType = "image/png";
              legacyPath = "legacy-rmbg";
            } else {
              console.warn(`rmbg erased subject for garment ${i} (visible pixels: ${(subjectFraction * 100).toFixed(1)}%), falling back to JPEG`);
            }
          } else {
            console.warn(`rmbg skipped for garment ${i}, falling back to JPEG`);
          }

          // Clean up temp — fire-and-forget, never blocks the response.
          supabase.storage.from("garment-thumbs").remove([tempName]).catch(() => {});
        }
      }

      // Compute dominant hex from the buffer BEFORE uploading so the color
      // sanity gate can reject obviously-wrong thumbs (e.g. marble crop on a
      // "white" sneaker) without leaving an orphan blob in storage.
      const dominantHex = await extractDominantHex(finalBuf);

      const catText = g.subcategory || g.category || "";
      if (COLOR_GATED_CATEGORY.test(catText) && dominantHex && g.color) {
        const dE = colorDistance(dominantHex, g.color);
        if (dE !== null && dE > COLOR_GATE_THRESHOLD) {
          // The cutout's dominant color disagrees with the AI's color name.
          // This used to NULL the thumbnail, but a mismatch usually means the
          // AI mislabeled the COLOR (muddy suede earth-tones, odd lighting),
          // not that the cutout is bad — and a missing thumb (the SVG cartoon)
          // is worse UX than a real photo with a slightly-off color tag. Keep
          // the cutout and trust the measured hex over the label. The
          // whiteLightnessFail check below still nulls warm floor/marble crops
          // on "white" shoes — the genuine bad-cutout case this gate is for.
          console.log(`color mismatch (kept) garment ${i}: path=${legacyPath} label="${label}" hex=${dominantHex} vs declared color="${g.color}" ΔE=${dE.toFixed(1)} > ${COLOR_GATE_THRESHOLD}`);
        }
        // Secondary check for whites — ΔE 25 is too forgiving for warm-tinted
        // marble/wood floors that read as off-white. Lightness floor catches them.
        if (whiteLightnessFail(dominantHex, g.color)) {
          console.log(`color sanity drop garment ${i}: path=${legacyPath} label="${label}" hex=${dominantHex} declared "white" but L* below floor (warm-tinted, likely a floor crop)`);
          return [i, { url: null, hex: null }];
        }
      }

      const { error: upErr } = await supabase.storage
        .from("garment-thumbs")
        .upload(fileName, finalBuf, { contentType, upsert: false });

      if (!upErr) {
        const { data: { publicUrl } } = supabase.storage
          .from("garment-thumbs")
          .getPublicUrl(fileName);
        console.log(`path=${legacyPath} label=${label} hex=${dominantHex || "—"}`);
        return [i, { url: publicUrl, hex: dominantHex }];
      }
      return [i, { url: null, hex: null }];
    } catch (cropErr) {
      console.warn(`thumb crop failed for garment ${i}:`, cropErr.message);
      return [i, { url: null, hex: null }];
    }
  }));

  const thumbHexes = {};
  thumbResults.forEach(([i, data]) => {
    if (data?.url) thumbUrls[i] = data.url;
    if (data?.hex) thumbHexes[i] = data.hex;
  });

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
    dominant_hex: thumbHexes[i] ?? null,
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
