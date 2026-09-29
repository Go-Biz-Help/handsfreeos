-- =============================================================================
-- A business receives its own mail (M19, step 1).
--
--        Until now a business's own domain only sent. Its mail still arrived
--        wherever its MX pointed, and HandsFreeOS heard only the replies that
--        came back through mail.handsfreeos.com. Now a verified domain can
--        also receive: the business points its MX at Postmark, the worker
--        sees it there, and mail to any address at the domain lands in the
--        business's Inbox. It goes to that address's own lane when there is
--        one, and to the default address when nobody has that name, so no
--        mail is dropped for a typo.
--
--        People turn receiving on and off (`receiving` off → pending, and
--        back to off). The worker says when the MX answers (on) and when it
--        stops (lapsed). Mail routes while it is on or lapsed, so a slow DNS
--        change loses nothing.
--
--        HandsFreeOS's own business may hold handsfreeos.com itself (Chris,
--        2026-09-29), so chris@handsfreeos.com can be a real mailbox. A staff
--        admin marks the business; a domain belongs to one business, so only
--        one of them can hold it at a time. Every other business is still
--        refused handsfreeos.com, every business is refused its subdomains,
--        and on the bare domain the reserved names (support, help, no-reply,
--        alerts, …) stay out of reach of that business too, so the support
--        desk and the system's own mail keep theirs.
-- =============================================================================

-- ---------- HandsFreeOS's own business ----------
alter table app.workspaces add column is_platform boolean not null default false;

comment on column app.workspaces.is_platform is
  'HandsFreeOS''s own business: the one workspace that may send and receive on handsfreeos.com. Set by a staff admin in /admin.';


-- The twin of private.guard_phone_model(): a business's own update may not touch it.
create or replace function private.guard_is_platform()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' and new.is_platform is distinct from old.is_platform then
    raise exception 'Only HandsFreeOS support marks its own business'
      using errcode = '42501', detail = 'is_platform_is_ours';
  end if;
  return new;
end $$;

create trigger workspaces_is_platform before update on app.workspaces
  for each row execute function private.guard_is_platform();

-- Staff admins only. It says what it was, so a repeat is visibly a no-op.
create or replace function private.set_platform_workspace(p_workspace uuid, p_on boolean)
returns table (was boolean, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_was boolean;
begin
  if not private.staff_can('platform.own_business.manage') then
    raise exception 'You cannot mark HandsFreeOS''s own business'
      using errcode = '42501', detail = 'is_platform_is_ours';
  end if;
  select w.is_platform into v_was from app.workspaces w where w.id = p_workspace for update;
  if not found then
    raise exception 'No business with that id' using errcode = '23503', detail = 'no_workspace';
  end if;
  if v_was and not p_on
     and exists (select 1 from app.email_domains d where d.workspace_id = p_workspace and d.domain = 'handsfreeos.com') then
    raise exception 'Remove handsfreeos.com from this business''s email first'
      using errcode = '23514', detail = 'platform_holds_our_domain';
  end if;
  update app.workspaces set is_platform = p_on where id = p_workspace;
  return query select v_was, v_was is distinct from p_on;
end $$;

revoke execute on function private.set_platform_workspace(uuid, boolean) from public;
grant execute on function private.set_platform_workspace(uuid, boolean) to authenticated;

-- Admins only: it lets one business speak as HandsFreeOS. Mirrored in core's ROLE_PERMISSIONS.
insert into app.role_permissions (role, permission) values
  ('staff_admin', 'platform.own_business.manage');

-- ---------- handsfreeos.com: HandsFreeOS's own business only ----------
-- A check can't read another table, so the check keeps refusing every subdomain and a trigger decides the bare
-- domain.
alter table app.email_domains drop constraint email_domains_domain_check;
alter table app.email_domains add constraint email_domains_domain_check
  check (domain = lower(domain) and length(domain) <= 253
    and domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
    and domain !~ '\.handsfreeos\.com$');

create or replace function private.guard_email_domain_ours()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.domain = 'handsfreeos.com'
     and not exists (select 1 from app.workspaces w where w.id = new.workspace_id and w.is_platform) then
    raise exception 'That domain is HandsFreeOS''s own' using errcode = '23514', detail = 'email_domain_ours';
  end if;
  return new;
end $$;

create trigger email_domains_ours before insert or update of domain, workspace_id on app.email_domains
  for each row execute function private.guard_email_domain_ours();

-- The reserved names are HandsFreeOS's on handsfreeos.com as well as on the shared subdomain: support@ is the
-- support desk's, and no-reply@ and alerts@ are the system's. Otherwise as in 0012.
create or replace function private.guard_email_address()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_domain text;
  v_status app.email_domain_status;
  v_workspace uuid;
begin
  if new.email_domain_id is null then
    if private.email_local_part_reserved(new.local_part) then
      raise exception 'That address is reserved' using errcode = '23514', detail = 'email_local_part_reserved';
    end if;
    v_domain := private.shared_mail_domain();
  else
    select d.domain, d.status, d.workspace_id into v_domain, v_status, v_workspace
    from app.email_domains d where d.id = new.email_domain_id;
    if v_workspace is distinct from new.workspace_id then
      raise exception 'Domain must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
    if v_domain = 'handsfreeos.com' and private.email_local_part_reserved(new.local_part) then
      raise exception 'That address is reserved' using errcode = '23514', detail = 'email_local_part_reserved';
    end if;
    if v_status is distinct from 'verified' and (tg_op = 'INSERT' or new.is_default
        or old.email_domain_id is distinct from new.email_domain_id) then
      raise exception 'Verify the domain before sending from it' using errcode = '23514', detail = 'email_domain_unverified';
    end if;
  end if;
  new.address := new.local_part || '@' || v_domain;
  if tg_op = 'UPDATE' and (old.local_part is distinct from new.local_part or old.email_domain_id is distinct from new.email_domain_id)
     and exists (select 1 from app.messages m where m.email_address_id = old.id) then
    raise exception 'An address that has sent mail keeps its name' using errcode = '23514', detail = 'email_address_in_use';
  end if;
  return new;
end $$;

-- ---------- receiving ----------
create type app.email_receiving_status as enum ('off', 'pending', 'on', 'lapsed');

alter table app.email_domains
  add column receiving app.email_receiving_status not null default 'off',
  add column mx_verified_at timestamptz,
  add column mx_checked_at timestamptz,
  add column inbound_server_id text;

comment on column app.email_domains.receiving is
  'Whether mail to this domain arrives in HandsFreeOS: off; pending until its MX points at Postmark; on; lapsed once the MX stopped pointing there.';
comment on column app.email_domains.mx_verified_at is
  'When the worker last found the domain''s MX pointing at Postmark.';
comment on column app.email_domains.mx_checked_at is 'When the worker last looked up the domain''s MX.';
comment on column app.email_domains.inbound_server_id is
  'The Postmark server that receives this domain''s mail. Null for handsfreeos.com, which the support server receives.';

-- People turn receiving on (pending) and off; only the worker says it's on or lapsed. A person can write no
-- other column (the grant below), and asks only for a domain that already proved it is theirs. The twin of
-- private.guard_phone_model(): it reads who is writing, so it runs as them.
create or replace function private.guard_email_domain_receiving()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' or new.receiving is not distinct from old.receiving then
    return new;
  end if;
  if new.receiving not in ('off', 'pending') then
    raise exception 'Only HandsFreeOS says when a domain''s mail arrives'
      using errcode = '42501', detail = 'email_domain_provider_fields';
  end if;
  if new.receiving = 'pending' and new.status <> 'verified' then
    raise exception 'Verify the domain before receiving mail at it'
      using errcode = '23514', detail = 'email_domain_unverified';
  end if;
  return new;
end $$;

create trigger email_domains_receiving before update on app.email_domains
  for each row execute function private.guard_email_domain_receiving();

create policy email_domains_update on app.email_domains for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'))
  with check (private.has_permission(workspace_id, 'channels.manage'));
grant update (receiving) on app.email_domains to authenticated;

-- Inbound mail to a business's own domain: the address's own lane, or the business's default address when
-- nobody has that name. Only while the domain receives, and never for a business being deleted.
create or replace function private.email_receiving_route(p_address text)
returns table (email_address_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select a.id, d.workspace_id, w.organization_id
  from app.email_domains d
  join app.workspaces w on w.id = d.workspace_id
  cross join lateral (
    select x.id
    from app.email_addresses x
    where x.workspace_id = d.workspace_id and (x.address = lower(p_address) or x.is_default)
    order by x.address = lower(p_address) desc
    limit 1
  ) a
  where d.domain = split_part(lower(p_address), '@', 2)
    and d.receiving in ('on', 'lapsed')
    and w.deletion_requested_at is null
$$;

-- Every domain that receives or is waiting to, for the worker's MX checks. Listed before a tenant is known.
create or replace function private.email_receiving_to_check()
returns table (email_domain_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select d.id, d.workspace_id, w.organization_id
  from app.email_domains d join app.workspaces w on w.id = d.workspace_id
  where d.receiving <> 'off'
  order by d.mx_checked_at nulls first, d.id
$$;

revoke all on function
  private.guard_email_domain_ours(), private.guard_email_domain_receiving(), private.guard_is_platform(),
  private.email_receiving_route(text), private.email_receiving_to_check()
  from public;
grant execute on function
  private.guard_email_domain_ours(), private.guard_email_domain_receiving(), private.guard_is_platform()
  to authenticated, service_actor;
grant execute on function private.email_receiving_route(text), private.email_receiving_to_check()
  to service_actor;
