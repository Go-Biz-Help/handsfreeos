-- =============================================================================
-- 0039 · The Action Center's list. Home answers "what needs attention?" from
--        app.attention_items: one row per business, kind and subject (a lead,
--        a booking, an approval, a conversation or a task), kept by the
--        worker as events happen, at exact recheck times and in an hourly
--        sweep. Each row keeps a fingerprint of the facts behind it, so a
--        dismissed or snoozed item comes back only when those facts change,
--        and the worker resolves it when they stop holding. People read the
--        list with records.read; with records.write they snooze, dismiss,
--        assign and handle items, and cancel an automatic action that is
--        waiting to go out. Everything an item says is the worker's (a guard
--        trigger), and only the worker adds and removes rows. Grants and the
--        foreign-key indexes are in 0043 (20260919000500_attention_grants.sql).
-- =============================================================================

-- open: needs someone. snoozed: out of sight until snoozed_until, or until its facts change. dismissed: a person
-- said it doesn't need doing; back only when its facts change. handled: done, by a person, through Let
-- HandsFreeOS Handle, or by HandsFreeOS on its own. resolved: its facts stopped holding (the worker's).
create type app.attention_state as enum ('open', 'snoozed', 'dismissed', 'handled', 'resolved');

create table app.attention_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- core's ATTENTION_KINDS (packages/core/src/attention/kinds.ts); a DB parity test keeps the two identical.
  -- Milestone 9's money kinds are one line each here.
  kind text not null constraint attention_items_kind_check check (kind in (
    'hot_lead',
    'unanswered_lead',
    'stale_opportunity',
    'missing_next_action',
    'unconfirmed_appointment',
    'ai_approval',
    'customer_waiting',
    'overdue_task'
  )),
  -- What it is about (core's ATTENTION_SUBJECT_OF: lead, attendee, approval, conversation, task) and that row's
  -- id. Subjects live in different tables, so the id has no foreign key: the worker takes it from rows it read in
  -- its own scope.
  subject_type text not null check (subject_type ~ '^[a-z][a-z_]{0,39}$'),
  subject_id uuid not null,
  -- Who and what it concerns: the card, Mine/Everyone and the banners on other pages.
  person_id uuid references app.people (id) on delete set null,
  lead_id uuid references app.leads (id) on delete set null,
  conversation_id uuid references app.conversations (id) on delete set null,
  state app.attention_state not null default 'open',
  -- When it (last) opened; when the wait behind it began (urgency grows from here, worked out when the list is
  -- read, so it is always current); when it counts as urgent; and its deadline (a task's due time, a start).
  opened_at timestamptz not null default now(),
  since_at timestamptz,
  urgent_from timestamptz,
  due_at timestamptz,
  -- The rank's inputs: value (V), probability (P) and confidence (C). A value the business never set is its
  -- typical job value, marked as an estimate and left out of "$ affected"; money_key counts one lead's value once
  -- however many items share it. reasons are the chips that explain the rank.
  value_cents bigint check (value_cents is null or value_cents >= 0),
  value_is_estimate boolean not null default false,
  money_key text check (money_key is null or length(money_key) between 1 and 200),
  probability real not null default 1 check (probability between 0 and 1),
  confidence real not null default 1 check (confidence between 0 and 1),
  reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array' and pg_column_size(reasons) <= 16384),
  title text not null check (length(btrim(title)) between 1 and 200),
  detail text check (detail is null or length(detail) <= 1000),
  -- A digest of the facts behind it: when it changes, a dismissed or snoozed item comes back.
  fingerprint text not null check (length(fingerprint) between 1 and 200),
  -- Whose it is. For a lead, conversation or task it follows the real owner; for a booking or an approval it is
  -- the item's own.
  assignee_user_id uuid references app.users (id) on delete set null,
  -- Snoozed until a time (up to 30 days ahead), when and by whom.
  snoozed_until timestamptz,
  snoozed_at timestamptz,
  snoozed_by uuid references app.users (id) on delete set null,
  -- Dismissed, when, by whom and why (optional).
  dismissed_at timestamptz,
  dismissed_by uuid references app.users (id) on delete set null,
  dismiss_reason text check (dismiss_reason is null or length(dismiss_reason) <= 500),
  -- Handled: by a person ('person'), by a person through Let HandsFreeOS Handle ('let_handle'), or by HandsFreeOS
  -- on its own ('auto', with no person). handled_until is the worker's: an item handled for now comes back then if
  -- its facts still hold (a sent confirmation request waits until 12 hours before the start).
  handled_at timestamptz,
  handled_by uuid references app.users (id) on delete set null,
  handled_via text check (handled_via is null or handled_via in ('person', 'let_handle', 'auto')),
  handled_until timestamptz,
  -- The automatic action (a confirmation request or a follow-up nudge): scheduled for a time after the cancel
  -- window, then sent, skipped (and why) or cancelled (and by whom), at auto_done_at.
  auto_state text check (auto_state is null or auto_state in ('scheduled', 'sent', 'skipped', 'cancelled')),
  auto_scheduled_for timestamptz,
  auto_done_at timestamptz,
  auto_skip_reason text check (auto_skip_reason is null or length(auto_skip_reason) between 1 and 200),
  auto_cancelled_by uuid references app.users (id) on delete set null,
  -- The facts an urgent email last went out for: at most one email per fingerprint.
  alert_fingerprint text check (alert_fingerprint is null or length(alert_fingerprint) between 1 and 200),
  alerted_at timestamptz,
  -- When and why its facts stopped holding ('replied', 'confirmed', 'subject_gone' …).
  resolved_at timestamptz,
  resolution text check (resolution is null or resolution ~ '^[a-z][a-z_]{0,39}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One row per business, kind and subject: the worker upserts on it.
  constraint attention_items_subject_key unique (workspace_id, kind, subject_type, subject_id),
  -- Each state carries its own fields, and only its own.
  check ((state = 'snoozed') = (snoozed_until is not null)),
  check ((snoozed_until is null) = (snoozed_at is null) and (snoozed_by is null or snoozed_until is not null)),
  check ((state = 'dismissed') = (dismissed_at is not null)),
  check (dismissed_at is not null or (dismissed_by is null and dismiss_reason is null)),
  check ((state = 'handled') = (handled_at is not null)),
  check ((handled_at is null) = (handled_via is null)),
  check (handled_at is not null or (handled_by is null and handled_until is null)),
  check (handled_via is distinct from 'auto' or handled_by is null),
  check ((state = 'resolved') = (resolved_at is not null)),
  check (resolved_at is not null or resolution is null),
  check (auto_state is distinct from 'scheduled' or auto_scheduled_for is not null),
  check ((auto_state is null or auto_state = 'scheduled') = (auto_done_at is null)),
  check (auto_skip_reason is null or auto_state is not distinct from 'skipped'),
  check (auto_cancelled_by is null or auto_state is not distinct from 'cancelled'),
  check ((alert_fingerprint is null) = (alerted_at is null))
);
-- Home's list and badge: a business's open items, Mine (theirs plus unassigned) or Everyone.
create index attention_items_open_idx on app.attention_items (workspace_id, assignee_user_id) where state = 'open';
-- The sweep's catch-up: snoozes that ran out and automatic actions that are due.
create index attention_items_snoozed_idx on app.attention_items (workspace_id, snoozed_until) where state = 'snoozed';
create index attention_items_auto_due_idx on app.attention_items (workspace_id, auto_scheduled_for)
  where auto_state = 'scheduled';
-- "3 handled today" and the Handled by HandsFreeOS section.
create index attention_items_handled_idx on app.attention_items (workspace_id, handled_at desc) where state = 'handled';
create trigger attention_items_updated_at before update on app.attention_items for each row execute function private.set_updated_at();
-- An item is its business, kind and subject for life: another subject is another item.
create trigger attention_items_immutable before update on app.attention_items for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'kind', 'subject_type', 'subject_id');

-- ---------- what people may change ----------
-- People change only what their commands write (0043 grants exactly those columns; this holds the line on the
-- values):
--   state        between open, snoozed, dismissed and handled. Resolving, and reopening a resolved item, is the
--                worker's, and so is an item HandsFreeOS handled on its own;
--   snooze       until a time ahead (at most 31 days; core offers up to 30), in their own name;
--   dismiss      in their own name, with an optional reason;
--   assignee     anyone in the business (the references trigger below);
--   handled      in their own name, as 'person' or 'let_handle', never 'auto'; nobody rewrites who handled it;
--   auto action  cancel one that is scheduled, in their own name, and nothing else.
-- The *_at stamps are the database's clock, never the caller's. Everything else (kind, subject, the facts, the
-- score, the fingerprint, the alert and the resolution) is the worker's. The test is on current_user, which no
-- role can fake, so this function must stay SECURITY INVOKER.
create or replace function private.guard_attention_item()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_uid uuid;
  v_theirs constant text[] := array[
    'state', 'assignee_user_id', 'snoozed_until', 'snoozed_at', 'snoozed_by', 'dismissed_at', 'dismissed_by',
    'dismiss_reason', 'handled_at', 'handled_by', 'handled_via', 'auto_state', 'auto_done_at', 'auto_cancelled_by',
    'updated_at'];
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  -- Only people get this far: the worker has no JWT and no access to the auth schema.
  v_uid := auth.uid();
  if (to_jsonb(new) - v_theirs) is distinct from (to_jsonb(old) - v_theirs) then
    raise exception 'Only HandsFreeOS changes what an attention item says'
      using errcode = '42501', detail = 'attention_item_protected';
  end if;

  if new.state is distinct from old.state
     and (old.state = 'resolved' or new.state = 'resolved' or old.handled_via is not distinct from 'auto') then
    raise exception 'An attention item can''t be moved from % to % by hand', old.state, new.state
      using errcode = '42501', detail = 'attention_state_transition';
  end if;

  if new.snoozed_until is not null
     and (new.snoozed_until, new.snoozed_by) is distinct from (old.snoozed_until, old.snoozed_by) then
    if new.snoozed_by is distinct from v_uid then
      raise exception 'People snooze in their own name' using errcode = '42501', detail = 'attention_actor_mismatch';
    end if;
    if new.snoozed_until <= now() or new.snoozed_until > now() + interval '31 days' then
      raise exception 'Snooze until a time in the next 30 days' using errcode = '22023', detail = 'attention_snooze_range';
    end if;
    new.snoozed_at := now();
  elsif new.snoozed_until is not null then
    new.snoozed_at := old.snoozed_at;
  end if;

  if new.dismissed_at is not null
     and (old.dismissed_at is null
       or (new.dismissed_by, new.dismiss_reason) is distinct from (old.dismissed_by, old.dismiss_reason)) then
    if new.dismissed_by is distinct from v_uid then
      raise exception 'People dismiss in their own name' using errcode = '42501', detail = 'attention_actor_mismatch';
    end if;
    new.dismissed_at := now();
  elsif new.dismissed_at is not null then
    new.dismissed_at := old.dismissed_at;
  end if;

  if new.handled_via = 'auto' and new.handled_via is distinct from old.handled_via then
    raise exception 'Only HandsFreeOS handles an item on its own' using errcode = '42501', detail = 'attention_handled_via';
  end if;
  if (new.handled_at, new.handled_by, new.handled_via) is distinct from (old.handled_at, old.handled_by, old.handled_via) then
    if new.handled_at is not null and old.handled_at is not null then
      if (new.handled_by, new.handled_via) is distinct from (old.handled_by, old.handled_via) then
        raise exception 'Nobody rewrites who handled an item' using errcode = '42501', detail = 'attention_handled_protected';
      end if;
      new.handled_at := old.handled_at;
    elsif new.handled_at is not null then
      if new.handled_by is distinct from v_uid then
        raise exception 'People handle in their own name' using errcode = '42501', detail = 'attention_actor_mismatch';
      end if;
      new.handled_at := now();
    end if;
  end if;
  -- Leaving handled takes the worker's "until" along.
  if new.handled_at is null then
    new.handled_until := null;
  end if;

  if (new.auto_state, new.auto_done_at, new.auto_cancelled_by)
     is distinct from (old.auto_state, old.auto_done_at, old.auto_cancelled_by) then
    if not coalesce(old.auto_state = 'scheduled' and new.auto_state = 'cancelled' and new.auto_cancelled_by = v_uid, false) then
      raise exception 'People can only cancel an automatic action that is waiting, in their own name'
        using errcode = '42501', detail = 'attention_auto_protected';
    end if;
    new.auto_done_at := now();
  end if;
  return new;
end $$;
create trigger attention_items_guard before update on app.attention_items for each row execute function private.guard_attention_item();

-- ---------- references stay inside the workspace, whoever writes ----------
-- Foreign keys don't see RLS, so without this a key copied from another business would still be accepted. On an
-- update only the references that changed are checked, so someone leaving the business doesn't freeze the items
-- they snoozed or dismissed. An update once the workspace is gone is its deletion cascading, and is let through.
create or replace function private.check_attention_item_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean;
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  v_ok := (new.person_id is null or (tg_op = 'UPDATE' and new.person_id is not distinct from old.person_id)
      or exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
    and (new.lead_id is null or (tg_op = 'UPDATE' and new.lead_id is not distinct from old.lead_id)
      or exists (select 1 from app.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id))
    and (new.conversation_id is null or (tg_op = 'UPDATE' and new.conversation_id is not distinct from old.conversation_id)
      or exists (select 1 from app.conversations c where c.id = new.conversation_id and c.workspace_id = new.workspace_id))
    and (new.assignee_user_id is null or (tg_op = 'UPDATE' and new.assignee_user_id is not distinct from old.assignee_user_id)
      or private.workspace_has_user(new.workspace_id, new.assignee_user_id))
    and (new.snoozed_by is null or (tg_op = 'UPDATE' and new.snoozed_by is not distinct from old.snoozed_by)
      or private.workspace_has_user(new.workspace_id, new.snoozed_by))
    and (new.dismissed_by is null or (tg_op = 'UPDATE' and new.dismissed_by is not distinct from old.dismissed_by)
      or private.workspace_has_user(new.workspace_id, new.dismissed_by))
    and (new.handled_by is null or (tg_op = 'UPDATE' and new.handled_by is not distinct from old.handled_by)
      or private.workspace_has_user(new.workspace_id, new.handled_by))
    and (new.auto_cancelled_by is null or (tg_op = 'UPDATE' and new.auto_cancelled_by is not distinct from old.auto_cancelled_by)
      or private.workspace_has_user(new.workspace_id, new.auto_cancelled_by));
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger attention_items_check_refs before insert or update of person_id, lead_id, conversation_id,
  assignee_user_id, snoozed_by, dismissed_by, handled_by, auto_cancelled_by
  on app.attention_items for each row execute function private.check_attention_item_refs();

-- ---------- RLS: people read and act; only the worker adds and removes items ----------
alter table app.attention_items enable row level security;

create policy attention_items_select on app.attention_items for select to authenticated
  using (private.has_permission(workspace_id, 'records.read'));
create policy attention_items_update on app.attention_items for update to authenticated
  using (private.has_permission(workspace_id, 'records.write'))
  with check (private.has_permission(workspace_id, 'records.write'));
create policy attention_items_service_all on app.attention_items for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- function privileges ----------
revoke all on function private.guard_attention_item(), private.check_attention_item_refs() from public;
grant execute on function private.guard_attention_item(), private.check_attention_item_refs()
  to authenticated, service_actor;
