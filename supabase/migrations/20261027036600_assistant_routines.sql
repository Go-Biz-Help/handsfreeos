-- =============================================================================
-- Reminders, questions on a schedule, and alerts (the owner, 25 Nov 2026: "ok id
-- like all of them", picking "Reminders and scheduled asks" first).
--        - Two new push switches: Tasks due ('tasks'), a task with a time pings
--          whoever has it at that time; and What you asked the Assistant for
--          ('assistant'), the answers and alerts below. Both on unless turned
--          off.
--        - app.assistant_routines: what a person asked the Assistant to do on
--          its own, in one business. A question asked on a schedule ("Every
--          Monday at 8 AM: who owes me money?"), answered in its own chat and
--          sent to their phone (and email, if they said so); or an alert ("Tell
--          me when Dana Smith writes"). Private to its person, as their chats
--          are: only they read or change theirs. The worker reads and keeps
--          them for the business it is scoped to.
--        - A deleted account keeps none of them: private.anonymize_user
--          (20261027029600) with the row added.
-- =============================================================================

-- ---------- two new push switches: Tasks due, and What you asked the Assistant for ----------
-- The keys match PUSH_SWITCHES (packages/core/src/push.ts).
create or replace function private.push_on(p_settings jsonb, p_key text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_key = 'safety' then
    return true;
  end if;
  if p_key is null or p_key not in ('customerWaiting', 'missedCall', 'urgent', 'approval', 'booking', 'assigned',
                                    'payment', 'wallet', 'jobs', 'connections', 'addons', 'supportTickets',
                                    'qualifying', 'documents', 'stock', 'tasks', 'assistant') then
    raise exception 'Unknown push switch: %', p_key using errcode = '22023', detail = 'push_switch_unknown';
  end if;
  if jsonb_typeof(p_settings -> 'push' -> p_key) = 'boolean' then
    return (p_settings -> 'push' ->> p_key)::boolean;
  end if;
  return p_key <> 'payment';
end $$;

comment on column app.users.settings is
  'Per-person choices, each top-level key saved whole: theme; notifications, the email switches (unansweredEmail, attentionDigest, aiHandoff, bookingEmail, paymentEmail, agencyDigest, eveningSummary, addonEmail), each on unless false; push, the phone''s switches (customerWaiting, missedCall, urgent, approval, booking, assigned, payment, wallet, jobs, connections, addons, supportTickets, qualifying, documents, stock, tasks, assistant), each on unless false except payment: private.push_on.';

-- ---------- what a person asked the Assistant to do on its own ----------
create type app.assistant_routine_kind as enum ('question', 'alert');

create table app.assistant_routines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  kind app.assistant_routine_kind not null,
  -- A question: what to ask, and when (core's RoutineCadence, in the business's time zone).
  question text check (question is null or char_length(btrim(question)) between 1 and 500),
  cadence jsonb check (cadence is null or jsonb_typeof(cadence) = 'object'),
  -- Its answer is emailed to them too, not only sent to their phone.
  email boolean not null default false,
  -- The chat its answers go in, from the first answer on: each answer adds to the same chat.
  thread_id uuid references app.assistant_threads (id) on delete set null,
  next_run_at timestamptz,
  last_run_at timestamptz,
  -- An alert: what to watch for (core's RoutineWatch).
  watch jsonb check (watch is null or jsonb_typeof(watch) = 'object'),
  -- Told once, then it stops ("tell me when Dana writes back"); else every time.
  once boolean not null default false,
  fired_count integer not null default 0 check (fired_count >= 0),
  last_fired_at timestamptz,
  -- Paused by them, or stopped after telling them once.
  paused_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint assistant_routines_shape check (
    (kind = 'question' and question is not null and cadence is not null and watch is null)
    or (kind = 'alert' and watch is not null and question is null and cadence is null)
  )
);
comment on table app.assistant_routines is
  'What a person asked the Assistant to do on its own: a question on a schedule, or an alert. Theirs alone to read and change.';
create index assistant_routines_mine_idx on app.assistant_routines (workspace_id, user_id, created_at);
-- The alerts an event in a business might set off.
create index assistant_routines_alerts_idx on app.assistant_routines (workspace_id, (watch ->> 'on'))
  where kind = 'alert' and paused_at is null;
create trigger assistant_routines_updated_at before update on app.assistant_routines
  for each row execute function private.set_updated_at();
create trigger assistant_routines_immutable before update on app.assistant_routines
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'user_id', 'kind');

alter table app.assistant_routines enable row level security;
create policy assistant_routines_select on app.assistant_routines for select to authenticated
  using (user_id = (select auth.uid()) and workspace_id in (select private.accessible_workspace_ids()));
create policy assistant_routines_insert on app.assistant_routines for insert to authenticated
  with check (user_id = (select auth.uid()) and private.has_permission(workspace_id, 'assistant.use'));
create policy assistant_routines_update on app.assistant_routines for update to authenticated
  using (user_id = (select auth.uid()) and private.has_permission(workspace_id, 'assistant.use'))
  with check (user_id = (select auth.uid()));
-- Stopping one never needs more than being here: someone who lost the Assistant can still remove theirs.
create policy assistant_routines_delete on app.assistant_routines for delete to authenticated
  using (user_id = (select auth.uid()) and workspace_id in (select private.accessible_workspace_ids()));
create policy assistant_routines_service_all on app.assistant_routines for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert, delete on app.assistant_routines to authenticated;
-- What a person changes: the question and when, the email, what to watch, once, and pausing. The worker keeps the
-- rest (when it last ran or told them, and the chat).
grant update (question, cadence, email, next_run_at, watch, once, paused_at) on app.assistant_routines to authenticated;
grant select, insert, update, delete on app.assistant_routines to service_actor;
revoke all on app.assistant_routines from anon;

-- ---------- a deleted account keeps none of them ----------
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
  delete from app.day_starts d where d.user_id = p_user;
  delete from app.push_devices d where d.user_id = p_user;
  delete from app.notifications n where n.user_id = p_user;
  delete from app.command_receipts r where r.user_id = p_user;
  delete from app.assistant_routines r where r.user_id = p_user;
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
