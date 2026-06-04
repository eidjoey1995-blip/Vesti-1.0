// =========================================================
// Color sanity check — compares a thumb's dominant hex against
// the declared garment color (from Claude vision). Used by
// save-garments.js to drop fallback-path thumbs whose dominant
// color is wildly different from what Claude said the garment is.
//
// Math: sRGB → CIE Lab → CIE76 ΔE (Euclidean distance in Lab).
// CIE76 is a "good enough" perceptual distance for our threshold
// of ~25 (the level at which two colors are obviously different
// to a human). CIEDE2000 is more accurate but not worth the math
// for a yes/no gate.
//
// Returns null when we can't compute (unknown color name or
// malformed hex), letting the caller skip the check rather than
// false-positive on edge cases.
// =========================================================

// Reference RGB triplets for the color words Claude returns in g.color.
// Keep this aligned with the segment-garments system prompt's color examples.
// Values chosen as the "canonical" centroid of each color family — close
// enough that a real garment of that color produces ΔE << 25.
const COLOR_RGB = {
  white:        [245, 245, 245],
  "off-white":  [240, 235, 225],
  cream:        [240, 230, 210],
  ivory:        [245, 240, 220],
  beige:        [210, 190, 160],
  tan:          [195, 165, 120],
  khaki:        [180, 165, 120],
  sand:         [210, 195, 160],
  stone:        [195, 185, 165],
  brown:        [110,  80,  55],
  chocolate:    [ 80,  55,  40],
  "dark brown": [ 70,  50,  35],
  black:        [ 25,  25,  25],
  charcoal:     [ 55,  55,  55],
  grey:         [130, 130, 130],
  gray:         [130, 130, 130],
  "dark grey":  [ 75,  75,  75],
  "dark gray":  [ 75,  75,  75],
  "light grey": [185, 185, 185],
  "light gray": [185, 185, 185],
  navy:         [ 30,  45,  85],
  blue:         [ 55,  95, 170],
  "dark blue":  [ 35,  60, 120],
  "light blue": [150, 190, 220],
  "sky blue":   [135, 200, 230],
  teal:         [ 30, 130, 140],
  green:        [ 70, 130,  70],
  "dark green": [ 45,  85,  45],
  olive:        [110, 115,  60],
  "olive green":[100, 110,  55],
  forest:       [ 50,  95,  55],
  red:          [180,  45,  45],
  burgundy:     [115,  35,  45],
  maroon:       [110,  35,  45],
  pink:         [225, 165, 180],
  purple:       [120,  70, 140],
  yellow:       [230, 200,  80],
  mustard:      [205, 165,  50],
  orange:       [225, 130,  60],
  rust:         [165,  80,  45],
};

function hexToRgb(hex) {
  if (typeof hex !== "string") return null;
  const m = hex.trim().toLowerCase().match(/^#?([0-9a-f]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// sRGB (0–255) → linear RGB (0–1).
function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

// Linear RGB → CIE XYZ (D65).
function rgbToXyz([r, g, b]) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const x = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
  const y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
  const z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;
  return [x, y, z];
}

// CIE XYZ → CIE Lab (D65 reference white).
function xyzToLab([x, y, z]) {
  const xn = x / 0.95047, yn = y / 1.00000, zn = z / 1.08883;
  const f = (t) => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(xn), fy = f(yn), fz = f(zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function rgbToLab(rgb) {
  return xyzToLab(rgbToXyz(rgb));
}

/**
 * colorDistance(hex, colorName) → number | null
 *
 * Returns CIE76 ΔE between the hex color and the canonical RGB for the
 * given color name. Returns null when the color name isn't in the table
 * or the hex is malformed — let the caller treat null as "no signal,
 * skip the check" rather than guessing.
 */
export function colorDistance(hex, colorName) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const key = (colorName || "").trim().toLowerCase();
  if (!key) return null;

  // Exact match first; then fall back to a substring lookup so phrases like
  // "navy blue" or "dark olive" still resolve.
  let ref = COLOR_RGB[key];
  if (!ref) {
    for (const k of Object.keys(COLOR_RGB)) {
      if (key.includes(k)) { ref = COLOR_RGB[k]; break; }
    }
  }
  if (!ref) return null;

  const lab1 = rgbToLab(rgb);
  const lab2 = rgbToLab(ref);
  const dL = lab1[0] - lab2[0];
  const da = lab1[1] - lab2[1];
  const db = lab1[2] - lab2[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}
