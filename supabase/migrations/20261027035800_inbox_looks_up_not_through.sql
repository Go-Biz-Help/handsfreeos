-- =============================================================================
-- The Inbox looks a customer's threads up, rather than through the business's
-- (speed audit, Nov 2026).
--        - The Inbox shows each customer once. For every row on a page it asks
--          three things about the rest of the business: is another thread of
--          theirs newer (so this one folds into it), which other threads are
--          theirs (the lanes), and, when nobody has said who a number or an
--          address is, which customer it looks like ("Same as Kim Alvarez?").
--        - Each of the three read the whole business to answer. On a business
--          with 20,000 threads and 8,000 customers a page of 50 took 0.8 s,
--          and a search by number 1.2 s. The biggest business has about 1,000
--          threads today (0.03 s), so this is ahead of the growth, not behind.
--        - Why they read everything: a signed-in person reads these tables
--          through row-level security, and there Postgres takes a condition to
--          an index only when its operator can't leak (text and uuid `=` can't;
--          an enum's, citext's and jsonb's `@>` can). So:
--            * a thread nobody has linked is found by channel and address, and
--              the one index with the address has the channel (an enum) ahead
--              of it. conversations_unlinked_idx has the address alone, over
--              only the threads with no customer;
--            * a customer's other numbers and addresses are in jsonb, behind
--              GIN indexes no signed-in look-up has ever used (0 scans, live),
--              and their main address is citext. private.people_with_contact
--              asks those indexes for the ids; the Inbox then reads those few
--              customers itself, through its own row-level security.
--        - Adds one index and one function. Nothing is changed or dropped, so
--          it can go on before the code.
-- =============================================================================

-- A thread nobody has linked to a customer, by who it's with. The channel is checked on the few rows this finds.
create index if not exists conversations_unlinked_idx
  on app.conversations (workspace_id, counterpart)
  where person_id is null;

-- The ids of the business's customers reached at an address or a number in one way:
--   'email'        their main email address (whatever its capitals: the column is citext);
--   'other_phone'  one of their other numbers;
--   'other_email'  one of their other addresses.
-- (Their main number needs no help: text `=` goes to people_phone_idx under row-level security as it is.)
-- Ids only, of a business the caller may ask about, and nothing about the customers: the caller reads them from
-- app.people by id, so what it may see of each is still row-level security's to say (the bin, the portal).
-- Runs as its owner so that each ask is one probe of an index: people_email_idx, people_other_phones_idx or
-- people_other_emails_idx. The two jsonb ones are asked for the address before the business is looked at
-- (`materialized`): left to itself Postgres also read the business's whole list of customers from another index
-- to cross the two, which is the reading this is here to end.
create or replace function private.people_with_contact(p_ws uuid, p_kind text, p_value text)
returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_value is null or not private.may_ask_about(p_ws) then
    return '{}'::uuid[];
  end if;
  if p_kind = 'email' then
    return coalesce((select array_agg(sp.id) from app.people sp
      where sp.workspace_id = p_ws and sp.email operator(extensions.=) p_value::extensions.citext), '{}'::uuid[]);
  elsif p_kind = 'other_phone' then
    return coalesce((
      with reached as materialized (
        select sp.id, sp.workspace_id from app.people sp
        where sp.other_phones @> jsonb_build_array(jsonb_build_object('phone', p_value)))
      select array_agg(r.id) from reached r where r.workspace_id = p_ws), '{}'::uuid[]);
  elsif p_kind = 'other_email' then
    return coalesce((
      with reached as materialized (
        select sp.id, sp.workspace_id from app.people sp
        where sp.other_emails @> jsonb_build_array(jsonb_build_object('email', p_value)))
      select array_agg(r.id) from reached r where r.workspace_id = p_ws), '{}'::uuid[]);
  end if;
  return '{}'::uuid[];
end
$$;

revoke all on function private.people_with_contact(uuid, text, text) from public;
grant execute on function private.people_with_contact(uuid, text, text) to authenticated, service_actor;
