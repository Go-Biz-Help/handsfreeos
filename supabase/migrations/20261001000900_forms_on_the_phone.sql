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
