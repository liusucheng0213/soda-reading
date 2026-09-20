begin;

grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges in schema public
grant all privileges on tables to service_role;
alter default privileges in schema public
grant usage, select on sequences to service_role;
alter default privileges in schema public
grant execute on functions to service_role;

commit;
