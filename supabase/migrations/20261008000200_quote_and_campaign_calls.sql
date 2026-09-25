-- AI outbound calls, piece 4b: quote follow-up calls and campaign calls.
--
-- Quote calls need nothing new here: they are `app.ai_calls` rows with purpose `quote` (always approved by a
-- person first), and their switch lives in the workspace's automation settings.
--
-- A campaign can now be calls: the AI teammate rings each person, only those who agreed to calls in writing
-- (`people.call_consent = 'opted_in'`). The AI writes one opening line for the whole campaign ("about our fall
-- tune-up, which is $89 this month"), which finishes "I'm calling …" and which the owner can change before
-- approving. Each person's call is an `app.ai_calls` row with purpose `campaign`.

alter table app.campaigns drop constraint campaigns_channel_check;
alter table app.campaigns add constraint campaigns_channel_check check (channel in ('sms', 'email', 'call'));

alter table app.campaigns
  add column call_opening text check (call_opening is null or length(btrim(call_opening)) between 1 and 200),
  -- A person changed the AI's words.
  add column call_edited boolean not null default false;

grant update (call_opening, call_edited) on app.campaigns to authenticated;
