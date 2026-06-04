import sharp from "sharp";

// Module-level version hash cache — survives across requests on the same warm instance.
let _gsamVersionHash = null;

// Category regexes — used by prompt normalization, the shoe sanity checks, AND
// the portrait-mode category slice further down. Keep them aligned with the
// per-category topPct/bottomPct block to avoid drift between the two places.
const SHOE_RE   = /(shoe|shoes|sneakers|boots|sandals|loafers|trainers|low.?top|high.?top)/;
const TOP_RE    = /(top|tops|t.?shirt|tee|shirt|blouse|sweater|hoodie|knit|polo)/;
const BOTTOM_RE = /(bottom|bottoms|pants|chinos|trousers|jeans|shorts|skirt)/;
const OUTER_RE  = /(outerwear|jacket|coat|blazer)/;
const SUIT_RE   = /(suit|suits|dress|jumpsuit)/;

// For shoes specifically, color-leading prompts like "white low-top sneakers"
// pull Grounding DINO toward any white-ish region in the frame — most painfully,
// the white-veined marble walls of elevators. Strip the color modifier and
// ground the bare garment noun. Color is preserved elsewhere (dominant_hex,
// description) so this only affects what DINO grounds against.
function normalizeMaskPrompt(labelText, category) {
  const cat = (category || "").toLowerCase();
  if (!SHOE_RE.test(cat)) return labelText;
  if (/boot/.test(cat))    return "boots";
  if (/sandal/.test(cat))  return "sandals";
  if (/loafer/.test(cat))  return "loafers";
  if (/sneaker|trainer|low.?top|high.?top/.test(cat)) return "sneakers";
  return "shoes";
}

// Default negative prompt per category — fills in when the caller doesn't
// supply one. Steers DINO away from the most common false-positive regions
// in worn mirror-selfie shots.
function defaultNegativePrompt(category) {
  const cat = (category || "").toLowerCase();
  if (SHOE_RE.test(cat)) return "wall, floor, tile, marble, ground, leg, pants, trousers";
  return "";
}

async function fetchGsamVersion(token) {
  if (_gsamVersionHash) return _gsamVersionHash;
  const res = await fetch("https://api.replicate.com/v1/models/schananas/grounded_sam", {
    headers: { "Authorization": "Token " + token }
  });
  if (!res.ok) {
    const body = await res.text();
    console.log("grounded-sam: model fetch HTTP", res.status, body);
    return null;
  }
  const data = await res.json();
  const hash = data?.latest_version?.id ?? null;
  if (hash) _gsamVersionHash = hash;
  return hash;
}

// Extract URL at output[2] (binary mask) from a prediction object.
function maskOutputUrl(prediction) {
  const out = prediction?.output;
  return Array.isArray(out) && out.length >= 3 && typeof out[2] === "string" ? out[2] : null;
}

// ---------------------------------------------------------------------------
// largestMaskComponent — connected-component cleanup for noisy SAM masks.
//
// SAM occasionally leaves stray specks of mask elsewhere in the frame. The old
// crop took the bounding box of *all* lit pixels, so a single speck would
// inflate the box and shrink the real garment to a corner sliver. This finds
// every connected blob (4-connectivity, iterative flood fill) and returns a
// label map identifying the single largest one — the actual garment.
//
// Runs on a downscaled copy of the mask (cap CC_MAX px) so memory/CPU stay
// bounded regardless of source photo size.
// ---------------------------------------------------------------------------
function largestMaskComponent(mask, w, h, fgThreshold) {
  const total = w * h;
  const labels = new Int32Array(total).fill(-1);
  const stack = new Int32Array(total);
  let bestLabel = -1, bestCount = 0, curLabel = 0;

  for (let start = 0; start < total; start++) {
    if (labels[start] !== -1 || mask[start] <= fgThreshold) continue;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = curLabel;
    let count = 0;
    while (sp > 0) {
      const p = stack[--sp];
      count++;
      const px = p % w, py = (p - px) / w;
      if (px > 0)     { const n = p - 1; if (labels[n] === -1 && mask[n] > fgThreshold) { labels[n] = curLabel; stack[sp++] = n; } }
      if (px < w - 1) { const n = p + 1; if (labels[n] === -1 && mask[n] > fgThreshold) { labels[n] = curLabel; stack[sp++] = n; } }
      if (py > 0)     { const n = p - w; if (labels[n] === -1 && mask[n] > fgThreshold) { labels[n] = curLabel; stack[sp++] = n; } }
      if (py < h - 1) { const n = p + w; if (labels[n] === -1 && mask[n] > fgThreshold) { labels[n] = curLabel; stack[sp++] = n; } }
    }
    if (count > bestCount) { bestCount = count; bestLabel = curLabel; }
    curLabel++;
  }
  return { labels, bestLabel, bestCount };
}

/**
 * maskGarment(originalImageUrl, labelText) → Buffer | null
 *
 * Calls schananas/grounded_sam with the full original image URL and a text label.
 * Applies the returned binary mask to the original, auto-crops to the mask's
 * content bounds with ~5% padding, and resizes to a 400×400 transparent PNG.
 *
 * Returns a Buffer on success, null on any failure (network, empty mask, sharp error).
 * All failures are console.log'd with the label for Vercel log grep.
 */
async function _attemptMask(originalImageUrl, labelText, effectivePrompt, effectiveNegative, category) {
  console.log(`grounded-sam attempt label="${labelText}" prompt="${effectivePrompt}"`);
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return null;

  // Resolve version hash (cached after first call).
  let version;
  try {
    version = await fetchGsamVersion(token);
  } catch (err) {
    console.log(`grounded-sam: version fetch error for "${labelText}":`, err.message);
    return null;
  }
  if (!version) {
    console.log(`grounded-sam: could not resolve version hash for "${labelText}"`);
    return null;
  }

  // Submit prediction. Prefer: wait=5 resolves fast completions inline.
  const ENDPOINT = "https://api.replicate.com/v1/predictions";
  const headers = {
    "Authorization": "Token " + token,
    "Content-Type": "application/json",
    "Prefer": "wait=10"
  };

  console.log(`grounded-sam submit mask_prompt="${effectivePrompt}" (raw="${labelText}") negative_mask_prompt="${effectiveNegative}"`);
  const body = JSON.stringify({
    version,
    input: {
      image: originalImageUrl,
      mask_prompt: effectivePrompt,
      negative_mask_prompt: effectiveNegative,
      adjustment_factor: 0
    }
  });

  let prediction;
  try {
    const res = await fetch(ENDPOINT, { method: "POST", headers, body });
    if (!res.ok) {
      const text = await res.text();
      console.log(`grounded-sam: submit HTTP ${res.status} for "${labelText}":`, text);
      return null;
    }
    prediction = await res.json();
  } catch (err) {
    console.log(`grounded-sam: submit error for "${labelText}":`, err.message);
    return null;
  }

  if (prediction?.status === "failed" || prediction?.status === "canceled") {
    console.log(`grounded-sam: prediction ${prediction.status} for "${labelText}":`, prediction.error || "");
    return null;
  }

  // If not resolved inline, poll urls.get every 500 ms, budget ~10 s (20 attempts).
  if (prediction?.status !== "succeeded") {
    const pollUrl = prediction?.urls?.get;
    if (!pollUrl) {
      console.log(`grounded-sam: no urls.get in response for "${labelText}"`, JSON.stringify(prediction));
      return null;
    }

    let resolved = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const pollRes = await fetch(pollUrl, { headers: { "Authorization": "Token " + token } });
        if (!pollRes.ok) {
          console.log(`grounded-sam: poll HTTP ${pollRes.status} for "${labelText}"`);
          return null;
        }
        const poll = await pollRes.json();
        if (poll.status === "succeeded") { prediction = poll; resolved = true; break; }
        if (poll.status === "failed" || poll.status === "canceled") {
          console.log(`grounded-sam: prediction ${poll.status} for "${labelText}":`, poll.error || "");
          return null;
        }
      } catch (err) {
        console.log(`grounded-sam: poll error for "${labelText}":`, err.message);
        return null;
      }
    }

    if (!resolved) {
      console.log(`grounded-sam: polling timed out after 30 s for "${labelText}"`);
      return null;
    }
  }

  // Extract mask URL from output[2].
  const maskUrl = maskOutputUrl(prediction);
  if (!maskUrl) {
    console.log(`grounded-sam: no mask URL at output[2] for "${labelText}"`, JSON.stringify(prediction?.output));
    return null;
  }

  // Fetch the original image and mask JPEG in parallel.
  let originalBuf, maskBuf;
  try {
    const [origRes, maskRes] = await Promise.all([fetch(originalImageUrl), fetch(maskUrl)]);
    if (!origRes.ok) {
      console.log(`grounded-sam: original image fetch HTTP ${origRes.status} for "${labelText}"`);
      return null;
    }
    if (!maskRes.ok) {
      console.log(`grounded-sam: mask fetch HTTP ${maskRes.status} for "${labelText}"`);
      return null;
    }
    [originalBuf, maskBuf] = await Promise.all([
      origRes.arrayBuffer().then(ab => Buffer.from(ab)),
      maskRes.arrayBuffer().then(ab => Buffer.from(ab))
    ]);
  } catch (err) {
    console.log(`grounded-sam: download error for "${labelText}":`, err.message);
    return null;
  }

  // Apply mask as alpha channel, auto-crop to content bounds, resize to 400×400 PNG.
  try {
    // Decode original to raw RGBA.
    const { data: origData, info } = await sharp(originalBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const W = info.width;
    const H = info.height;

    // Decode mask to raw greyscale, stretched to match original dimensions.
    const { data: maskData } = await sharp(maskBuf)
      .greyscale()
      .resize(W, H, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // ── Mask cleanup — keep only the largest connected blob ─────────────────
    // Run connected-component analysis on a downscaled copy of the mask so a
    // stray speck of noise can't inflate the crop box and shrink the real
    // garment to a corner sliver. Pixels outside the largest blob are dropped.
    const CC_MAX = 384;
    const ccScale = Math.min(1, CC_MAX / Math.max(W, H));
    const ccW = Math.max(1, Math.round(W * ccScale));
    const ccH = Math.max(1, Math.round(H * ccScale));
    const { data: ccMask } = await sharp(maskBuf)
      .greyscale()
      .resize(ccW, ccH, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { labels, bestLabel, bestCount } = largestMaskComponent(ccMask, ccW, ccH, 60);

    if (bestLabel < 0) {
      console.log(`grounded-sam: empty mask (no visible pixels) for "${labelText}"`);
      return null;
    }

    // ── Quality gate ────────────────────────────────────────────────────────
    // If even the largest blob covers a trivially small share of the frame,
    // detection effectively failed — return null so the caller falls back to
    // the clean category icon instead of saving a broken-looking crop.
    const componentFraction = bestCount / (ccW * ccH);
    if (componentFraction < 0.015) {
      console.log(`grounded-sam: quality gate — largest component only ${(componentFraction * 100).toFixed(2)}% of frame for "${labelText}", skipping thumb`);
      return null;
    }

    // ── Shoe sanity checks ──────────────────────────────────────────────────
    // Shoes in a worn portrait shot must be small AND sit at the bottom of the
    // frame. A 25%+ blob is almost always the wall or the full body; a blob
    // whose vertical center is above the bottom 40% of the frame is also not
    // the shoes. Both checks short-circuit before we apply the mask so the
    // caller falls back to the bbox-crop path instead of saving a marble thumb.
    const cat = (category || "").toLowerCase();
    const sourceAspectGate = H / W;
    if (SHOE_RE.test(cat) && sourceAspectGate > 1.3) {
      if (componentFraction > 0.25) {
        console.log(`grounded-sam: shoe gate — blob too large (${(componentFraction * 100).toFixed(1)}% of frame) for "${labelText}", skipping thumb`);
        return null;
      }
      // Centroid Y of the largest blob in downscaled CC space.
      let sumY = 0;
      for (let p = 0; p < labels.length; p++) {
        if (labels[p] === bestLabel) sumY += Math.floor(p / ccW);
      }
      const centroidYNorm = (sumY / bestCount) / ccH;
      if (centroidYNorm < 0.60) {
        console.log(`grounded-sam: shoe gate — blob centroid Y=${centroidYNorm.toFixed(2)} above bottom 40% for "${labelText}", skipping thumb`);
        return null;
      }
    }

    // Write mask luma into the alpha channel, zeroing any pixel whose region
    // belongs to a smaller component (copy origData to avoid mutation), and
    // compute the bounding box of what survives.
    const pixels = Buffer.from(origData);
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y++) {
      const cy = Math.min(ccH - 1, Math.floor(y * ccScale));
      for (let x = 0; x < W; x++) {
        const cx = Math.min(ccW - 1, Math.floor(x * ccScale));
        const i = y * W + x;
        const a = labels[cy * ccW + cx] === bestLabel ? maskData[i] : 0;
        pixels[i * 4 + 3] = a;
        if (a > 20) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < minX || maxY < minY) {
      console.log(`grounded-sam: empty mask after cleanup for "${labelText}"`);
      return null;
    }

    // Alias content bounds as mutable — the category heuristic may shrink the vertical range.
    let contentTop = minY, contentBottom = maxY, contentLeft = minX, contentRight = maxX;

    const bboxHeight = contentBottom - contentTop;
    const bboxWidth  = contentRight  - contentLeft;
    const maskAspect   = bboxHeight / bboxWidth;
    const sourceAspect = H / W;

    // `cat` was hoisted earlier for the shoe sanity checks — reuse it here.
    let topPct = 0, bottomPct = 1;

    if (SHOE_RE.test(cat)) {
      topPct = 0.82; bottomPct = 1.0;
    } else if (TOP_RE.test(cat)) {
      topPct = 0.20; bottomPct = 0.65;
    } else if (BOTTOM_RE.test(cat)) {
      topPct = 0.35; bottomPct = 0.92;
    } else if (OUTER_RE.test(cat)) {
      topPct = 0.15; bottomPct = 0.75;
    } else if (SUIT_RE.test(cat)) {
      topPct = 0; bottomPct = 0.95;
    }

    // Portrait source image (H/W > 1.3) → likely a worn mirror selfie → apply category slice.
    // Landscape / square source → likely a flat-lay or hanger shot → use mask bbox as-is.
    const isPortrait = sourceAspect > 1.3;
    const sliced = isPortrait && !!category && (topPct !== 0 || bottomPct !== 1);

    console.log("grounded-sam:slice", { source_aspect: sourceAspect.toFixed(2), mask_aspect: maskAspect.toFixed(2), category, sliced, topPct, bottomPct });

    if (sliced) {
      const sliceTop    = contentTop + Math.floor(bboxHeight * topPct);
      const sliceBottom = contentTop + Math.floor(bboxHeight * bottomPct);
      contentTop    = sliceTop;
      contentBottom = sliceBottom;
    }

    // Add ~5% padding around the (possibly sliced) content bbox, clamped to image bounds.
    const contentW = contentRight - contentLeft + 1;
    const contentH = contentBottom - contentTop + 1;
    const padX = Math.max(1, Math.floor(contentW * 0.05));
    const padY = Math.max(1, Math.floor(contentH * 0.05));
    const cropLeft   = Math.max(0, contentLeft   - padX);
    const cropTop    = Math.max(0, contentTop    - padY);
    const cropRight  = Math.min(W - 1, contentRight  + padX);
    const cropBottom = Math.min(H - 1, contentBottom + padY);
    const cropW = cropRight  - cropLeft  + 1;
    const cropH = cropBottom - cropTop  + 1;

    return await sharp(pixels, { raw: { width: W, height: H, channels: 4 } })
      .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
      .resize(400, 400, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  } catch (err) {
    console.log(`grounded-sam: sharp processing error for "${labelText}":`, err.message);
    return null;
  }
}

/**
 * maskGarment — public entry point. Runs _attemptMask once with the category-
 * normalized prompt. If that returns null and the category is a shoe, retries
 * once with a body-context prompt ("shoes on feet") to give DINO a second
 * anchor when the bare noun fails to ground in busy backgrounds.
 *
 * Cost: one extra Replicate call only on shoe failures. All other categories
 * are unchanged — single attempt, fail-through to caller's fallback path.
 */
export async function maskGarment(originalImageUrl, labelText, negativeLabelText = "", category = "") {
  const cat = (category || "").toLowerCase();
  const primaryPrompt   = normalizeMaskPrompt(labelText, category);
  const primaryNegative = negativeLabelText || defaultNegativePrompt(category);

  const first = await _attemptMask(originalImageUrl, labelText, primaryPrompt, primaryNegative, category);
  if (first) return first;

  if (SHOE_RE.test(cat) && primaryPrompt !== "shoes on feet") {
    console.log(`grounded-sam: shoe retry for "${labelText}" with prompt "shoes on feet"`);
    const retry = await _attemptMask(originalImageUrl, labelText, "shoes on feet", primaryNegative, category);
    if (retry) return retry;
  }

  return null;
}
