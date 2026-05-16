import sharp from "sharp";

// Module-level version hash cache — survives across requests on the same warm instance.
let _gsamVersionHash = null;

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
export async function maskGarment(originalImageUrl, labelText, negativeLabelText = "", category = "") {
  console.log("grounded-sam attempt label=" + labelText);
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
  console.log(`grounded-sam submit mask_prompt="${labelText}" negative_mask_prompt="${negativeLabelText}"`);
  const body = JSON.stringify({
    version,
    input: {
      image: originalImageUrl,
      mask_prompt: labelText,
      negative_mask_prompt: negativeLabelText,
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

    // Write mask luma into the alpha channel (copy origData to avoid mutation).
    const pixels = Buffer.from(origData);
    for (let i = 0; i < W * H; i++) {
      pixels[i * 4 + 3] = maskData[i];
    }

    // Compute bounding box of non-transparent pixels (alpha threshold > 20).
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (pixels[(y * W + x) * 4 + 3] > 20) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < minX || maxY < minY) {
      console.log(`grounded-sam: empty mask (no visible pixels) for "${labelText}"`);
      return null;
    }

    // Reject if the detected subject is less than 5% of the frame area.
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    const subjectFraction = (bboxW * bboxH) / (W * H);
    if (subjectFraction < 0.05) {
      console.log(`grounded-sam: mask too small for "${labelText}" (${(subjectFraction * 100).toFixed(1)}% of frame)`);
      return null;
    }

    // Alias content bounds as mutable — the category heuristic may shrink the vertical range.
    let contentTop = minY, contentBottom = maxY, contentLeft = minX, contentRight = maxX;

    // Whole-figure detection: if mask aspect ratio is tall (>1.4), it's likely the full person
    // not a single garment. Apply category-based vertical slice to focus on the relevant region.
    const bboxHeight = contentBottom - contentTop;
    const bboxWidth  = contentRight  - contentLeft;
    const aspectRatio = bboxHeight / bboxWidth;

    const cat = category.toLowerCase();
    let topPct = 0, bottomPct = 1;

    if (/(shoe|shoes|sneakers|boots|sandals|loafers|trainers|low.?top|high.?top)/.test(cat)) {
      topPct = 0.78; bottomPct = 1.0;
    } else if (/(top|tops|t.?shirt|tee|shirt|blouse|sweater|hoodie|knit|polo)/.test(cat)) {
      topPct = 0; bottomPct = 0.55;
    } else if (/(bottom|bottoms|pants|chinos|trousers|jeans|shorts|skirt)/.test(cat)) {
      topPct = 0.35; bottomPct = 0.92;
    } else if (/(outerwear|jacket|coat|blazer)/.test(cat)) {
      topPct = 0; bottomPct = 0.70;
    } else if (/(suit|suits|dress|jumpsuit)/.test(cat)) {
      topPct = 0; bottomPct = 0.95;
    }

    console.log(`grounded-sam bbox-check label=${labelText} category=${category} aspect=${aspectRatio.toFixed(2)} sliced=${topPct !== 0 || bottomPct !== 1}`);

    if (aspectRatio > 1.4 && category && (topPct !== 0 || bottomPct !== 1)) {
      const sliceTop    = contentTop + Math.floor(bboxHeight * topPct);
      const sliceBottom = contentTop + Math.floor(bboxHeight * bottomPct);
      contentTop    = sliceTop;
      contentBottom = sliceBottom;

      console.log(`grounded-sam crop category=${category} aspect=${aspectRatio.toFixed(2)} slice=${topPct}-${bottomPct}`);
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
