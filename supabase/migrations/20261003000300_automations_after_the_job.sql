-- =============================================================================
-- 0094 · After the job: a thank-you, and the friend who needs you too.
--
--        Two of Settings → Automations' "After the job" rows.
--
--        **Thank-you after the job.** Two hours after a job is marked done,
--        the AI teammate texts the customer a short thank-you (a draft to
--        approve while it is training). When it can't — no AI teammate, or
--        it is switched off — a card on Home asks a person to thank them
--        instead. `app.thank_yous` is the worker's record of which it was,
--        one row per customer per job, so the card knows to open and the
--        job never thanks anybody twice.
--
--        **Referral mentioned.** A customer who says "my neighbour Jan
--        needs her AC looked at" has handed the business its next customer.
--        `app.referrals` keeps each one the worker found: who said it, who
--        they meant, how to reach them, and what became of it. A card offers
--        "Create lead"; the AI teammate thanks the customer in its reply.
--
--        The names in attention_items_kind_check must match core's
--        ATTENTION_KINDS exactly; packages/db/test/parity.test.ts compares.
-- =============================================================================

-- ---------- the thank-you, as it went ----------
create table app.thank_yous (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  appointment_id uuid not null references app.appointments (id) on delete cascade,
  attendee_id uuid not null references app.appointment_attendees (id) on delete cascade,
  person_id uuid not null references app.people (id) on delete cascade,
  -- When the job was marked done: the card and the "nobody has messaged them since" check count from here.
  completed_at timestamptz not null,
  -- sent: the AI teammate texted them. drafted: it wrote one for a person to approve. card: it couldn't, so a
  -- card asks a person. skipped: there was no need (someone already wrote to them, a review workflow covers
  -- it, they can't be reached).
  outcome text not null check (outcome in ('sent', 'drafted', 'card', 'skipped')),
  reason text check (reason is null or length(reason) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One per customer per job, whatever runs twice.
create unique index thank_yous_attendee on app.thank_yous (attendee_id);
create index thank_yous_cards on app.thank_yous (workspace_id, completed_at desc) where outcome = 'card';
create index thank_yous_appointment_idx on app.thank_yous (appointment_id);
create index thank_yous_person_idx on app.thank_yous (person_id);
create trigger thank_yous_updated_at before update on app.thank_yous
  for each row execute function private.set_updated_at();
create trigger thank_yous_immutable before update on app.thank_yous
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'attendee_id');

-- ---------- the people customers pass the business on to ----------
create table app.referrals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The customer who mentioned them.
  referrer_person_id uuid not null references app.people (id) on delete cascade,
  -- Where they said it: a message or a call, and its conversation.
  conversation_id uuid references app.conversations (id) on delete set null,
  message_id uuid references app.messages (id) on delete set null,
  call_id uuid references app.calls (id) on delete set null,
  -- Who they meant, as far as they said. Any of these may be missing ("my neighbour needs a quote").
  referred_name text check (referred_name is null or length(btrim(referred_name)) between 1 and 200),
  -- How they know them: neighbour, friend, sister.
  relation text check (relation is null or length(btrim(relation)) between 1 and 60),
  referred_phone_e164 text check (referred_phone_e164 is null or referred_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  referred_email text check (referred_email is null or length(btrim(referred_email)) between 3 and 320),
  -- What they need, in a few words ("AC looked at").
  need text check (need is null or length(btrim(need)) between 1 and 300),
  -- The customer's own words it came from, for the card.
  quote text check (quote is null or length(quote) <= 500),
  status text not null default 'mentioned' check (status in ('mentioned', 'lead_created', 'dismissed')),
  -- What "Create lead" made.
  person_id uuid references app.people (id) on delete set null,
  lead_id uuid references app.leads (id) on delete set null,
  decided_by uuid references app.users (id) on delete set null,
  decided_at timestamptz,
  -- When the AI teammate thanked the customer for it.
  thanked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (message_id is not null or call_id is not null),
  check (status <> 'lead_created' or lead_id is not null)
);
-- One per message or call, whatever reads it twice.
create unique index referrals_message on app.referrals (message_id) where message_id is not null;
create unique index referrals_call on app.referrals (call_id) where call_id is not null;
create index referrals_open on app.referrals (workspace_id, created_at desc) where status = 'mentioned';
create index referrals_referrer_idx on app.referrals (referrer_person_id);
create index referrals_conversation_idx on app.referrals (conversation_id) where conversation_id is not null;
create index referrals_person_idx on app.referrals (person_id) where person_id is not null;
create index referrals_lead_idx on app.referrals (lead_id) where lead_id is not null;
create index referrals_decided_by_idx on app.referrals (decided_by);
create trigger referrals_updated_at before update on app.referrals
  for each row execute function private.set_updated_at();
create trigger referrals_immutable before update on app.referrals
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'referrer_person_id',
    'message_id', 'call_id');

-- A referral, and what it made, belong to one business.
create or replace function private.check_referral_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.people p where p.id = new.referrer_person_id
                   and p.workspace_id = new.workspace_id)
     or (new.person_id is not null and not exists (select 1 from app.people p where p.id = new.person_id
                   and p.workspace_id = new.workspace_id))
     or (new.lead_id is not null and not exists (select 1 from app.leads l where l.id = new.lead_id
                   and l.workspace_id = new.workspace_id))
     or (new.conversation_id is not null and not exists (select 1 from app.conversations c
                   where c.id = new.conversation_id and c.workspace_id = new.workspace_id)) then
    raise exception 'That belongs to another business'
      using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
create trigger referrals_check_refs before insert or update on app.referrals
  for each row execute function private.check_referral_refs();

-- ---------- RLS ----------
alter table app.thank_yous enable row level security;
alter table app.referrals enable row level security;

create policy thank_yous_select on app.thank_yous for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy thank_yous_service_all on app.thank_yous for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy referrals_select on app.referrals for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
-- "Create lead" (referral.create_lead) records what it made; the column grant below is all it may change.
create policy referrals_update on app.referrals for update to authenticated
  using (private.has_permission(workspace_id, 'records.write'))
  with check (private.has_permission(workspace_id, 'records.write'));
create policy referrals_service_all on app.referrals for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- grants ----------
-- The worker writes both; a person reads them, and decides a referral.
grant select on app.thank_yous, app.referrals to authenticated;
grant update (status, person_id, lead_id, decided_by, decided_at, updated_at) on app.referrals to authenticated;
grant select, insert, update, delete on app.thank_yous, app.referrals to service_actor;
revoke all on app.thank_yous, app.referrals from anon;

-- ---------- the AI's read of a possible referral ----------
-- Counted, and charged, like every other AI call outside the Assistant.
alter type app.ai_usage_source add value if not exists 'automations';

-- ---------- the two cards ----------
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
    'referral_mentioned'
  ));

comment on column app.attention_items.subject_id is
  'The row the card is about: a lead, an attendee, an approval, a conversation, a task, an estimate, an '
  'invoice, a thank-you (app.thank_yous), a referral — or, for the wallet''s three kinds, the workspace''s '
  'own id, because a business has one wallet.';
