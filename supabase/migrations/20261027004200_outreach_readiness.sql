-- =============================================================================
-- Social Outreach (outreach): Get ready for your best results
-- (HANDSFREEOS_MAIN_OFFER_IMPLEMENTATION_PLAN.md, "Getting ready"; docs/outreach.md,
-- decision 63).
--
--        Each person's own part of getting ready, kept on their setup row:
--        their monthly goal for calls booked and when they last saw what it
--        takes each day, and the profile items they ticked, each with when
--        and the main offer's version live then (so a new version asks them
--        to look again). Whether someone is ready is worked out each time
--        (outreach.readiness), never kept as a flag.
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

alter table addon_outreach.setup
  -- Calls booked a month; null until they set it.
  add column calls_goal smallint check (calls_goal is null or calls_goal between 1 and 100),
  -- When they last saved their goal, having seen the math.
  add column numbers_at timestamptz,
  -- The profile items ticked: {"picture": {"at": "…", "version": 2}, …}.
  add column profile jsonb not null default '{}'::jsonb
    check (jsonb_typeof(profile) = 'object' and octet_length(profile::text) <= 4000);

-- Get ready is a step of the setup, after the playbooks: the furthest step finished may be it.
alter table addon_outreach.setup drop constraint setup_reached_check;
alter table addon_outreach.setup add constraint setup_reached_check
  check (reached in ('playbooks', 'ready', 'rules', 'settings', 'extension', 'groups'));

-- The AI's latest check of the person's own Facebook profile, read by the extension (decision 64): each item right
-- or not with what to change, bios to pick from, a cover line and what to feature, when it was read and against
-- which version of the main offer. What the page said is never kept, only this.
alter table addon_outreach.setup
  add column profile_check jsonb
    check (profile_check is null or (jsonb_typeof(profile_check) = 'object' and octet_length(profile_check::text) <= 12000));
