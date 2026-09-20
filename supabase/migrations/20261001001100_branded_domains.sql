-- =============================================================================
-- 0087 · A business's own domain on the pages its customers see (M17).
--
--        `booking.lonestarhvac.com` instead of `handsfreeos.com/book/lonestar`
--        — for the booking page, the public forms, the estimate and invoice
--        links, the chat widget and the short links. All of them, or a
--        business gets a branded page with unbranded links inside it, which is
--        worse than not offering it.
--
--        **The shape is app.email_domains', deliberately.** That feature
--        already solved this exact problem one milestone ago: a business adds
--        a domain, we hand back the DNS records, a job checks them, a status
--        moves, and a daily job re-checks. Same statuses, same
--        `channels.manage`, same "the provider's fields are the worker's"
--        split. Somebody who has read 0012 can read this.
--
--        **It hangs off app.booking_sites, not app.workspaces.** The site row
--        is already the business's public identity — the `lonestar` in
--        /book/lonestar and /f/lonestar/quote — and a custom domain is another
--        name for exactly that thing. One row per site, so a business has one
--        branded domain and the routing question always has one answer.
--
--        **Two DNS records, and only one of them is ours to invent.** The
--        `verification` TXT proves the business controls the name before we
--        ask a certificate authority for a certificate in it; the CNAME is
--        what actually points the name at us. The values come back from the
--        host, which is why they are nullable until the worker has been.
-- =============================================================================

create type app.branded_domain_status as enum ('pending', 'verifying', 'verified', 'failed');

create table app.branded_domains (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- One per business: "which business is this host?" must have exactly one answer, in both directions.
  site_id uuid not null unique references app.booking_sites (id) on delete cascade,
  domain text not null unique
    check (domain = lower(domain) and length(domain) <= 253
      and domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
      -- Ours is not theirs to claim, and a business pointing one of our own names at itself would take the
      -- app down for everybody.
      and domain !~ '(^|\.)handsfreeos\.com$'),
  status app.branded_domain_status not null default 'pending',

  -- ---- what the business has to put in its DNS ----
  -- The TXT that proves they hold the name, and the CNAME that points it here. Null until the host has been
  -- asked; `private.guard_branded_domain_update()` makes them the worker's alone.
  verification_host text,
  verification_value text,
  cname_host text,
  cname_value text,

  -- ---- what the host says ----
  -- Whether the certificate is issued. A verified domain with no certificate still serves nothing.
  certificate_ready boolean not null default false,
  verified_at timestamptz,
  last_checked_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 2000),
  next_check_at timestamptz,

  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index branded_domains_workspace_idx on app.branded_domains (workspace_id, created_at);
-- The twin of telephony_registrations_poll_idx: the checker reads only what is still waiting on DNS.
create index branded_domains_check_idx on app.branded_domains (next_check_at)
  where status in ('pending', 'verifying');
create trigger branded_domains_updated_at before update on app.branded_domains
  for each row execute function private.set_updated_at();
create trigger branded_domains_immutable before update on app.branded_domains
  for each row execute function private.forbid_tenant_column_change(
    'workspace_id', 'site_id', 'domain', 'created_by');

-- ---------- the host's answer is ours to write ----------
-- The twin of private.guard_registration_update(): a business adds a domain and removes one, and everything
-- the host said about it is the worker's. Without this a person could mark their own domain verified and we
-- would serve a name nobody proved they hold.
create or replace function private.guard_branded_domain_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.status is distinct from new.status
     or old.verification_host is distinct from new.verification_host
     or old.verification_value is distinct from new.verification_value
     or old.cname_host is distinct from new.cname_host
     or old.cname_value is distinct from new.cname_value
     or old.certificate_ready is distinct from new.certificate_ready
     or old.verified_at is distinct from new.verified_at
     or old.last_checked_at is distinct from new.last_checked_at
     or old.last_error is distinct from new.last_error
     or old.next_check_at is distinct from new.next_check_at then
    raise exception 'Only HandsFreeOS records what the host said about a domain'
      using errcode = '42501', detail = 'branded_domain_provider_fields';
  end if;
  return new;
end $$;
create trigger branded_domains_update_guard before update on app.branded_domains
  for each row execute function private.guard_branded_domain_update();

-- ---------- who may see and change it ----------
-- The same permission as the numbers and the email domains, because it is the same question: which names a
-- business's customers reach it by. Everybody in the business reads it — the booking page shows the address
-- it is on — and only owners and admins change it.
alter table app.branded_domains enable row level security;

create policy branded_domains_select on app.branded_domains for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy branded_domains_insert on app.branded_domains for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage') and created_by = (select auth.uid())
    and status = 'pending' and verified_at is null and not certificate_ready);
create policy branded_domains_update on app.branded_domains for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'))
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy branded_domains_delete on app.branded_domains for delete to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'));
create policy branded_domains_service_all on app.branded_domains for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.branded_domains from public;
grant select, insert, update, delete on app.branded_domains to authenticated;
grant select, insert, update, delete on app.branded_domains to service_actor;
revoke all on function private.guard_branded_domain_update() from public;

-- ---------- which business is this host? ----------
-- Read by the web app on every request that arrives on a name that is not ours, so it is a function rather
-- than a query somebody writes twice, and it answers only for a domain that is actually working: a name
-- still waiting on DNS must not start serving a half-configured business.
create or replace function private.site_for_domain(p_domain text)
returns table (site_slug text, workspace_id uuid)
language sql stable security definer set search_path = '' as $$
  select s.slug::text, d.workspace_id
  from app.branded_domains d
  join app.booking_sites s on s.id = d.site_id
  where d.domain = lower(p_domain) and d.status = 'verified' and d.certificate_ready and s.enabled
$$;
revoke all on function private.site_for_domain(text) from public;
grant execute on function private.site_for_domain(text) to authenticated, anon, service_actor;
