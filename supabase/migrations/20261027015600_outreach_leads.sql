-- =============================================================================
-- Social Outreach: a lead in the pipeline for whoever wants a demo
-- (docs/outreach.md, decision 105).
--
-- The owner's decision (settled):
--
--        A lead goes in when someone reached wants a demo or answers the
--        playbook's questions, in the main pipeline's first stage, marked
--        with the network and group they came from.
--
-- `profiles.lead_id` is the lead it opened (or the customer's open lead it
-- found), and `profiles.lead_at` when: a profile opens one lead, once, so a
-- lead won, lost or deleted for good is never opened again. A lead deleted
-- for good leaves `lead_id` empty and `lead_at` set.
--
-- Only adds: two columns, with no rows to fill.
-- =============================================================================

alter table addon_outreach.profiles
  add column lead_id uuid references app.leads (id) on delete set null,
  add column lead_at timestamptz;
create index profiles_lead_idx on addon_outreach.profiles (lead_id) where lead_id is not null;
