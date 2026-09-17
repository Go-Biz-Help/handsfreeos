-- =============================================================================
-- 0063 · Newest wins for changes of state. A change made on a phone with no
--        signal can arrive after a later change to the same thing, by someone
--        else or by a customer's message, and the later one stands: the
--        commands don't apply the phone's, and say so on the timeline. To tell,
--        they need when each thing last changed, at the moment the change was
--        made (private.change_moment, 0062):
--          - conversations.status_changed_at: when it was last opened, closed
--            or snoozed, or its snooze moved. A trigger stamps it whoever writes
--            (a customer's message reopens a conversation through the worker);
--          - appointments.rescheduled_at: when its start last moved, by the team
--            or the customer. A trigger stamps it too;
--          - app.record_tag_removals: when a tag last came off a record. A tag
--            that's on says when it went on (record_tags.created_at); one that's
--            off needs this. A trigger on record_tags keeps it, so nobody writes
--            it by hand.
--        What already says when: a task's done state (field_times.done_at,
--        written by task.complete and task.reopen), a lead's stage
--        (stage_entered_at), an attention item (opened_at, snoozed_at,
--        dismissed_at) and a qualifying answer (answeredAt).
--        Also: a draft or an approval decided on the phone says so
--        (via = 'mobile').
-- =============================================================================

-- ---------- when a conversation's status last changed ----------
alter table app.conversations add column status_changed_at timestamptz;
comment on column app.conversations.status_changed_at is
  'When it was last opened, closed or snoozed, or its snooze moved: the moment the change was made (0063). Stamped by a trigger; null until the first change after 0063.';

create or replace function private.stamp_conversation_status()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.status, new.snoozed_until) is distinct from (old.status, old.snoozed_until) then
    new.status_changed_at := private.change_moment();
  else
    new.status_changed_at := old.status_changed_at;
  end if;
  return new;
end $$;
create trigger conversations_status_changed before update on app.conversations
  for each row execute function private.stamp_conversation_status();

-- ---------- when an appointment last moved ----------
alter table app.appointments add column rescheduled_at timestamptz;
comment on column app.appointments.rescheduled_at is
  'When its start last moved: the moment the change was made (0063). Stamped by a trigger; null until it first moves after 0063.';

create or replace function private.stamp_appointment_move()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.starts_at is distinct from old.starts_at then
    new.rescheduled_at := private.change_moment();
  else
    new.rescheduled_at := old.rescheduled_at;
  end if;
  return new;
end $$;
create trigger appointments_rescheduled before update on app.appointments
  for each row execute function private.stamp_appointment_move();

-- ---------- when a tag last came off a record ----------
create table app.record_tag_removals (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  tag_id uuid not null references app.tags (id) on delete cascade,
  record_type app.record_type not null,
  record_id uuid not null,
  -- The moment the tag was taken off (a phone's, corrected for its clock), whoever took it off.
  removed_at timestamptz not null,
  primary key (tag_id, record_type, record_id)
);
create index record_tag_removals_workspace_idx on app.record_tag_removals (workspace_id);
comment on table app.record_tag_removals is
  'When a tag last came off a record (0063), so a change made before it (on a phone with no signal) doesn''t put it back. Kept by a trigger on record_tags.';

-- SECURITY DEFINER: it runs as the table's owner, so the row is written whoever took the tag off, and nobody writes
-- one by hand. A tag or a business being deleted takes its rows with it, and there's nothing to remember then.
create or replace function private.note_tag_removal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.tags t where t.id = old.tag_id)
     or not exists (select 1 from app.workspaces w where w.id = old.workspace_id) then
    return null;
  end if;
  insert into app.record_tag_removals (workspace_id, tag_id, record_type, record_id, removed_at)
  values (old.workspace_id, old.tag_id, old.record_type, old.record_id, private.change_moment())
  on conflict (tag_id, record_type, record_id) do update set removed_at = excluded.removed_at;
  return null;
end $$;
create trigger record_tags_note_removal after delete on app.record_tags
  for each row execute function private.note_tag_removal();

alter table app.record_tag_removals enable row level security;
create policy record_tag_removals_select on app.record_tag_removals for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy record_tag_removals_service_select on app.record_tag_removals for select to service_actor
  using (workspace_id = private.system_scope_workspace());
grant select on app.record_tag_removals to authenticated, service_actor;

-- ---------- a decision made on the phone ----------
alter table app.workflow_approvals drop constraint workflow_approvals_via_check;
alter table app.workflow_approvals add constraint workflow_approvals_via_check
  check (via is null or via in ('web', 'email', 'assistant', 'system', 'mobile'));
alter table app.ai_teammate_drafts drop constraint ai_teammate_drafts_via_check;
alter table app.ai_teammate_drafts add constraint ai_teammate_drafts_via_check
  check (via is null or via in ('web', 'email', 'assistant', 'system', 'mobile'));

-- 0021's and 0032's rules, with the phone among the places a person decides from.
drop policy workflow_approvals_update on app.workflow_approvals;
create policy workflow_approvals_update on app.workflow_approvals for update to authenticated
  using (status = 'pending' and workspace_id in (select private.accessible_workspace_ids())
    and (private.has_permission(workspace_id, 'workflows.manage') or (select auth.uid()) = any (approvers)))
  with check (status in ('approved', 'rejected') and decided_by = (select auth.uid())
    and via in ('web', 'assistant', 'mobile')
    and (private.has_permission(workspace_id, 'workflows.manage') or (select auth.uid()) = any (approvers)));
drop policy ai_teammate_drafts_update on app.ai_teammate_drafts;
create policy ai_teammate_drafts_update on app.ai_teammate_drafts for update to authenticated
  using (status = 'pending'
    and private.has_permission(workspace_id, case when kind = 'reply' then 'inbox.use' else 'ai_team.manage' end))
  with check (status in ('approved', 'rejected', 'cancelled') and decided_by = (select auth.uid())
    and via in ('web', 'assistant', 'mobile')
    and private.has_permission(workspace_id, case when kind = 'reply' then 'inbox.use' else 'ai_team.manage' end));

-- ---------- function privileges ----------
revoke all on function
  private.stamp_conversation_status(), private.stamp_appointment_move(), private.note_tag_removal()
  from public;
grant execute on function
  private.stamp_conversation_status(), private.stamp_appointment_move(), private.note_tag_removal()
  to authenticated, service_actor;
