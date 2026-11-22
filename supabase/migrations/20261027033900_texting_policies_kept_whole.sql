-- =============================================================================
-- A business's own privacy policy and terms, kept whole once the part about
-- texts has been added (the owner, 22 Nov 2026: "give them the entire policy
-- and terms based on what they already have so they can copy and paste", and
-- "the entire policies should be included in the files sent to their web
-- person").
--
--        Texting approval reads a business's own policy from its page (or
--        from what it pasted) and hands it back whole, with the section the
--        carriers look for in its place. Until now that lived only in the
--        open browser tab: coming back meant reading the page and asking the
--        AI again, and "Email your web person" could send only the section.
--
--        **app.registration_policies** keeps the last one made for each
--        document: one row per business and kind ('privacy', 'terms'), with
--        the address it's for, whether its words were pasted, the document as
--        blocks (the business's own words, the new section marked) and the
--        lines of its own that changed.
--
--        Only the worker writes it (registration.record_policy), as it makes
--        one. People who manage the business's channels read it, like the
--        registration it belongs to. It says what a business is in the middle
--        of, so it is not in the powersync publication.
-- =============================================================================

create table app.registration_policies (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  kind text not null check (kind in ('privacy', 'terms')),
  -- The page the document is on, as the registration names it. Null when it was pasted with no address given.
  source_url text check (char_length(source_url) <= 2000),
  -- Its words were pasted in, because the page couldn't be read.
  pasted boolean not null default false,
  blocks jsonb not null
    check (jsonb_typeof(blocks) = 'array' and pg_column_size(blocks) <= 524288),
  changes jsonb not null default '[]'::jsonb
    check (jsonb_typeof(changes) = 'array' and pg_column_size(changes) <= 65536),
  made_by uuid references app.users (id) on delete set null,
  made_at timestamptz not null default now(),
  primary key (workspace_id, kind)
);
comment on table app.registration_policies is
  'A business''s own privacy policy or terms as texting approval last handed it back: whole, with the part about texts in place.';
create trigger registration_policies_immutable before update on app.registration_policies
  for each row execute function private.forbid_tenant_column_change('workspace_id');

alter table app.registration_policies enable row level security;

create policy registration_policies_select on app.registration_policies for select to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'));
create policy registration_policies_service_all on app.registration_policies for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.registration_policies from public;
grant select on app.registration_policies to authenticated;
grant select, insert, update, delete on app.registration_policies to service_actor;
