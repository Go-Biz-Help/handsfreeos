-- =============================================================================
-- Webinars, part 5: who to follow up with
-- (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md; the owner's answers of 29 October 2026).
--
--        When a call with a live poll ends, each customer who came is scored
--        (the owner's 21 and 22): points for each answer and each button
--        pressed, as the poll's questions say, and for staying to the end,
--        then Hot, Warm or Cold from the lines the poll sets, and one line from
--        the AI on why. The poll also says what happens to the hot ones (the
--        owner's 23): the ranked list; the list plus a Home card; or the AI
--        teammate texts each of them, waiting for a person's OK while it's on
--        training wheels (the default).
--
--        - **Each customer's score** is a row of `app.video_call_leads`, one
--          per call and person. Only the worker writes it; whoever sees the
--          call sees it.
--        - **Home** gets one card kind, `webinar_hot`: a hot one the poll puts
--          on Home, or one the AI teammate couldn't text.
--
-- Only widens.
-- =============================================================================

create table app.video_call_leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  video_call_id uuid not null references app.video_calls (id) on delete cascade,
  person_id uuid not null references app.people (id) on delete cascade,
  -- The live poll it was scored by, and their answers on it.
  form_id uuid references app.forms (id) on delete set null,
  response_id uuid references app.form_responses (id) on delete set null,
  points integer not null default 0 check (points between -100000 and 100000),
  label text not null check (label in ('hot', 'warm', 'cold')),
  -- Still there when the team finished, and how long they were in it.
  stayed boolean not null default false,
  seconds integer not null default 0 check (seconds >= 0),
  -- What the points came from, in words: [{"what": "Stayed to the end", "points": 10}, …].
  parts jsonb not null default '[]'::jsonb check (jsonb_typeof(parts) = 'array'),
  -- The AI's one line on why, written once the scores are in.
  reason text check (reason is null or length(reason) <= 500),
  reason_at timestamptz,
  -- What the poll said to do with the hot ones when it was scored: list, home or text.
  follow_up text not null default 'list' check (follow_up in ('list', 'home', 'text')),
  -- The AI teammate's text to a hot one: sent, drafted (waiting for an OK), card (a person is asked on Home) or
  -- skipped (someone wrote to them already, or there's no way to reach them).
  outcome text check (outcome in ('sent', 'drafted', 'card', 'skipped')),
  outcome_reason text check (outcome_reason is null or length(outcome_reason) <= 200),
  scored_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (video_call_id, person_id)
);
create index video_call_leads_workspace_idx on app.video_call_leads (workspace_id);
create index video_call_leads_person_idx on app.video_call_leads (person_id);
create index video_call_leads_form_idx on app.video_call_leads (form_id) where form_id is not null;
create index video_call_leads_response_idx on app.video_call_leads (response_id) where response_id is not null;
-- Home's cards: hot ones a person is asked about.
create index video_call_leads_home_idx on app.video_call_leads (workspace_id, scored_at)
  where label = 'hot' and (follow_up = 'home' or outcome = 'card');
create trigger video_call_leads_updated_at before update on app.video_call_leads
  for each row execute function private.set_updated_at();
create trigger video_call_leads_immutable before update on app.video_call_leads
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'video_call_id', 'person_id');

comment on table app.video_call_leads is
  'Each customer in a HandsFreeOS video call with a live poll, scored when it ended: points, Hot, Warm or Cold, the AI''s reason, and what happened to a hot one (webinars, part 5). Only the worker writes it.';

-- The person belongs to the call's business.
create or replace function private.check_video_call_lead_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.video_calls c where c.id = new.video_call_id and c.workspace_id = new.workspace_id)
     or not exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id)
     or (new.form_id is not null
         and not exists (select 1 from app.forms f where f.id = new.form_id and f.workspace_id = new.workspace_id))
  then
    raise exception 'That belongs to another business' using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
create trigger video_call_leads_check_refs before insert on app.video_call_leads
  for each row execute function private.check_video_call_lead_refs();

-- Whoever sees the call sees who to follow up with from it; the worker scores them.
alter table app.video_call_leads enable row level security;
create policy video_call_leads_select on app.video_call_leads for select to authenticated
  using (video_call_id in (select c.id from app.video_calls c));
create policy video_call_leads_service_all on app.video_call_leads for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select on app.video_call_leads to authenticated;
grant select, insert, update, delete on app.video_call_leads to service_actor;
revoke all on app.video_call_leads from anon;

-- ---------- Home ----------
alter table app.attention_items drop constraint attention_items_kind_check;
alter table app.attention_items add constraint attention_items_kind_check check (kind in (
  'hot_lead', 'unanswered_lead', 'stale_opportunity', 'missing_next_action', 'unconfirmed_appointment',
  'ai_approval', 'customer_waiting', 'overdue_task', 'estimate_waiting', 'invoice_overdue',
  'wallet_low', 'wallet_empty', 'wallet_card_declined',
  'job_not_thanked', 'referral_mentioned', 'maintenance_due',
  'pipeline_mismatch', 'quiet_after_price', 'job_unconfirmed', 'job_never_completed', 'job_no_address',
  'client_quiet', 'promise_due', 'revenue_moved',
  'channel_quiet', 'connection_error', 'connection_silent', 'ai_unreviewed', 'ai_corrections', 'website_changed',
  'faq_suggestions', 'offer_lapsing', 'texting_rejected',
  'addon_alert',
  'webinar_hot'));
