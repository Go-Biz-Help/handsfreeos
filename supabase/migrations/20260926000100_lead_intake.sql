-- =============================================================================
-- 0072 · Lead intake (M14, slice A). A stranger who texts, calls or emails a
--        business becomes a customer and an open lead by themselves, so the
--        workflows, the AI teammate and the Action Center that wait on
--        lead.created all wake up without anybody typing the person in.
--
--        Every way a lead can arrive is a row here: the three channels now,
--        website forms and API keys later (slice B). A channel a business
--        never touched has no row at all and takes the defaults (on, opens a
--        lead, in the default pipeline), so nothing has to be seeded for the
--        businesses that already exist. Turning one off, pointing it at
--        another pipeline or renaming it writes the row.
--
--        channels.manage (owners, admins) sets them; everyone in the business
--        can see them; the worker reads them and keeps the daily counter,
--        which is what stops a robocall storm from filling the pipeline.
-- =============================================================================

create type app.intake_kind as enum ('text', 'call', 'email', 'website_form', 'api');

create table app.intake_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  kind app.intake_kind not null,
  -- What the customer and the lead are filed under ("Text message"), so the pipeline shows where leads come from.
  name text not null check (length(btrim(name)) between 1 and 60),
  active boolean not null default true,
  -- Off: the customer record is still made and the conversation links to it, but no lead opens.
  create_lead boolean not null default true,
  -- Where its leads land. Null is the business's default pipeline and its first open stage, which is what
  -- lead.create picks on its own, so a business that reorders its pipelines never has a stale setting here.
  pipeline_id uuid references app.pipelines (id) on delete set null,
  stage_id uuid references app.pipeline_stages (id) on delete set null,
  -- The most leads a day this source may open by itself. The counter below is the day it counted.
  daily_cap integer not null default 50 check (daily_cap between 1 and 1000),
  day_count integer not null default 0 check (day_count >= 0),
  day_on date,
  last_intake_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A stage without its pipeline says nothing.
  check (stage_id is null or pipeline_id is not null),
  -- The count belongs to a day: one without the other would be a count of nothing.
  check ((day_on is null) = (day_count = 0))
);
-- A channel is one row per business; forms and API keys (slice B) may be many.
create unique index intake_sources_channel_unique on app.intake_sources (workspace_id, kind)
  where kind in ('text', 'call', 'email');
create index intake_sources_workspace_idx on app.intake_sources (workspace_id, kind);
create trigger intake_sources_updated_at before update on app.intake_sources
  for each row execute function private.set_updated_at();
create trigger intake_sources_immutable before update on app.intake_sources
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'kind', 'created_by');

-- The pipeline and stage a source points at are the workspace's own, and the stage is in that pipeline.
create or replace function private.check_intake_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  if new.pipeline_id is not null and not exists (
      select 1 from app.pipelines p where p.id = new.pipeline_id and p.workspace_id = new.workspace_id) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  if new.stage_id is not null and not exists (
      select 1 from app.pipeline_stages s
      where s.id = new.stage_id and s.workspace_id = new.workspace_id and s.pipeline_id = new.pipeline_id) then
    raise exception 'That stage is in another pipeline' using errcode = '23514', detail = 'stage_pipeline_mismatch';
  end if;
  return new;
end $$;
create trigger intake_sources_check_refs before insert or update of pipeline_id, stage_id on app.intake_sources
  for each row execute function private.check_intake_refs();

-- ---------- RLS: everyone in the business sees them, channels.manage sets them, the worker counts ----------
alter table app.intake_sources enable row level security;

create policy intake_sources_select on app.intake_sources for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy intake_sources_insert on app.intake_sources for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage') and created_by = (select auth.uid()));
create policy intake_sources_update on app.intake_sources for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'))
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy intake_sources_service_all on app.intake_sources for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- grants ----------
grant select, insert on app.intake_sources to authenticated;
-- The counter and the clock are the worker's; people name a source, point it somewhere and turn it off.
grant update (name, active, create_lead, pipeline_id, stage_id, daily_cap) on app.intake_sources to authenticated;
grant select, insert, update on app.intake_sources to service_actor;

revoke all on function private.check_intake_refs() from public;
grant execute on function private.check_intake_refs() to authenticated, service_actor;
