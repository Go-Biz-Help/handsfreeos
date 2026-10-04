-- =============================================================================
-- Real Estate Agent, round two, step 14: how many of the AI's buyer-memory
-- suggestions were left out because they were about who lives somewhere or a
-- protected class.
--
--        The "What they want" page says so (board 16), so the agent knows the
--        AI heard something and fair housing rules kept it out. Only the count
--        is kept, never what was said.
-- =============================================================================

alter table addon_realestate.deals
  add column memory_protected_dropped integer not null default 0
    check (memory_protected_dropped >= 0);
