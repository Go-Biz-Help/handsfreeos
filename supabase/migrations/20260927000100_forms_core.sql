-- =============================================================================
-- 0073 · Forms, surveys and quizzes (M15). A business asks its customers
--        something and keeps the answers: an intake form, a satisfaction
--        survey, a staff quiz, a "which service do you need?" quiz that ends in
--        a recommendation. Chris chose (2026-09-18) that these are not three
--        features but one — a form, a survey and a quiz are the same definition
--        with a different `mode`, which is why a business can turn a feedback
--        survey into a scored quiz without rebuilding it.
--
--        The shape is the one workflows already proved (0021), for the same
--        reason: three editors — the question list, the live preview and the
--        Assistant — have to be three views of one thing rather than three
--        things that drift. So a form keeps one draft (`definition`, core's
--        FormDefinition), every editor changes it through patch ops, and
--        publishing freezes the draft as an append-only version. A response
--        keeps the version it was given on for its whole life, so rewording a
--        question never rewrites what somebody already answered.
--
--        forms.manage (owners, admins) builds, publishes and closes; everyone
--        in the business reads. The public page and the embed are signed out
--        entirely — they come through the worker, which is why nothing here is
--        granted to anon and the route function arrives in 0075.
-- =============================================================================

create type app.form_mode as enum ('form', 'survey', 'quiz');
-- `draft` has never been published; `live` is taking answers; `closed` still shows but turns people away
-- (its closing message); `archived` is out of the way and keeps its responses.
create type app.form_status as enum ('draft', 'live', 'closed', 'archived');

-- ---------- forms: the permanent identity, and the one draft every editor changes ----------
create table app.forms (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- What the business calls it in the list. The customer reads the definition's own title.
  name text not null check (length(btrim(name)) between 1 and 120),
  mode app.form_mode not null default 'form',
  status app.form_status not null default 'draft',
  -- The public link: /f/<site>/<slug>, the same shape as a booking link (0015). Renaming retires the old
  -- one below, so a link on a flyer or in a text message keeps working.
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  -- The draft. It is never what a visitor fills in: publishing copies it into form_versions. Core validates it.
  definition jsonb not null default '{}'::jsonb
    check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 524288),
  definition_version integer not null default 1 check (definition_version >= 1),
  -- Every save raises it. A save names the revision it started from and fails with revision_conflict otherwise.
  revision integer not null default 1 check (revision >= 1),
  -- What a visitor gets (foreign key below: versions point back here).
  active_version_id uuid,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  -- Nothing is live or closed until something has been published.
  check (status not in ('live', 'closed') or active_version_id is not null),
  check ((status = 'archived') = (archived_at is not null)),
  unique (workspace_id, slug)
);
create index forms_list_idx on app.forms (workspace_id, status, lower(name));
create index forms_active_version_id_idx on app.forms (active_version_id);
create index forms_created_by_idx on app.forms (created_by);
create trigger forms_updated_at before update on app.forms for each row execute function private.set_updated_at();
create trigger forms_immutable before update on app.forms
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- ---------- versions: what a publish froze. Responses point here for their whole life ----------
create table app.form_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  form_id uuid not null references app.forms (id) on delete cascade,
  version integer not null check (version >= 1),
  definition jsonb not null
    check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 524288),
  definition_version integer not null check (definition_version >= 1),
  -- The draft revision this version froze.
  revision integer not null check (revision >= 1),
  -- Who asked for it: the question list, the Assistant, or an agency template push.
  source text not null default 'editor' check (source in ('editor', 'assistant', 'template')),
  -- What changed since the last version, in plain English (core's diffForms), for the history screen.
  diff_summary jsonb not null default '[]'::jsonb check (jsonb_typeof(diff_summary) = 'array'),
  published_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (form_id, version)
);
create index form_versions_workspace_id_idx on app.form_versions (workspace_id);
create index form_versions_published_by_idx on app.form_versions (published_by);

-- NO ACTION rather than RESTRICT: deleting a whole form or workspace cascades to both sides at once, and
-- NO ACTION checks only at the end of that statement.
alter table app.forms add constraint forms_active_version_id_fkey
  foreign key (active_version_id) references app.form_versions (id);

-- A version never changes and never goes on its own; 0021's guard does the work (its arguments are the
-- parent table and the column naming it, then the tenant table and its column).
create trigger form_versions_append_only before update or delete on app.form_versions
  for each row execute function private.guard_version_row('forms', 'form_id', 'workspaces', 'workspace_id');

-- A version belongs to its form's workspace, and an active version belongs to the form that points at it.
create or replace function private.check_form_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_form_workspace uuid;
  v_version_form uuid;
begin
  if tg_table_name = 'form_versions' then
    select f.workspace_id into v_form_workspace from app.forms f where f.id = new.form_id;
    if v_form_workspace is distinct from new.workspace_id then
      raise exception 'That form belongs to another business' using errcode = '23514', detail = 'cross_workspace';
    end if;
  elsif new.active_version_id is not null then
    select v.form_id into v_version_form from app.form_versions v where v.id = new.active_version_id;
    if v_version_form is distinct from new.id then
      raise exception 'That version belongs to another form' using errcode = '23514', detail = 'cross_form';
    end if;
  end if;
  return new;
end $$;
create trigger form_versions_check_refs before insert on app.form_versions
  for each row execute function private.check_form_refs();
create trigger forms_check_refs before insert or update of active_version_id on app.forms
  for each row execute function private.check_form_refs();

-- ---------- retired slugs: a renamed form's old links still land ----------
create table app.form_slugs (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  form_id uuid not null references app.forms (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  retired_at timestamptz not null default now(),
  primary key (workspace_id, slug)
);
create index form_slugs_form_idx on app.form_slugs (form_id);

-- The name a form is leaving goes on the retired list; taking a name back takes it off, since a live slug
-- always wins over a retired one.
create or replace function private.track_form_slug()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.slug is distinct from new.slug then
    insert into app.form_slugs (workspace_id, form_id, slug) values (old.workspace_id, old.id, old.slug)
      on conflict (workspace_id, slug) do update set form_id = excluded.form_id, retired_at = now();
    delete from app.form_slugs s where s.workspace_id = new.workspace_id and s.slug = new.slug;
  end if;
  return new;
end $$;
create trigger forms_track_slug after update of slug on app.forms
  for each row execute function private.track_form_slug();

-- ---------- permissions ----------
insert into app.role_permissions (role, permission) values
  ('owner', 'forms.manage'), ('admin', 'forms.manage');

-- ---------- RLS: the whole team reads; forms.manage builds, publishes and closes ----------
alter table app.forms enable row level security;
alter table app.form_versions enable row level security;
alter table app.form_slugs enable row level security;

create policy forms_select on app.forms for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
-- A new form is a draft with nothing published.
create policy forms_insert on app.forms for insert to authenticated
  with check (private.has_permission(workspace_id, 'forms.manage') and created_by = (select auth.uid())
    and status = 'draft' and active_version_id is null and archived_at is null);
create policy forms_update on app.forms for update to authenticated
  using (private.has_permission(workspace_id, 'forms.manage'))
  with check (private.has_permission(workspace_id, 'forms.manage'));
create policy forms_service_all on app.forms for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy form_versions_select on app.form_versions for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy form_versions_insert on app.form_versions for insert to authenticated
  with check (private.has_permission(workspace_id, 'forms.manage') and published_by = (select auth.uid()));
create policy form_versions_service_all on app.form_versions for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy form_slugs_select on app.form_slugs for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy form_slugs_service_all on app.form_slugs for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- grants ----------
grant select, insert on app.forms, app.form_versions to authenticated;
grant update (name, mode, status, slug, definition, definition_version, revision, active_version_id,
  updated_at, archived_at) on app.forms to authenticated;
grant select on app.form_slugs to authenticated;
grant select, insert, update, delete on app.forms, app.form_versions, app.form_slugs to service_actor;
