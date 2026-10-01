-- =============================================================================
-- 0105 · What registering for texting costs, passed on to the business.
--
--        A local number's registration (10DLC) costs HandsFreeOS money at The
--        Campaign Registry and the carriers: $4.50 to register the brand,
--        $41.50 to vet it when the business texts 1,000 or more a month, $15
--        each time the campaign is reviewed, and $10 a month for the campaign
--        once it is approved. Until now HandsFreeOS paid all of it. Now the
--        business does, at cost (core's money/texting-fees). Toll-free
--        verification costs nothing and has no fees.
--
--        **Nothing goes to the carriers unpaid.** Sending a registration
--        writes what it costs here, `pending`, beside the registration, and
--        the worker holds the 10DLC steps back until it is paid: charged to
--        the card a business paid with before, or else paid on a Stripe page
--        (Checkout, in our own account), which keeps the card. Each month of
--        the campaign is charged to that card by the worker.
--
--        **Shaped like an RCS request** (0104): a person's command writes the
--        row; everything Stripe says is the worker's to write, and
--        private.guard_texting_fee_update() holds that line. A person may only
--        put an unpaid fee aside, which is what sending the registration again
--        does: the new fee carries the old one's lines.
-- =============================================================================

create type app.texting_fee_purpose as enum ('registration', 'month');
create type app.texting_fee_status as enum ('pending', 'open', 'paid', 'failed', 'cancelled', 'waived');

create table app.texting_fees (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  purpose app.texting_fee_purpose not null,
  -- pending: owed, and the worker is collecting it. open: a payment page is waiting for the business.
  -- failed: the card said no, or the page ran out; the business pays it with another card. waived: paying online
  -- isn't switched on, so it went ahead uncharged. cancelled: a newer registration carries its lines.
  status app.texting_fee_status not null default 'pending',
  -- What it is for, line by line: [{ key, name, cents }] from core's TEXTING_FEES.
  lines jsonb not null check (jsonb_typeof(lines) = 'array' and length(lines::text) <= 4000),
  amount_cents integer not null check (amount_cents > 0),
  -- A month's fee: the campaign it is for, which month since approval (0 is the month it was approved), and when
  -- that month starts.
  registration_id uuid references app.telephony_registrations (id) on delete set null,
  month_index integer check (month_index is null or month_index >= 0),
  period_start timestamptz,

  -- ---- what Stripe says: the worker's alone (private.guard_texting_fee_update) ----
  session_ref text unique check (length(session_ref) <= 255),
  session_url text check (length(session_url) <= 2000),
  session_expires_at timestamptz,
  payment_ref text check (length(payment_ref) <= 255),
  paid_cents integer check (paid_cents is null or paid_cents >= 0),
  -- The customer and card it was paid with (`cus_…`, `pm_…`): the card later fees are charged to. Ids only.
  customer_ref text check (length(customer_ref) <= 255),
  card_ref text check (length(card_ref) <= 255),
  paid_at timestamptz,
  -- Why it isn't paid, in words for the business.
  problem text not null default '' check (length(problem) <= 1000),

  requested_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint texting_fees_open_has_page
    check (status <> 'open' or (session_ref is not null and session_url is not null)),
  constraint texting_fees_paid_has_date check (status <> 'paid' or paid_at is not null),
  constraint texting_fees_month_says_which
    check ((purpose = 'month') = (month_index is not null and period_start is not null))
);

-- One registration's fee waiting at a time: sending the registration again puts the old one aside.
create unique index texting_fees_one_unsettled_registration on app.texting_fees (workspace_id)
  where purpose = 'registration' and status in ('pending', 'open', 'failed');
-- Each month of a campaign once.
create unique index texting_fees_one_per_month on app.texting_fees (registration_id, month_index)
  where purpose = 'month';
create index texting_fees_workspace_idx on app.texting_fees (workspace_id, created_at desc);

create trigger texting_fees_updated_at before update on app.texting_fees
  for each row execute function private.set_updated_at();
create trigger texting_fees_immutable before update on app.texting_fees
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'requested_by');

create or replace function private.check_texting_fee_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.registration_id is not null and not exists (
      select 1 from app.telephony_registrations r
      where r.id = new.registration_id and r.workspace_id = new.workspace_id) then
    raise exception 'A texting fee''s registration belongs to its own business'
      using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger texting_fees_check_refs before insert or update on app.texting_fees
  for each row execute function private.check_texting_fee_refs();

-- ---------- what Stripe said is ours to write ----------
-- A person puts an unpaid registration fee aside when a newer one carries it. Nothing else.
create or replace function private.guard_texting_fee_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if not (old.purpose = 'registration' and old.status in ('pending', 'open', 'failed')
          and new.status = 'cancelled') then
    raise exception 'People can only put an unpaid texting fee aside'
      using errcode = '42501', detail = 'texting_fee_transition';
  end if;
  if old.lines is distinct from new.lines
     or old.amount_cents is distinct from new.amount_cents
     or old.registration_id is distinct from new.registration_id
     or old.month_index is distinct from new.month_index
     or old.period_start is distinct from new.period_start
     or old.session_ref is distinct from new.session_ref
     or old.session_url is distinct from new.session_url
     or old.session_expires_at is distinct from new.session_expires_at
     or old.payment_ref is distinct from new.payment_ref
     or old.paid_cents is distinct from new.paid_cents
     or old.customer_ref is distinct from new.customer_ref
     or old.card_ref is distinct from new.card_ref
     or old.paid_at is distinct from new.paid_at
     or old.problem is distinct from new.problem then
    raise exception 'Only HandsFreeOS records what Stripe said about a texting fee'
      using errcode = '42501', detail = 'texting_fee_provider_fields';
  end if;
  return new;
end $$;
create trigger texting_fees_update_guard before update on app.texting_fees
  for each row execute function private.guard_texting_fee_update();

-- ---------- who may see and change it ----------
-- The people who manage the business's channels: the ones who send the registration and see what it costs.
alter table app.texting_fees enable row level security;

create policy texting_fees_select on app.texting_fees for select to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'));
create policy texting_fees_insert on app.texting_fees for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage') and requested_by = (select auth.uid())
    and purpose = 'registration' and status = 'pending' and registration_id is null and month_index is null
    and period_start is null and session_ref is null and session_url is null and payment_ref is null
    and paid_cents is null and customer_ref is null and card_ref is null and paid_at is null and problem = '');
create policy texting_fees_update on app.texting_fees for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'))
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy texting_fees_service_all on app.texting_fees for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.texting_fees from public, anon;
-- No delete for people: a fee put aside says so, and a paid one is a record of money taken.
grant select, insert, update on app.texting_fees to authenticated;
grant select, insert, update, delete on app.texting_fees to service_actor;

revoke all on function private.guard_texting_fee_update(), private.check_texting_fee_refs() from public;
grant execute on function private.guard_texting_fee_update(), private.check_texting_fee_refs()
  to authenticated, service_actor;

-- ---------- Stripe's events find their business ----------
create or replace function private.texting_fee_route(p_fee uuid)
returns table (workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select f.workspace_id, w.organization_id
  from app.texting_fees f join app.workspaces w on w.id = f.workspace_id
  where f.id = p_fee
$$;

revoke all on function private.texting_fee_route(uuid) from public;
grant execute on function private.texting_fee_route(uuid) to service_actor;

-- ---------- the campaign's month ----------
-- The worker's hourly sweep holds no business: this is what it reads to know whose campaign month has started.
-- The newest campaign of each business, approved, on an account still open, with a card the business paid a
-- texting fee with (so a business registered before 0105 is never charged for a month it never agreed to), no
-- month fee waiting on the business, and its next month started.
create or replace function private.texting_months_due(p_limit integer)
returns table (workspace_id uuid, organization_id uuid, registration_id uuid, month_index integer,
               period_start timestamptz)
language sql stable security definer set search_path = '' as $$
  with campaigns as (
    select distinct on (r.workspace_id) r.workspace_id, r.id, r.status, r.approved_at
    from app.telephony_registrations r
    where r.kind = 'a2p_campaign'
    order by r.workspace_id, r.created_at desc
  ), next as (
    select c.workspace_id, c.id, c.approved_at,
      coalesce((select max(f.month_index) + 1 from app.texting_fees f
                where f.registration_id = c.id and f.purpose = 'month'), 0) as month_index
    from campaigns c
    where c.status = 'approved' and c.approved_at is not null
      and exists (select 1 from app.telephony_accounts a
                  where a.workspace_id = c.workspace_id and a.status <> 'closed')
      and exists (select 1 from app.texting_fees f
                  where f.workspace_id = c.workspace_id and f.status = 'paid' and f.card_ref is not null)
      and not exists (select 1 from app.texting_fees f
                      where f.workspace_id = c.workspace_id and f.purpose = 'month'
                        and f.status in ('pending', 'open', 'failed'))
  )
  select n.workspace_id, w.organization_id, n.id, n.month_index,
    n.approved_at + make_interval(months => n.month_index)
  from next n join app.workspaces w on w.id = n.workspace_id
  where n.approved_at + make_interval(months => n.month_index) <= now()
  order by 5
  limit greatest(1, least(p_limit, 500))
$$;

revoke all on function private.texting_months_due(integer) from public;
grant execute on function private.texting_months_due(integer) to service_actor;

comment on table app.texting_fees is
  'What registering a local number for texting costs a business, passed on at cost (0105): the registration''s '
  'one-time fees before it goes to the carriers, and the campaign''s month after approval.';
