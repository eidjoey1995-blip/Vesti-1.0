import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `You are a wardrobe vision assistant for Vesti, a styling app for men.
You will be shown a flatlay photo of clothing items spread out (e.g. on a bed or floor).

Your job: identify every distinct garment in the photo and return structured data about each one.

For every garment you see, return:
- category: one of "shirt", "tshirt", "polo", "sweater", "jacket", "blazer", "coat", "pants", "jeans", "chinos", "shorts", "shoes", "sneakers", "boots", "accessory", "other"
- subcategory: a more specific description (e.g. "oxford shirt", "cargo shorts", "white sneakers")
- color: primary color in plain English (e.g. "navy", "white", "olive green")
- pattern: one of "solid", "striped", "check", "plaid", "printed", "other"
- formality_score: integer 1-5 where 1=loungewear/athletic, 3=casual everyday, 5=formal/suit territory
- description: one sentence describing the item

Return JSON only, no other text. Format:
{
  "garments": [
    {
      "category": "...",
      "subcategory": "...",
      "color": "...",
      "pattern": "...",
      "formality_score": 3,
      "description": "..."
    }
  ]
}`;

export default async function handler(req, res) {
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
              text: "Identify every garment in this flatlay. Return JSON only.",
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
