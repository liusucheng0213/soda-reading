-- Keep the quieter dictionary line and the in-text referent flag with each saved word.
alter table public.vocabulary_items
  add column if not exists common_translation text not null default '';

alter table public.vocabulary_items
  add column if not exists referent boolean not null default false;
