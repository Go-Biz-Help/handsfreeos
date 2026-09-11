-- =============================================================================
-- 0001 · Schemas, extensions, and the application roles.
--
-- HandsFreeOS app processes never connect as `postgres`. The API logs in as
-- `hfos_api` (NOINHERIT: it can do nothing until it runs
-- `SET LOCAL ROLE authenticated`), the worker as `hfos_worker` (switches to
-- `service_actor`, whose policies are scoped by `app.system_scope.*` settings).
-- Dev passwords below are for the local stack only; step 13 rotates them on
-- the hosted project with `ALTER ROLE ... PASSWORD`.
-- =============================================================================

create schema if not exists app;
create schema if not exists private;

create extension if not exists citext with schema extensions;
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'hfos_api') then
    create role hfos_api login noinherit nosuperuser nocreatedb nocreaterole nobypassrls
      password 'hfos_api_dev_password';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hfos_worker') then
    create role hfos_worker login noinherit nosuperuser nocreatedb nocreaterole nobypassrls
      password 'hfos_worker_dev_password';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_actor') then
    create role service_actor nologin nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$;

grant authenticated to hfos_api;
grant service_actor to hfos_worker;

-- The app schema is reachable only by the roles our processes switch into.
revoke all on schema app from public;
revoke all on schema private from public;
grant usage on schema app to authenticated, service_actor;
grant usage on schema private to authenticated, service_actor;
grant usage on schema extensions to authenticated, service_actor;

comment on schema app is 'HandsFreeOS tenant data. Not exposed through PostgREST; reached only through the API command layer.';
comment on schema private is 'SECURITY DEFINER helpers used by RLS policies and bootstrap functions.';
