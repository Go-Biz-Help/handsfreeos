-- =============================================================================
-- Real Estate Agent, round two, step 8: tours, and the agreement rule.
--
--        Chris decided (2026-09-30): a tour is one appointment on the core
--        calendar, with the homes in order; the client is invited and
--        reminded. A tour needs a signed buyer agreement that hasn't ended
--        by the tour's day; an owner or admin (Approve exceptions) can let
--        one through with a reason, which is kept here and in the deal's
--        history. The appointment is the deal's, so someone off a private
--        deal sees it only as busy (step 1).
--
--        **tours**: one per appointment: when, who leads it, the agreement
--        it rested on or the exception that let it through, and whether it
--        happened. The times follow the appointment when it's moved on the
--        calendar (the worker), so the client's portal reads them here.
--        **tour_stops**: the homes, in order, and whether each was seen.
--        **tour_feedback**: what each client thought of each home they saw,
--        in their portal (step 12) or as the agent heard it.
-- =============================================================================

create table addon_realestate.tours (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  -- Core's appointment for it; an add-on's row may point into core, never the other way.
  appointment_id uuid references app.appointments (id) on delete set null,
  calendar_id uuid references app.calendars (id) on delete set null,
  status text not null default 'planned' check (status in ('planned', 'done', 'canceled')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  agent_user_id uuid references app.users (id) on delete set null,
  -- The signed buyer agreement it rested on, or the exception that let it through without one.
  agreement_document_id uuid references addon_realestate.documents (id) on delete set null,
  exception_reason text check (exception_reason is null or length(btrim(exception_reason)) between 1 and 500),
  exception_by uuid references app.users (id) on delete set null,
  exception_at timestamptz,
  note text check (note is null or length(note) <= 2000),
  canceled_reason text check (canceled_reason is null or length(canceled_reason) <= 500),
  canceled_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (ends_at > starts_at),
  check ((exception_reason is null) = (exception_at is null)),
  check ((status = 'canceled') = (canceled_at is not null)),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create unique index tours_appointment_unique on addon_realestate.tours (appointment_id)
  where appointment_id is not null;
create index tours_deal_idx on addon_realestate.tours (workspace_id, deal_record_id, starts_at);
create index tours_calendar_idx on addon_realestate.tours (calendar_id) where calendar_id is not null;
create index tours_agent_idx on addon_realestate.tours (agent_user_id) where agent_user_id is not null;
create index tours_agreement_idx on addon_realestate.tours (agreement_document_id)
  where agreement_document_id is not null;
create index tours_exception_by_idx on addon_realestate.tours (exception_by) where exception_by is not null;
create index tours_created_by_idx on addon_realestate.tours (created_by) where created_by is not null;
select private.addon_table_policies('addon_realestate.tours', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
select private.addon_portal_policies('addon_realestate.tours', 'deal_record_id',
  array['id', 'status', 'starts_at', 'ends_at', 'canceled_at', 'created_at']);

create table addon_realestate.tour_stops (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  tour_id uuid not null,
  home_id uuid not null,
  position integer not null check (position between 1 and 30),
  status text not null default 'planned' check (status in ('planned', 'visited', 'skipped')),
  visited_at timestamptz,
  -- The agent's note on the visit: for the team, not the client.
  note text check (note is null or length(note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (tour_id, home_id),
  check ((status = 'visited') = (visited_at is not null)),
  foreign key (workspace_id, tour_id) references addon_realestate.tours (workspace_id, id) on delete cascade,
  foreign key (workspace_id, home_id) references addon_realestate.homes (workspace_id, id) on delete cascade,
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index tour_stops_tour_idx on addon_realestate.tour_stops (workspace_id, tour_id, position);
create index tour_stops_home_idx on addon_realestate.tour_stops (workspace_id, home_id);
create index tour_stops_deal_idx on addon_realestate.tour_stops (workspace_id, deal_record_id);
-- A planned tour's homes change as a whole; one taken off before anyone saw it is simply gone.
select private.addon_table_policies('addon_realestate.tour_stops', 'realestate.use', 'realestate.use',
  'realestate.use', 'deal_record_id');
select private.addon_portal_policies('addon_realestate.tour_stops', 'deal_record_id',
  array['id', 'tour_id', 'home_id', 'position', 'status', 'visited_at']);

create table addon_realestate.tour_feedback (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  tour_id uuid not null,
  stop_id uuid not null,
  home_id uuid not null,
  -- The client it's from: given in their portal, or typed in by someone on the team who heard it.
  person_id uuid not null references app.people (id) on delete cascade,
  recorded_by uuid references app.users (id) on delete set null,
  interest text not null check (interest in ('love', 'maybe', 'no')),
  rating smallint check (rating is null or rating between 1 and 5),
  words text check (words is null or length(words) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stop_id, person_id),
  foreign key (workspace_id, stop_id) references addon_realestate.tour_stops (workspace_id, id) on delete cascade,
  foreign key (workspace_id, tour_id) references addon_realestate.tours (workspace_id, id) on delete cascade,
  foreign key (workspace_id, home_id) references addon_realestate.homes (workspace_id, id) on delete cascade,
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index tour_feedback_tour_idx on addon_realestate.tour_feedback (workspace_id, tour_id);
create index tour_feedback_home_idx on addon_realestate.tour_feedback (workspace_id, home_id);
create index tour_feedback_deal_idx on addon_realestate.tour_feedback (workspace_id, deal_record_id);
create index tour_feedback_person_idx on addon_realestate.tour_feedback (person_id);
create index tour_feedback_recorded_by_idx on addon_realestate.tour_feedback (recorded_by)
  where recorded_by is not null;
select private.addon_table_policies('addon_realestate.tour_feedback', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
select private.addon_portal_policies('addon_realestate.tour_feedback', 'deal_record_id',
  array['id', 'tour_id', 'stop_id', 'home_id', 'person_id', 'interest', 'rating', 'words', 'created_at',
    'updated_at']);
