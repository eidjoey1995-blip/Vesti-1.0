import { createClient } from "@supabase/supabase-js";

// =========================================================
// Shared Supabase service-role client factory.
//
// Usage in an API route:
//   const { supabase, envErr } = getServiceClient();
//   if (envErr) return res.status(500).json({ error: envErr });
//
// Returns:
//   { supabase, envErr: null }  on success
//   { supabase: null, envErr }  when env vars are missing —
//     envErr is a ready-to-send { code, message } error body.
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY
// =========================================================
export function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    return {
      supabase: null,
      envErr: { code: "missing_env", message: "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in Vercel env vars." }
    };
  }
  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  return { supabase, envErr: null };
}
