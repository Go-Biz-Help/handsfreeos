-- Whether an email's sender is who its From says (FDE1). Anyone can write any address in From, so the worker asks
-- the mail service's checks (DMARC, DKIM or SPF for the From domain) and email.receive keeps the answer here:
-- true, the From domain vouched for it; false, it didn't (still filed, never lost, but spam-checked like a stranger's,
-- answered by the AI teammate like an unverified website chat, and never a source of contact details for contact AI);
-- null, nobody checked (a connected Gmail or Outlook mailbox, mail from before this, and every other channel).
-- Additive: a nullable column, covered by the table's existing grants and policies.
alter table app.messages add column if not exists sender_verified boolean;

comment on column app.messages.sender_verified is
  'Email only: true when the From domain vouched for it (DMARC, aligned DKIM or aligned SPF), false when it did not, null when nobody checked.';
