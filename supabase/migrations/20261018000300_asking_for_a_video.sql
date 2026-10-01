-- =============================================================================
-- Asking a customer for a video: a link that takes the original.
--
--        A video texted by MMS is whatever the customer's phone and carrier
--        squeezed it into, often a 3GP of 50 KB, and nothing can bring back
--        what was thrown away. So the team (and later the AI teammate) can
--        text a link instead: the customer opens it signed out, picks or
--        records a video, and it goes up as it is, up to 250 MB.
--
--        **The link is a key, kept as its hash.** The page hands back the
--        token; only its SHA-256 is stored, as a form's resume key is. The
--        worker finds the link with private.video_link_lookup(), holding no
--        business while it looks, as Stripe's events find an RCS request.
--
--        **What arrives is a reply.** Each video lands in the conversation
--        as an inbound text with the video on it (core's
--        video_link.receive_upload), so the thread, the unread count, the
--        reply reminder and the phone's sync work unchanged. It is kept in
--        the `telephony` bucket under the message's own folder,
--        <workspace>/messages/<message>/…, which storage_read_allowed already
--        reads by the message's own rules (narrowed inboxes, private mail),
--        and which a business's deletion already removes. That bucket's
--        limit goes up from 25 MB to 250 MB for it; only the worker writes
--        there, and the customer only through a link the worker signs for one
--        path at a time.
--
--        A link lasts a week and takes three videos. It is never shown in
--        full again after it is made: only the person who made it sees it,
--        once, to send.
-- =============================================================================

create table app.video_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  conversation_id uuid not null references app.conversations (id) on delete cascade,
  -- SHA-256 of the token in the link. The token itself is never stored.
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  -- Who asked: a person, or the AI teammate (never both).
  created_by uuid references app.users (id) on delete set null,
  created_by_teammate_id uuid references app.ai_teammates (id) on delete set null,
  expires_at timestamptz not null,
  max_uploads smallint not null default 3 check (max_uploads between 1 and 10),
  -- Uploads begun (a signed upload handed out) and finished. Begun is capped, so a link can't be used to
  -- hand out upload after upload that never arrive.
  uploads_started smallint not null default 0 check (uploads_started between 0 and 20),
  uploads_received smallint not null default 0 check (uploads_received >= 0 and uploads_received <= max_uploads),
  last_upload_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (created_by is null or created_by_teammate_id is null)
);

create index video_links_conversation_idx on app.video_links (workspace_id, conversation_id, created_at desc);

create trigger video_links_updated_at before update on app.video_links
  for each row execute function private.set_updated_at();
create trigger video_links_immutable before update on app.video_links
  for each row execute function private.forbid_tenant_column_change(
    'workspace_id', 'conversation_id', 'token_hash', 'created_by', 'created_by_teammate_id');

alter table app.video_links enable row level security;

-- A person who can open the conversation sees its links and may make one, in their own name and fresh. Nothing
-- else about a link is theirs to change: the counts are the worker's, as each video arrives.
create policy video_links_select on app.video_links for select to authenticated
  using (private.has_permission(workspace_id, 'inbox.use')
    and exists (select 1 from app.conversations c where c.id = conversation_id));
create policy video_links_insert on app.video_links for insert to authenticated
  with check (private.has_permission(workspace_id, 'inbox.use')
    and exists (select 1 from app.conversations c
                where c.id = conversation_id and c.workspace_id = video_links.workspace_id)
    and created_by = (select auth.uid()) and created_by_teammate_id is null
    and uploads_started = 0 and uploads_received = 0 and last_upload_at is null);
create policy video_links_service_all on app.video_links for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.video_links from public, anon;
-- The hash is the worker's alone to read, as a form's resume key is (0074).
grant select (id, workspace_id, conversation_id, created_by, created_by_teammate_id, expires_at, max_uploads,
  uploads_started, uploads_received, last_upload_at, created_at, updated_at) on app.video_links to authenticated;
grant insert on app.video_links to authenticated;
grant select, insert, update, delete on app.video_links to service_actor;

-- ---------- the page finds its link ----------
-- The worker's public routes hold no business until they know whose link it is.
create or replace function private.video_link_lookup(p_hash bytea)
returns table (video_link_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select l.id, l.workspace_id, w.organization_id
  from app.video_links l join app.workspaces w on w.id = l.workspace_id
  where l.token_hash = p_hash and w.deletion_requested_at is null
$$;

revoke all on function private.video_link_lookup(bytea) from public;
grant execute on function private.video_link_lookup(bytea) to service_actor;

-- ---------- room for a whole video ----------
-- 250 MB: about two or three minutes of a phone's full-quality video. The hosted project's own upload limit
-- (Storage → Settings) has to be at least this too, or Storage refuses the upload first.
update storage.buckets set file_size_limit = 262144000 where id = 'telephony';
