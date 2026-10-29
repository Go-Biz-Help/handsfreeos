-- =============================================================================
-- Social Outreach: Later on a person, and a phone alert when a request is
-- accepted (docs/outreach.md, decisions 100 and 101).
--
-- The owner's decisions (settled):
--
--        Later, in someone's person menu, takes them off the person's Today
--        for 2 weeks; then they're back. Their replies still come.
--        `stages.later_until` keeps when they're back, for one teammate and
--        one profile, as the rest of `stages` is each person's own. Null is
--        not on Later.
--
--        A push when someone accepts the person's friend request (or
--        connection, or follow) is off to start, with a switch under the
--        phone's alerts in Social Outreach's settings:
--        `automation.accepted_push`.
--
-- Only adds: two columns, with no rows to fill.
-- =============================================================================

alter table addon_outreach.stages
  add column later_until timestamptz;
create index stages_later_idx on addon_outreach.stages (workspace_id, user_id)
  where later_until is not null;

alter table addon_outreach.automation
  add column accepted_push boolean not null default false;
