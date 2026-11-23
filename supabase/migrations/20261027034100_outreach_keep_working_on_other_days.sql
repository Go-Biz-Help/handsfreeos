-- Social Outreach: Keep working on other days, kept (decision 139).
--
-- The switch under Working hours (likes, friend requests, comments and replies go every day in the hours; new
-- messages only on the ticked days) shipped with nowhere to keep it: a save dropped it, and reading the settings back
-- turned it on again. The owner, 22 Nov 2026: "can't turn the switch off. i switch it off and then it turns back on."
--
-- On to start, as a setting saved before has none, which counts as on.
--
-- Only adds: one column, with a default for the rows there.

alter table addon_outreach.automation
  add column every_day boolean not null default true;
