-- =============================================================================
-- Real Estate Agent, round five, step 8: showings of our listings.
--
--        Chris decided (2026-10-02): both. **Our own showing page**: a buyer's
--        agent asks for one of the seller's open times on the listing's page,
--        the seller says yes in their portal (or it's confirmed on its own when
--        the listing says so), then the access instructions go to that agent
--        alone, just before, and a feedback link after. **ShowingTime's
--        emails**, for listings already on it, are read into the same showings
--        and feedback, each marked to be checked by a person.
--
--        Showings and their feedback join the listing's activity, the seller's
--        portal (feedback once the agent shares it) and the price review.
-- =============================================================================

-- How showings work on a listing.
alter table addon_realestate.listings
  add column showings_open boolean not null default true,
  add column showing_confirm text not null default 'seller' check (showing_confirm in ('seller', 'auto')),
  -- The lockbox code and how to get in: only for a confirmed showing's agent, just before it.
  add column showing_access text check (showing_access is null or length(btrim(showing_access)) between 1 and 1000),
  add column showing_access_hours smallint not null default 1 check (showing_access_hours between 0 and 24),
  add column showing_feedback_hours smallint not null default 1 check (showing_feedback_hours between 0 and 48),
  add column showing_minutes smallint not null default 30 check (showing_minutes between 15 and 120),
  -- The seller's open times: these days of the week (0 Sunday), between these times, in the business's time zone.
  add column showing_days smallint[] not null default '{0,1,2,3,4,5,6}'
    check (showing_days <@ '{0,1,2,3,4,5,6}'::smallint[]),
  add column showing_from time not null default '10:00',
  add column showing_to time not null default '18:00',
  -- What buyers said, grouped by the AI from their words (each theme with its quotes), and when.
  add column showing_themes jsonb check (showing_themes is null or jsonb_typeof(showing_themes) = 'object'),
  add column showing_themes_at timestamptz,
  add constraint listings_showing_hours_check check (showing_from < showing_to);

create table addon_realestate.showings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  source text not null check (source in ('page', 'showingtime', 'agent')),
  state text not null default 'requested' check (state in ('requested', 'confirmed', 'declined', 'cancelled', 'done')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- The buyer's agent.
  agent_name text not null check (length(btrim(agent_name)) between 1 and 120),
  brokerage text check (brokerage is null or length(btrim(brokerage)) between 1 and 120),
  license text check (license is null or length(btrim(license)) between 1 and 40),
  agent_email text check (agent_email is null or length(agent_email) <= 254),
  agent_phone text check (agent_phone is null or length(agent_phone) <= 40),
  -- Read from an email: a person checks it before it counts as right.
  checked boolean not null default true,
  -- ShowingTime's own reference, when its email gave one; and the email it came in.
  external_id text check (external_id is null or length(external_id) <= 200),
  message_id uuid references app.messages (id) on delete set null,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references app.users (id) on delete set null,
  decided_by_person_id uuid references app.people (id) on delete set null,
  -- The seller's or agent's words with a no or "another time".
  decision_note text check (decision_note is null or length(btrim(decision_note)) between 1 and 500),
  access_sent_at timestamptz,
  feedback_asked_at timestamptz,
  -- The feedback link's token, hashed (the link itself is only in the email).
  feedback_token_hash bytea unique,
  -- interest (1–5), liked, pause, price (low, right, high).
  feedback jsonb check (feedback is null or jsonb_typeof(feedback) = 'object'),
  feedback_at timestamptz,
  feedback_source text check (feedback_source is null or feedback_source in ('page', 'showingtime', 'agent')),
  -- Shared with the seller in their portal.
  feedback_shared_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, external_id),
  check (starts_at < ends_at),
  check ((feedback is null) = (feedback_at is null)),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index showings_deal_idx on addon_realestate.showings (workspace_id, deal_record_id, starts_at desc);
create index showings_open_idx on addon_realestate.showings (workspace_id, starts_at)
  where state in ('requested', 'confirmed');
create index showings_message_idx on addon_realestate.showings (message_id) where message_id is not null;
create index showings_decided_by_idx on addon_realestate.showings (decided_by) where decided_by is not null;
create index showings_decided_person_idx on addon_realestate.showings (decided_by_person_id)
  where decided_by_person_id is not null;
create index showings_created_by_idx on addon_realestate.showings (created_by) where created_by is not null;
select private.addon_table_policies('addon_realestate.showings', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
-- The seller sees when, who and where it stands; never how to get in or the agent's contact details. Feedback only
-- once it's shared (the portal's own query says so too).
select private.addon_portal_policies('addon_realestate.showings', 'deal_record_id',
  array['id', 'source', 'state', 'starts_at', 'ends_at', 'agent_name', 'brokerage', 'requested_at', 'decided_at',
        'decided_by_person_id', 'decision_note', 'feedback', 'feedback_at', 'feedback_shared_at']);
-- Whether a showing waits for the seller's yes, for their portal.
grant select (showing_confirm) on addon_realestate.listings to portal_actor;
