-- =============================================================================
-- 0031 · The AI teammate. Each business has one AI teammate: an ai_teammates
--        row, never a user account, so it can't sign in or hold a membership
--        (the kernel records what it does as actor_type 'ai_employee' with
--        the teammate's id). Its settings document (`config`, core's
--        TeammateConfig) alone defines what it does, with a snapshot of every
--        save to restore from, as calendars have. Training wheels: while it
--        trains, everything it would say to a customer waits for a person's
--        OK, and each decision is counted by private.record_teammate_decision,
--        the only writer of the counts, which turns it automatic at the
--        business's threshold. Conversations learn who is answering (nobody
--        in particular, the AI, or a person) and when one needs a person;
--        messages learn which teammate wrote them and who approved them;
--        leads keep the answers to qualifying questions. ai_team.manage
--        (owners, admins) sets the teammate up; everyone in the workspace
--        reads it. Grants and the remaining foreign-key indexes are in 0034
--        (20260918000500_ai_team_grants.sql).
-- =============================================================================

-- ---------- the teammate: its identity, training progress and the settings that define it ----------
create table app.ai_teammates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The name customers see ("Ava"); messages show it as "Ava (AI)".
  name text not null check (length(btrim(name)) between 1 and 120),
  status app.ai_teammate_status not null default 'off',
  -- core's TeammateConfig. Core validates it; the database keeps it an object of sane size.
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 262144),
  config_version integer not null default 1 check (config_version >= 1),
  -- Every save raises it. A save names the revision it started from and fails with revision_conflict otherwise.
  revision integer not null default 1 check (revision >= 1),
  -- Inferred from the config for lists ("Appointment Coordinator"); never gates a setting.
  labels text[] not null default '{}' check (cardinality(labels) <= 12 and array_position(labels, null) is null),
  -- Training progress. It lives outside the settings, so restoring an old revision never touches it. Every
  -- approval counts toward the threshold; edited_count is how many of those a person changed first. Only
  -- private.record_teammate_decision raises them, and only "Back to training" (automatic -> training) resets
  -- them (the guard below).
  approved_count integer not null default 0 check (approved_count >= 0),
  edited_count integer not null default 0 check (edited_count >= 0),
  rejected_count integer not null default 0 check (rejected_count >= 0),
  training_started_at timestamptz,
  -- When it turned automatic. A pause (off) keeps it for when it resumes; going to training clears it.
  automatic_since timestamptz,
  -- How the current automatic stretch began, set only while automatic: 'threshold' (it earned it) or
  -- 'override' (a person switched it on before it had).
  automatic_via text check (automatic_via is null or automatic_via in ('threshold', 'override')),
  -- Reserved: nothing archives a teammate yet. One live teammate per workspace (below); a second one later
  -- is an index change.
  archived_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (edited_count <= approved_count),
  check ((status = 'automatic') = (automatic_via is not null)),
  check (status <> 'automatic' or automatic_since is not null),
  check (status <> 'training' or (training_started_at is not null and automatic_since is null))
);
create unique index ai_teammates_one_live on app.ai_teammates (workspace_id) where archived_at is null;
create trigger ai_teammates_updated_at before update on app.ai_teammates for each row execute function private.set_updated_at();
create trigger ai_teammates_immutable before update on app.ai_teammates for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- The approvals a teammate in training needs before it turns automatic: config.autonomy.approvalsNeeded, or
-- 20 when that is unset or not a positive number (core keeps it between 5 and 200; tests use fewer).
create or replace function private.teammate_approvals_needed(p_config jsonb)
returns integer language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p_config #> '{autonomy,approvalsNeeded}') = 'number'
      and (p_config #>> '{autonomy,approvalsNeeded}')::numeric between 1 and 100000
    then floor((p_config #>> '{autonomy,approvalsNeeded}')::numeric)::integer
    else 20
  end
$$;

-- People (and the worker) change the name and the settings, and move the status between off, training and
-- automatic. What each move does to the progress:
--   off -> training        keeps the counts (pausing never costs progress);
--   training -> off        keeps everything;
--   training -> automatic  "Switch to automatic now": an override;
--   automatic -> off       a pause (a holiday, say): keeps the counts and automatic_since;
--   off -> automatic       resuming: 'threshold' when the approvals already meet it, otherwise an override;
--   automatic -> training  "Back to training": starts the count again.
-- The counts, training_started_at, automatic_since and automatic_via follow from those moves and are never
-- written directly. private.record_teammate_decision is SECURITY DEFINER, so it runs as the table's owner
-- and passes: it alone raises the counts and turns a training teammate on at the threshold. The test is on
-- current_user, which no role can fake, so this function must stay SECURITY INVOKER.
create or replace function private.guard_ai_teammate()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user not in ('authenticated', 'service_actor') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.approved_count <> 0 or new.edited_count <> 0 or new.rejected_count <> 0
       or new.automatic_via is not null or new.automatic_since is not null then
      raise exception 'Training progress is counted by HandsFreeOS' using errcode = '42501', detail = 'teammate_counts_protected';
    end if;
    if new.status = 'automatic' then
      raise exception 'A new teammate starts off or in training' using errcode = '42501', detail = 'teammate_status_transition';
    end if;
    new.training_started_at := case when new.status = 'training' then now() end;
    return new;
  end if;
  if (old.approved_count, old.edited_count, old.rejected_count, old.training_started_at, old.automatic_since, old.automatic_via)
     is distinct from
     (new.approved_count, new.edited_count, new.rejected_count, new.training_started_at, new.automatic_since, new.automatic_via) then
    raise exception 'Training progress is counted by HandsFreeOS' using errcode = '42501', detail = 'teammate_counts_protected';
  end if;
  if old.status is not distinct from new.status then
    return new;
  end if;
  if old.status = 'off' and new.status = 'training' then
    -- It picks up where it left off; a teammate in training isn't automatic since anything.
    new.training_started_at := coalesce(old.training_started_at, now());
    new.automatic_since := null;
  elsif old.status = 'training' and new.status = 'off' then
    null;
  elsif old.status = 'training' and new.status = 'automatic' then
    new.automatic_via := 'override';
    new.automatic_since := now();
  elsif old.status = 'automatic' and new.status = 'off' then
    new.automatic_via := null;
  elsif old.status = 'off' and new.status = 'automatic' then
    new.automatic_via := case when new.approved_count >= private.teammate_approvals_needed(new.config)
      then 'threshold' else 'override' end;
    new.automatic_since := coalesce(old.automatic_since, now());
  elsif old.status = 'automatic' and new.status = 'training' then
    new.approved_count := 0;
    new.edited_count := 0;
    new.rejected_count := 0;
    new.training_started_at := now();
    new.automatic_via := null;
    new.automatic_since := null;
  else
    raise exception 'A teammate can''t move from % to %', old.status, new.status
      using errcode = '42501', detail = 'teammate_status_transition';
  end if;
  return new;
end $$;
create trigger ai_teammates_guard before insert or update on app.ai_teammates for each row execute function private.guard_ai_teammate();

-- ---------- revisions: every save, as a snapshot History can restore ----------
-- Restoring saves the old settings again as a new revision. The counts are no part of a revision, so
-- restoring never touches training progress.
create table app.ai_teammate_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  teammate_id uuid not null references app.ai_teammates (id) on delete cascade,
  revision integer not null check (revision >= 1),
  config jsonb not null check (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 262144),
  config_version integer not null check (config_version >= 1),
  labels text[] not null default '{}' check (cardinality(labels) <= 12 and array_position(labels, null) is null),
  diff_summary jsonb not null default '[]'::jsonb check (jsonb_typeof(diff_summary) = 'array'),
  changed_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (teammate_id, revision)
);

-- Nobody edits or removes a revision, the table's owner included; one goes only with its teammate or its
-- workspace. The one change allowed is the foreign key forgetting a deleted account (changed_by set to null).
create or replace function private.guard_teammate_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from app.ai_teammates t where t.id = old.teammate_id)
       or not exists (select 1 from app.workspaces w where w.id = old.workspace_id) then
      return old;
    end if;
  elsif new.changed_by is null and (to_jsonb(new) - 'changed_by') = (to_jsonb(old) - 'changed_by') then
    return new;
  end if;
  raise exception 'app.ai_teammate_revisions is append-only' using errcode = '42501', detail = 'revision_immutable';
end $$;
create trigger ai_teammate_revisions_append_only before update or delete on app.ai_teammate_revisions
  for each row execute function private.guard_teammate_revision();

-- ---------- conversations: who answers, and when one needs a person ----------
alter table app.conversations
  -- none: nobody in particular (the teammate may pick it up); ai: the teammate answers; person: someone took
  -- it over, or the teammate handed it off. A person's message in a conversation the AI handles takes it over.
  add column handled_by app.conversation_handler not null default 'none',
  -- The teammate answering it, kept through a take-over so Hand back knows whom to hand it to. Teammates are
  -- archived, never deleted (NO ACTION: deleting a whole workspace still removes both sides at once).
  add column ai_teammate_id uuid references app.ai_teammates (id),
  -- Raised whenever the conversation changes hands: a run that started under an older epoch is superseded.
  add column ai_epoch integer not null default 0 check (ai_epoch >= 0),
  -- The "Needs a person" box: since when, why, and the teammate's note for whoever picks it up.
  add column needs_person_since timestamptz,
  add column handoff_reason text check (handoff_reason is null or handoff_reason in (
    'asked_for_person', 'frustrated', 'cant_answer', 'sensitive', 'emergency', 'legal', 'complaint', 'refund',
    'cancellation', 'limit', 'budget', 'error', 'draft_expired', 'loop', 'other')),
  add column handoff_note text check (handoff_note is null or length(handoff_note) <= 500),
  add column taken_over_by uuid references app.users (id) on delete set null,
  -- The newest customer message the teammate has answered: the next run's batch is everything after it.
  add column ai_answered_through timestamptz,
  -- When the teammate first said it's an AI in this conversation.
  add column ai_disclosed_at timestamptz,
  add constraint conversations_ai_handler_check check (handled_by <> 'ai' or ai_teammate_id is not null),
  add constraint conversations_needs_person_check check (needs_person_since is null or handled_by = 'person'),
  -- One conversation per website visitor: chat:<visitor id>.
  add constraint conversations_chat_counterpart_check
    check (channel <> 'chat' or counterpart ~ '^chat:[A-Za-z0-9_-]{8,80}$');
-- The inbox's "Needs a person" box (oldest first) and the teammate's own box.
create index conversations_needs_person_idx on app.conversations (workspace_id, needs_person_since)
  where needs_person_since is not null;
create index conversations_ai_handled_idx on app.conversations (workspace_id, last_message_at desc nulls last, id desc)
  where handled_by = 'ai';

-- ---------- messages: which teammate wrote one, and who approved it ----------
alter table app.messages
  -- The teammate that wrote it ("Ava (AI)"). It never changes, and teammates are archived, never deleted.
  add column sent_by_teammate_id uuid references app.ai_teammates (id),
  -- The run that wrote it and the draft a person approved (their foreign keys follow in 0032, with the tables).
  add column ai_run_id uuid,
  add column ai_draft_id uuid,
  -- The person whose OK sent it ("approved by Chris").
  add column approved_by uuid references app.users (id) on delete set null,
  -- The teammate is never a person: its messages go out with no sent_by, and nobody else's carry AI details.
  add constraint messages_teammate_sender_check
    check (sent_by_teammate_id is null or (direction = 'outbound' and sent_by is null)),
  add constraint messages_ai_details_check
    check (sent_by_teammate_id is not null or (ai_run_id is null and ai_draft_id is null and approved_by is null));

-- Same name, so it keeps its place among the messages triggers (they fire in name order).
drop trigger messages_immutable on app.messages;
create trigger messages_immutable before update on app.messages for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'conversation_id', 'channel', 'direction', 'sent_by', 'sent_by_teammate_id');

-- ---------- leads: the answers to the business's qualifying questions ----------
-- Core's shape, with each question's text copied in, so the answers still read right after the questions
-- change (and moving them into custom fields later is a data copy).
alter table app.leads
  add column qualification jsonb not null default '{}'::jsonb
    check (jsonb_typeof(qualification) = 'object' and pg_column_size(qualification) <= 16384);

-- ---------- references stay inside the workspace, whoever writes ----------
-- Foreign keys don't see RLS, so without this a key copied from another business would still be accepted.
-- An update once the workspace is gone is its deletion cascading (a foreign key clearing a column on the way
-- out), and is let through.
create or replace function private.check_ai_teammate_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean := true;
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  if tg_table_name = 'ai_teammate_revisions' then
    v_ok := exists (select 1 from app.ai_teammates t where t.id = new.teammate_id and t.workspace_id = new.workspace_id);
  elsif tg_table_name = 'conversations' then
    v_ok := (new.ai_teammate_id is null or exists (
        select 1 from app.ai_teammates t where t.id = new.ai_teammate_id and t.workspace_id = new.workspace_id))
      and (new.taken_over_by is null or private.workspace_has_user(new.workspace_id, new.taken_over_by));
  elsif tg_table_name = 'messages' then
    v_ok := (new.sent_by_teammate_id is null or exists (
        select 1 from app.ai_teammates t where t.id = new.sent_by_teammate_id and t.workspace_id = new.workspace_id))
      and (new.approved_by is null or private.workspace_has_user(new.workspace_id, new.approved_by));
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger ai_teammate_revisions_check_refs before insert on app.ai_teammate_revisions
  for each row execute function private.check_ai_teammate_refs();
create trigger conversations_check_ai_refs before insert or update of ai_teammate_id, taken_over_by on app.conversations
  for each row execute function private.check_ai_teammate_refs();
create trigger messages_check_ai_refs before insert or update of sent_by_teammate_id, approved_by on app.messages
  for each row execute function private.check_ai_teammate_refs();

-- ---------- training progress: the only writer of the counts ----------
-- ai_teammate.decide_draft calls it in the transaction that claims the draft, so a second click (which
-- claims nothing) counts nothing. It locks the teammate, counts the decision ('approved' or 'rejected'; an
-- edited approval also counts as edited) and, while the teammate is training, switches it to automatic
-- (automatic_via 'threshold') once approvals reach its threshold (private.teammate_approvals_needed). The
-- person deciding must work the inbox in the teammate's business, or the worker must be scoped to it.
create or replace function private.record_teammate_decision(p_teammate_id uuid, p_decision text, p_edited boolean)
returns table (status app.ai_teammate_status, approved_count integer, edited_count integer, rejected_count integer,
  approvals_needed integer, became_automatic boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_teammate app.ai_teammates;
  v_needed integer;
  v_switched boolean := false;
begin
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'A decision is approved or rejected' using errcode = '22023', detail = 'teammate_decision_invalid';
  end if;
  select t.* into v_teammate from app.ai_teammates t where t.id = p_teammate_id for update;
  if not found then
    raise exception 'No such teammate' using errcode = 'P0002', detail = 'teammate_not_found';
  end if;
  if not (coalesce(private.system_scope_workspace() = v_teammate.workspace_id, false)
          or private.has_permission(v_teammate.workspace_id, 'inbox.use')) then
    raise exception 'Only the business''s own team decides its teammate''s drafts'
      using errcode = '42501', detail = 'teammate_decision_forbidden';
  end if;
  v_needed := private.teammate_approvals_needed(v_teammate.config);
  update app.ai_teammates t
  set approved_count = t.approved_count + case when p_decision = 'approved' then 1 else 0 end,
      edited_count = t.edited_count + case when p_decision = 'approved' and coalesce(p_edited, false) then 1 else 0 end,
      rejected_count = t.rejected_count + case when p_decision = 'rejected' then 1 else 0 end
  where t.id = p_teammate_id
  returning t.* into v_teammate;
  if v_teammate.status = 'training' and v_teammate.approved_count >= v_needed then
    update app.ai_teammates t
    set status = 'automatic', automatic_via = 'threshold', automatic_since = now()
    where t.id = p_teammate_id
    returning t.* into v_teammate;
    v_switched := true;
  end if;
  return query select v_teammate.status, v_teammate.approved_count, v_teammate.edited_count, v_teammate.rejected_count,
    v_needed, v_switched;
end $$;

-- ---------- permissions ----------
insert into app.role_permissions (role, permission) values
  ('owner', 'ai_team.manage'), ('admin', 'ai_team.manage');

-- ---------- RLS: the whole team reads; ai_team.manage sets the teammate up ----------
alter table app.ai_teammates enable row level security;
alter table app.ai_teammate_revisions enable row level security;

-- A new teammate starts off or in training with nothing counted (the guard above).
create policy ai_teammates_select on app.ai_teammates for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy ai_teammates_insert on app.ai_teammates for insert to authenticated
  with check (private.has_permission(workspace_id, 'ai_team.manage') and created_by = (select auth.uid())
    and archived_at is null);
create policy ai_teammates_update on app.ai_teammates for update to authenticated
  using (private.has_permission(workspace_id, 'ai_team.manage'))
  with check (private.has_permission(workspace_id, 'ai_team.manage'));
create policy ai_teammates_service_all on app.ai_teammates for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy ai_teammate_revisions_select on app.ai_teammate_revisions for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy ai_teammate_revisions_insert on app.ai_teammate_revisions for insert to authenticated
  with check (private.has_permission(workspace_id, 'ai_team.manage') and changed_by = (select auth.uid()));
create policy ai_teammate_revisions_service_all on app.ai_teammate_revisions for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- function privileges ----------
revoke all on function
  private.teammate_approvals_needed(jsonb), private.guard_ai_teammate(), private.guard_teammate_revision(),
  private.check_ai_teammate_refs(), private.record_teammate_decision(uuid, text, boolean)
  from public;
-- The guard runs as whoever writes, so they need the threshold helper too.
grant execute on function
  private.teammate_approvals_needed(jsonb), private.guard_ai_teammate(), private.guard_teammate_revision(),
  private.check_ai_teammate_refs(), private.record_teammate_decision(uuid, text, boolean)
  to authenticated, service_actor;
