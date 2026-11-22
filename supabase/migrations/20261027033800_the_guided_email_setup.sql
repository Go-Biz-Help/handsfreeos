-- =============================================================================
-- The guided email setup (the owner, 22 Nov 2026: one question at a time, "nothing changes until you click
-- Set it up"). Three things the questions need from the database:
--
--   1. app.email_domain_lookups: where a website name's mail goes and where its records are looked after, for a
--      name the business has only typed so far. The first question says "Found it. It's looked after at
--      SiteGround, and its mail goes there today." before the name is added to anything. One row a business:
--      the name it last asked about. Only the worker writes it.
--   2. email_domains.mx_records: the name's mail records as the worker last saw them, with their priorities, so
--      the last step can list the old ones to delete and say which are still there.
--   3. A plan can carry more addresses than the one customers hear from (plan.addresses), each the team's or
--      one person's own, and a person's own may come with "Let Ava read this mail" already on. That yes is one
--      person's (20261027033700), so only they write it into a plan: nobody plans it for someone else.
-- =============================================================================

-- ---------- 1. a name looked up before it is added ----------
create table app.email_domain_lookups (
  workspace_id uuid primary key references app.workspaces (id) on delete cascade,
  domain text not null check (length(domain) between 1 and 253),
  -- none, handsfreeos, google, microsoft… or other; null when DNS didn't answer.
  mail_host text check (mail_host is null or length(mail_host) <= 40),
  -- godaddy, cloudflare, siteground… or other; null when DNS didn't answer.
  dns_host text check (dns_host is null or length(dns_host) <= 40),
  -- [{host, priority}], lowest priority first; null when DNS didn't answer.
  mx_records jsonb check (
    mx_records is null or (jsonb_typeof(mx_records) = 'array' and pg_column_size(mx_records) <= 8192)
  ),
  looked_at timestamptz not null default now()
);
comment on table app.email_domain_lookups is
  'The website name a business last asked about in the guided email setup, before adding it: where its mail goes and where its DNS is looked after. Written by the worker only.';

alter table app.email_domain_lookups enable row level security;
create policy email_domain_lookups_select on app.email_domain_lookups for select to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'));
create policy email_domain_lookups_service_all on app.email_domain_lookups for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.email_domain_lookups from public;
grant select on app.email_domain_lookups to authenticated;
grant select, insert, update on app.email_domain_lookups to service_actor;

-- ---------- 2. a name's mail records as last seen ----------
alter table app.email_domains add column mx_records jsonb;
alter table app.email_domains add constraint email_domains_mx_records_list check (
  mx_records is null or (jsonb_typeof(mx_records) = 'array' and pg_column_size(mx_records) <= 8192)
);
comment on column app.email_domains.mx_records is
  'Its MX records as the worker last saw them: [{host, priority}], lowest priority first. Null until it has looked.';

-- ---------- 3. "Let Ava read this mail" in a plan is its own person's to write ----------
comment on column app.email_domains.plan is
  'What happens once the domain verifies: {team: {localPart, displayName}} makes the team address and the default, {addresses: [{localPart, userId?, aiReads?}]} the other addresses (a userId makes one that person''s own), {own: {localPart, userId}} the person''s own address (the older step), {receive: true} receives its mail. Cleared once done.';

create function private.guard_email_domain_plan_ai_reads()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_entry jsonb;
begin
  if current_user <> 'authenticated' or jsonb_typeof(new.plan -> 'addresses') is distinct from 'array' then
    return new;
  end if;
  for v_entry in select e from jsonb_array_elements(new.plan -> 'addresses') e loop
    if v_entry -> 'aiReads' = 'true'::jsonb
       and (v_entry ->> 'userId') is distinct from auth.uid()::text
       and not (tg_op = 'UPDATE' and jsonb_typeof(old.plan -> 'addresses') = 'array'
                and old.plan -> 'addresses' @> jsonb_build_array(v_entry)) then
      raise exception 'Only its own person lets the AI teammate read an address''s mail'
        using errcode = '42501', detail = 'email_address_ai_reads_is_theirs';
    end if;
  end loop;
  return new;
end $$;

create trigger email_domains_plan_ai_reads_guard before insert or update of plan on app.email_domains
  for each row execute function private.guard_email_domain_plan_ai_reads();
