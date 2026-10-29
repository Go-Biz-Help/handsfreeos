-- AI calls, part 4: a call campaign that keeps adding people. Anyone who later gets one of its tags or reaches one
-- of its stages, and has agreed to calls in writing, joins it and is called at its pace, until it's stopped.
alter table app.campaigns add column if not exists keep_adding boolean not null default false;

alter table app.campaigns drop constraint if exists campaigns_keep_adding_calls;
alter table app.campaigns add constraint campaigns_keep_adding_calls
  check (not keep_adding or channel = 'call');

-- The worker looks for a business's campaigns still adding people whenever a tag, a stage or a yes to calls changes.
create index if not exists campaigns_keep_adding on app.campaigns (workspace_id)
  where keep_adding and status = 'sending';

-- People who run workflows turn it on and off (campaign.set_keep_adding).
grant update (keep_adding) on app.campaigns to authenticated;
