-- =============================================================================
-- Real Estate Agent, round four, steps 4 and 5: what a duty waits on, and
-- escalation after a business day.
--
--        Chris decided (2026-10-02): built-in orders plus the agent's own, a
--        waiting duty shows what it waits on and who has it, and a slip shows
--        what moves; an at-risk item nobody acknowledges within a business day
--        goes to the business's alert people.
--
--        **duty_links** gains who added one: nobody for the built-in orders
--        (the add-on writes them when both duties are on a deal), else the
--        person who said this duty waits on that one.
--
--        **duties** gains, for the Waiting room, when it started waiting on
--        someone outside and the day to chase them; and, for escalation, when
--        it became at risk and when that went to the alert people.
-- =============================================================================

alter table addon_realestate.duty_links
  add column added_by uuid references app.users (id) on delete set null;
create index duty_links_added_by_idx on addon_realestate.duty_links (added_by) where added_by is not null;

alter table addon_realestate.duties
  add column waiting_since timestamptz,
  add column chase_at timestamptz,
  add column at_risk_since timestamptz,
  add column escalated_at timestamptz,
  add check (escalated_at is null or at_risk_since is not null);
-- The Waiting room's list, and the sweep's look for waits past their chase.
create index duties_waiting_idx on addon_realestate.duties (workspace_id, chase_at)
  where status in ('waiting_external', 'blocked');

comment on column addon_realestate.duties.chase_at is
  'Waiting on someone outside: the day to chase them (round four). Past it, the deal turns yellow until someone says they chased.';
comment on column addon_realestate.duties.at_risk_since is
  'When its alert first said at risk; with nobody acknowledging it for a business day, it goes to the business''s alert people (escalated_at).';
