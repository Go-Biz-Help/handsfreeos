-- =============================================================================
-- A message can carry a sealed part (Real Estate round seven, core).
--
--        Chris decided (2026-10-05) that a lockbox's code is sealed, sent only to the confirmed agent just before
--        a showing, and never on phones or in exports. The access email is an ordinary message, so its stored body
--        is what the Inbox, phones and exports see: the code can't be in it. Instead the body carries a marker
--        ("[Lockbox code, kept locked]") and the code waits here, sealed by the worker, which puts it in place only
--        as it hands the email to the provider.
--
--        Only the worker reads or writes this table: no person's role has any grant on it, so it never reaches the
--        API, a phone or an export. It goes with its message.
-- =============================================================================

create table app.message_sealed_parts (
  message_id uuid not null references app.messages (id) on delete cascade,
  position smallint not null check (position between 1 and 5),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- What the stored body says in its place.
  marker text not null check (length(marker) between 3 and 120),
  -- Sealed by the worker for this business, add-on and value (`sealed:v1.…`).
  value_enc text not null check (value_enc like 'sealed:v1.%' and length(value_enc) <= 8200),
  addon_id text not null check (addon_id ~ '^[a-z]{2,16}$'),
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  created_at timestamptz not null default now(),
  primary key (message_id, position)
);
create index message_sealed_parts_workspace_idx on app.message_sealed_parts (workspace_id);
comment on table app.message_sealed_parts is
  'A sealed value an email carries (round seven): the stored body has the marker, and the worker puts the value in place only as it sends. The worker''s alone.';

alter table app.message_sealed_parts enable row level security;
create policy message_sealed_parts_service on app.message_sealed_parts for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
revoke all on app.message_sealed_parts from anon, authenticated;
grant select, insert, delete on app.message_sealed_parts to service_actor;
