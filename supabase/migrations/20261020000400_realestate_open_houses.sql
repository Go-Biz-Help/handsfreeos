-- =============================================================================
-- Real Estate Agent, round three, step 7: open houses.
--
--        Chris decided (2026-10-01): visitors sign in on a page they open
--        from a QR code. Chosen for him: an open house needs no sign-off from
--        the seller, who sees it in the portal; a visitor working with another
--        agent is recorded but never made a lead or texted.
--
--        **open_houses**: when, who hosts it, and its appointment on the
--        host's calendar (made as a tour's is; a private deal's shows only as
--        busy to others).
--        **open_house_visitors**: who signed in, whether they're working with
--        an agent, whether they agreed to texts, and whether they've been
--        followed up. A visitor on their own is a customer with a lead for the
--        host; one with an agent is only their name and how to reach them.
-- =============================================================================

create table addon_realestate.open_houses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  host_user_id uuid references app.users (id) on delete set null,
  appointment_id uuid references app.appointments (id) on delete set null,
  calendar_id uuid references app.calendars (id) on delete set null,
  state text not null default 'planned' check (state in ('planned', 'cancelled')),
  cancelled_at timestamptz,
  cancelled_reason text check (cancelled_reason is null or length(cancelled_reason) <= 500),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (ends_at > starts_at and ends_at - starts_at <= interval '12 hours'),
  check ((state = 'cancelled') = (cancelled_at is not null)),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index open_houses_deal_idx on addon_realestate.open_houses (workspace_id, deal_record_id, starts_at);
create index open_houses_host_idx on addon_realestate.open_houses (host_user_id) where host_user_id is not null;
create index open_houses_appointment_idx on addon_realestate.open_houses (appointment_id)
  where appointment_id is not null;
create index open_houses_calendar_idx on addon_realestate.open_houses (calendar_id) where calendar_id is not null;
create index open_houses_created_by_idx on addon_realestate.open_houses (created_by) where created_by is not null;
select private.addon_table_policies('addon_realestate.open_houses', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
-- The seller sees their open houses.
select private.addon_portal_policies('addon_realestate.open_houses', 'deal_record_id',
  array['id', 'starts_at', 'ends_at', 'state']);

create table addon_realestate.open_house_visitors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  open_house_id uuid not null,
  -- The customer they are: never set for a visitor working with another agent.
  person_id uuid references app.people (id) on delete set null,
  lead_id uuid references app.leads (id) on delete set null,
  first_name text not null check (length(btrim(first_name)) between 1 and 80),
  last_name text check (last_name is null or length(last_name) <= 80),
  email text check (email is null or length(email) <= 254),
  phone text check (phone is null or length(phone) <= 40),
  with_agent boolean not null default false,
  agent_name text check (agent_name is null or length(agent_name) <= 160),
  sms_consent boolean not null default false,
  signed_in_at timestamptz not null default now(),
  followed_up_at timestamptz,
  followed_up_by uuid references app.users (id) on delete set null,
  follow_up_note text check (follow_up_note is null or length(follow_up_note) <= 500),
  unique (open_house_id, person_id),
  check (not with_agent or (person_id is null and lead_id is null and not sms_consent)),
  check (email is not null or phone is not null),
  foreign key (workspace_id, open_house_id) references addon_realestate.open_houses (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index open_house_visitors_house_idx on addon_realestate.open_house_visitors (open_house_id, signed_in_at);
create index open_house_visitors_deal_idx on addon_realestate.open_house_visitors (workspace_id, deal_record_id);
create index open_house_visitors_person_idx on addon_realestate.open_house_visitors (person_id)
  where person_id is not null;
create index open_house_visitors_lead_idx on addon_realestate.open_house_visitors (lead_id) where lead_id is not null;
create index open_house_visitors_followed_up_by_idx on addon_realestate.open_house_visitors (followed_up_by)
  where followed_up_by is not null;
select private.addon_table_policies('addon_realestate.open_house_visitors', 'realestate.use', 'realestate.use',
  null, 'deal_record_id');
