-- garment_corrections
-- Captures every edit a user makes to an auto-extracted garment: what the vision
-- model said (old_value) vs what the user corrected it to (new_value), one row
-- per changed field. This is the training fuel for better prompts, few-shot
-- examples, and future garment fingerprinting.
--
-- Run this once in the Supabase SQL editor (project ref tmgftqnekispazjfnqxw).

create table if not exists public.garment_corrections (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,
  garment_id       uuid not null,
  field            text not null,        -- 'category' | 'subcategory' | 'color' | 'pattern' | 'fabric' | 'formality_score' | 'name'
  old_value        text,                 -- what the model produced
  new_value        text not null,        -- what the user changed it to
  source_photo_url text,                 -- the original photo the garment came from
  thumb_url        text,
  created_at       timestamptz not null default now()
);

create index if not exists garment_corrections_field_idx   on public.garment_corrections (field);
create index if not exists garment_corrections_user_idx    on public.garment_corrections (user_id);
create index if not exists garment_corrections_garment_idx on public.garment_corrections (garment_id);

-- Writes come only from /api/update-garment using the service key, which bypasses
-- RLS. Enable RLS with no public policies so nothing else can read/write it.
alter table public.garment_corrections enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- Useful queries once data accumulates:
--
-- Most common color mistakes:
--   select old_value, new_value, count(*)
--   from garment_corrections where field = 'color'
--   group by old_value, new_value order by count(*) desc;
--
-- Most-corrected fields overall (where the model is weakest):
--   select field, count(*) from garment_corrections group by field order by count(*) desc;
