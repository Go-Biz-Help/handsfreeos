-- Social Outreach: each person's Networking calendar and Lead calendar (decision 178).
--
-- The owner, 18 Nov 2026: "we should have a networking calendar and a lead calendar that users of this add on will use.
-- mine is the Chris’ calendar and the Demo Calendar respectively", and their pick 5a: demos book on the person's Lead
-- calendar first, with the playbook's link as the backup. The networking call (decisions 173 and 176) books on their
-- Networking calendar; with none picked, on their own oldest calendar that isn't the demo page, as before.
--
-- On the person's own settings row. A calendar deleted takes the pick with it.

alter table addon_outreach.automation
  add column networking_calendar_id uuid references app.calendars (id) on delete set null,
  add column lead_calendar_id uuid references app.calendars (id) on delete set null;

create index automation_networking_calendar_idx on addon_outreach.automation (networking_calendar_id)
  where networking_calendar_id is not null;
create index automation_lead_calendar_idx on addon_outreach.automation (lead_calendar_id)
  where lead_calendar_id is not null;
