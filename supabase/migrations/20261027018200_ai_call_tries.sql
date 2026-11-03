-- AI calls, part 3: a campaign's call and a workflow's ring again the next day when nobody answers, the line's busy
-- or a voicemail box picks up, up to the business's tries (Settings → Automations → AI calls → Adjust, 3 to begin
-- with). `tries` counts the times it has rung; the row waits as `queued` between them.

alter table app.ai_calls add column if not exists tries smallint not null default 0
  check (tries between 0 and 3);

-- The calls already made rang once.
update app.ai_calls set tries = 1 where placed_at is not null and tries = 0;
