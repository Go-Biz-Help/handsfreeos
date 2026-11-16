-- Social Outreach: a job that failed has its own line in the feed (docs/outreach.md, decision 170). Three the same in
-- a row, with nothing else on that network for an hour, shows the network as stuck at the top of its page in
-- Settings. The check is dropped and added again in one step, with every kind it allowed before.
do $$
begin
  alter table addon_outreach.live_steps drop constraint live_steps_kind_check;
  alter table addon_outreach.live_steps add constraint live_steps_kind_check
    check (kind in ('done', 'passed', 'job', 'failed', 'stopped', 'day'));
end
$$;
