-- =============================================================================
-- About you (docs/outreach.md, decision 165; the owner, 14 Nov 2026: "im not
-- hispanic lol", then "so maybe we need a personal info section").
--        - app.user_about: what a person says of themselves, in their own
--          words, for every AI that writes as them: where they're from, their
--          heritage, family, faith, hobbies, teams, past jobs. One row a
--          person, theirs alone: nobody else on the team reads it (app.users is
--          read by teammates, so it can't live in users.settings). The worker
--          reads it for the people of the business it is scoped to, to write
--          as them.
--        - A deleted account keeps none of it: private.anonymize_user (0059,
--          then 20261027012600) with the row added.
-- =============================================================================

-- ---------- what a person says of themselves ----------
create table app.user_about (
  user_id uuid primary key references app.users (id) on delete cascade,
  about text not null check (char_length(about) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table app.user_about is
  'What a person says of themselves, for the AI that writes as them. Theirs alone: no teammate reads it.';
create trigger user_about_updated_at before update on app.user_about
  for each row execute function private.set_updated_at();

alter table app.user_about enable row level security;
create policy user_about_select on app.user_about for select to authenticated
  using (user_id = (select auth.uid()));
create policy user_about_insert on app.user_about for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy user_about_update on app.user_about for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy user_about_delete on app.user_about for delete to authenticated
  using (user_id = (select auth.uid()));
-- The worker writes as the people of the business it is scoped to.
create policy user_about_service_select on app.user_about for select to service_actor
  using (user_id in (select private.system_scope_user_ids()));

grant select, insert, delete on app.user_about to authenticated;
grant update (about) on app.user_about to authenticated;
grant select on app.user_about to service_actor;
revoke all on app.user_about from anon;

-- ---------- a deleted account keeps none of it ----------
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
  delete from app.user_about a where a.user_id = p_user;
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
