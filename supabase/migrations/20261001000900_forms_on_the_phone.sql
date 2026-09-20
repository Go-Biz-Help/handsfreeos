-- =============================================================================
-- 0085 · A form, filled in on a phone, with no signal (M17).
--
--        docs/forms.md has said what was missing since M15: the engine is
--        ready — `formState` is browser-safe and runs on the phone unchanged —
--        and what was not there was the form itself reaching the phone.
--
--        **Two tables, not three.** `app.forms` and `app.form_versions` go into
--        the publication; `app.form_responses` deliberately does not. Its
--        `resume_token_hash` is a secret column by the rule
--        packages/db/test/sync-secrets.test.ts enforces, and PowerSync's first
--        copy of a table reads every column whatever the stream selects — so
--        publishing it would put a token hash in PowerSync's own storage for
--        no gain. A phone does not need a response row to fill a form in. It
--        needs the questions; the answers go back as one command.
--
--        **`form_versions.is_active` is a stored flag**, for the same reason
--        `sync_window` is one (0056): a stream query cannot join, so "the
--        version this form is actually serving" has to be written down. A
--        business with forty forms and three hundred versions between them
--        syncs forty rows rather than three hundred, each of which may be half
--        a megabyte of JSON.
--
--        The flag means *a phone should hold this one*, which is narrower than
--        "it is the active version": a closed or archived form is not taking
--        answers, so its version is not worth a phone's disk.
-- =============================================================================

alter table app.form_versions add column is_active boolean not null default false;

comment on column app.form_versions.is_active is
  'The version a phone should hold: this form''s active version, while the form is live (0085). Kept by '
  'private.form_sync_active(); writing it by hand does nothing, the trigger replaces it.';

-- ---------- an append-only version still has one thing that moves ----------
-- `form_versions_append_only` (0069) freezes a published version through private.guard_version_row(), and
-- until this was run against a real database it froze `is_active` with it: every write below was refused,
-- the flag was never set, and nothing reached a phone. The whole of this migration was inert.
--
-- `is_active` is not content. It says which version the form currently points at, which is a fact about the
-- *form*, mirrored here because a PowerSync stream cannot join. So the guard learns it, the way it already
-- carves out `published_by` being cleared when a user is deleted.
--
-- **Scoped to the table that has the column.** `to_jsonb(new) ? 'is_active'` is false on
-- app.workflow_versions and app.workflow_template_versions, which share this guard, so nothing about them
-- changes — not even a no-op update, which they still refuse. And a write that touches content *and*
-- `is_active` is still refused here: the carve-out is the flag alone or nothing.
create or replace function private.guard_version_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_parent_alive boolean;
  v_tenant_alive boolean;
begin
  if tg_op = 'DELETE' then
    execute format('select exists (select 1 from app.%I x where x.id = $1)', tg_argv[0])
      into v_parent_alive using (to_jsonb(old) ->> tg_argv[1])::uuid;
    execute format('select exists (select 1 from app.%I x where x.id = $1)', tg_argv[2])
      into v_tenant_alive using (to_jsonb(old) ->> tg_argv[3])::uuid;
    if not (v_parent_alive and v_tenant_alive) then
      return old;
    end if;
  elsif new.published_by is null and (to_jsonb(new) - 'published_by') = (to_jsonb(old) - 'published_by') then
    return new;
  elsif to_jsonb(new) ? 'is_active'
        and (to_jsonb(new) - 'is_active') = (to_jsonb(old) - 'is_active') then
    return new;
  end if;
  raise exception '%.% is append-only', tg_table_schema, tg_table_name
    using errcode = '42501', detail = 'version_immutable';
end $$;

-- ---------- what a phone should hold ----------
create or replace function private.form_sync_active(p_form uuid)
returns void language sql security definer set search_path = '' as $$
  update app.form_versions v
  set is_active = (
    v.id = (select f.active_version_id from app.forms f where f.id = p_form and f.status = 'live')
  )
  where v.form_id = p_form
    and v.is_active is distinct from (
      v.id = (select f.active_version_id from app.forms f where f.id = p_form and f.status = 'live')
    );
$$;

create or replace function private.form_sync_active_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.form_sync_active(new.id);
  return null;
end $$;
-- Publishing moves active_version_id; closing or archiving moves status. Both change the answer.
create trigger forms_sync_active after insert or update of active_version_id, status on app.forms
  for each row execute function private.form_sync_active_changed();

create index form_versions_is_active_idx on app.form_versions (workspace_id) where is_active;

-- Every form that already has one.
select private.form_sync_active(f.id) from app.forms f where f.active_version_id is not null;

-- ---------- to the phone ----------
alter publication powersync add table app.forms, app.form_versions;
grant select on app.forms, app.form_versions to hfos_sync;
