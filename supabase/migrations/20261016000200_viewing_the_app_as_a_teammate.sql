-- =============================================================================
-- Viewing the app as a teammate.
--
--        "What does Maria see?" An owner sets up permissions and can't tell
--        what they add up to; support hears "I can't find the money tab" and
--        can't see what that person sees. A view answers it: pick someone,
--        and the web and the phone show the business as they would see it,
--        their menu, their inbox, their money, until you stop.
--
--        **Who may view as whom.** Someone who works in the business may view
--        as a teammate below their role (an owner as an admin or a member, an
--        admin as a member) who can do nothing they can't: the rule that
--        already stops anyone handing out a role above their own. And where
--        the business shows someone only their own threads or bills, only
--        someone who sees all of them views as a person who has some, so a
--        view never shows more than the viewer could see anyway. It is a
--        permission, members.view_as, owners' and admins' by default, which
--        an owner can take away. HandsFreeOS may view as anyone in a business
--        it has open: support inside a look (M13), which keeps its reason, its
--        time limit and the business being told, and the founder inside their
--        session as its owner (20261013002100).
--
--        **Read-only.** A view changes nothing. The API refuses every change
--        to the business a viewing request asks for, and the phone refuses
--        them before they're queued. What the viewer does as themselves
--        elsewhere (their own settings, another business) carries on.
--
--        **How it reads as them.** A request says which view it is in (the
--        `x-hfos-view-as` header). The API asks private.teammate_view() as
--        the viewer whether that view is theirs and still holds, and only
--        then reads the business as the teammate, so every rule answers as it
--        would for them. The viewer is named in the request's claims
--        (`hfos_viewer`), which is how the rules below know someone else is
--        looking.
--
--        **What a view never shows.** A person's own mail (M19) is theirs
--        alone: not the owners', and not anyone viewing as them either. Two
--        restrictive policies hide private threads and their messages from
--        any request read through a view, beside the policies that decide
--        everything else, which stay exactly as they were.
--
--        **What is kept.** Each view: who, as whom, where, when it started and
--        ended. A teammate's view is written into the business's own audit
--        log; support's is told to the business as its look is; the
--        founder's, like their session, is not.
-- =============================================================================

-- ---------- the permission ----------
-- Inserting into role_permissions refreshes everyone's app.workspace_access (20261013000100's triggers).
insert into app.role_permissions (role, permission) values
  ('owner', 'members.view_as'), ('admin', 'members.view_as');
insert into app.customizable_permissions (permission, requires) values ('members.view_as', '{}');

-- ---------- who may view as whom ----------
-- Asked about the caller. HandsFreeOS with the business open (a look, or the founder's session) may view as
-- anyone who works in it; anyone else needs the permission, a role above the person's, and every permission
-- the person holds, so a view shows nothing the viewer couldn't see as themselves.
create or replace function private.may_view_as(p_ws uuid, p_person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    p_person is distinct from auth.uid()
    and private.works_in(p_person, p_ws)
    and exists (select 1 from app.workspaces w where w.id = p_ws and w.deletion_requested_at is null)
    and (
      exists (select 1 from private.my_view_as(p_ws))
      or (
        private.has_permission(p_ws, 'members.view_as')
        and private.role_rank(private.user_workspace_role(p_person, p_ws))
            < private.role_rank(private.my_workspace_role(p_ws))
        and coalesce((select wa.permissions from app.workspace_access wa
                      where wa.user_id = p_person and wa.workspace_id = p_ws), '{}'::text[])
            <@ private.my_permissions(p_ws)
        -- Holding the same permissions isn't seeing the same threads and bills: someone who sees only their own
        -- (0083's narrowed inbox, 0050's members' money) would see the teammate's through the view.
        and (not private.inbox_narrowed(p_ws)
             or not exists (select 1 from app.workspace_access wa
                            where wa.user_id = p_person and wa.workspace_id = p_ws and 'inbox.use' = any (wa.permissions)))
        and (private.has_permission(p_ws, 'money.manage')
             or not exists (select 1 from app.workspace_access wa
                            where wa.user_id = p_person and wa.workspace_id = p_ws and 'money.read' = any (wa.permissions)))
      )
    ), false)
$$;
revoke all on function private.may_view_as(uuid, uuid) from public;
grant execute on function private.may_view_as(uuid, uuid) to authenticated;

-- ---------- the views ----------
create table app.teammate_views (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  viewer_id uuid not null references app.users (id) on delete cascade,
  person_id uuid not null references app.users (id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  check (viewer_id <> person_id),
  check (ended_at is null or ended_at >= started_at)
);
comment on table app.teammate_views is
  'Someone viewing the app as a teammate: read-only, until they stop. Each person sees only their own.';
-- One at a time in each business: opening the next one ends the last.
create unique index teammate_views_one_open on app.teammate_views (viewer_id, workspace_id) where ended_at is null;
create index teammate_views_workspace_idx on app.teammate_views (workspace_id, started_at desc);

-- A view is only ever ended: who, as whom and where stay as they were opened.
create or replace function private.teammate_view_only_ends()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id <> old.id or new.workspace_id <> old.workspace_id or new.organization_id <> old.organization_id
     or new.viewer_id <> old.viewer_id or new.person_id <> old.person_id or new.started_at <> old.started_at
     or new.created_at <> old.created_at or (old.ended_at is not null and new.ended_at is distinct from old.ended_at)
     or new.ended_at is null then
    raise exception 'A view can only be ended' using errcode = '42501', detail = 'teammate_view_only_ends';
  end if;
  return new;
end $$;
revoke all on function private.teammate_view_only_ends() from public;
create trigger teammate_views_only_end before update on app.teammate_views
  for each row execute function private.teammate_view_only_ends();

alter table app.teammate_views enable row level security;

-- The business learns of a view from its audit log, never from this table: the founder's are not its to read.
create policy teammate_views_select on app.teammate_views for select to authenticated
  using (viewer_id = (select auth.uid()));
create policy teammate_views_insert on app.teammate_views for insert to authenticated
  with check (viewer_id = (select auth.uid()) and ended_at is null
    and organization_id = private.workspace_organization(workspace_id)
    and private.may_view_as(workspace_id, person_id));
-- Ending one needs no permission: someone whose role changed since can still stop.
create policy teammate_views_update on app.teammate_views for update to authenticated
  using (viewer_id = (select auth.uid()))
  with check (viewer_id = (select auth.uid()));

revoke all on app.teammate_views from public;
grant select, insert, update on app.teammate_views to authenticated;

-- The view a request names, for the API: where, as whom, and whether it still holds. It answers about the
-- caller's own views and nobody else's, so a made-up id is simply not there. A view stops holding when it is
-- ended, when the viewer may no longer view as that person (their role or permissions changed, the person left,
-- support's look ran out), or when the business is being deleted.
create or replace function private.teammate_view(p_view uuid)
returns table (
  workspace_id uuid, person_id uuid, person_email text, person_name text, person_role text, live boolean)
language sql stable security definer set search_path = '' as $$
  select v.workspace_id, v.person_id, u.email::text, u.full_name,
    private.user_workspace_role(v.person_id, v.workspace_id),
    v.ended_at is null and private.may_view_as(v.workspace_id, v.person_id)
  from app.teammate_views v
  join app.users u on u.id = v.person_id
  where v.id = p_view and v.viewer_id = auth.uid()
$$;
revoke all on function private.teammate_view(uuid) from public;
grant execute on function private.teammate_view(uuid) to authenticated;

-- ---------- what a view never shows ----------
-- Whether this request is read through someone else's view. Only the API sets `hfos_viewer`, and only after
-- private.teammate_view() said yes; anyone else setting it only hides their own private mail from themselves.
create or replace function private.read_through_a_view()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'hfos_viewer', '') <> ''
$$;
revoke all on function private.read_through_a_view() from public;
grant execute on function private.read_through_a_view() to authenticated, service_actor;

-- Restrictive: they narrow what the other policies allow and allow nothing themselves. A private thread's member
-- arm (0083) and its own arm (M19) both answer for its person; through a view, neither does.
create policy conversations_private_not_viewed on app.conversations as restrictive
  for select to authenticated
  using (private_to is null or not (select private.read_through_a_view()));
create policy messages_private_not_viewed on app.messages as restrictive
  for select to authenticated
  using (private_to is null or not (select private.read_through_a_view()));
