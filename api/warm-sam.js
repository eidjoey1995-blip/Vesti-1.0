import { waitUntil } from "@vercel/functions";
import { maskGarment } from "../lib/grounded-sam.js";

export const maxDuration = 60;

const WARMER_URL = "https://tmgftqnekispazjfnqxw.supabase.co/storage/v1/object/public/garment-thumbs/_warmer.jpeg";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "GET only" });
  }

  console.log("warm-sam: start, responding immediately");

  // Respond to the client right away so cron-job.org gets its 200 OK
  // well within its 30-second timeout.
  res.status(200).json({ ok: true, warming: true });

  // Run the Replicate call after the response is sent. waitUntil keeps the
  // Vercel function alive until the promise settles (up to maxDuration).
  waitUntil(
    (async () => {
      const t0 = Date.now();
      try {
        const buf = await maskGarment(WARMER_URL, "shirt", "", "");
        const ms = Date.now() - t0;
        console.log(`warm-sam: done warm=${buf !== null} ms=${ms}`);
      } catch (err) {
        const ms = Date.now() - t0;
        console.log(`warm-sam: error ms=${ms}`, err?.message || String(err));
      }
    })()
  );
}
