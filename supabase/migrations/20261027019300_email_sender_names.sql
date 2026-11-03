-- =============================================================================
-- The name an email came from, so a sender can be added to Contacts as who
-- they said they were.
--
-- The owner (2026-10-29): "when using hfos for email we should be able to
-- quickly create a new contact from it or assign that email to an existing
-- contact". Adding them starts with the address already; the name on the
-- From line ("Gregory Lyons <grlyons1010@gmail.com>") was read and then let
-- go, so the person typed it again. Each email now keeps it, and the
-- conversation offers the newest one its sender gave.
--
-- Mail from the last 30 days gets it back: the mail service's own copy of each
-- email is kept that long after it is filed (app.webhook_deliveries), name and
-- all. Mail from a connected Gmail or Outlook mailbox keeps it from now on.
--
-- Only adds: one column nobody has to fill.
-- =============================================================================

alter table app.messages add column from_name text;

comment on column app.messages.from_name is
  'Email: the name on its From line, as the sender gave it, or null when it had none.';

update app.messages m
set from_name = left(btrim(coalesce(
      nullif(btrim(d.params -> 'FromFull' ->> 'Name'), ''),
      d.params ->> 'FromName')), 200)
from app.webhook_deliveries d
where m.channel = 'email'
  and m.direction = 'inbound'
  and m.provider = 'postmark'
  and m.from_name is null
  and d.provider = 'postmark'
  and d.kind = 'email.inbound'
  and d.workspace_id = m.workspace_id
  and d.dedupe_key = 'inbound:' || m.provider_message_id
  and nullif(btrim(coalesce(
        nullif(btrim(d.params -> 'FromFull' ->> 'Name'), ''),
        d.params ->> 'FromName')), '') is not null;
