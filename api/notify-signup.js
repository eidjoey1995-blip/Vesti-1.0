// =========================================================
// POST /api/notify-signup
//
// Called by a Supabase trigger on auth.users INSERT (see the
// SQL in the build notes). Sends Joey an email whenever a new
// user signs up for the BETA.
//
// Auth: shared secret in the `x-notify-secret` header, matched
// against NOTIFY_SECRET. This is NOT a user-facing endpoint —
// the secret keeps randoms from spamming the inbox / burning
// the Resend quota if they discover the URL.
//
// Body (sent by the trigger): { email, id, created_at }
//
// Env vars:
//   RESEND_API_KEY   — Resend API key (re_...)
//   NOTIFY_SECRET    — shared secret, also embedded in the SQL trigger
// =========================================================

const ALERT_TO   = "eidjoey1995@gmail.com";
const ALERT_FROM = "Vesti <onboarding@resend.dev>";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: { code: "method_not_allowed", message: "POST only" } });
  }

  const resendKey = process.env.RESEND_API_KEY;
  const secret    = process.env.NOTIFY_SECRET;
  if (!resendKey || !secret) {
    return res.status(500).json({
      error: { code: "missing_env", message: "RESEND_API_KEY and NOTIFY_SECRET must be set in Vercel env vars." }
    });
  }

  // ── Verify the shared secret ───────────────────────────────────────────────
  const provided = (req.headers["x-notify-secret"] || "").trim();
  if (provided !== secret) {
    return res.status(401).json({ error: { code: "unauthorized", message: "Bad or missing notify secret" } });
  }

  // ── Read the payload ───────────────────────────────────────────────────────
  const body = req.body || {};
  const email     = typeof body.email === "string" ? body.email : "(unknown email)";
  const userId    = typeof body.id === "string" ? body.id : "(unknown id)";
  const createdAt = typeof body.created_at === "string" ? body.created_at : new Date().toISOString();

  // ── Send the alert via the Resend REST API (no SDK dependency) ─────────────
  try {
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: ALERT_FROM,
        to: ALERT_TO,
        subject: `New Vesti signup: ${email}`,
        text:
          `A new user just signed up for the Vesti BETA.\n\n` +
          `Email:      ${email}\n` +
          `User ID:    ${userId}\n` +
          `Signed up:  ${createdAt}\n`,
      }),
    });

    if (!resendRes.ok) {
      const detail = await resendRes.text().catch(() => "");
      console.warn("notify-signup: Resend error", resendRes.status, detail);
      return res.status(502).json({
        error: { code: "resend_failed", message: `Resend HTTP ${resendRes.status}` }
      });
    }
  } catch (e) {
    console.warn("notify-signup: send exception:", e?.message || e);
    return res.status(502).json({ error: { code: "resend_failed", message: e?.message || String(e) } });
  }

  return res.status(200).json({ ok: true });
}
