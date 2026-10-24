-- =============================================================================
-- Personal form links (funnels): a form link that knows who it's for.
--
--        A workflow's "Send a form" texts each customer their own link,
--        /f/<site>/<form>?k=<key>. The key is random and nothing personal is
--        in the address: it's what ties the link to the customer, kept here
--        only as its SHA-256, as a sheet's resume key is (0074).
--
--        **Opening one knows who they are.** Their sheet is theirs from the
--        first page, the questions that fill a contact detail we already have
--        are skipped, and the page can greet them by name. It never shows the
--        email or phone on file: a forwarded link would show them to whoever
--        opened it.
--
--        **The key also writes to their sheet.** A sheet started from a link
--        carries the link (`form_responses.form_link_id`), and the key is
--        accepted beside the sheet's own resume key, so the link works again
--        from another text without a new key being made each time.
--
--        A link works for 30 days. It is the worker's alone: nobody signed in
--        reads or writes these rows, and the customer's deletion takes them.
-- =============================================================================

create table app.form_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  form_id uuid not null references app.forms (id) on delete cascade,
  person_id uuid not null references app.people (id) on delete cascade,
  -- SHA-256 of the key in the link. The key itself is never stored.
  key_hash bytea not null unique check (octet_length(key_hash) = 32),
  expires_at timestamptz not null,
  -- The first time somebody opened it.
  opened_at timestamptz,
  created_at timestamptz not null default now()
);

create index form_links_person_idx on app.form_links (workspace_id, person_id, created_at desc);
create index form_links_form_idx on app.form_links (form_id);

create trigger form_links_immutable before update on app.form_links
  for each row execute function private.forbid_tenant_column_change(
    'workspace_id', 'form_id', 'person_id', 'key_hash');

alter table app.form_links enable row level security;

create policy form_links_service_all on app.form_links for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.form_links from public, anon, authenticated;
grant select, insert, update, delete on app.form_links to service_actor;

-- ---------- the sheet a link started ----------
alter table app.form_responses
  add column form_link_id uuid references app.form_links (id) on delete set null;

create index form_responses_link_idx on app.form_responses (form_link_id)
  where form_link_id is not null;

-- A sheet the app starts on the phone is never a link's (0109's rule, with the new column).
drop policy form_responses_insert_from_app on app.form_responses;
create policy form_responses_insert_from_app on app.form_responses for insert to authenticated
  with check (
    source = 'app'
    and status = 'in_progress'
    and resume_token_hash is null
    and visitor_hash is null
    and person_id is null
    and lead_id is null
    and invoice_id is null
    and form_link_id is null
    and private.has_permission(workspace_id, 'records.write')
  );

-- People read which link a sheet came from (it's only an id); the key itself stays the worker's.
grant select (form_link_id) on app.form_responses to authenticated;
