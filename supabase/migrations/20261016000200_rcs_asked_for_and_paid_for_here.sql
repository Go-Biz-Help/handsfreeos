-- =============================================================================
-- 0104 · RCS for a client business: asked for and paid for here, made by us.
--
--        **A client can't make their own RCS sender.** Twilio makes them
--        only in its console, and a client's Twilio account is a subaccount
--        under HandsFreeOS's — nobody outside HandsFreeOS can open it. So the
--        RCS card asks for what the sender needs (the name customers see, a
--        description, a colour, the links the carriers check), takes the
--        payment, and opens a support ticket; HandsFreeOS makes the sender in
--        the console and connects it (0103).
--
--        **What it costs is passed on, and said so** (core's money/rcs-fees):
--        the carriers' $500 onboarding and Aegis's $200 yearly vetting at
--        cost, plus $100 setup — $800 for the first year — then $215 a year
--        (the vetting again, and $15 upkeep). Paid at Stripe Checkout in our
--        own account, with the card kept for the yearly renewal, which the
--        worker charges itself.
--
--        **Shaped like a founding checkout** (0093): a person asks, writing a
--        `pending` request in their own name and nothing else; a job makes the
--        Stripe page (`open`); Stripe's signed event says the money is in
--        (`paid`). The money is only ever believed from that event.
--
--        A person may give up on a request before paying (`cancelled`), and
--        stop a paid one renewing (`stopped_at`). A renewal the card refuses
--        is never tried again on its own: the business pays it on a page of
--        its own, with another card. Everything Stripe says is the worker's
--        to write, and private.guard_rcs_request_update() holds that line
--        whoever runs the command.
-- =============================================================================

create type app.rcs_request_status as enum ('pending', 'open', 'paid', 'expired', 'failed', 'cancelled');

create table app.rcs_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  status app.rcs_request_status not null default 'pending',
  -- What the sender needs, as the business typed it (core's schemas/rcs-request RcsBrand).
  brand jsonb not null check (jsonb_typeof(brand) = 'object' and length(brand::text) <= 8000),
  -- The prices it was sold at. A price changed later moves new requests only.
  first_year_cents integer not null check (first_year_cents > 0),
  yearly_cents integer not null check (yearly_cents > 0),

  -- ---- what Stripe says: the worker's alone (private.guard_rcs_request_update) ----
  -- Stripe's `cs_…` and its address, once the worker has made the page.
  session_ref text unique check (length(session_ref) <= 255),
  session_url text check (length(session_url) <= 2000),
  session_expires_at timestamptz,
  -- Stripe's `pi_…` for the first year: what a refund, if staff ever make one, is made against.
  payment_ref text check (length(payment_ref) <= 255),
  paid_cents integer check (paid_cents is null or paid_cents >= 0),
  -- Who pays, and the card the renewal is charged to (`cus_…`, `pm_…`). Ids only; Stripe holds the card.
  customer_ref text check (length(customer_ref) <= 255),
  card_ref text check (length(card_ref) <= 255),
  paid_at timestamptz,
  -- The end of the year paid for. The renewal is charged then, and moves it on a year.
  paid_through timestamptz,
  renewal_count integer not null default 0 check (renewal_count >= 0),
  -- The last renewal the card refused, until staff sort it out. Nothing is charged again while it is set.
  renewal_problem text check (renewal_problem is null or length(renewal_problem) <= 1000),
  renewal_failed_at timestamptz,
  -- After a refused renewal, a page the business pays it on with another card: Stripe's `cs_…`, its address, and
  -- the `paid_through` it renews. The card it is paid with becomes the one charged next year.
  renewal_session_ref text unique check (length(renewal_session_ref) <= 255),
  renewal_session_url text check (length(renewal_session_url) <= 2000),
  renewal_session_for timestamptz,
  -- The support ticket the payment opened. No foreign key: the desk is HandsFreeOS's (platform), the request
  -- the business's, and a business being deleted must not reach into the desk.
  ticket_id uuid,
  ticket_number bigint,
  -- Why a page closed without being paid, in words for the business.
  problem text not null default '' check (length(problem) <= 1000),

  -- ---- a person's ----
  requested_by uuid references app.users (id) on delete set null,
  -- Somebody stopped it renewing. RCS stays paid until `paid_through`, and nothing more is charged.
  stopped_at timestamptz,
  stopped_by uuid references app.users (id) on delete set null,

  created_at timestamptz not null default now(),
  opened_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint rcs_requests_open_has_page
    check (status <> 'open' or (session_ref is not null and session_url is not null)),
  constraint rcs_requests_paid_has_dates
    check (status <> 'paid' or (paid_at is not null and paid_through is not null))
);

-- One request a business is living with: a second press of Pay picks the first one back up. A paid one that
-- was stopped no longer counts, so the business can ask again once it wants RCS back.
create unique index rcs_requests_one_live_per_workspace on app.rcs_requests (workspace_id)
  where status in ('pending', 'open') or (status = 'paid' and stopped_at is null);
create index rcs_requests_workspace_idx on app.rcs_requests (workspace_id, created_at desc);
-- What the renewal sweep reads: paid, still renewing, and not waiting on staff after a refused card.
create index rcs_requests_renewal_idx on app.rcs_requests (paid_through)
  where status = 'paid' and stopped_at is null and renewal_failed_at is null;

create trigger rcs_requests_updated_at before update on app.rcs_requests
  for each row execute function private.set_updated_at();
create trigger rcs_requests_immutable before update on app.rcs_requests
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'requested_by');

-- ---------- what Stripe said is ours to write ----------
-- A person gives up on a request before paying, or stops a paid one renewing. Nothing else.
create or replace function private.guard_rcs_request_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_giving_up boolean := old.status in ('pending', 'open') and new.status = 'cancelled';
  v_stopping boolean := old.status = 'paid' and new.status = 'paid' and old.stopped_at is null
    and new.stopped_at is not null;
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if not (v_giving_up or v_stopping) then
    raise exception 'People can only give up on an RCS request before paying, or stop it renewing'
      using errcode = '42501', detail = 'rcs_request_transition';
  end if;
  if old.brand is distinct from new.brand
     or old.first_year_cents is distinct from new.first_year_cents
     or old.yearly_cents is distinct from new.yearly_cents
     or old.session_ref is distinct from new.session_ref
     or old.session_url is distinct from new.session_url
     or old.session_expires_at is distinct from new.session_expires_at
     or old.payment_ref is distinct from new.payment_ref
     or old.paid_cents is distinct from new.paid_cents
     or old.customer_ref is distinct from new.customer_ref
     or old.card_ref is distinct from new.card_ref
     or old.paid_at is distinct from new.paid_at
     or old.paid_through is distinct from new.paid_through
     or old.renewal_count is distinct from new.renewal_count
     or old.renewal_problem is distinct from new.renewal_problem
     or old.renewal_failed_at is distinct from new.renewal_failed_at
     or old.renewal_session_ref is distinct from new.renewal_session_ref
     or old.renewal_session_url is distinct from new.renewal_session_url
     or old.renewal_session_for is distinct from new.renewal_session_for
     or old.ticket_id is distinct from new.ticket_id
     or old.ticket_number is distinct from new.ticket_number
     or old.problem is distinct from new.problem
     or old.opened_at is distinct from new.opened_at
     or (old.stopped_at is distinct from new.stopped_at and not v_stopping)
     or (old.stopped_by is distinct from new.stopped_by and not v_stopping) then
    raise exception 'Only HandsFreeOS records what Stripe said about an RCS request'
      using errcode = '42501', detail = 'rcs_request_provider_fields';
  end if;
  return new;
end $$;
create trigger rcs_requests_update_guard before update on app.rcs_requests
  for each row execute function private.guard_rcs_request_update();

-- ---------- who may see and change it ----------
-- The people who manage the business's channels: the same people who connect a sender and buy numbers, and
-- the only ones who see what RCS costs and pay for it.
alter table app.rcs_requests enable row level security;

create policy rcs_requests_select on app.rcs_requests for select to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'));
create policy rcs_requests_insert on app.rcs_requests for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage') and requested_by = (select auth.uid())
    and status = 'pending' and session_ref is null and session_url is null and payment_ref is null
    and paid_cents is null and customer_ref is null and card_ref is null and paid_at is null
    and paid_through is null and renewal_count = 0 and renewal_problem is null and renewal_failed_at is null
    and renewal_session_ref is null and renewal_session_url is null and renewal_session_for is null
    and ticket_id is null and ticket_number is null and stopped_at is null and stopped_by is null);
create policy rcs_requests_update on app.rcs_requests for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'))
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy rcs_requests_service_all on app.rcs_requests for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.rcs_requests from public, anon;
-- No delete for people: a request given up on says so, and a paid one is a record of money taken.
grant select, insert, update on app.rcs_requests to authenticated;
grant select, insert, update, delete on app.rcs_requests to service_actor;

revoke all on function private.guard_rcs_request_update() from public;
grant execute on function private.guard_rcs_request_update() to authenticated, service_actor;

-- ---------- Stripe's events find their business ----------
-- The webhook holds no business while it reads the event, the way a founding checkout's does (0093).
create or replace function private.rcs_request_route(p_request uuid)
returns table (workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select r.workspace_id, w.organization_id
  from app.rcs_requests r join app.workspaces w on w.id = r.workspace_id
  where r.id = p_request
$$;

revoke all on function private.rcs_request_route(uuid) from public;
grant execute on function private.rcs_request_route(uuid) to service_actor;

-- ---------- the yearly renewal ----------
-- The worker's hourly sweep holds no business either: this is what it reads to know whose year is up. Paid,
-- still renewing, not waiting on support after a refused card, and due.
create or replace function private.rcs_renewals_due(p_limit integer)
returns table (rcs_request_id uuid, workspace_id uuid, organization_id uuid, paid_through timestamptz)
language sql stable security definer set search_path = '' as $$
  select r.id, r.workspace_id, w.organization_id, r.paid_through
  from app.rcs_requests r join app.workspaces w on w.id = r.workspace_id
  where r.status = 'paid' and r.stopped_at is null and r.renewal_failed_at is null
    and r.paid_through <= now()
  order by r.paid_through
  limit greatest(1, least(p_limit, 500))
$$;

revoke all on function private.rcs_renewals_due(integer) from public;
grant execute on function private.rcs_renewals_due(integer) to service_actor;

comment on table app.rcs_requests is
  'A business asking HandsFreeOS for an RCS sender, and paying for it (0104). The sender itself is app.rcs_senders, '
  'connected once HandsFreeOS has made it at Twilio.';
