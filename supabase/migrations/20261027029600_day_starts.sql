-- =============================================================================
-- Where each person's day starts (docs/outreach.md, decision 179; the owner,
-- 18 Nov 2026: "1a 2a 3(all 3 options)").
--        - app.day_starts: the address a person sets out from each morning.
--          On a calendar that leaves time to drive between visits, the drive
--          to their first visit of a day is timed from here; later visits are
--          timed from the visit before. One row a person in each business;
--          none means the business's own address.
--        - It is often their home, so only they and the business's owners and
--          admins (calendars.manage) read it. Whoever may change their hours
--          (private.may_edit_hours) may change it. The worker reads it for the
--          business it is scoped to, to time the drives.
--        - A deleted account keeps none of it: private.anonymize_user
--          (20261027027200) with the row added.
--        - A service's places may include a meet-up spot ('meetup'): coffee
--          at your usual spot, one halfway between you, or one they name.
-- =============================================================================

create table app.day_starts (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  address text not null check (char_length(btrim(address)) between 1 and 300),
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
comment on table app.day_starts is
  'Where a person sets out from each day, for drive times between visits. Theirs and the owners'' and admins'' to read.';
create trigger day_starts_updated_at before update on app.day_starts
  for each row execute function private.set_updated_at();
create trigger day_starts_immutable before update on app.day_starts
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'user_id');

alter table app.day_starts enable row level security;
create policy day_starts_select on app.day_starts for select to authenticated
  using (
    (user_id = (select auth.uid()) and workspace_id in (select private.accessible_workspace_ids()))
    or private.has_permission(workspace_id, 'calendars.manage')
  );
create policy day_starts_insert on app.day_starts for insert to authenticated
  with check (private.may_edit_hours(workspace_id, 'user', user_id) and updated_by = (select auth.uid()));
create policy day_starts_update on app.day_starts for update to authenticated
  using (private.may_edit_hours(workspace_id, 'user', user_id))
  with check (private.may_edit_hours(workspace_id, 'user', user_id) and updated_by = (select auth.uid()));
create policy day_starts_delete on app.day_starts for delete to authenticated
  using (private.may_edit_hours(workspace_id, 'user', user_id));
create policy day_starts_service_select on app.day_starts for select to service_actor
  using (workspace_id = private.system_scope_workspace());

grant select, insert, delete on app.day_starts to authenticated;
grant update (address, updated_by) on app.day_starts to authenticated;
grant select on app.day_starts to service_actor;
revoke all on app.day_starts from anon;

-- ---------- a deleted account keeps none of it ----------
create or replace function private.anonymize_user(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.users u where u.id = p_user) then
    raise exception 'No such person' using errcode = 'P0002', detail = 'user_not_found';
  end if;
  -- Memberships first: the last-owner rules refuse a business's or agency's only owner.
  delete from app.organization_memberships m where m.user_id = p_user;
  delete from app.workspace_memberships m where m.user_id = p_user;
  delete from app.user_phones p where p.user_id = p_user;
  delete from app.user_about a where a.user_id = p_user;
  delete from app.day_starts d where d.user_id = p_user;
  delete from app.push_devices d where d.user_id = p_user;
  delete from app.notifications n where n.user_id = p_user;
  delete from app.command_receipts r where r.user_id = p_user;
  delete from app.assistant_threads t where t.user_id = p_user;
  -- Their own calendar stops blocking the business's: disconnected, its sealed tokens gone here (as 0017's guard does
  -- for people; the worker's scope bypasses that guard), its busy times by 0017's trigger.
  update app.calendar_connections c set status = 'disconnected', disconnected_at = now(), token_enc = null,
    token_key_id = null, pkce_verifier_enc = null, oauth_state_hash = null, next_sync_at = null
  where c.user_id = p_user and c.status <> 'disconnected';
  update app.users u set
    full_name = 'Former teammate',
    email = 'deleted-' || replace(u.id::text, '-', '') || '@deleted.handsfreeos.invalid',
    avatar_url = null,
    settings = '{}'::jsonb,
    deleted_at = coalesce(u.deleted_at, now())
  where u.id = p_user;
end $$;

-- ---------- a meet-up spot as a place (decision 179: coffee spots) ----------
-- A calendar's or service's place can be a meet-up spot: your usual spot, one halfway between you, or one the
-- customer names. Calendar places live in their settings (checked in code); a service's are checked here.
alter table app.services drop constraint services_location_kinds_check;
alter table app.services add constraint services_location_kinds_check
  check (location_kinds <@ array['customer_address', 'business', 'virtual', 'phone', 'meetup']);
