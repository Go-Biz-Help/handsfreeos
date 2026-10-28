-- =============================================================================
-- Social Outreach (outreach): the old table of what the extension saw goes
-- (docs/outreach.md, decision 74).
--
--        `reports` kept, for a week, a note of each page a job read
--        (20261027008000). Those notes became core's problem reports
--        (20261027008100 copied them across), and since then nothing writes
--        it: the worker stopped emptying it, the last thing that touched it,
--        when the two old save commands were retired.
--
-- Only drops: one table nothing reads, writes or points into. Its policies and
-- indexes go with it.
-- =============================================================================

drop table if exists addon_outreach.reports;
