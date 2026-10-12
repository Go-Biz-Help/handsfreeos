-- Starting an add-on fresh (docs/addon-architecture.md, "Starting fresh"): an owner deletes all of an add-on's data
-- and it comes back empty, in one step, the moves an owner would make on Settings → Add-ons one after another:
-- uninstall, delete its data, install. The command uninstalls it and marks it to start fresh (`fresh_by`, `fresh_at`);
-- the worker then deletes its data and installs it again as a new generation, and clears the mark. Like deleting an
-- add-on's data, only an owner may, after typing its name, and only while nothing the business holds keeps its data.

alter table app.addon_installations
  add column fresh_by uuid references app.users (id) on delete set null,
  add column fresh_at timestamptz;
create index addon_installations_fresh_by_idx on app.addon_installations (fresh_by) where fresh_by is not null;

-- Marks an add-on being uninstalled to start fresh, for an owner. Security definer: a person never writes the row.
create or replace function private.addon_start_fresh(p_ws uuid, p_addon text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Sign in to change add-ons' using errcode = '42501', detail = 'addon_needs_person';
  end if;
  if not private.has_permission(p_ws, 'addons.purge') then
    raise exception 'Only an owner can start an add-on fresh' using errcode = '42501',
      detail = 'addon_purge_owner_only';
  end if;
  update app.addon_installations i set fresh_by = v_user, fresh_at = now()
  where i.workspace_id = p_ws and i.addon_id = p_addon and i.state = 'uninstalling';
  if not found then
    raise exception 'That add-on isn''t being uninstalled' using errcode = '23514', detail = 'addon_bad_move';
  end if;
end $$;
revoke all on function private.addon_start_fresh(uuid, text) from public;
grant execute on function private.addon_start_fresh(uuid, text) to authenticated;

-- The hourly sweep also picks up an add-on part way through starting fresh, so a lost job never leaves it
-- uninstalled or deleted.
create or replace function private.addon_installations_to_reconcile()
returns table (workspace_id uuid, organization_id uuid, addon_id text)
language sql stable security definer set search_path = '' as $$
  select i.workspace_id, w.organization_id, i.addon_id
  from app.addon_installations i join app.workspaces w on w.id = i.workspace_id
  where (i.state in ('installing', 'uninstalling', 'purging') or i.verified_at is null or i.verified_at < i.changed_at
      or i.fresh_at is not null)
    and w.deletion_requested_at is null
$$;
