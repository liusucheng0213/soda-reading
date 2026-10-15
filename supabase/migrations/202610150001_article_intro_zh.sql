alter table public.article_variants
  add column if not exists intro_zh text not null default '';
