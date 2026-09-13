-- =============================================================================
-- 0018 · Short booking links. Every booking (appointment_attendees) and
--        waitlist entry gets `public_ref`: 8 random base62 characters, unique
--        and not secret. The customer's change-or-cancel link is
--        /m/<public_ref><code> and a waitlist offer is /w/<public_ref><code>,
--        where the code is an HMAC the worker signs (nothing secret is stored).
--        The worker finds a link's booking by its reference before it knows the
--        workspace, through two lookups only it may call.
-- =============================================================================

-- 8 characters from [0-9A-Za-z]. Bytes of 248 and above are skipped (248 is the largest multiple of 62
-- under 256), so every character is equally likely. Security definer: the default runs as whoever inserts.
create or replace function private.new_public_ref()
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  ref text := '';
  b bytea;
  v integer;
begin
  while length(ref) < 8 loop
    b := extensions.gen_random_bytes(16);
    for i in 0..15 loop
      v := get_byte(b, i);
      if v < 248 and length(ref) < 8 then
        ref := ref || substr(alphabet, (v % 62) + 1, 1);
      end if;
    end loop;
  end loop;
  return ref;
end $$;

-- A volatile default gives each existing row its own reference too.
alter table app.appointment_attendees
  add column public_ref text not null default private.new_public_ref()
  check (public_ref ~ '^[0-9A-Za-z]{8}$');
create unique index appointment_attendees_public_ref_key on app.appointment_attendees (public_ref);
create trigger appointment_attendees_public_ref_immutable before update of public_ref on app.appointment_attendees
  for each row execute function private.forbid_tenant_column_change('public_ref');

alter table app.waitlist_entries
  add column public_ref text not null default private.new_public_ref()
  check (public_ref ~ '^[0-9A-Za-z]{8}$');
create unique index waitlist_entries_public_ref_key on app.waitlist_entries (public_ref);
create trigger waitlist_entries_public_ref_immutable before update of public_ref on app.waitlist_entries
  for each row execute function private.forbid_tenant_column_change('public_ref');

-- The booking a change-or-cancel link names, with its tenant: the worker then reads everything else under
-- that workspace's scope (and checks the HMAC against manage_version).
create or replace function private.booking_manage_lookup(p_ref text)
returns table (attendee_id uuid, workspace_id uuid, organization_id uuid, manage_version integer)
language sql stable security definer set search_path = '' as $$
  select a.id, a.workspace_id, w.organization_id, a.manage_version
  from app.appointment_attendees a
  join app.workspaces w on w.id = a.workspace_id
  where p_ref ~ '^[0-9A-Za-z]{8}$' and a.public_ref = p_ref
$$;

-- The waitlist entry an offer link names, with its tenant.
create or replace function private.waitlist_offer_lookup(p_ref text)
returns table (entry_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select e.id, e.workspace_id, w.organization_id
  from app.waitlist_entries e
  join app.workspaces w on w.id = e.workspace_id
  where p_ref ~ '^[0-9A-Za-z]{8}$' and e.public_ref = p_ref
$$;

-- ---------- function privileges ----------
revoke all on function private.new_public_ref(), private.booking_manage_lookup(text),
  private.waitlist_offer_lookup(text) from public;
-- Staff add attendees and waitlist entries; the worker adds both for the booking page.
grant execute on function private.new_public_ref() to authenticated, service_actor;
grant execute on function private.booking_manage_lookup(text), private.waitlist_offer_lookup(text)
  to service_actor;
