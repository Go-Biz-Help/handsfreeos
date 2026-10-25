-- =============================================================================
-- Social Outreach: what each person told the AI about their messages (docs/outreach.md, decision 87)
--
-- In the setup's Your messages, a person changes a sample message or tells the AI what's not quite right of it.
-- `setup.message_notes` keeps what they said of each part (first messages, the video, the link, the follow-ups,
-- the check-in), apart from the samples, so the next samples and their real messages follow it. The samples they
-- wrote themselves stay in `message_samples`, marked in its jsonb.
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

alter table addon_outreach.setup
  add column message_notes jsonb not null default '{}'::jsonb
    check (jsonb_typeof(message_notes) = 'object' and octet_length(message_notes::text) <= 40000);
