begin;

create extension if not exists pgcrypto;
create extension if not exists citext;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username citext not null unique check (username ~ '^[a-zA-Z0-9_]{3,24}$'),
  display_name text not null default '',
  role text not null default 'reader' check (role in ('reader', 'admin')),
  cefr text not null default 'B1' check (cefr in ('A2', 'B1', 'B2', 'C1')),
  topics text[] not null default array['科技']::text[],
  daily_minutes integer not null default 10 check (daily_minutes between 5 and 120),
  reminder_time time not null default '20:30',
  timezone text not null default 'Asia/Shanghai',
  review_limit integer not null default 20 check (review_limit between 10 and 50),
  must_change_password boolean not null default true,
  is_active boolean not null default true,
  session_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.is_active_user(target_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = target_user
      and p.is_active
      and p.session_version = coalesce(
        nullif(auth.jwt() -> 'app_metadata' ->> 'session_version', '')::integer,
        p.session_version
      )
  );
$$;

create or replace function public.is_soda_admin(target_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = target_user
      and p.role = 'admin'
      and p.is_active
      and p.session_version = coalesce(
        nullif(auth.jwt() -> 'app_metadata' ->> 'session_version', '')::integer,
        p.session_version
      )
  );
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_username text;
begin
  requested_username := coalesce(
    new.raw_user_meta_data ->> 'username',
    split_part(new.email, '@', 1)
  );
  insert into public.profiles (
    id,
    username,
    display_name,
    role,
    cefr,
    topics,
    must_change_password,
    session_version
  )
  values (
    new.id,
    requested_username,
    coalesce(new.raw_user_meta_data ->> 'display_name', requested_username),
    case when new.raw_app_meta_data ->> 'role' = 'admin' then 'admin' else 'reader' end,
    coalesce(new.raw_user_meta_data ->> 'cefr', 'B1'),
    coalesce(
      array(select jsonb_array_elements_text(new.raw_user_meta_data -> 'topics')),
      array['科技']::text[]
    ),
    coalesce((new.raw_user_meta_data ->> 'must_change_password')::boolean, true),
    coalesce((new.raw_app_meta_data ->> 'session_version')::integer, 1)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_auth_user();

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute procedure public.set_updated_at();

create table if not exists public.reading_progress (
  user_id uuid not null references public.profiles(id) on delete cascade,
  content_hash text not null check (length(content_hash) between 16 and 128),
  content_id text,
  chapter_id text,
  location jsonb not null default '{}'::jsonb,
  progress double precision not null default 0 check (progress between 0 and 1),
  last_read_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, content_hash)
);

create trigger reading_progress_set_updated_at
before update on public.reading_progress
for each row execute procedure public.set_updated_at();

create table if not exists public.vocabulary_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  content_hash text not null,
  content_id text,
  word text not null,
  normalized_word text generated always as (lower(trim(word))) stored,
  lemma text,
  part_of_speech text,
  phonetic text,
  translation text not null check (length(trim(translation)) > 0),
  sentence text not null,
  before_context text not null default '',
  after_context text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, content_hash, normalized_word)
);

create trigger vocabulary_items_set_updated_at
before update on public.vocabulary_items
for each row execute procedure public.set_updated_at();

create table if not exists public.vocabulary_cards (
  vocabulary_id uuid primary key references public.vocabulary_items(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  due timestamptz not null default now(),
  stability double precision not null default 0,
  difficulty double precision not null default 0,
  elapsed_days integer not null default 0,
  scheduled_days integer not null default 0,
  reps integer not null default 0,
  lapses integer not null default 0,
  learning_steps integer not null default 0,
  state integer not null default 0 check (state between 0 and 3),
  last_review timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists vocabulary_cards_due_idx
on public.vocabulary_cards (user_id, due);

create trigger vocabulary_cards_set_updated_at
before update on public.vocabulary_cards
for each row execute procedure public.set_updated_at();

create table if not exists public.vocabulary_reviews (
  id uuid primary key default gen_random_uuid(),
  vocabulary_id uuid not null references public.vocabulary_items(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  rating smallint not null check (rating between 1 and 4),
  reviewed_at timestamptz not null default now(),
  state_before jsonb not null,
  state_after jsonb not null,
  idempotency_key uuid not null unique
);

create table if not exists public.user_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  installation_id text not null,
  device_name text not null default '未知设备',
  platform text not null default 'web',
  app_version text not null default '',
  push_token text,
  last_active_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, installation_id)
);

create table if not exists public.translation_cache (
  request_hash text primary key,
  canonical_hash text not null,
  scope text not null check (scope in ('word', 'sentence')),
  source_text_hash text not null,
  result jsonb not null,
  provider text not null,
  model text not null,
  prompt_version text not null,
  quality text not null check (quality in ('contextual', 'basic')),
  hit_count integer not null default 0,
  latency_ms integer not null default 0,
  created_at timestamptz not null default now(),
  last_hit_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);

create index if not exists translation_cache_lookup_idx
on public.translation_cache (canonical_hash, expires_at desc);

create table if not exists public.provider_health (
  provider text primary key,
  model text not null,
  enabled boolean not null default true,
  free_only boolean not null default true,
  quality_score double precision not null default 0.8 check (quality_score between 0 and 1),
  recent_success_rate double precision not null default 1 check (recent_success_rate between 0 and 1),
  p95_latency_ms integer not null default 1500,
  success_count bigint not null default 0,
  failure_count bigint not null default 0,
  rate_limit_count bigint not null default 0,
  timeout_count bigint not null default 0,
  circuit_open_until timestamptz,
  last_error_code text,
  updated_at timestamptz not null default now()
);

insert into public.provider_health (provider, model, quality_score, p95_latency_ms)
values
  ('zhipu', 'glm-4.7-flash', 0.90, 1200),
  ('modelscope', 'Qwen/Qwen3.5-35B-A3B', 0.88, 1600),
  ('siliconflow', 'Qwen/Qwen2.5-7B-Instruct', 0.75, 2100)
on conflict (provider) do nothing;

create table if not exists public.client_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  installation_id text,
  event_type text not null check (event_type in (
    'crash', 'sync_failure', 'translation_latency', 'import_failure', 'app_health'
  )),
  aggregate jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists client_events_user_time_idx
on public.client_events (user_id, occurred_at desc);

create table if not exists public.daily_usage (
  user_id uuid not null references public.profiles(id) on delete cascade,
  usage_date date not null default current_date,
  translation_requests integer not null default 0,
  cache_hits integer not null default 0,
  primary key (user_id, usage_date)
);

create or replace function public.consume_translation_quota(
  max_daily_requests integer default 500
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_count integer;
begin
  if not public.is_active_user(auth.uid()) then
    return false;
  end if;
  insert into public.daily_usage (user_id, usage_date, translation_requests)
  values (auth.uid(), current_date, 1)
  on conflict (user_id, usage_date)
  do update set translation_requests = public.daily_usage.translation_requests + 1
  returning translation_requests into current_count;
  return current_count <= greatest(1, max_daily_requests);
end;
$$;

create or replace function public.record_cache_hit(cache_request_hash text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.translation_cache
  set hit_count = hit_count + 1, last_hit_at = now()
  where request_hash = cache_request_hash;
  insert into public.daily_usage (user_id, usage_date, cache_hits)
  values (auth.uid(), current_date, 1)
  on conflict (user_id, usage_date)
  do update set cache_hits = public.daily_usage.cache_hits + 1;
$$;

create or replace function public.prune_translation_cache(max_rows integer default 50000)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  if not public.is_soda_admin(auth.uid()) and auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;
  with ranked as (
    select
      request_hash,
      expires_at,
      row_number() over (order by last_hit_at desc) as keep_rank
    from public.translation_cache
  ),
  doomed as (
    select request_hash
    from ranked
    where expires_at < now() or keep_rank > greatest(1, max_rows)
  )
  delete from public.translation_cache
  where request_hash in (select request_hash from doomed);
  get diagnostics removed = row_count;
  return removed;
end;
$$;

create table if not exists public.source_policies (
  id text primary key,
  name text not null,
  license text not null,
  crawl_allowed boolean not null default false,
  full_text_allowed boolean not null default false,
  attribution_required boolean not null default true,
  commercial_allowed boolean not null default false,
  region text not null default 'CN',
  status text not null default 'review',
  source_tier text not null default 'B',
  source_type text not null default 'api',
  endpoint text not null default '',
  topics jsonb not null default '[]'::jsonb,
  peer_review_default text not null default 'unknown',
  freshness_class text not null default 'news',
  updated_at timestamptz not null default now()
);

create table if not exists public.source_fetch_states (
  source_id text primary key references public.source_policies(id) on delete cascade,
  etag text not null default '',
  last_modified text not null default '',
  last_success_at timestamptz,
  last_error text not null default '',
  consecutive_failures integer not null default 0,
  fetched_count integer not null default 0,
  accepted_count integer not null default 0,
  duplicate_count integer not null default 0,
  health_score double precision not null default 1
);

create table if not exists public.content_candidates (
  id text primary key default gen_random_uuid()::text,
  source_id text not null references public.source_policies(id),
  external_id text not null,
  doi text not null default '',
  canonical_url text not null,
  title text not null,
  summary text not null default '',
  authors jsonb not null default '[]'::jsonb,
  source_published_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  topic text not null,
  content_kind text not null default 'news',
  peer_review_status text not null default 'unknown',
  source_tier text not null default 'B',
  license text not null default '',
  full_text_allowed boolean not null default false,
  raw_hash text not null,
  title_fingerprint text not null,
  quality_score double precision not null default 0,
  status text not null default 'accepted',
  rejection_reason text not null default '',
  metadata_json jsonb not null default '{}'::jsonb,
  unique (source_id, external_id)
);

create index if not exists content_candidates_status_idx
on public.content_candidates (status, quality_score desc);

create table if not exists public.story_clusters (
  id text primary key default gen_random_uuid()::text,
  topic text not null,
  canonical_title text not null,
  candidate_ids jsonb not null default '[]'::jsonb,
  independent_source_ids jsonb not null default '[]'::jsonb,
  evidence_score double precision not null default 0,
  risk_level text not null default 'low',
  status text not null default 'ready',
  created_at timestamptz not null default now()
);

create table if not exists public.fact_claims (
  id text primary key default gen_random_uuid()::text,
  story_cluster_id text not null references public.story_clusters(id) on delete cascade,
  claim text not null,
  source_url text not null,
  source_label text not null,
  evidence_locator text not null default '',
  verified boolean not null default false
);

create table if not exists public.article_variants (
  id text primary key default gen_random_uuid()::text,
  story_cluster_id text not null references public.story_clusters(id),
  source_candidate_id text not null references public.content_candidates(id),
  title text not null,
  author text not null default '苏打阅读编辑部',
  summary text not null,
  paragraphs jsonb not null default '[]'::jsonb,
  sentence_translations jsonb not null default '{}'::jsonb,
  glossary jsonb not null default '[]'::jsonb,
  body_hash text not null,
  cefr text not null check (cefr in ('A2', 'B1', 'B2', 'C1')),
  word_count integer not null,
  reading_minutes integer not null,
  topic text not null,
  content_mode text not null default 'editorial_digest',
  peer_review_status text not null default 'not_applicable',
  quality_score double precision not null default 0,
  difficulty_metrics jsonb not null default '{}'::jsonb,
  source_published_at timestamptz not null,
  sources jsonb not null default '[]'::jsonb,
  risk_flags jsonb not null default '[]'::jsonb,
  review_status text not null default 'review',
  review_note text not null default '',
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (story_cluster_id, cefr, body_hash)
);

create index if not exists article_variants_feed_idx
on public.article_variants (review_status, cefr, topic, created_at desc);

create table if not exists public.pipeline_runs (
  id text primary key default gen_random_uuid()::text,
  kind text not null default 'discovery',
  status text not null default 'running',
  requested_limit integer not null default 0,
  fetched_count integer not null default 0,
  accepted_count integer not null default 0,
  duplicate_count integer not null default 0,
  rejected_count integer not null default 0,
  generated_count integer not null default 0,
  published_count integer not null default 0,
  source_stats jsonb not null default '{}'::jsonb,
  topic_coverage jsonb not null default '{}'::jsonb,
  error text not null default '',
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.daily_editions (
  edition_date date primary key,
  status text not null default 'staging',
  article_ids jsonb not null default '[]'::jsonb,
  coverage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  published_at timestamptz
);

create table if not exists public.daily_recommendations (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references public.profiles(id) on delete cascade,
  recommendation_date date not null,
  primary_article_id text not null references public.article_variants(id),
  alternative_article_ids jsonb not null default '[]'::jsonb,
  reasons jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, recommendation_date)
);

create table if not exists public.pipeline_locks (
  lock_key text primary key,
  owner text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.profiles enable row level security;
alter table public.reading_progress enable row level security;
alter table public.vocabulary_items enable row level security;
alter table public.vocabulary_cards enable row level security;
alter table public.vocabulary_reviews enable row level security;
alter table public.user_devices enable row level security;
alter table public.translation_cache enable row level security;
alter table public.provider_health enable row level security;
alter table public.client_events enable row level security;
alter table public.daily_usage enable row level security;
alter table public.source_policies enable row level security;
alter table public.source_fetch_states enable row level security;
alter table public.content_candidates enable row level security;
alter table public.story_clusters enable row level security;
alter table public.fact_claims enable row level security;
alter table public.article_variants enable row level security;
alter table public.pipeline_runs enable row level security;
alter table public.daily_editions enable row level security;
alter table public.daily_recommendations enable row level security;
alter table public.pipeline_locks enable row level security;

create policy profiles_read_own_or_admin on public.profiles
for select to authenticated
using ((id = auth.uid() and public.is_active_user()) or public.is_soda_admin());

create policy profiles_update_own on public.profiles
for update to authenticated
using (id = auth.uid() and public.is_active_user())
with check (id = auth.uid() and public.is_active_user());

create policy reading_progress_owner on public.reading_progress
for all to authenticated
using (user_id = auth.uid() and public.is_active_user())
with check (user_id = auth.uid() and public.is_active_user());

create policy vocabulary_items_owner on public.vocabulary_items
for all to authenticated
using (user_id = auth.uid() and public.is_active_user())
with check (user_id = auth.uid() and public.is_active_user());

create policy vocabulary_cards_owner on public.vocabulary_cards
for all to authenticated
using (user_id = auth.uid() and public.is_active_user())
with check (user_id = auth.uid() and public.is_active_user());

create policy vocabulary_reviews_owner on public.vocabulary_reviews
for all to authenticated
using (user_id = auth.uid() and public.is_active_user())
with check (user_id = auth.uid() and public.is_active_user());

create policy user_devices_owner on public.user_devices
for all to authenticated
using (user_id = auth.uid() and public.is_active_user())
with check (user_id = auth.uid() and public.is_active_user());

create policy client_events_insert_own on public.client_events
for insert to authenticated
with check (user_id = auth.uid() and public.is_active_user());

create policy client_events_read_own_or_admin on public.client_events
for select to authenticated
using ((user_id = auth.uid() and public.is_active_user()) or public.is_soda_admin());

create policy daily_usage_read_own_or_admin on public.daily_usage
for select to authenticated
using ((user_id = auth.uid() and public.is_active_user()) or public.is_soda_admin());

create policy content_authenticated_read on public.source_policies
for select to authenticated using (public.is_active_user());
create policy source_health_admin_read on public.source_fetch_states
for select to authenticated using (public.is_soda_admin());
create policy candidates_admin_read on public.content_candidates
for select to authenticated using (public.is_soda_admin());
create policy clusters_admin_read on public.story_clusters
for select to authenticated using (public.is_soda_admin());
create policy claims_authenticated_read on public.fact_claims
for select to authenticated using (public.is_active_user());
create policy articles_authenticated_read on public.article_variants
for select to authenticated
using (
  public.is_active_user()
  and (review_status = 'approved' or public.is_soda_admin())
);
create policy editions_authenticated_read on public.daily_editions
for select to authenticated
using (
  public.is_active_user()
  and (status = 'published' or public.is_soda_admin())
);
create policy recommendations_owner on public.daily_recommendations
for select to authenticated
using (user_id = auth.uid() and public.is_active_user());
create policy providers_admin_read on public.provider_health
for select to authenticated using (public.is_soda_admin());
create policy pipeline_runs_admin_read on public.pipeline_runs
for select to authenticated using (public.is_soda_admin());

revoke all on all tables in schema public from anon;
grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, cefr, topics, daily_minutes, reminder_time, timezone, review_limit)
  on public.profiles to authenticated;
grant select, insert, update, delete on public.reading_progress to authenticated;
grant select, insert, update, delete on public.vocabulary_items to authenticated;
grant select, insert, update, delete on public.vocabulary_cards to authenticated;
grant select, insert on public.vocabulary_reviews to authenticated;
grant select, insert, update, delete on public.user_devices to authenticated;
grant select, insert on public.client_events to authenticated;
grant select on public.daily_usage to authenticated;
grant select on public.source_policies, public.fact_claims, public.article_variants,
  public.daily_editions, public.daily_recommendations to authenticated;
grant select on public.source_fetch_states, public.content_candidates,
  public.story_clusters, public.provider_health, public.pipeline_runs to authenticated;
grant execute on function public.consume_translation_quota(integer) to authenticated;
grant execute on function public.record_cache_hit(text) to authenticated;
revoke execute on function public.prune_translation_cache(integer) from public, anon, authenticated;
grant execute on function public.prune_translation_cache(integer) to service_role;

commit;
