-- =============================================================================
-- Social Outreach: Cancel all, for the friend requests nobody answered
-- (docs/outreach.md, decision 121).
--
-- The owner's decision (settled):
--
--        A Cancel all button under Old friend requests that skips the wait,
--        with a box to leave out the ones the extension sent, ticked to
--        start. It works through them at the day's limit.
--
-- Pressing it marks each of the person's sent requests waiting then
-- (`friends.cancel_at`): the extension cancels those, the oldest first,
-- inside the day's limit, until none is left or they press Stop, which clears
-- the marks. A mark counts while the request it was put on still waits
-- (`cancel_at >= since`): one sent again later starts afresh.
--
-- Only adds: one column nobody has to fill.
-- =============================================================================

alter table addon_outreach.friends add column cancel_at timestamptz;

comment on column addon_outreach.friends.cancel_at is
  'When Cancel all marked this sent request to cancel (decision 121): it counts while it''s since `since`.';
