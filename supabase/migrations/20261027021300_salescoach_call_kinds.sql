-- =============================================================================
-- AI Sales Coach: a script for each way a sales call starts
-- (docs/salescoach.md, "The question-led method").
--
-- The owner's decision (2026-10-31, "all of your picks"): the script builder
-- writes one script for each kind of call, each with its own opening: a new
-- lead who asked to be called, a booked call, an older lead and a cold call.
-- The kinds from before stay, for the scripts written as them.
--
-- Only the check widens. Steps' stages live in `details`, the add-on's own
-- shape, so nothing else here changes.
-- =============================================================================

alter table addon_salescoach.playbooks drop constraint playbooks_kind_check;
alter table addon_salescoach.playbooks add constraint playbooks_kind_check
  check (kind in ('new_lead', 'booked_call', 'aged_lead', 'cold_call',
    'first_call', 'estimate', 'follow_up', 'any'));
