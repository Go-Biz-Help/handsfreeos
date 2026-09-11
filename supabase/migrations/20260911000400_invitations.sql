-- =============================================================================
-- 0004 · Invitations. Only the sha256 of the link token is ever stored; the
--        worker mints the token when it sends the email (0005 grants it the
--        columns). One pending invitation per email per workspace.
-- =============================================================================

create table app.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  email extensions.citext not null,
  role app.member_role not null default 'member',
  token_hash bytea unique,
  invited_by uuid references app.users (id) on delete set null,
  sent_at timestamptz,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references app.users (id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email::text ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$')
);
create unique index invitations_one_pending_per_email on app.invitations (workspace_id, email)
  where accepted_at is null and revoked_at is null;
create index invitations_workspace_idx on app.invitations (workspace_id, created_at desc);
create index invitations_email_idx on app.invitations (email);
create trigger invitations_updated_at before update on app.invitations
  for each row execute function private.set_updated_at();
create trigger invitations_immutable before update on app.invitations
  for each row execute function private.forbid_tenant_column_change('organization_id', 'workspace_id', 'email', 'role', 'invited_by');

-- ---------- grants: token_hash is never readable by app roles ----------
grant select (id, organization_id, workspace_id, email, role, invited_by, sent_at, expires_at,
  accepted_at, accepted_by, revoked_at, revoked_by, created_at, updated_at) on app.invitations to authenticated;
grant insert on app.invitations to authenticated; -- RLS (0005) forbids setting token/acceptance/revocation columns
grant update (revoked_at, revoked_by, updated_at) on app.invitations to authenticated;

grant select (id, organization_id, workspace_id, email, role, invited_by, sent_at, expires_at,
  accepted_at, accepted_by, revoked_at, revoked_by, created_at, updated_at) on app.invitations to service_actor;
grant update (token_hash, sent_at, expires_at, updated_at) on app.invitations to service_actor;
revoke all on app.invitations from anon;
