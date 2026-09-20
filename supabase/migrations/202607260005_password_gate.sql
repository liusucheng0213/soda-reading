begin;

create or replace function public.is_ready_user(target_user uuid default auth.uid())
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
      and not p.must_change_password
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
      and not p.must_change_password
      and p.session_version = coalesce(
        nullif(auth.jwt() -> 'app_metadata' ->> 'session_version', '')::integer,
        p.session_version
      )
  );
$$;

drop policy if exists reading_progress_owner on public.reading_progress;
create policy reading_progress_owner on public.reading_progress
for all to authenticated
using (user_id = auth.uid() and public.is_ready_user())
with check (user_id = auth.uid() and public.is_ready_user());

drop policy if exists vocabulary_items_owner on public.vocabulary_items;
create policy vocabulary_items_owner on public.vocabulary_items
for all to authenticated
using (user_id = auth.uid() and public.is_ready_user())
with check (user_id = auth.uid() and public.is_ready_user());

drop policy if exists vocabulary_cards_owner on public.vocabulary_cards;
create policy vocabulary_cards_owner on public.vocabulary_cards
for all to authenticated
using (user_id = auth.uid() and public.is_ready_user())
with check (user_id = auth.uid() and public.is_ready_user());

drop policy if exists vocabulary_reviews_owner on public.vocabulary_reviews;
create policy vocabulary_reviews_owner on public.vocabulary_reviews
for all to authenticated
using (user_id = auth.uid() and public.is_ready_user())
with check (user_id = auth.uid() and public.is_ready_user());

drop policy if exists user_devices_owner on public.user_devices;
create policy user_devices_owner on public.user_devices
for all to authenticated
using (user_id = auth.uid() and public.is_ready_user())
with check (user_id = auth.uid() and public.is_ready_user());

drop policy if exists client_events_insert_own on public.client_events;
create policy client_events_insert_own on public.client_events
for insert to authenticated
with check (user_id = auth.uid() and public.is_ready_user());

drop policy if exists client_events_read_own_or_admin on public.client_events;
create policy client_events_read_own_or_admin on public.client_events
for select to authenticated
using ((user_id = auth.uid() and public.is_ready_user()) or public.is_soda_admin());

drop policy if exists daily_usage_read_own_or_admin on public.daily_usage;
create policy daily_usage_read_own_or_admin on public.daily_usage
for select to authenticated
using ((user_id = auth.uid() and public.is_ready_user()) or public.is_soda_admin());

drop policy if exists content_authenticated_read on public.source_policies;
create policy content_authenticated_read on public.source_policies
for select to authenticated using (public.is_ready_user());

drop policy if exists claims_authenticated_read on public.fact_claims;
create policy claims_authenticated_read on public.fact_claims
for select to authenticated using (public.is_ready_user());

drop policy if exists articles_authenticated_read on public.article_variants;
create policy articles_authenticated_read on public.article_variants
for select to authenticated using (
  public.is_ready_user()
  and review_status = 'approved'
  and quality_score >= 85
);

drop policy if exists editions_authenticated_read on public.daily_editions;
create policy editions_authenticated_read on public.daily_editions
for select to authenticated using (
  public.is_ready_user()
  and status = 'published'
);

drop policy if exists recommendations_owner on public.daily_recommendations;
create policy recommendations_owner on public.daily_recommendations
for all to authenticated
using (user_id = auth.uid() and public.is_ready_user())
with check (user_id = auth.uid() and public.is_ready_user());

grant execute on function public.is_ready_user(uuid) to authenticated, service_role;

commit;
