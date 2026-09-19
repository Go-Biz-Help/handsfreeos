-- =============================================================================
-- 0077 · "One answer per customer" is a setting, not a law (M15). 0074 put a
--        unique index on (form_id, person_id) for completed responses, which
--        quietly made every form refuse a customer's second answer — wrong for
--        the ordinary case, where a customer books a job in March and another
--        in September through the same form.
--
--        The setting lives in the form's definition, which an index can't read.
--        So the response carries the answer to it: `one_per_person` is copied
--        from the version they filled in, and the unique index covers only the
--        rows that asked for it. The race two tabs can run is still settled by
--        the database rather than by a check in code.
-- =============================================================================

drop index if exists app.form_responses_one_per_person;

alter table app.form_responses
  -- Copied from the version's settings as the response is sent, so changing the setting later never
  -- rewrites what was true when somebody answered.
  add column one_per_person boolean not null default false;

create unique index form_responses_one_per_person on app.form_responses (form_id, person_id)
  where one_per_person and person_id is not null and status = 'completed';

comment on column app.form_responses.one_per_person is
  'The form asked for one answer per customer when this one was sent (see the unique index).';
