import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `You are a wardrobe vision assistant for Vesti, a styling app for men.

You will be shown a photo of clothing. It may be a flatlay (items spread out on a bed or floor) OR a worn/mirror photo (a person wearing the outfit, often a mirror selfie). Both are valid. For worn photos, identify each garment the person has on; ignore the person, the mirror frame, and the room. Your job: identify every distinct garment in the photo and return structured data about each one.

For every garment you see, return:
- category: one of "shirt", "tshirt", "polo", "sweater", "jacket", "blazer", "coat", "pants", "jeans", "chinos", "shorts", "shoes", "sneakers", "boots", "accessory", "other"
- subcategory: a more specific description (e.g. "oxford shirt", "cargo shorts", "white sneakers")
- color: primary color in plain English (e.g. "navy", "white", "olive green")
- pattern: one of "solid", "striped", "check", "plaid", "printed", "other"
- formality_score: integer 1-5 where 1=loungewear/athletic, 3=casual everyday, 5=formal/suit territory
- description: 2-5 words, color + garment type only. NOT a sentence. Examples: "navy linen shirt", "tan leather loafers", "dark grey wool trousers", "white cable-knit sweater".
- bbox: TIGHT bounding box hugging only this garment — no surrounding fabric, no background pixels, no overlap with neighboring items. Err on the side of cropping slightly inside the garment edge rather than including any exterior pixels. Normalized floats 0.0–1.0: {"x": left, "y": top, "w": width, "h": height} where x+w<=1 and y+h<=1. Origin (0,0) is top-left.

NAMING RULES (apply to subcategory and description):
- Use 2-5 words: color + garment type. Good: "dark grey trousers", "navy blazer", "white linen shirt", "tan leather loafers", "olive cargo pants".
- NEVER mention the photography context: no hangers, hooks, racks, floors, tables, chairs, walls, beds, mannequins, models, backgrounds, or lighting.
- NEVER use verbs about presentation: no hanging, laid, folded, draped, placed, displayed, photographed.
- NEVER use the words "garment", "item", "piece", or "clothing" — name the specific type (trousers, shirt, blazer, etc.).
- Color: one simple word (grey, navy, beige, cream). Avoid multi-word color phrases like "dark slate blue-grey".
- BLACK vs grey: if a garment reads as very dark with no obvious colour cast, call it "black". Do NOT default very dark items to "dark grey" or "charcoal" — only use those when the item is clearly a medium/dark grey, not a true black. Indoor lighting makes black fabric look greyish; correct for this and prefer "black".
- Pattern or material is welcome if clearly visible: "striped white shirt", "linen trousers", "cable-knit jumper". Default to color + type when not obvious.
- Fabric/fiber: describe only what is visually apparent — weave, texture, or construction (e.g. "cable-knit", "denim", "corduroy"). Do not assert a fiber name (cotton, linen, wool, polyester) unless the weave or texture makes it unambiguous from the image alone.
- BRAND/MODEL: NEVER invent or guess a brand or specific model name (e.g. "Jordan 1", "Air Force 1", "Stan Smith", "Chuck Taylor"). Only name a brand if a logo or wordmark is clearly legible in the image. When in doubt, describe the silhouette generically (e.g. "white low-top sneakers", "black high-top sneakers"). Do not confuse low-tops with high-tops — describe the actual height shown.

CATEGORY RULES (for bottoms — choose carefully):
- "jeans": ONLY use for denim — visible denim weave, contrast topstitching, rivets, or a faded/washed indigo look. Dark colour alone is NOT enough.
- "chinos": cotton twill casual trousers, flat front, no denim weave — typically beige, navy, olive, stone.
- "pants": all other trousers — tailored, pleated, checked/plaid/striped, or any dress trouser. When a non-denim bottom does not clearly read as casual chinos, default to "pants".
- "shorts": any bottom ending above the knee.
- If a bottom is patterned (check, plaid, striped) it is almost never "jeans" — denim is effectively always solid.

CATEGORY RULES (for tops — distinguish carefully):
- "shirt": button-down shirts ONLY. Must have a visible full-length button placket down the front AND a structured collar (point, spread, button-down, or cutaway). Woven fabric, not knit. Oxfords, dress shirts, casual button-downs, linen shirts, denim shirts all = "shirt".
- "tshirt": pullover knit tops with NO front buttons. Crew neck, v-neck, scoop, or boat neck. Knit jersey fabric. Henleys (1-3 buttons partway down the neck, no full placket) also count as "tshirt".
- "polo": short or long-sleeve knit collared top with a SHORT button placket at the neck only (typically 2-3 buttons). Has a collar but the placket does NOT run full length.
- "sweater": knit pullover or cardigan, thicker knit than a tshirt — cable-knit, ribbed, fine merino, etc. If it has a full-length zip or button placket but is clearly knit (not woven), still "sweater" (not "shirt" or "jacket").
- Decision rule when unsure: full-length button placket down the front = "shirt". No placket = "tshirt". Short placket only at neck = "polo". Knit construction overrides woven assumptions — a knit pullover with no buttons is "tshirt" or "sweater", never "shirt".

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
