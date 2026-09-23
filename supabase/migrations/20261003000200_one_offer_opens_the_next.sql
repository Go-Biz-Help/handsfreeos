-- =============================================================================
-- 0092 · One offer opens the next.
--
--        The growth plan is a sequence, not a menu: twenty-five free seats,
--        then a hundred at $497 once, and partway through those the monthly
--        plan goes on sale beside them. This makes the sequence run itself.
--
--        **The switch is taken where the seat is taken.** An offer names the
--        one it follows and how many of that one's seats must be out before it
--        opens — or, with no count, "when that one is full". The check runs in
--        the same transaction as the grant that crossed the line, after the
--        cap's own lock (0091), so the twenty-fifth approval and the $497 offer
--        opening are one event. There is no job to miss it and no second
--        approval that can open it twice.
--
--        **One way only.** An offer is only ever opened from `draft`. A seat
--        that frees up afterwards does not close the next offer again, so the
--        website never flickers back to a stage it has left; and an offer
--        somebody closed by hand is `closed`, not `draft`, so the chain never
--        reopens it. Opening or closing anything by hand still works exactly
--        as before — the chain only does what a person would have done at the
--        moment the line was crossed.
--
--        **The monthly plan is a row here, and it is not a founding offer.**
--        It has no seats, takes no applications and is never granted: it is
--        in this table only so that the chain can open it and /admin can open
--        or close it like everything else. `billing = 'monthly'` is what says
--        so, and the seat guard and the application function both refuse it
--        rather than trusting every caller to know. Its `seat_cap` is the
--        largest the column allows and means nothing.
--
--        **A later offer supersedes an earlier one; the monthly plan never
--        does.** When the $497 offer opens, the free one stops being
--        advertised — a free seat that frees up afterwards is for somebody on
--        the waitlist, handed out from /admin, not re-offered to the world
--        beside a paid one. The monthly plan opens *beside* the $497 seats,
--        so it supersedes nothing. The view says which is which, so the
--        website does not have to know the rule.
-- =============================================================================

-- ---------- what an offer follows ----------
alter table platform.founding_offers
  /** `once` is a founding seat, free or paid once. `monthly` is the plan: no seats, no applications. */
  add column billing text not null default 'once' check (billing in ('once', 'monthly')),
  /** The offer this one opens after. Null: it opens only when somebody opens it. */
  add column opens_after_offer_id text references platform.founding_offers (id),
  /** How many of that offer's seats must be out first. Null: when that offer is full, whatever its cap is. */
  add column opens_after_count integer check (opens_after_count is null or opens_after_count > 0),
  /** The first time it opened, by hand or by the chain. What "the free seats went in eleven days" is read from. */
  add column opened_at timestamptz,
  add constraint founding_offers_not_after_itself
    check (opens_after_offer_id is null or opens_after_offer_id <> id),
  add constraint founding_offers_count_needs_an_offer
    check (opens_after_count is null or opens_after_offer_id is not null);

create index founding_offers_opens_after_idx on platform.founding_offers (opens_after_offer_id)
  where opens_after_offer_id is not null;

-- Offers already open were opened when they were last changed: `updated_at` is when the founding partner offer
-- was switched on, and nothing has touched it since.
update platform.founding_offers set opened_at = updated_at where status <> 'draft' and opened_at is null;

-- ---------- the chain ----------
/**
 * Open whatever follows `p_offer`, if its line has been crossed.
 *
 * Only `draft` offers are opened, which is the whole of "one way" and of "never reopen what a person closed".
 * It is safe to call as often as anything likes: an offer that is already open, or whose line has not been
 * crossed, is left exactly as it was.
 *
 * Opening an offer is itself an update to this table, which runs this again for *that* offer's successors —
 * so a chain can advance more than one step if the seats are already there. It stops on its own, because an
 * offer is opened at most once.
 */
create or replace function private.founding_open_successors(p_offer text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_held integer := private.founding_seats_held(p_offer);
  v_cap integer;
begin
  select o.seat_cap into v_cap from platform.founding_offers o where o.id = p_offer;
  if v_cap is null then
    return;
  end if;
  update platform.founding_offers n
     set status = 'open'
   where n.opens_after_offer_id = p_offer
     and n.status = 'draft'
     and v_held >= coalesce(n.opens_after_count, v_cap);
end $$;

-- A seat was taken: the line may have been crossed. After the row is written, so the new seat is counted, and
-- inside the same transaction as the cap's lock, so two approvals for the last seat cannot both see it.
create or replace function private.founding_grant_opens_next()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('reserved', 'active') then
    perform private.founding_open_successors(new.offer_id);
  end if;
  return null;
end $$;

create trigger founding_grants_open_next after insert or update of status on platform.founding_grants
  for each row execute function private.founding_grant_opens_next();

-- The offers themselves can cross a line too: a cap lowered to exactly the seats out makes an offer full, an
-- offer reopened with seats already out may be past its successor's count, and a chain configured onto an offer
-- that is already full should not wait for a seat that will never come.
create or replace function private.founding_offer_opens_next()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.seat_cap is distinct from old.seat_cap or new.status is distinct from old.status then
    perform private.founding_open_successors(new.id);
  end if;
  if new.opens_after_offer_id is not null
     and (new.opens_after_offer_id is distinct from old.opens_after_offer_id
          or new.opens_after_count is distinct from old.opens_after_count) then
    perform private.founding_open_successors(new.opens_after_offer_id);
  end if;
  return null;
end $$;

-- Inserts too: `old` is null then, so a new offer counts as changed in every way, and one chained onto an offer
-- that is already full opens as it arrives.
create trigger founding_offers_open_next after insert or update on platform.founding_offers
  for each row execute function private.founding_offer_opens_next();

-- ---------- the guards learn about the monthly plan ----------
/**
 * 0091's cap, plus one refusal: the monthly plan has no seats to take. Everything else is unchanged — the
 * lock on the offer's row, the count, and no system-actor bypass.
 */
create or replace function private.guard_founding_seat()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_cap integer;
  v_status platform.founding_offer_status;
  v_billing text;
  v_held integer;
  v_was_held boolean := tg_op = 'UPDATE' and old.status in ('reserved', 'active');
begin
  if new.status not in ('reserved', 'active') or v_was_held then
    return new;
  end if;

  select o.seat_cap, o.status, o.billing into v_cap, v_status, v_billing
  from platform.founding_offers o where o.id = new.offer_id for update;

  if v_cap is null then
    raise exception 'There is no offer called %', new.offer_id
      using errcode = '23503', detail = 'founding_offer_missing';
  end if;
  if v_billing <> 'once' then
    raise exception 'The % plan is paid month to month; there is no seat in it to hold', new.offer_id
      using errcode = '23514', detail = 'founding_offer_not_seats';
  end if;
  if v_status <> 'open' then
    raise exception 'The % offer is not taking anybody new', new.offer_id
      using errcode = '23514', detail = 'founding_offer_closed';
  end if;

  v_held := private.founding_seats_held(new.offer_id);
  if v_held >= v_cap then
    raise exception 'Every seat in % is taken (% of %)', new.offer_id, v_held, v_cap
      using errcode = '23514', detail = 'founding_offer_full';
  end if;
  return new;
end $$;

/**
 * 0091's rule that a cap never goes below the seats already out, plus the first time an offer opens being
 * written down.
 */
create or replace function private.guard_founding_offer()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_held integer;
begin
  if new.seat_cap < old.seat_cap then
    v_held := private.founding_seats_held(new.id);
    if new.seat_cap < v_held then
      raise exception 'There are already % seats out in %; the cap cannot go below that', v_held, new.id
        using errcode = '23514', detail = 'founding_cap_below_held';
    end if;
  end if;
  if new.status = 'open' and old.status <> 'open' and new.opened_at is null then
    new.opened_at := now();
  end if;
  return new;
end $$;

/**
 * 0091's application, refusing the monthly plan: nobody applies for it, they sign up for it. Answered exactly
 * as an offer that does not exist is, because to somebody filling in a form that is what it is.
 */
create or replace function private.founding_apply(
  p_offer text,
  p_business_name text,
  p_contact_name text,
  p_email text,
  p_phone text,
  p_website text,
  p_industry text,
  p_team_size text,
  p_note text,
  p_source text
)
returns table (application_id uuid, status text, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_status platform.founding_application_status;
  v_open boolean;
  v_room boolean;
  v_id uuid;
begin
  select o.status = 'open', private.founding_seats_held(o.id) < o.seat_cap
    into v_open, v_room
  from platform.founding_offers o
  where o.id = p_offer and o.status <> 'draft' and o.billing = 'once';

  if v_open is null then
    raise exception 'There is no offer called %', p_offer
      using errcode = '23503', detail = 'founding_offer_missing';
  end if;

  v_status := case when v_open and v_room then 'pending' else 'waitlisted' end;

  insert into platform.founding_applications
    (offer_id, business_name, contact_name, email, phone, website, industry, team_size, note, source, status)
  values
    (p_offer, p_business_name, p_contact_name, p_email::extensions.citext,
     nullif(p_phone, ''), nullif(p_website, ''), nullif(p_industry, ''), nullif(p_team_size, ''),
     coalesce(p_note, ''), coalesce(p_source, ''), v_status)
  on conflict do nothing
  returning id into v_id;

  if v_id is not null then
    return query select v_id, v_status::text, true;
    return;
  end if;

  -- citext's own equality (case-insensitive, and the unique index's), named because search_path is empty.
  return query
    select a.id, a.status::text, false
    from platform.founding_applications a
    where a.offer_id = p_offer and a.email operator(extensions.=) p_email::extensions.citext
      and a.status in ('pending', 'approved', 'waitlisted')
    limit 1;
end $$;

-- ---------- what the website reads ----------
/**
 * Every offer that is not a draft, with three more facts at the end so the website never has to know the
 * rules: how it is billed, whether its numbers should be printed, and whether a later founding offer has
 * already opened after it. Still no applicant and no business anywhere in it.
 *
 * `show_counter` moved from the filter into a column: the monthly plan has to be visible — so the site knows
 * whether it is on sale — without a counter that would read "99,999 of 100,000 left".
 */
create or replace view platform.founding_counts as
  select o.id, o.name, o.blurb, o.status, o.price_cents, o.seat_cap,
         private.founding_seats_held(o.id) as claimed,
         greatest(o.seat_cap - private.founding_seats_held(o.id), 0) as remaining,
         o.sort,
         o.billing,
         o.show_counter,
         exists (select 1 from platform.founding_offers n
                  where n.opens_after_offer_id = o.id and n.status <> 'draft' and n.billing = 'once')
           as superseded
  from platform.founding_offers o
  where o.status <> 'draft';

-- ---------- the sequence itself ----------
-- The $497 seats open the moment the twenty-five free ones are all out, whatever the free cap is raised to.
update platform.founding_offers
   set opens_after_offer_id = 'founding_partner', opens_after_count = null
 where id = 'founding_lifetime';

-- The monthly plan goes on sale beside them once twenty-five of the $497 seats are out.
insert into platform.founding_offers
  (id, name, seat_cap, price_cents, status, billing, show_counter, starting_credit_cents, sort, blurb,
   opens_after_offer_id, opens_after_count)
values
  ('monthly', 'HandsFreeOS', 100000, 9700, 'draft', 'monthly', false, 0, 3,
   'Everything HandsFreeOS does, for one business, month to month. Texts, calls and AI are billed for what you use.',
   'founding_lifetime', 25);
