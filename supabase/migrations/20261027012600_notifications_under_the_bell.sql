-- =============================================================================
-- Notifications under the bell (the owner, 26 Oct 2026: "when i get a push
-- notification on the phone those notifications should show up in the top
-- right when i tap the notification bell and should see the history of the
-- notifications and then clicking the notification should take me to the
-- relevant screen of the notification").
--
--        app.notifications keeps every push a person's phones were handed,
--        for that person: its words, its business and the screen it opens
--        (`path`, as the push). The bell beside Ask HandsFreeOS lists the
--        business on screen's, never another's (the owner's pick), with the
--        person's own about no business, newest first, on the phone and on
--        the web.
--
--        - **One row per person per thing.** A push that replaces an earlier
--          one on the phone (the same collapse id: a conversation's, a
--          check-in's, an add-on alert's) replaces its row too, and makes it
--          new again at the top. Every other push is a row of its own.
--        - **The worker keeps them** as each send hands the push to the
--          person's phones (private.keep_push_notification), whatever the
--          push's scope: a business's, a support person's or a person's own.
--          Each push is kept once: a retried send changes nothing, and an
--          older push never replaces a newer one.
--        - **People read their own,** and mark them seen (the bell opened,
--          so its count leaves them out) or read (one pressed, in the list or
--          as the push itself): notification.seen and notification.read.
--          Nothing else on a row is theirs to change.
--        - **Kept 30 days** (private.delete_old_notifications, nightly), and
--          only while the person can open the business: losing access takes
--          that business's notifications with it, a support person who stops
--          being one loses the desk's, and deleting an account takes all.
--        - **The phone keeps them** in me_v1 (apps/sync/sync-config.yaml), and
--          the web's bell hears of a new one in a business on its live
--          channel (`notification.kept`, ids none).
--
-- Only adds: a table, its definers, a trigger on app.workspace_access, and one
-- line in private.anonymize_user.
-- =============================================================================

create table app.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.users (id) on delete cascade,
  -- The business it is about; null for a push about none (a new support ticket, a sign-in to the extension).
  workspace_id uuid references app.workspaces (id) on delete cascade,
  -- The push's own id (its data.notificationId): the same on every phone and for everyone it reached.
  push_id uuid not null,
  -- What it replaces on the phone (data.collapseId), else its own push id: one row per person for each.
  collapse_key text not null check (length(collapse_key) between 1 and 64),
  -- The push's category (PUSH_CATEGORIES in @hfos/core/push.ts).
  category text not null check (category ~ '^[a-z][a-z0-9_]{0,39}$'),
  title text not null check (length(title) <= 200),
  subtitle text check (subtitle is null or length(subtitle) <= 200),
  body text not null check (length(body) <= 500),
  -- Where it opens, as the push: /app/w/<business>/…, the support desk's /admin/…, or /app/extension-sign-in/….
  path text not null check (length(path) between 2 and 2000 and path ~ '^/(app|admin)/'),
  -- The records it is about (PushRefs).
  refs jsonb not null default '{}'::jsonb check (jsonb_typeof(refs) = 'object'),
  -- When the push was queued.
  sent_at timestamptz not null,
  -- The bell was opened with it in the list: the count leaves it out.
  seen_at timestamptz,
  -- Pressed, in the list or as the push itself.
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notifications_user_collapse_key unique (user_id, collapse_key)
);
create index notifications_user_sent_idx on app.notifications (user_id, sent_at desc, id);
create index notifications_user_push_idx on app.notifications (user_id, push_id);
create index notifications_workspace_user_idx on app.notifications (workspace_id, user_id);
create index notifications_sent_idx on app.notifications (sent_at);
create trigger notifications_updated_at before update on app.notifications
  for each row execute function private.set_updated_at();

-- ---------- RLS: a person's own; they change only when they saw and read each ----------
alter table app.notifications enable row level security;

create policy notifications_select on app.notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy notifications_update on app.notifications for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select on app.notifications to authenticated;
grant update (seen_at, read_at) on app.notifications to authenticated;
revoke all on app.notifications from anon;

-- The phone keeps a person's own (me_v1).
grant select on app.notifications to hfos_sync;
alter publication powersync add table app.notifications;

-- ---------- the worker keeps them ----------
-- A push handed to these people's phones, kept for each: a new row, or the row it replaces (the same collapse key),
-- made new again. Written once per push and never by an older one, so a retried send changes nothing. A business's
-- push is kept only for people who can still open it. Answers how many rows it wrote; when that is any, a business's
-- web bells hear of it (ids none: the topic is everyone's in the business).
create or replace function private.keep_push_notification(
  p_users uuid[],
  p_workspace uuid,
  p_push uuid,
  p_collapse text,
  p_category text,
  p_title text,
  p_subtitle text,
  p_body text,
  p_path text,
  p_refs jsonb,
  p_sent_at timestamptz
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  insert into app.notifications as n (user_id, workspace_id, push_id, collapse_key, category, title, subtitle, body,
    path, refs, sent_at)
  select u.id, p_workspace, p_push, coalesce(nullif(btrim(p_collapse), ''), p_push::text), p_category,
    left(coalesce(p_title, ''), 200), left(nullif(btrim(p_subtitle), ''), 200), left(coalesce(p_body, ''), 500),
    p_path, coalesce(p_refs, '{}'::jsonb), p_sent_at
  from app.users u
  where u.id = any (p_users)
    and u.deleted_at is null
    and (p_workspace is null
      or exists (select 1 from app.workspace_access a where a.user_id = u.id and a.workspace_id = p_workspace))
  on conflict on constraint notifications_user_collapse_key do update set
    workspace_id = excluded.workspace_id,
    push_id = excluded.push_id,
    category = excluded.category,
    title = excluded.title,
    subtitle = excluded.subtitle,
    body = excluded.body,
    path = excluded.path,
    refs = excluded.refs,
    sent_at = excluded.sent_at,
    seen_at = null,
    read_at = null
  where n.push_id <> excluded.push_id and n.sent_at <= excluded.sent_at;
  get diagnostics v_count = row_count;
  if v_count > 0 and p_workspace is not null then
    perform realtime.send(
      jsonb_build_object(
        'id', gen_random_uuid(),
        'type', 'notification.kept',
        'entityType', 'notification',
        'entityId', null,
        'actorType', 'system',
        'actorId', null,
        'correlationId', null,
        'at', now()
      ),
      'change',
      'workspace:' || p_workspace::text,
      true
    );
  end if;
  return v_count;
end $$;

-- ---------- what goes ----------
-- Someone who can no longer open a business (removed, their agency role gone, the business deleted) keeps none of
-- its notifications: their words came from it.
create or replace function private.notifications_follow_access()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from app.notifications n where n.user_id = old.user_id and n.workspace_id = old.workspace_id;
  return null;
end $$;
create trigger workspace_access_notifications after delete on app.workspace_access
  for each row execute function private.notifications_follow_access();

-- Nightly, a batch at a time: notifications older than 30 days, and the support desk's notifications of anyone who
-- is no longer an active support person.
create or replace function private.delete_old_notifications(p_limit integer default 5000)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  delete from app.notifications n
  where n.id in (
    select x.id from app.notifications x
    where x.sent_at < now() - interval '30 days'
       or (x.workspace_id is null and x.path like '/admin/%'
           and not exists (select 1 from platform.staff s where s.user_id = x.user_id and s.status = 'active'))
    order by x.sent_at
    limit greatest(1, least(coalesce(p_limit, 5000), 10000)));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- A deleted account keeps no notifications (0059's anonymize, with them added).
create or replace function private.anonymize_user(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.users u where u.id = p_user) then
    raise exception 'No such person' using errcode = 'P0002', detail = 'user_not_found';
  end if;
  -- Memberships first: the last-owner rules refuse a business's or agency's only owner.
  delete from app.organization_memberships m where m.user_id = p_user;
  delete from app.workspace_memberships m where m.user_id = p_user;
  delete from app.user_phones p where p.user_id = p_user;
  delete from app.push_devices d where d.user_id = p_user;
  delete from app.notifications n where n.user_id = p_user;
  delete from app.command_receipts r where r.user_id = p_user;
  delete from app.assistant_threads t where t.user_id = p_user;
  -- Their own calendar stops blocking the business's: disconnected, its sealed tokens gone here (as 0017's guard does
  -- for people; the worker's scope bypasses that guard), its busy times by 0017's trigger.
  update app.calendar_connections c set status = 'disconnected', disconnected_at = now(), token_enc = null,
    token_key_id = null, pkce_verifier_enc = null, oauth_state_hash = null, next_sync_at = null
  where c.user_id = p_user and c.status <> 'disconnected';
  update app.users u set
    full_name = 'Former teammate',
    email = 'deleted-' || replace(u.id::text, '-', '') || '@deleted.handsfreeos.invalid',
    avatar_url = null,
    settings = '{}'::jsonb,
    deleted_at = coalesce(u.deleted_at, now())
  where u.id = p_user;
end $$;

-- ---------- function privileges ----------
revoke all on function
  private.keep_push_notification(uuid[], uuid, uuid, text, text, text, text, text, text, jsonb, timestamptz),
  private.notifications_follow_access(),
  private.delete_old_notifications(integer)
  from public;
grant execute on function
  private.keep_push_notification(uuid[], uuid, uuid, text, text, text, text, text, text, jsonb, timestamptz),
  private.delete_old_notifications(integer)
  to service_actor;
-- Whoever ends someone's access runs the trigger: a person, the worker, or Auth deleting an account.
grant execute on function private.notifications_follow_access()
  to authenticated, service_actor, supabase_auth_admin;
