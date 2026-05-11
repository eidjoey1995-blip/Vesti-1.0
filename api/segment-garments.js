import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `You are a wardrobe vision assistant for Vesti, a styling app for men.

You will be shown a flatlay photo of clothing items spread out (e.g. on a bed or floor). Your job: identify every distinct garment in the photo and return structured data about each one.

For every garment you see, return:
- category: one of "shirt", "tshirt", "polo", "sweater", "jacket", "blazer", "coat", "pants", "jeans", "chinos", "shorts", "shoes", "sneakers", "boots", "accessory", "other"
- subcategory: a more specific description (e.g. "oxford shirt", "cargo shorts", "white sneakers")
- color: primary color in plain English (e.g. "navy", "white", "olive green")
- pattern: one of "solid", "striped", "check", "plaid", "printed", "other"
- formality_score: integer 1-5 where 1=loungewear/athletic, 3=casual everyday, 5=formal/suit territory
- description: one sentence describing the item
- bbox: TIGHT bounding box hugging only this garment — no surrounding fabric, no background pixels, no overlap with neighboring items. Err on the side of cropping slightly inside the garment edge rather than including any exterior pixels. Normalized floats 0.0–1.0: {"x": left, "y": top, "w": width, "h": height} where x+w<=1 and y+h<=1. Origin (0,0) is top-left.

Return JSON only, no other text. Format:
{
  "garments": [
    {
      "category": "...",
      "subcategory": "...",
      "color": "...",
      "pattern": "...",
      "formality_score": 3,
      "description": "...",
      "bbox": { "x": 0.12, "y": 0.34, "w": 0.25, "h": 0.40 }
    }
  ]
}`;

export default async function handler(req, res) {
  console.log("ANTHROPIC_API_KEY length:", (process.env.ANTHROPIC_API_KEY || "").length);
  console.log("ANTHROPIC_API_KEY prefix:", (process.env.ANTHROPIC_API_KEY || "MISSING").slice(0, 13));

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { photoUrl, photoBase64, mediaType } = req.body || {};
  if (!photoUrl && !photoBase64) {
    return res.status(400).json({ error: "photoUrl or photoBase64 required" });
  }

  try {
    let imageData;
    let imageMediaType = mediaType || "image/jpeg";

    if (photoBase64) {
      imageData = photoBase64;
    } else {
      const imgRes = await fetch(photoUrl);
      if (!imgRes.ok) {
        return res.status(400).json({ error: "Could not fetch image from photoUrl" });
      }
      const imgBuffer = await imgRes.arrayBuffer();
      imageData = Buffer.from(imgBuffer).toString("base64");
      imageMediaType = imgRes.headers.get("content-type") || "image/jpeg";
    }

    // Normalize: bake EXIF rotation, convert HEIC/PNG/WebP → JPEG so Claude
    // always receives a format it handles. If HEIC and sharp can't decode it
    // (libvips built without HEIF), surface a clear 415 rather than a crash.
    const rawBuf = Buffer.from(imageData, "base64");
    try {
      const jpegBuf = await sharp(rawBuf).rotate().jpeg({ quality: 90 }).toBuffer();
      imageData = jpegBuf.toString("base64");
      imageMediaType = "image/jpeg";
    } catch (normErr) {
      const isHeic = rawBuf.length >= 12 && rawBuf.slice(4, 8).toString("ascii") === "ftyp";
      if (isHeic) {
        return res.status(415).json({ error: "HEIC conversion failed — please convert to JPEG and try again." });
      }
      // Non-HEIC normalization failure: proceed with original data and let Claude handle it.
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: imageMediaType,
                data: imageData,
              },
            },
            {
              type: "text",
              text: "Identify every garment in this flatlay. Return JSON only. For each garment include a TIGHT bbox hugging only that garment — no background, no neighboring items. Err inside rather than outside.",
            },
          ],
        },
      ],
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const json = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    return res.status(200).json(json);
  } catch (err) {
    console.error("segment-garments error:", err);
    return res.status(500).json({ error: err.message });
  }
}
