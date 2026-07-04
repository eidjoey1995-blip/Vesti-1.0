// =========================================================
// Shared JWT resolver for all authenticated API routes.
//
// Extracts the Supabase access token from the Authorization
// header ("Bearer <token>") and validates it via
// supabase.auth.getUser(). user_id is ALWAYS derived from the
// token — never trusted from the request body.
//
// Usage in an API route:
//   const { userId, err } = await resolveUser(req, supabase);
//   if (err) return res.status(401).json({ error: err });
//
// Returns:
//   { userId, email, err: null }        on success
//   { userId: null, email: null, err }  on failure —
//     err is a ready-to-send { code, message } error body (401).
// =========================================================
export async function resolveUser(req, supabase) {
  const auth = (req.headers.authorization || "").trim();
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    return { userId: null, email: null, err: { code: "unauthorized", message: "Authorization header required" } };
  }
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return { userId: null, email: null, err: { code: "unauthorized", message: error?.message || "Invalid token" } };
  }
  return { userId: user.id, email: user.email, err: null };
}
