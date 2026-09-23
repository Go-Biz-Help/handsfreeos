-- Automations, stage 4b: health and quality.
--
-- Seven Action Center kinds: a channel gone quiet, a connection broken or silent, nobody reviewing the AI
-- teammate, the AI being corrected for the same thing again and again, the website changed since the AI read it,
-- and a question customers keep asking that the AI can't answer.
--
-- `app.teammate_lessons` keeps what the worker made of repeated corrections: one line of guidance for the AI,
-- which a person adds to what the AI knows with one tap (teammate_lesson.apply) or dismisses.
--
-- One push switch, `connections`: a connection that broke (payments, calendar, email, reviews, a phone number).

create table app.teammate_lessons (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  teammate_id uuid not null references app.ai_teammates (id) on delete cascade,
  -- The line of guidance ("Say we don't work Sundays") and what the corrections had in common.
  line text not null check (length(btrim(line)) between 1 and 300),
  why text check (why is null or length(why) <= 500),
  -- The drafts it was read from.
  draft_ids uuid[] not null default '{}' check (cardinality(draft_ids) <= 20),
  status text not null default 'open' check (status in ('open', 'applied', 'dismissed')),
  decided_by uuid references app.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'open') = (decided_at is null))
);
create index teammate_lessons_teammate on app.teammate_lessons (teammate_id, created_at desc);
create index teammate_lessons_open on app.teammate_lessons (workspace_id) where status = 'open';
create index teammate_lessons_decided_by_idx on app.teammate_lessons (decided_by);
create trigger teammate_lessons_updated_at before update on app.teammate_lessons
  for each row execute function private.set_updated_at();
create trigger teammate_lessons_immutable before update on app.teammate_lessons
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'teammate_id', 'line');

create or replace function private.check_teammate_lesson_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.ai_teammates t
                 where t.id = new.teammate_id and t.workspace_id = new.workspace_id) then
    raise exception 'That belongs to another business'
      using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
create trigger teammate_lessons_check_refs before insert or update on app.teammate_lessons
  for each row execute function private.check_teammate_lesson_refs();

-- ---------- RLS ----------
alter table app.teammate_lessons enable row level security;
create policy teammate_lessons_select on app.teammate_lessons for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
-- Applying or dismissing it (the teammate_lesson commands); the column grant below is all a person may change.
create policy teammate_lessons_update on app.teammate_lessons for update to authenticated
  using (private.has_permission(workspace_id, 'knowledge.manage'))
  with check (private.has_permission(workspace_id, 'knowledge.manage'));
create policy teammate_lessons_service_all on app.teammate_lessons for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select on app.teammate_lessons to authenticated;
grant update (status, decided_by, decided_at, updated_at) on app.teammate_lessons to authenticated;
grant select, insert, update, delete on app.teammate_lessons to service_actor;
revoke all on app.teammate_lessons from anon;

-- ---------- the weekly re-read of the website ----------
-- The worker's own scan (Automations' "Website changed") rather than one a person started: only these open a
-- card, since a person who pressed Scan is already looking.
alter table app.knowledge_scans add column automatic boolean not null default false;

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
    'revenue_moved',
    'channel_quiet',
    'connection_error',
    'connection_silent',
    'ai_unreviewed',
    'ai_corrections',
    'website_changed',
    'faq_suggestions'
  ));

-- ---------- the push switch ----------
-- `connections` is on by default: a broken payment or calendar connection costs money and bookings until fixed.
create or replace function private.push_on(p_settings jsonb, p_key text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_key is null or p_key not in ('customerWaiting', 'missedCall', 'urgent', 'approval', 'booking', 'assigned', 'payment', 'wallet', 'jobs', 'connections') then
    raise exception 'Unknown push switch: %', p_key using errcode = '22023', detail = 'push_switch_unknown';
  end if;
  if jsonb_typeof(p_settings -> 'push' -> p_key) = 'boolean' then
    return (p_settings -> 'push' ->> p_key)::boolean;
  end if;
  return p_key <> 'payment';
end $$;

comment on column app.users.settings is
  'Per-person choices, each top-level key saved whole: theme; notifications, the email switches (unansweredEmail, attentionDigest, aiHandoff, bookingEmail, paymentEmail, agencyDigest, eveningSummary), each on unless false; push, the phone''s switches (customerWaiting, missedCall, urgent, approval, booking, assigned, payment, wallet, jobs, connections), each on unless false except payment: private.push_on.';
