-- =============================================================================
-- Saving the texting registration as the business fills it in.
--
--        The registration wizard (Settings → Texting & calls) asks eight
--        steps of questions: the EIN, the address, two example texts, how
--        customers agree, the privacy policy. Until now every answer lived
--        only in the open browser tab, so a refresh, a closed laptop or a
--        trip to find the EIN letter threw the lot away.
--
--        **One row per business, not a `draft` row in
--        app.telephony_registrations.** Those rows are the carrier chain: a
--        row per step, walked by the worker, read by the texting page's
--        status and by the hosted privacy policy. A half-typed form is none
--        of those things, and a `draft` step there would be read as the
--        latest registration. So the answers sit here, loosely shaped (the
--        wizard's own form), until the business presses Send, and
--        `registration.submit` deletes the row in the same transaction.
--
--        **The EIN is in here**, like `submission` on the registration, so
--        only people who can manage the business's channels see the row, and
--        it is deliberately absent from the `powersync` publication.
-- =============================================================================
create table app.registration_drafts (
  workspace_id uuid primary key references app.workspaces (id) on delete cascade,
  answers jsonb not null default '{}'::jsonb
    check (jsonb_typeof(answers) = 'object' and pg_column_size(answers) <= 32768),
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger registration_drafts_updated_at before update on app.registration_drafts
  for each row execute function private.set_updated_at();
create trigger registration_drafts_immutable before update on app.registration_drafts
  for each row execute function private.forbid_tenant_column_change('workspace_id');

alter table app.registration_drafts enable row level security;

-- The same permission as sending the registration: the draft is the registration, not sent yet.
create policy registration_drafts_select on app.registration_drafts for select to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'));
create policy registration_drafts_insert on app.registration_drafts for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy registration_drafts_update on app.registration_drafts for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'))
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy registration_drafts_delete on app.registration_drafts for delete to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'));
create policy registration_drafts_service_all on app.registration_drafts for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.registration_drafts from public;
grant select, insert, update, delete on app.registration_drafts to authenticated;
grant select, insert, update, delete on app.registration_drafts to service_actor;
