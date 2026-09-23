-- Automations, stage 4a: service, hand-offs and revenue.
--
-- `app.promises` keeps what someone on the team told a customer they'd do by a time ("I'll send the quote
-- tomorrow"), read from their own texts, emails and call transcripts by the worker. A card on Home opens when
-- the time has passed and nothing of the kind reached the customer. Three Action Center kinds: a regular gone
-- quiet, a promise not kept, and last week's money in far from the usual week.

create table app.promises (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The customer it was made to.
  person_id uuid not null references app.people (id) on delete cascade,
  -- Where it was said: a message or a call, and its conversation.
  conversation_id uuid references app.conversations (id) on delete set null,
  message_id uuid references app.messages (id) on delete set null,
  call_id uuid references app.calls (id) on delete set null,
  -- Who said it.
  promised_by uuid references app.users (id) on delete set null,
  -- What, in a few words ("send the quote"), and what sort of thing keeps it.
  what text not null check (length(btrim(what)) between 1 and 200),
  kind text not null default 'other' check (kind in ('call', 'send', 'visit', 'other')),
  due_at timestamptz not null,
  -- open until a card is dismissed; a kept promise is what reached the customer, read when the card is.
  status text not null default 'open' check (status in ('open', 'dismissed')),
  dismissed_by uuid references app.users (id) on delete set null,
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (message_id is not null or call_id is not null)
);
-- One per message or call, whatever reads it twice.
create unique index promises_message on app.promises (message_id) where message_id is not null;
create unique index promises_call on app.promises (call_id) where call_id is not null;
create index promises_open on app.promises (workspace_id, due_at) where status = 'open';
create index promises_person_idx on app.promises (person_id);
create index promises_conversation_idx on app.promises (conversation_id) where conversation_id is not null;
create index promises_promised_by_idx on app.promises (promised_by);
create index promises_dismissed_by_idx on app.promises (dismissed_by);
create trigger promises_updated_at before update on app.promises
  for each row execute function private.set_updated_at();
create trigger promises_immutable before update on app.promises
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'person_id',
    'message_id', 'call_id');

-- A promise belongs to one business, like the customer and the conversation it was made in.
create or replace function private.check_promise_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id)
     or (new.conversation_id is not null and not exists (select 1 from app.conversations c
                   where c.id = new.conversation_id and c.workspace_id = new.workspace_id)) then
    raise exception 'That belongs to another business'
      using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
create trigger promises_check_refs before insert or update on app.promises
  for each row execute function private.check_promise_refs();

-- ---------- RLS ----------
alter table app.promises enable row level security;
create policy promises_select on app.promises for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
-- Dismissing its card (promise.dismiss) marks it; the column grant below is all a person may change.
create policy promises_update on app.promises for update to authenticated
  using (private.has_permission(workspace_id, 'records.write'))
  with check (private.has_permission(workspace_id, 'records.write'));
create policy promises_service_all on app.promises for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select on app.promises to authenticated;
grant update (status, dismissed_by, dismissed_at, updated_at) on app.promises to authenticated;
grant select, insert, update, delete on app.promises to service_actor;
revoke all on app.promises from anon;

-- ---------- the cards ----------
alter table app.attention_items
  drop constraint attention_items_kind_check,
  add constraint attention_items_kind_check check (kind in (
    'hot_lead',
    'unanswered_lead',
    'stale_opportunity',
    'missing_next_action',
    'unconfirmed_appointment',
    'ai_approval',
    'customer_waiting',
    'overdue_task',
    'estimate_waiting',
    'invoice_overdue',
    'wallet_low',
    'wallet_empty',
    'wallet_card_declined',
    'job_not_thanked',
    'referral_mentioned',
    'maintenance_due',
    'pipeline_mismatch',
    'quiet_after_price',
    'job_unconfirmed',
    'job_never_completed',
    'job_no_address',
    'client_quiet',
    'promise_due',
    'revenue_moved'
  ));
