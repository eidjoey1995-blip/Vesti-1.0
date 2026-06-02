// =========================================================
// Perceptual colour distance (CIE Lab ΔE) for garment dedup.
//
// Why Lab instead of raw RGB:
//   RGB distance treats (255,0,0) vs (0,255,0) the same as
//   (100,100,100) vs (110,100,100) — even though humans see
//   the first pair as "red vs green" and the second as
//   "basically identical grey". Lab space is built to match
//   human perception, so a small ΔE means "looks the same to
//   a person", which is exactly the question we're asking.
//
// Pipeline: hex → sRGB → linear RGB → XYZ (D65) → Lab → ΔE.
// CIE76 ΔE is "good enough" for our use case; CIE2000 is
// more accurate but the math is 5x longer and the difference
// at our thresholds is negligible.
//
// Thresholds (empirically tuned for clothing photos):
//   ΔE < 10  → strong   ("almost certainly the same garment")
//   ΔE < 20  → borderline ("might be the same — ask the user")
//   ΔE >= 20 → different
// =========================================================

function hexToRgb(hex) {
  if (typeof hex !== "string") return null;
  const clean = hex.replace(/^#/, "").trim();
  if (clean.length !== 6) return null;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return [r, g, b];
}

function srgbToLinear(channel) {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function rgbToXyz([r, g, b]) {
  const rL = srgbToLinear(r);
  const gL = srgbToLinear(g);
  const bL = srgbToLinear(b);
  // sRGB D65 matrix
  return [
    rL * 0.4124564 + gL * 0.3575761 + bL * 0.1804375,
    rL * 0.2126729 + gL * 0.7151522 + bL * 0.0721750,
    rL * 0.0193339 + gL * 0.1191920 + bL * 0.9503041,
  ];
}

function xyzToLab([x, y, z]) {
  // D65 reference white
  const Xn = 0.95047, Yn = 1.00000, Zn = 1.08883;
  const f = (t) => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(x / Xn), fy = f(y / Yn), fz = f(z / Zn);
  return [
    116 * fy - 16,
    500 * (fx - fy),
    200 * (fy - fz),
  ];
}

export function hexToLab(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return xyzToLab(rgbToXyz(rgb));
}

// CIE76 ΔE — simple Euclidean distance in Lab space.
export function labDistance(labA, labB) {
  if (!labA || !labB) return Infinity;
  const dL = labA[0] - labB[0];
  const da = labA[1] - labB[1];
  const db = labA[2] - labB[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

// Convenience: classify two hexes into a dedup confidence band, or null.
// Returns { distance, confidence } where confidence is 'strong' | 'borderline' | null.
export function classifyHexPair(hexA, hexB, { strong = 10, borderline = 20 } = {}) {
  const labA = hexToLab(hexA);
  const labB = hexToLab(hexB);
  if (!labA || !labB) return { distance: Infinity, confidence: null };
  const distance = labDistance(labA, labB);
  let confidence = null;
  if (distance < strong) confidence = "strong";
  else if (distance < borderline) confidence = "borderline";
  return { distance, confidence };
}
