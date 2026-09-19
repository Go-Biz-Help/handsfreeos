-- =============================================================================
-- 0080 · What customers said in public (M16).
--
--        The old CRM showed a business its Google and Facebook reviews, and
--        leaving it loses none of them — they were never its reviews to keep.
--        What leaving does lose is the one place the business looked.
--
--        So this connects to the source rather than copying from the CRM: the
--        Google Business Profile and the Facebook Page. Reviews are read from
--        there, kept here so the list opens instantly and a reply can be
--        written beside the rest of a customer's history, and a reply is posted
--        back to where people will read it.
--
--        Two things this deliberately does not do. It does not invent a rating
--        for Facebook, which stopped having stars years ago and has a thumb up
--        or down: that is recorded as what it is. And it never asks a customer
--        for a review on its own — asking is a message to a person, and
--        messages to people are never sent by a table.
-- =============================================================================

create type app.review_provider as enum ('google', 'facebook');
create type app.review_connection_status as enum
  ('pending', 'connected', 'needs_attention', 'disconnected');
-- Facebook has no stars. A recommendation is a yes or a no, and pretending otherwise would put a made-up
-- number beside a real one.
create type app.review_sentiment as enum ('positive', 'negative');

-- ---------- the place the reviews come from ----------
create table app.review_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  provider app.review_provider not null,
  status app.review_connection_status not null default 'pending',
  -- The provider's own id for the place: a Google location, a Facebook page.
  external_account_id text
    check (external_account_id is null or length(btrim(external_account_id)) between 1 and 200),
  -- What the provider calls it, so somebody with three vans in three towns knows which is which.
  display_name text check (display_name is null or length(btrim(display_name)) between 1 and 200),
  /** Where people read it. Shown beside every review from this place. */
  public_url text check (public_url is null or length(btrim(public_url)) between 1 and 500),
  scopes text[] not null default '{}',
  -- The sign-in: a one-time state (hashed) and the PKCE verifier, both sealed, both gone once it finishes.
  oauth_state_hash text unique,
  oauth_state_expires_at timestamptz,
  pkce_verifier_enc text,
  token_enc text,
  token_key_id text,
  token_expires_at timestamptz,
  -- Reading is polled: neither provider will reliably tell us the moment somebody writes one.
  next_sync_at timestamptz,
  last_synced_at timestamptz,
  sync_cursor jsonb not null default '{}'::jsonb check (jsonb_typeof(sync_cursor) = 'object'),
  failures integer not null default 0 check (failures between 0 and 1000000),
  last_error text check (last_error is null or length(last_error) <= 2000),
  disconnected_reason text check (disconnected_reason is null
    or disconnected_reason in ('person', 'revoked', 'failed', 'replaced')),
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'disconnected') = (disconnected_at is not null)),
  check (disconnected_at is not null or disconnected_reason is null)
);
-- One live connection per place. A reconnect replaces the old one rather than doubling the reviews.
create unique index review_connections_place on app.review_connections
  (workspace_id, provider, external_account_id)
  where external_account_id is not null and status <> 'disconnected';
create index review_connections_due on app.review_connections (next_sync_at)
  where status = 'connected' and next_sync_at is not null;
create index review_connections_created_by_idx on app.review_connections (created_by);
create trigger review_connections_updated_at before update on app.review_connections
  for each row execute function private.set_updated_at();
create trigger review_connections_immutable before update on app.review_connections
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'provider', 'created_by');

-- ---------- what people said ----------
create table app.reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  connection_id uuid not null references app.review_connections (id) on delete cascade,
  provider app.review_provider not null,
  -- The provider's own id, which is what stops one review arriving twice.
  external_id text not null check (length(btrim(external_id)) between 1 and 300),
  author_name text check (author_name is null or length(btrim(author_name)) between 1 and 200),
  author_photo_url text check (author_photo_url is null or length(btrim(author_photo_url)) <= 1000),
  -- Google's stars. Null for Facebook, which has none.
  rating smallint check (rating is null or rating between 1 and 5),
  -- Facebook's thumb. Null for Google, where the stars say it.
  sentiment app.review_sentiment,
  body text check (body is null or length(body) <= 10000),
  -- Their time, never ours: a review written in 2019 belongs in 2019.
  posted_at timestamptz not null,
  source_updated_at timestamptz,
  -- Where people read it.
  url text check (url is null or length(btrim(url)) between 1 and 500),
  -- Matched to a customer when the name and the place make that safe; left null rather than guessed.
  person_id uuid references app.people (id) on delete set null,
  -- The reply, as it stands over there. Written here, posted there, and read back on the next sync.
  reply_body text check (reply_body is null or length(reply_body) <= 4000),
  reply_posted_at timestamptz,
  reply_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One of the two ways of saying how it went, never both and never neither.
  check ((rating is null) <> (sentiment is null)),
  check ((reply_body is null) = (reply_posted_at is null))
);
-- The same review read twice is one row.
create unique index reviews_source on app.reviews (workspace_id, provider, external_id);
-- The list: newest first, and "which ones has nobody answered?".
create index reviews_recent on app.reviews (workspace_id, posted_at desc);
create index reviews_unanswered on app.reviews (workspace_id, posted_at desc) where reply_body is null;
create index reviews_person_idx on app.reviews (person_id) where person_id is not null;
create index reviews_connection_idx on app.reviews (connection_id);
create index reviews_reply_by_idx on app.reviews (reply_by);
create trigger reviews_updated_at before update on app.reviews
  for each row execute function private.set_updated_at();
create trigger reviews_immutable before update on app.reviews
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'connection_id',
    'provider', 'external_id');

-- A review belongs to its connection's business.
create or replace function private.check_review_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ws uuid;
begin
  select c.workspace_id into v_ws from app.review_connections c where c.id = new.connection_id;
  if v_ws is distinct from new.workspace_id then
    raise exception 'That connection belongs to another business'
      using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
create trigger reviews_check_refs before insert on app.reviews
  for each row execute function private.check_review_refs();

-- ---------- the sign-in, sharing one callback with the others ----------
-- Mailboxes, calendars, payment accounts and now review places all come back through
-- /oauth/:provider/callback, and the state (hashed) says which one is waiting.
create or replace function private.oauth_connection_by_state(p_state_hash text)
returns table (kind text, connection_id uuid, workspace_id uuid, organization_id uuid, provider text,
  status text, user_id uuid, state_expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select 'mailbox', mc.id, mc.workspace_id, w.organization_id, mc.provider::text, mc.status::text, mc.user_id,
    mc.oauth_state_expires_at
  from app.mailbox_connections mc join app.workspaces w on w.id = mc.workspace_id
  where mc.oauth_state_hash = p_state_hash
  union all
  select 'calendar', cc.id, cc.workspace_id, w.organization_id, cc.provider::text, cc.status::text, cc.user_id,
    cc.oauth_state_expires_at
  from app.calendar_connections cc join app.workspaces w on w.id = cc.workspace_id
  where cc.oauth_state_hash = p_state_hash
  union all
  select 'payment', pc.id, pc.workspace_id, w.organization_id, pc.provider::text, pc.status::text, null::uuid,
    pc.oauth_state_expires_at
  from app.payment_connections pc join app.workspaces w on w.id = pc.workspace_id
  where pc.oauth_state_hash = p_state_hash
  union all
  -- A review place belongs to the business, not to a person, so user_id is null.
  select 'reviews', rc.id, rc.workspace_id, w.organization_id, rc.provider::text, rc.status::text, null::uuid,
    rc.oauth_state_expires_at
  from app.review_connections rc join app.workspaces w on w.id = rc.workspace_id
  where rc.oauth_state_hash = p_state_hash
$$;

-- ---------- permissions ----------
insert into app.role_permissions (role, permission) values
  ('owner', 'reviews.manage'), ('admin', 'reviews.manage');

-- ---------- RLS ----------
alter table app.review_connections enable row level security;
alter table app.reviews enable row level security;

-- The whole team reads what customers said; connecting and disconnecting is the business's own decision.
create policy review_connections_select on app.review_connections for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
-- Starting a sign-in is all a browser may write, and only ever a pending one with nothing in it: the insert
-- is granted on the table, so the policy is what keeps tokens and results out.
create policy review_connections_insert on app.review_connections for insert to authenticated
  with check (private.has_permission(workspace_id, 'reviews.manage')
    and created_by = (select auth.uid()) and status = 'pending'
    and external_account_id is null and pkce_verifier_enc is null and token_enc is null
    and token_key_id is null and token_expires_at is null and connected_at is null
    and disconnected_at is null and failures = 0);
-- Disconnecting is the other thing a person does, and the column grant below says it is all they can change.
create policy review_connections_update on app.review_connections for update to authenticated
  using (private.has_permission(workspace_id, 'reviews.manage'))
  with check (private.has_permission(workspace_id, 'reviews.manage'));
create policy review_connections_service_all on app.review_connections for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy reviews_select on app.reviews for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
-- Answering one. The column grant below is what stops a browser rewriting what a customer said.
create policy reviews_update on app.reviews for update to authenticated
  using (private.has_permission(workspace_id, 'reviews.manage'))
  with check (private.has_permission(workspace_id, 'reviews.manage'));
create policy reviews_service_all on app.reviews for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- grants ----------
-- No token ever reaches a browser, so `authenticated` reads the rows it is allowed to see and writes none
-- of them: connecting, disconnecting and replying all go through the worker.
grant select (id, workspace_id, provider, status, external_account_id, display_name, public_url,
  last_synced_at, last_error, connected_at, disconnected_at, disconnected_reason, created_at, updated_at)
  on app.review_connections to authenticated;
grant insert on app.review_connections to authenticated;
-- Disconnecting, and nothing else: the worker clears the sign-in itself.
grant update (status, disconnected_at, disconnected_reason, next_sync_at, token_enc, token_key_id,
  pkce_verifier_enc, oauth_state_hash, oauth_state_expires_at, updated_at)
  on app.review_connections to authenticated;
grant select on app.reviews to authenticated;
-- A reply, and nothing else. What a customer said is theirs and is never edited here.
grant update (reply_body, reply_posted_at, reply_by, updated_at) on app.reviews to authenticated;
grant select, insert, update, delete on app.review_connections, app.reviews to service_actor;
revoke all on app.review_connections, app.reviews from anon;
