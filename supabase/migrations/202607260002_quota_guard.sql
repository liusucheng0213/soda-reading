begin;

create table if not exists public.edge_function_usage_monthly (
  month_start date not null,
  function_name text not null,
  invocation_count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (month_start, function_name)
);

create table if not exists public.platform_usage_events (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in ('github_action_minutes', 'eas_android_build')),
  amount double precision not null check (amount >= 0),
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

alter table public.edge_function_usage_monthly enable row level security;
alter table public.platform_usage_events enable row level security;

create policy edge_usage_admin_read on public.edge_function_usage_monthly
for select to authenticated using (public.is_soda_admin());

create policy platform_usage_admin_read on public.platform_usage_events
for select to authenticated using (public.is_soda_admin());

grant select on public.edge_function_usage_monthly, public.platform_usage_events to authenticated;

create or replace function public.record_edge_invocation(edge_function_name text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.edge_function_usage_monthly (
    month_start,
    function_name,
    invocation_count
  )
  values (date_trunc('month', current_date)::date, left(edge_function_name, 80), 1)
  on conflict (month_start, function_name)
  do update set
    invocation_count = public.edge_function_usage_monthly.invocation_count + 1,
    updated_at = now();
$$;

create or replace function public.record_platform_usage(
  usage_type text,
  usage_amount double precision,
  usage_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if usage_type not in ('github_action_minutes', 'eas_android_build') then
    raise exception 'invalid usage type';
  end if;
  insert into public.platform_usage_events (event_type, amount, metadata)
  values (usage_type, greatest(0, usage_amount), coalesce(usage_metadata, '{}'::jsonb));
end;
$$;

revoke execute on function public.record_edge_invocation(text) from public, anon, authenticated;
grant execute on function public.record_edge_invocation(text) to service_role;
revoke execute on function public.record_platform_usage(text, double precision, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_platform_usage(text, double precision, jsonb)
  to service_role;

create or replace function public.internal_quota_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when not public.is_soda_admin(auth.uid()) then
      jsonb_build_object('authorized', false)
    else
      jsonb_build_object(
        'authorized', true,
        'databaseBytes', pg_database_size(current_database()),
        'databaseWarning', pg_database_size(current_database()) >= 400 * 1024 * 1024,
        'edgeInvocations', coalesce((
          select sum(invocation_count)
          from public.edge_function_usage_monthly
          where month_start = date_trunc('month', current_date)::date
        ), 0),
        'edgeWarning', coalesce((
          select sum(invocation_count)
          from public.edge_function_usage_monthly
          where month_start = date_trunc('month', current_date)::date
        ), 0) >= 400000,
        'githubMinutes', coalesce((
          select sum(amount)
          from public.platform_usage_events
          where event_type = 'github_action_minutes'
            and occurred_at >= date_trunc('month', now())
        ), 0),
        'githubWarning', coalesce((
          select sum(amount)
          from public.platform_usage_events
          where event_type = 'github_action_minutes'
            and occurred_at >= date_trunc('month', now())
        ), 0) >= 1600,
        'easBuilds', coalesce((
          select sum(amount)
          from public.platform_usage_events
          where event_type = 'eas_android_build'
            and occurred_at >= date_trunc('month', now())
        ), 0),
        'easWarning', coalesce((
          select sum(amount)
          from public.platform_usage_events
          where event_type = 'eas_android_build'
            and occurred_at >= date_trunc('month', now())
        ), 0) >= 12
      )
  end;
$$;

grant execute on function public.internal_quota_status() to authenticated;

commit;
