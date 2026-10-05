-- =============================================================================
-- The AI teammate uses add-ons (round seven, step 5; Chris 2026-10-05: answer
-- from their deal, ask before acting).
--
--        Look-ups as the customer. An add-on names the queries its client's
--        portal runs that the teammate may run too. The worker runs them as
--        `portal_actor` with the teammate's run in `app.portal.teammate_run`
--        instead of a device's session: while that run is still answering
--        (running, under 30 minutes old, for a customer), the portal's rules
--        see the run's customer, so the teammate reads exactly what that
--        client's portal shows them and nothing about anyone else. It never
--        writes: a customer's changes run as the service actor, and the kernel
--        refuses a customer with no device session any command.
--
--        Asks. What an add-on lets the teammate ask for waits in a draft of
--        its own kind, 'ask', tied to the record it's about (the client's
--        deal). Someone who may see that conversation and that record decides
--        it; approving runs the add-on's command as them, so their own
--        permission is checked again then.
-- =============================================================================

-- ---------- who is asking: a device, or the teammate answering its customer ----------
create or replace function portal.session()
returns table (person_id uuid, workspace_id uuid) language sql stable security definer set search_path = '' as $$
  select s.person_id, s.workspace_id
  from app.portal_sessions s join app.portal_access a on a.id = s.access_id
  where current_setting('role', true) = 'portal_actor'
    and s.id = nullif(current_setting('app.portal.session_id', true), '')::uuid
    and s.ended_at is null and a.revoked_at is null
    and s.expires_at > now() and s.last_seen_at > now() - interval '30 days'
  union all
  -- The teammate, for one run: never alongside a device's session, and only while the run is answering.
  select r.person_id, r.workspace_id
  from app.ai_teammate_runs r
  where current_setting('role', true) = 'portal_actor'
    and nullif(current_setting('app.portal.session_id', true), '') is null
    and r.id = nullif(current_setting('app.portal.teammate_run', true), '')::uuid
    and r.status = 'running' and r.person_id is not null
    and r.started_at > now() - interval '30 minutes'
$$;

-- ---------- an ask: a draft about one of an add-on's records ----------
alter table app.ai_teammate_drafts drop constraint ai_teammate_drafts_kind_check;
alter table app.ai_teammate_drafts add constraint ai_teammate_drafts_kind_check
  check (kind in ('reply', 'approval', 'call', 'ask'));

alter table app.ai_teammate_drafts
  add column custom_record_id uuid references app.custom_records (id) on delete cascade;
alter table app.ai_teammate_drafts add constraint ai_teammate_drafts_ask_record_check
  check ((kind = 'ask') = (custom_record_id is not null));
comment on column app.ai_teammate_drafts.custom_record_id is
  'An ask''s record (round seven): the add-on record it is about, which whoever decides it must be able to see.';

create index ai_teammate_drafts_custom_record_id_idx on app.ai_teammate_drafts (custom_record_id)
  where custom_record_id is not null;

-- An ask's record is one of an add-on's, in the draft's business.
create or replace function private.check_ai_draft_record()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.custom_record_id is not null and not exists (
    select 1 from app.custom_records r join app.custom_record_types k on k.id = r.type_id
    where r.id = new.custom_record_id and r.workspace_id = new.workspace_id and k.addon_id is not null
  ) then
    raise exception 'ai_teammate_drafts references a record outside its workspace' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.check_ai_draft_record() from public;
grant execute on function private.check_ai_draft_record() to authenticated, service_actor;
create trigger ai_teammate_drafts_check_record before insert or update of custom_record_id
  on app.ai_teammate_drafts for each row execute function private.check_ai_draft_record();

-- 20261012020100's, and an ask is decided by somebody who works the inbox, may see its thread, and may see its
-- record: a deal kept to its people is decided by one of them (or someone who sees every one).
drop policy if exists ai_teammate_drafts_update on app.ai_teammate_drafts;
create policy ai_teammate_drafts_update on app.ai_teammate_drafts for update to authenticated
  using (status = 'pending'
    and private.has_permission(workspace_id, case when kind in ('reply', 'call', 'ask') then 'inbox.use' else 'ai_team.manage' end)
    and (not private.inbox_narrowed(workspace_id) or member_viewer_ids @> array[(select auth.uid())])
    and (kind <> 'ask' or private.custom_record_visible(custom_record_id)))
  with check (status in ('approved', 'rejected', 'cancelled') and decided_by = (select auth.uid())
    and via in ('web', 'assistant', 'mobile')
    and private.has_permission(workspace_id, case when kind in ('reply', 'call', 'ask') then 'inbox.use' else 'ai_team.manage' end)
    and (kind <> 'ask' or private.custom_record_visible(custom_record_id)));
