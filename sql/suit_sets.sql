-- suit_sets
-- Lets two or more garments be linked as a "suit" (e.g. a blazer + its matching
-- trousers, sometimes + a waistcoat). Pieces in the same set share one
-- suit_set_id. The stylist uses this to recommend a suit's pieces together and
-- never pair one half of a suit with a non-matching piece.
--
-- A suit is just N garment rows that share the same suit_set_id. NULL = the
-- garment belongs to no suit (the normal case).
--
-- Run this once in the Supabase SQL editor (project ref tmgftqnekispazjfnqxw).

alter table public.garments
  add column if not exists suit_set_id uuid;

-- Fast lookup of "all pieces in this suit" and "does this garment have a suit".
create index if not exists garments_suit_set_idx
  on public.garments (suit_set_id)
  where suit_set_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Useful queries:
--
-- All suits for a user and their pieces:
--   select suit_set_id, count(*), array_agg(subcategory)
--   from garments
--   where user_id = '<uuid>' and suit_set_id is not null
--   group by suit_set_id;
--
-- Unlink a suit (clear it for both pieces):
--   update garments set suit_set_id = null where suit_set_id = '<uuid>';
