-- =============================================================================
-- 0102 · More than one way to reach a customer. A person and a company kept
--        one email, one number and one address (and a spare number,
--        `phone_alt`, that only imports ever filled in). Real customers have
--        a work address and a home one, a cell and an office line, a rental
--        across town. So both now keep the others too: other_emails,
--        other_phones and other_addresses.
--
--        **The main one stays where it is.** email, phone_e164 and the
--        address columns are still the main email, number and address. Every
--        text, email, reminder, receipt, booking and report goes on reading
--        them exactly as before; the others sit beside them, so a customer who
--        writes in from their other address, or calls from their office line,
--        is still recognised as themselves (the matching queries in
--        packages/core and the worker read both).
--
--        **JSON on the record, like `custom` (0076)**, and not a table of
--        their own: a customer and the ways to reach them are one thing to
--        read, one thing to write and one thing to sync to a phone that is
--        offline. A GIN index on each list is what keeps "who has this
--        number" quick.
--
--          other_emails     [{"email": "dale@work.com", "label": "Work"}]
--          other_phones     [{"phone": "+17135550100", "label": "Office"}]
--          other_addresses  [{"label": "Rental", "line1": "12 Oak St",
--                             "line2": null, "city": "Katy", "state": "TX",
--                             "postalCode": "77494", "country": "US"}]
--
--        An email is kept lowercased and a number in E.164; a label is
--        optional. Up to 20 of each.
--
--        **The main one and the others never overlap.** A trigger drops an
--        entry that repeats an earlier one or the main one, whoever writes.
--        So "make this one the main one" is a plain swap — the command moves
--        the old main one into the list and the new one out of it, and a
--        writer that only knows the main column (an import, the AI teammate
--        filling in a blank) can never leave the same number in both places.
--
--        **phone_alt folds in.** Each spare number that reads as a number
--        becomes the first other phone, labelled "Other", and phone_alt is
--        emptied. The column stays, because phones on older builds still
--        sync it; nothing writes it any more.
--
--        Search (search_text) reads the others too.
-- =============================================================================

alter table app.people
  add column other_emails jsonb not null default '[]'::jsonb,
  add column other_phones jsonb not null default '[]'::jsonb,
  add column other_addresses jsonb not null default '[]'::jsonb;
alter table app.companies
  add column other_emails jsonb not null default '[]'::jsonb,
  add column other_phones jsonb not null default '[]'::jsonb,
  add column other_addresses jsonb not null default '[]'::jsonb;

comment on column app.people.other_emails is
  'The customer''s emails besides the main one (0102): [{"email", "label"}], lowercased, never repeating each other or the main one.';
comment on column app.people.other_phones is
  'The customer''s numbers besides the main one (0102): [{"phone" (E.164), "label"}], never repeating each other or the main one.';
comment on column app.people.other_addresses is
  'The customer''s addresses besides the main one (0102): [{"label", "line1", "line2", "city", "state", "postalCode", "country"}].';
comment on column app.companies.other_emails is
  'The company''s emails besides the main one (0102): [{"email", "label"}], lowercased, never repeating each other or the main one.';
comment on column app.companies.other_phones is
  'The company''s numbers besides the main one (0102): [{"phone" (E.164), "label"}], never repeating each other or the main one.';
comment on column app.companies.other_addresses is
  'The company''s addresses besides the main one (0102): [{"label", "line1", "line2", "city", "state", "postalCode", "country"}].';

-- ---------- what a list may hold ----------
-- CASE first, because AND does not promise to test the array before jsonb_array_elements would raise on an object.
create or replace function private.valid_other_emails(p jsonb)
returns boolean language sql immutable parallel safe set search_path = '' as $$
  select case when jsonb_typeof(p) is distinct from 'array' then false else
    jsonb_array_length(p) <= 20 and not exists (
      select 1 from jsonb_array_elements(p) e
      where jsonb_typeof(e) <> 'object'
        or jsonb_typeof(e -> 'email') is distinct from 'string'
        or length(e ->> 'email') not between 3 and 254
        or (e ->> 'email') !~ '^[^@[:space:]]+@[^@[:space:]]+$'
        or (e ->> 'email') <> lower(e ->> 'email')
        or coalesce(jsonb_typeof(e -> 'label'), 'null') not in ('string', 'null')
        or length(coalesce(e ->> 'label', '')) > 40
        or exists (select 1 from jsonb_object_keys(e) k where k not in ('email', 'label')))
  end
$$;

create or replace function private.valid_other_phones(p jsonb)
returns boolean language sql immutable parallel safe set search_path = '' as $$
  select case when jsonb_typeof(p) is distinct from 'array' then false else
    jsonb_array_length(p) <= 20 and not exists (
      select 1 from jsonb_array_elements(p) e
      where jsonb_typeof(e) <> 'object'
        or jsonb_typeof(e -> 'phone') is distinct from 'string'
        or (e ->> 'phone') !~ '^\+[1-9][0-9]{6,14}$'
        or coalesce(jsonb_typeof(e -> 'label'), 'null') not in ('string', 'null')
        or length(coalesce(e ->> 'label', '')) > 40
        or exists (select 1 from jsonb_object_keys(e) k where k not in ('phone', 'label')))
  end
$$;

create or replace function private.valid_other_addresses(p jsonb)
returns boolean language sql immutable parallel safe set search_path = '' as $$
  select case when jsonb_typeof(p) is distinct from 'array' then false else
    jsonb_array_length(p) <= 20 and not exists (
      select 1 from jsonb_array_elements(p) e
      where jsonb_typeof(e) <> 'object'
        or exists (select 1 from jsonb_object_keys(e) k
                   where k not in ('label', 'line1', 'line2', 'city', 'state', 'postalCode', 'country'))
        or exists (select 1 from jsonb_each(e) kv where jsonb_typeof(kv.value) not in ('string', 'null'))
        or length(coalesce(e ->> 'label', '')) > 40
        or length(coalesce(e ->> 'line1', '')) > 200
        or length(coalesce(e ->> 'line2', '')) > 200
        or length(coalesce(e ->> 'city', '')) > 100
        or length(coalesce(e ->> 'state', '')) > 50
        or length(coalesce(e ->> 'postalCode', '')) > 20
        or coalesce(e ->> 'country', 'US') !~ '^[A-Z]{2}$'
        -- An address is somewhere: a street, a town or a ZIP at the least.
        or coalesce(btrim(e ->> 'line1'), '') || coalesce(btrim(e ->> 'city'), '')
           || coalesce(btrim(e ->> 'postalCode'), '') = '')
  end
$$;

alter table app.people
  add constraint people_other_emails_check check (private.valid_other_emails(other_emails)),
  add constraint people_other_phones_check check (private.valid_other_phones(other_phones)),
  add constraint people_other_addresses_check check (private.valid_other_addresses(other_addresses));
alter table app.companies
  add constraint companies_other_emails_check check (private.valid_other_emails(other_emails)),
  add constraint companies_other_phones_check check (private.valid_other_phones(other_phones)),
  add constraint companies_other_addresses_check check (private.valid_other_addresses(other_addresses));

-- ---------- the main one and the others never overlap ----------
-- Tidies what it understands and passes everything else through untouched, so the checks above refuse it rather
-- than it vanishing: an entry that is not an object with a string in it stays exactly as written. Emails are
-- trimmed and lowercased, labels trimmed (an empty one dropped); then an entry that is empty, repeats the main one
-- or repeats an earlier entry goes. An address repeats another when its street, second line, town, state and ZIP
-- all read the same, ignoring case.
create or replace function private.tidy_other_contacts()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_main_address text := lower(concat_ws('|', btrim(new.address_line1), btrim(new.address_line2), btrim(new.city),
    btrim(new.state), btrim(new.postal_code)));
begin
  if jsonb_typeof(new.other_emails) = 'array' then
    select coalesce(jsonb_agg(t.e order by t.n), '[]'::jsonb) into new.other_emails
    from (
      select x.n, x.e, x.k, row_number() over (partition by x.k order by x.n) as nth
      from (
        select el.n,
          case when jsonb_typeof(el.value -> 'email') = 'string' then
            case when coalesce(btrim(el.value ->> 'label'), '') = '' then el.value - 'label'
                 else el.value || jsonb_build_object('label', btrim(el.value ->> 'label')) end
            || jsonb_build_object('email', lower(btrim(el.value ->> 'email')))
          else el.value end as e,
          case when jsonb_typeof(el.value -> 'email') = 'string' then lower(btrim(el.value ->> 'email')) end as k
        from jsonb_array_elements(new.other_emails) with ordinality as el(value, n)
      ) x
    ) t
    where t.k is null
       or (t.k <> '' and t.nth = 1 and t.k is distinct from lower(btrim(new.email::text)));
  end if;

  if jsonb_typeof(new.other_phones) = 'array' then
    select coalesce(jsonb_agg(t.e order by t.n), '[]'::jsonb) into new.other_phones
    from (
      select x.n, x.e, x.k, row_number() over (partition by x.k order by x.n) as nth
      from (
        select el.n,
          case when jsonb_typeof(el.value -> 'phone') = 'string' then
            case when coalesce(btrim(el.value ->> 'label'), '') = '' then el.value - 'label'
                 else el.value || jsonb_build_object('label', btrim(el.value ->> 'label')) end
            || jsonb_build_object('phone', btrim(el.value ->> 'phone'))
          else el.value end as e,
          case when jsonb_typeof(el.value -> 'phone') = 'string' then btrim(el.value ->> 'phone') end as k
        from jsonb_array_elements(new.other_phones) with ordinality as el(value, n)
      ) x
    ) t
    where t.k is null
       or (t.k <> '' and t.nth = 1 and t.k is distinct from new.phone_e164);
  end if;

  if jsonb_typeof(new.other_addresses) = 'array' then
    select coalesce(jsonb_agg(t.e order by t.n), '[]'::jsonb) into new.other_addresses
    from (
      select x.n, x.e, x.k, row_number() over (partition by x.k order by x.n) as nth
      from (
        select el.n,
          case when jsonb_typeof(el.value) = 'object' and coalesce(btrim(el.value ->> 'label'), '') = ''
                 then el.value - 'label'
               when jsonb_typeof(el.value) = 'object'
                 then el.value || jsonb_build_object('label', btrim(el.value ->> 'label'))
               else el.value end as e,
          case when jsonb_typeof(el.value) = 'object' then
            lower(concat_ws('|', btrim(el.value ->> 'line1'), btrim(el.value ->> 'line2'), btrim(el.value ->> 'city'),
              btrim(el.value ->> 'state'), btrim(el.value ->> 'postalCode'))) end as k
        from jsonb_array_elements(new.other_addresses) with ordinality as el(value, n)
      ) x
    ) t
    where t.k is null
       or (replace(t.k, '|', '') <> '' and t.nth = 1 and t.k is distinct from v_main_address);
  end if;
  return new;
end $$;

create trigger people_tidy_other_contacts before insert or update of email, phone_e164, address_line1,
  address_line2, city, state, postal_code, other_emails, other_phones, other_addresses on app.people
  for each row execute function private.tidy_other_contacts();
create trigger companies_tidy_other_contacts before insert or update of email, phone_e164, address_line1,
  address_line2, city, state, postal_code, other_emails, other_phones, other_addresses on app.companies
  for each row execute function private.tidy_other_contacts();

-- ---------- who has this number, or this address ----------
-- Probed with `other_phones @> '[{"phone": "+1…"}]'` (and the same for emails) beside the workspace.
create index people_other_emails_idx on app.people using gin (other_emails jsonb_path_ops);
create index people_other_phones_idx on app.people using gin (other_phones jsonb_path_ops);
create index companies_other_emails_idx on app.companies using gin (other_emails jsonb_path_ops);
create index companies_other_phones_idx on app.companies using gin (other_phones jsonb_path_ops);

-- ---------- search reads them too ----------
-- The words the lists add to a record's search: every other email and number, and each other address's town and
-- street. Immutable, so a generated column may call it.
create or replace function private.other_contacts_text(p_emails jsonb, p_phones jsonb, p_addresses jsonb)
returns text language sql immutable parallel safe set search_path = '' as $$
  select concat_ws(' ',
    (select string_agg(e ->> 'email', ' ')
     from jsonb_array_elements(case when jsonb_typeof(p_emails) = 'array' then p_emails else '[]'::jsonb end) e),
    (select string_agg(e ->> 'phone', ' ')
     from jsonb_array_elements(case when jsonb_typeof(p_phones) = 'array' then p_phones else '[]'::jsonb end) e),
    (select string_agg(concat_ws(' ', e ->> 'city', e ->> 'line1'), ' ')
     from jsonb_array_elements(case when jsonb_typeof(p_addresses) = 'array' then p_addresses else '[]'::jsonb end) e))
$$;

alter table app.people alter column search_text set expression as (
  lower(coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(email::text, '') || ' '
    || coalesce(phone_e164, '') || ' ' || coalesce(city, '') || ' ' || coalesce(address_line1, '') || ' '
    || private.other_contacts_text(other_emails, other_phones, other_addresses)));
alter table app.companies alter column search_text set expression as (
  lower(coalesce(name, '') || ' ' || coalesce(email::text, '') || ' ' || coalesce(phone_e164, '') || ' '
    || coalesce(city, '') || ' ' || coalesce(address_line1, '') || ' '
    || private.other_contacts_text(other_emails, other_phones, other_addresses)));

-- ---------- phone_alt folds in ----------
-- The spare number as E.164, when it reads as one: already international, or ten US digits (with or without the
-- leading 1). Anything else is left in phone_alt, where it has always been.
create or replace function private.phone_alt_e164(p text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select case
    when x.plus and ('+' || x.digits) ~ '^\+[1-9][0-9]{6,14}$' then '+' || x.digits
    when not x.plus and x.digits ~ '^[2-9][0-9]{9}$' then '+1' || x.digits
    when not x.plus and x.digits ~ '^1[2-9][0-9]{9}$' then '+' || x.digits
  end
  from (select btrim(p) like '+%' as plus, regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as digits) x
$$;

update app.people p
set other_phones = jsonb_build_array(jsonb_build_object('phone', v.e164, 'label', 'Other')) || p.other_phones,
    phone_alt = null
from (
  select pp.id, private.phone_alt_e164(pp.phone_alt) as e164
  from app.people pp
  where pp.phone_alt is not null
) v
where p.id = v.id and v.e164 is not null;

-- ---------- function privileges ----------
revoke all on function
  private.valid_other_emails(jsonb), private.valid_other_phones(jsonb), private.valid_other_addresses(jsonb),
  private.tidy_other_contacts(), private.other_contacts_text(jsonb, jsonb, jsonb), private.phone_alt_e164(text)
  from public;
grant execute on function
  private.valid_other_emails(jsonb), private.valid_other_phones(jsonb), private.valid_other_addresses(jsonb),
  private.tidy_other_contacts(), private.other_contacts_text(jsonb, jsonb, jsonb)
  to authenticated, service_actor;
