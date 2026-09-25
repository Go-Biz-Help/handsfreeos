-- =============================================================================
-- 0109 · A form filled in on the phone reaches HandsFreeOS (M17).
--
--        0085 put forms on the phone, and `form_response.record` sends what a
--        teammate filled in there for a customer: the answer sheet, made and
--        sent in one go. It runs as the teammate, and every one was refused.
--        0074 said nobody types a response in and only the worker writes
--        them, so `authenticated` could read a sheet and delete one, and
--        nothing else. Nothing ran the command against a database until the
--        phone app's own flows did.
--
--        **What a teammate may now write**, with `records.write`, the
--        permission the command asks for:
--        - a sheet from the app (`source = 'app'`), started with no key and
--          nobody on it yet;
--        - that sheet, while it is still open, sent: its answers, what it
--          worked out, and the customer, lead and invoice it led to, all of
--          them this business's own;
--        - that sheet's answers, one row each;
--        - the form's count of answers for the day.
--
--        **What stays the worker's alone.** A sheet from the link, the embed,
--        a QR code or a conversation: a person can't start one, change one or
--        file answers under one. The resume key's hash and the visitor's hash:
--        a person can neither read them nor set one. A sheet once sent: it is
--        never edited, only deleted (`forms.manage`, as before).
--
--        `one_per_person` becomes readable: "has this customer already
--        answered?" reads it, and it is no secret.
-- =============================================================================

-- ---------- the sheet ----------
create policy form_responses_insert_from_app on app.form_responses for insert to authenticated
  with check (
    source = 'app'
    and status = 'in_progress'
    and resume_token_hash is null
    and visitor_hash is null
    and person_id is null
    and lead_id is null
    and invoice_id is null
    and private.has_permission(workspace_id, 'records.write')
  );

-- Open sheets from the app only: `using` reads the row as it was, so a sent sheet is never touched again, and
-- `source` can't move (form_responses_immutable).
create policy form_responses_update_from_app on app.form_responses for update to authenticated
  using (
    source = 'app'
    and status = 'in_progress'
    and private.has_permission(workspace_id, 'records.write')
  )
  with check (
    private.has_permission(workspace_id, 'records.write')
    and (person_id is null or exists (
      select 1 from app.people p where p.id = person_id and p.workspace_id = form_responses.workspace_id))
    and (lead_id is null or exists (
      select 1 from app.leads l where l.id = lead_id and l.workspace_id = form_responses.workspace_id))
    and (invoice_id is null or exists (
      select 1 from app.invoices i where i.id = invoice_id and i.workspace_id = form_responses.workspace_id))
  );

-- ---------- its answers, one row each ----------
create policy form_answers_insert_from_app on app.form_answers for insert to authenticated
  with check (
    private.has_permission(workspace_id, 'records.write')
    and exists (select 1 from app.form_responses r where r.id = response_id and r.source = 'app')
  );
-- Sending writes each answer with `on conflict do update`, which asks for this even when nothing conflicts.
create policy form_answers_update_from_app on app.form_answers for update to authenticated
  using (
    private.has_permission(workspace_id, 'records.write')
    and exists (select 1 from app.form_responses r where r.id = response_id and r.source = 'app')
  )
  with check (
    private.has_permission(workspace_id, 'records.write')
    and exists (select 1 from app.form_responses r where r.id = response_id and r.source = 'app')
  );

-- ---------- the form's day ----------
create policy form_days_insert_from_app on app.form_days for insert to authenticated
  with check (
    private.has_permission(workspace_id, 'records.write')
    and exists (select 1 from app.forms f where f.id = form_id and f.workspace_id = form_days.workspace_id)
  );
create policy form_days_update_from_app on app.form_days for update to authenticated
  using (private.has_permission(workspace_id, 'records.write'))
  with check (private.has_permission(workspace_id, 'records.write'));

-- ---------- grants ----------
-- Every column, because the insert names every column (Drizzle writes `default` for the ones it isn't given); the
-- policy above is what keeps the hashes empty and the source the app's.
grant insert on app.form_responses to authenticated;
grant update (status, completed_at, answers, calculations, score, score_possible, score_percent, passed,
  result_id, person_id, lead_id, invoice_id, one_per_person) on app.form_responses to authenticated;
grant select (one_per_person) on app.form_responses to authenticated;
grant insert on app.form_answers to authenticated;
grant update (value, number_value, text_value, choice_ids, choice_labels, question_title, answered_at)
  on app.form_answers to authenticated;
grant insert (workspace_id, form_id, day, completions), update (completions) on app.form_days to authenticated;
