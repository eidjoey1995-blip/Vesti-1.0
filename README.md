# Vesti — V1 BETA

AI wardrobe and personal stylist for men, MENA-first (Beirut baseline; Dubai, Riyadh, New York overlays). Users photograph their clothes; Claude vision segments and catalogs each garment; an AI stylist picks outfits from the user's own closet for a given occasion, grounded in a proprietary styling methodology (the **codex**, see `lib/codex.js`).

**Live at:** vesti-1-0.vercel.app

## Stack

| Layer | Tech |
|---|---|
| Frontend | Static HTML + vanilla JS (no framework, no build step). PWA-installable. EN/AR with RTL. |
| API | Vercel serverless functions (`/api/*.js`, ES modules, Node) |
| DB / Auth / Storage | Supabase (Postgres, magic-link auth, `garment-thumbs` storage bucket) |
| AI | Claude (garment vision + stylist), Replicate (851-labs background remover, Grounded-SAM masking) |
| Weather | OpenWeather (optional — stylist degrades gracefully without it) |
| Email | Resend (signup notifications) |

Dependencies (4): `@anthropic-ai/sdk`, `@supabase/supabase-js`, `@vercel/functions`, `sharp`.

## Pages

| File | Purpose |
|---|---|
| `index.html` | Landing + magic-link login entry |
| `login.html` | Login |
| `onboarding.html` | Photo upload → segmentation → save to closet (`?add=true` re-enters from closet) |
| `app.html` | The app: closet (tabs + sub-sections), item detail, stylist, gaps, profile |
| `test-segment.html` | Dev-only harness for the segmentation endpoint |

## Auth pattern

All user-facing endpoints require `Authorization: Bearer <supabase_access_token>`. `user_id` is **always** derived from the JWT server-side (`lib/auth.js → resolveUser`) — never accepted from the request body. Every DB query is scoped `.eq("user_id", userId)`.

## API endpoints

All routes live in `/api`. Bodies and responses are JSON. Errors are `{ error: { code, message, details? } }`.

### Closet
| Endpoint | Method | Auth | Body / Query | Returns |
|---|---|---|---|---|
| `/api/segment-garments` | POST | JWT | image (base64) | Detected garments: name, category, color, formality, pattern, bbox |
| `/api/save-garments` | POST | JWT | `{ city?, source_photo_url?, garments[] }` | Saves rows; generates cutout thumbs via Replicate RMBG (JPEG fallback); extracts dominant hex |
| `/api/get-closet` | GET | JWT | `?limit&cursor&category` | Paginated garments (dupes hidden) |
| `/api/update-garment` | POST | JWT | `{ garment_id, updates: { name?, category?, sub_category?, color?, formality_score?, pattern?, fabric? } }` | Whitelist update; logs to `garment_corrections` |
| `/api/delete-garment` | POST | JWT | `{ garment_id }` | Deletes row + storage objects + cascades orphaned outfits |
| `/api/find-dupes` | POST | JWT | `{ candidate_ids[] }` | Closest Lab-color match per candidate: ΔE<10 strong, <20 borderline. Pure pixel math, zero tokens |
| `/api/confirm-dupe` | POST | JWT | `{ candidate_id, dupe_of_id, confidence }` | Marks duplicate (hidden from grid). Both garments ownership-verified |
| `/api/link-suit` | POST | JWT | `{ garment_ids[] , unlink? }` | Links/unlinks pieces into a suit set (stylist never splits a suit) |
| `/api/get-gaps` | GET | JWT | — | Missing foundational pieces vs Methodology §5b baseline |
| `/api/get-stats` | GET | JWT | — | `{ garments_count, outfits_count, days_active }` |

### Stylist
| Endpoint | Method | Auth | Body / Query | Returns |
|---|---|---|---|---|
| `/api/stylist` | POST | JWT | `{ occasion, avoid_garment_ids?, keep_garment_ids?, rejected_garment_ids? }` | `{ outfit_id, outfit: { items[], reasoning }, occasion, city }`. Codex-grounded; validates picks against closet; enforces suit integrity; injects live weather |
| `/api/todays-outfit` | GET | JWT | — | Daily outfit, cached per day via `for_date` |
| `/api/swipe` | POST | JWT | `{ outfit_id, signal: "yes"\|"no"\|"refresh", rejected_garment_ids? }` | Records feedback signal for future personalization |
| `/api/pair-garment` | POST | JWT | `{ garment_id }` | 2–3 closet pieces that pair with the target, each with a one-line reason |

### Profile / infra
| Endpoint | Method | Auth | Body / Query | Returns |
|---|---|---|---|---|
| `/api/update-profile` | GET/POST | JWT | POST: `{ daily_register?, first_name?, city? }` (strict whitelist) | Profile read/write |
| `/api/auth-config` | GET | none | — | Public Supabase URL + anon key for client init |
| `/api/warm-sam` | GET | none | — | Fire-and-forget Replicate model warm-up (call before onboarding; the 24/7 cron was retired) |
| `/api/notify-signup` | POST | `x-notify-secret` header | `{ email, id, created_at }` (sent by Supabase trigger) | Emails Joey on new signup via Resend |
| `/api/backfill-hex` | GET | `?secret=BACKFILL_SECRET` | `&limit=200` | One-shot maintenance: backfills `dominant_hex`. Idempotent |

## Shared libs (`/lib`)

| File | Purpose |
|---|---|
| `auth.js` | `resolveUser(req, supabase)` — JWT → `{ userId, email, err }` |
| `supabase.js` | `getServiceClient()` — service-role client factory + env check |
| `codex.js` | **The styling methodology.** City overlays (§5.0) + occasion entries (§5), versioned (`CODEX_VERSION`). Edit here, not in stylist.js |
| `color-distance.js` | Hex → Lab conversion + CIE76 ΔE (dupe detection) |
| `color-sanity.js` | Color sanity checks (white-lightness floor etc.) |
| `dominant-hex.js` | Dominant color extraction from thumbs |
| `grounded-sam.js` | Replicate Grounded-SAM garment masking |

## Environment variables (Vercel)

| Var | Used for |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Server-side DB/storage (service role) |
| `SUPABASE_ANON_KEY` | Served to clients via `/api/auth-config` |
| `ANTHROPIC_API_KEY` | Claude vision + stylist |
| `REPLICATE_API_TOKEN` | Background removal + Grounded-SAM |
| `OPENWEATHER_API_KEY` | Optional weather injection in stylist |
| `RESEND_API_KEY`, `NOTIFY_SECRET` | Signup notification email |
| `BACKFILL_SECRET` | Guards `/api/backfill-hex` |

## Database

Supabase Postgres. Main tables: `garments`, `outfits` (note: has both `rationale` and `reasoning` columns — legacy drift, stylist handles both), `profiles`, `garment_corrections` (logs user fixes to AI reads — query before tuning vision prompts), plus swipe signals. Migration snippets in `/sql`. Row-Level Security is configured in the Supabase console (not in this repo).

## Deploy

Push to `main` → Vercel auto-deploys. No build step, no tests/CI — verify syntax with `node --check api/*.js` before pushing.

## Known deliberate trade-offs

- `app.html` is a single ~6k-line file (inline CSS/JS). Fine at beta scale; split when a real frontend team exists.
- Vision model can't distinguish fabric reliably (linen vs cotton) — user-confirm step planned post-V1.
- Bounding-box localization from vision is approximate; category-based crop heuristics compensate (`aspect ratio > 1.3` = worn photo).
