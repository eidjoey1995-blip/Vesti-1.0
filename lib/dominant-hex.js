import sharp from "sharp";

// =========================================================
// Dominant-colour extraction for garment dedup.
// Run on a thumbnail buffer (PNG with transparent bg, or JPEG).
// Resize to 64x64 for speed, drop transparent + near-white +
// near-black pixels, average the rest. Returns "#rrggbb" or null.
// Cost: ~5ms per thumb on a warm sharp instance, no token spend.
// =========================================================
export async function extractDominantHex(buf) {
  if (!buf) return null;
  try {
    const { data } = await sharp(buf)
      .resize(64, 64, { fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let r = 0, g = 0, b = 0, count = 0;
    for (let p = 0; p < data.length; p += 4) {
      const a = data[p + 3];
      if (a < 128) continue;                                   // skip transparent (RMBG bg)
      const rr = data[p], gg = data[p + 1], bb = data[p + 2];
      if (rr > 240 && gg > 240 && bb > 240) continue;          // skip near-white (JPEG bg)
      if (rr < 12  && gg < 12  && bb < 12 ) continue;          // skip near-black noise
      r += rr; g += gg; b += bb; count++;
    }
    if (count === 0) return null;
    const avgR = Math.round(r / count);
    const avgG = Math.round(g / count);
    const avgB = Math.round(b / count);
    return "#" + [avgR, avgG, avgB].map(n => n.toString(16).padStart(2, "0")).join("");
  } catch (err) {
    console.warn("extractDominantHex failed:", err.message);
    return null;
  }
}
