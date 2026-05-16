import { maskGarment } from "../lib/grounded-sam.js";

export const maxDuration = 30;

const WARMER_URL = "https://tmgftqnekispazjfnqxw.supabase.co/storage/v1/object/public/garment-thumbs/_warmer.jpeg";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "GET only" });
  }

  console.log("warm-sam: start");
  const t0 = Date.now();
  let warm = false;
  let errMsg;

  try {
    const buf = await maskGarment(WARMER_URL, "shirt", "", "");
    warm = buf !== null;
  } catch (err) {
    errMsg = err?.message || String(err);
    console.log("warm-sam: error", errMsg);
  }

  const ms = Date.now() - t0;
  console.log(`warm-sam: done warm=${warm} ms=${ms}`);

  const body = { ok: true, warm, ms };
  if (errMsg) body.err = errMsg;
  return res.status(200).json(body);
}
