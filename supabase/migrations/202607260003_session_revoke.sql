begin;

create or replace function public.revoke_user_sessions(target_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  removed integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;
  delete from auth.sessions where user_id = target_user_id;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke execute on function public.revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid) to service_role;

commit;
