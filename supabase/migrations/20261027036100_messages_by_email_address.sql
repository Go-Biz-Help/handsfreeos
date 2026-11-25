-- =============================================================================
-- A sending address finds its own mail, rather than reading the business's
-- (speed audit, Nov 2026).
--        - Settings → Email lists the business's sending addresses, and asks of
--          each whether it has ever carried mail: one that has keeps its name
--          (guard_email_address asks the same before a rename).
--        - messages.email_address_id had no index, so each address read every
--          message of the business to answer. On the live database, with 19
--          addresses and 17,780 messages, the list took 0.5 s and up to 1.5 s.
--        - Deleting an address did the same once more, to set the column to
--          null on the messages it carried (the foreign key's own look-up).
--        - Partial on `is not null`, as the keys in 20261012070100 are: about
--          one message in a hundred carries an address, and a null matches
--          neither question. uuid `=` can't leak, so a signed-in person's
--          look-up goes to the index under row-level security.
--        - Adds one index. Nothing is changed or dropped, so it can go on
--          before the code.
-- =============================================================================

create index if not exists messages_email_address_id_idx
  on app.messages (email_address_id) where email_address_id is not null;
