-- =============================================================================
-- 0045 · The two documents money runs on: app.estimates and app.invoices, each
--        with its own lines. They are separate tables on purpose — they
--        diverge exactly where money is at stake (numbering, what freezes on
--        send, the state machine, what the customer's page does) — and share
--        their shape: a public reference and link version for /e/<token> and
--        /i/<token>, a number taken from app.document_counters when the
--        document is sent, the customer, the lead, the assignee, a totals
--        block with the tax rate snapshotted onto it, sent and viewed stamps,
--        and a void. Estimates add the acceptance block and deposit terms;
--        invoices add where they came from, what they are for, the due date,
--        what has been paid and refunded, and the account they are paid into.
--        A guard freezes an issued document, keeps every customer-facing stamp
--        the worker's, and lets the database's clock write every *_at.
--        Grants, the foreign-key indexes and the rule that lets a member see
--        the jobs they are on are in 0050 (20260920000700_money_grants.sql).
-- =============================================================================

-- draft: being written. sent: issued, numbered and frozen. accepted / declined: the customer answered (online
-- or recorded by staff). expired: it stayed good until expires_on and nobody answered. void: withdrawn; its
-- number is kept and never reused.
create type app.estimate_status as enum ('draft', 'sent', 'accepted', 'declined', 'expired', 'void');
-- draft, sent, partly_paid, paid, overdue (past due_on with money still owed), void. A bank transfer on its way
-- is a payment in 'processing' (0047), not an invoice status: it leaves the invoice 'sent', never 'overdue'.
create type app.invoice_status as enum ('draft', 'sent', 'partly_paid', 'paid', 'overdue', 'void');
-- What an invoice is for. A deposit is an invoice like any other, marked as one and linked to the estimate or
-- the booking it holds; the balance is the invoice that follows it.
create type app.invoice_purpose as enum ('standard', 'deposit', 'balance', 'setup_fee', 'subscription', 'quick');
-- Where it came from, for reporting and for the timeline.
create type app.money_origin as enum ('staff', 'estimate', 'booking', 'subscription', 'workflow', 'assistant');

-- ---------- numbering: one counter per business and kind ----------
-- Sending locks this row and takes the next number inside the same transaction, so businesses read their
-- invoice numbers aloud and accountants find them sequential. The customer's link uses public_ref instead, so
-- a number never makes a document guessable.
create table app.document_counters (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  kind text not null check (kind in ('estimate', 'invoice')),
  next_number bigint not null default 1 check (next_number between 1 and 1000000000),
  prefix text not null default '' check (length(prefix) <= 12 and prefix ~ '^[A-Za-z0-9-]*$'),
  pad integer not null default 4 check (pad between 0 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, kind)
);
create trigger document_counters_updated_at before update on app.document_counters for each row
  execute function private.set_updated_at();

-- ---------- estimates ----------
create table app.estimates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The customer's link is /e/<public_ref><code>: 8 random characters, not secret, plus an HMAC the worker
  -- signs over link_version. Raising the version retires every link already sent.
  public_ref text not null default private.new_public_ref() check (public_ref ~ '^[0-9A-Za-z]{8}$'),
  link_version integer not null default 1 check (link_version between 1 and 1000000),
  -- Taken from the counter when it is sent, and kept for life, void or not.
  number text check (number is null or length(btrim(number)) between 1 and 40),
  status app.estimate_status not null default 'draft',
  person_id uuid not null references app.people (id),
  lead_id uuid references app.leads (id) on delete set null,
  assignee_user_id uuid references app.users (id) on delete set null,
  title text check (title is null or length(btrim(title)) between 1 and 200),
  notes text check (notes is null or length(notes) <= 5000),
  -- The totals block, worked out by core and frozen once the document is issued. discount_cents is what came
  -- off in total; discount_percent_bp records it when it was asked for as a percentage ("10% off").
  subtotal_cents bigint not null default 0 check (subtotal_cents between 0 and 100000000000),
  discount_cents bigint not null default 0 check (discount_cents between 0 and 100000000000),
  discount_percent_bp integer check (discount_percent_bp is null or discount_percent_bp between 0 and 10000),
  taxable_base_cents bigint not null default 0 check (taxable_base_cents between 0 and 100000000000),
  tax_cents bigint not null default 0 check (tax_cents between 0 and 100000000000),
  total_cents bigint not null default 0 check (total_cents between 0 and 100000000000),
  -- One rate per business, snapshotted here with the name it is shown under ("Sales tax").
  tax_rate_bp integer not null default 0 check (tax_rate_bp between 0 and 10000),
  tax_label text check (tax_label is null or length(btrim(tax_label)) between 1 and 60),
  currency char(3) not null default 'USD' check (currency = 'USD'),
  -- What the customer is asked for up front if they accept: one of the two, never both.
  deposit_percent_bp integer check (deposit_percent_bp is null or deposit_percent_bp between 0 and 10000),
  deposit_cents bigint check (deposit_cents is null or deposit_cents between 0 and 100000000000),
  expires_on date,
  sent_at timestamptz,
  -- What the customer did, and when: the worker's alone.
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  -- The acceptance: an Accept button and a typed name ('link'), or a person recording a yes given on the phone
  -- ('staff', named in accepted_by). Any non-empty name is taken; the wording shown and a hash of exactly what
  -- was accepted are kept beside it.
  accepted_at timestamptz,
  accepted_via text check (accepted_via is null or accepted_via in ('link', 'staff')),
  accepted_by uuid references app.users (id) on delete set null,
  accepted_name text check (accepted_name is null or length(btrim(accepted_name)) between 1 and 120),
  accepted_wording text check (accepted_wording is null or length(accepted_wording) <= 1000),
  accepted_hash text check (accepted_hash is null or length(accepted_hash) between 16 and 128),
  declined_at timestamptz,
  declined_reason text check (declined_reason is null or length(declined_reason) <= 1000),
  voided_at timestamptz,
  voided_by uuid references app.users (id) on delete set null,
  void_reason text check (void_reason is null or length(void_reason) <= 500),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Numbering happens on send: a draft has neither, an issued document has both.
  check ((number is null) = (sent_at is null)),
  -- Each state carries its own evidence, and only its own.
  check ((status = 'accepted') = (accepted_at is not null)),
  check ((accepted_at is null) = (accepted_via is null)),
  check (accepted_by is null or accepted_via is not distinct from 'staff'),
  check (accepted_at is not null or accepted_name is null),
  check ((status = 'declined') = (declined_at is not null)),
  check ((status = 'void') = (voided_at is not null)),
  check (voided_at is not null or (voided_by is null and void_reason is null)),
  -- A deposit is asked for as a share of the total or as an amount, never both.
  check (deposit_percent_bp is null or deposit_cents is null)
);
create unique index estimates_public_ref_key on app.estimates (public_ref);
create unique index estimates_number_unique on app.estimates (workspace_id, number) where number is not null;
-- The Estimates list, newest first.
create index estimates_list_idx on app.estimates (workspace_id, status, created_at desc, id desc);
-- The Money card on a lead and the Money tab on a customer.
create index estimates_lead_idx on app.estimates (lead_id) where lead_id is not null;
create index estimates_person_idx on app.estimates (person_id, created_at desc);
-- The job that expires estimates nobody answered.
create index estimates_expiry_idx on app.estimates (workspace_id, expires_on) where status = 'sent';
create trigger estimates_updated_at before update on app.estimates for each row execute function private.set_updated_at();
create trigger estimates_immutable before update on app.estimates for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'public_ref', 'person_id', 'created_by');

-- ---------- invoices ----------
create table app.invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  public_ref text not null default private.new_public_ref() check (public_ref ~ '^[0-9A-Za-z]{8}$'),
  link_version integer not null check (link_version between 1 and 1000000) default 1,
  number text check (number is null or length(btrim(number)) between 1 and 40),
  status app.invoice_status not null default 'draft',
  person_id uuid not null references app.people (id),
  lead_id uuid references app.leads (id) on delete set null,
  assignee_user_id uuid references app.users (id) on delete set null,
  title text check (title is null or length(btrim(title)) between 1 and 200),
  notes text check (notes is null or length(notes) <= 5000),
  -- The estimate this was made from, the booking it is for, and the plan cycle that raised it. The last two
  -- foreign keys are added where those tables arrive (0046 and 0048).
  estimate_id uuid references app.estimates (id) on delete set null,
  attendee_id uuid references app.appointment_attendees (id) on delete set null,
  subscription_id uuid,
  purpose app.invoice_purpose not null default 'standard',
  origin app.money_origin not null default 'staff',
  -- The account the customer pays into: one business can have several connected at once.
  connection_id uuid,
  subtotal_cents bigint not null default 0 check (subtotal_cents between 0 and 100000000000),
  discount_cents bigint not null default 0 check (discount_cents between 0 and 100000000000),
  discount_percent_bp integer check (discount_percent_bp is null or discount_percent_bp between 0 and 10000),
  taxable_base_cents bigint not null default 0 check (taxable_base_cents between 0 and 100000000000),
  tax_cents bigint not null default 0 check (tax_cents between 0 and 100000000000),
  total_cents bigint not null default 0 check (total_cents between 0 and 100000000000),
  tax_rate_bp integer not null default 0 check (tax_rate_bp between 0 and 10000),
  tax_label text check (tax_label is null or length(btrim(tax_label)) between 1 and 60),
  currency char(3) not null default 'USD' check (currency = 'USD'),
  -- What the customer owes, and by when. terms is the wording shown ("Net 15").
  due_on date,
  terms text check (terms is null or length(terms) <= 2000),
  -- Rolled up from the payments and refunds that succeeded (0047), never written by hand.
  amount_paid_cents bigint not null default 0 check (amount_paid_cents between 0 and 100000000000),
  amount_refunded_cents bigint not null default 0 check (amount_refunded_cents between 0 and 100000000000),
  balance_cents bigint generated always as (total_cents - amount_paid_cents + amount_refunded_cents) stored,
  sent_at timestamptz,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  paid_at timestamptz,
  -- Which reminders have gone out, before and after the due date: the worker's.
  reminder_state jsonb not null default '{}'::jsonb
    check (jsonb_typeof(reminder_state) = 'object' and pg_column_size(reminder_state) <= 16384),
  voided_at timestamptz,
  voided_by uuid references app.users (id) on delete set null,
  void_reason text check (void_reason is null or length(void_reason) <= 500),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((number is null) = (sent_at is null)),
  -- Paid is what the roll-up in 0047 says it is; nobody reaches it by hand.
  check (status <> 'paid' or paid_at is not null),
  check ((status = 'void') = (voided_at is not null)),
  check (voided_at is not null or (voided_by is null and void_reason is null))
);
create unique index invoices_public_ref_key on app.invoices (public_ref);
create unique index invoices_number_unique on app.invoices (workspace_id, number) where number is not null;
create index invoices_list_idx on app.invoices (workspace_id, status, created_at desc, id desc);
create index invoices_lead_idx on app.invoices (lead_id) where lead_id is not null;
create index invoices_person_idx on app.invoices (person_id, created_at desc);
-- The overdue detector and the reminder job: what is owed, and when it was due.
create index invoices_due_idx on app.invoices (workspace_id, due_on) where status in ('sent', 'partly_paid', 'overdue');
create trigger invoices_updated_at before update on app.invoices for each row execute function private.set_updated_at();
create trigger invoices_immutable before update on app.invoices for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'public_ref', 'person_id', 'created_by');

-- ---------- lines ----------
-- Every line keeps what the product said at the moment it was added: renaming or repricing a product never
-- changes a document that has gone out. amount_cents is quantity x unit_price_cents, worked out by core;
-- discount_cents is this line's share of the document discount, allocated pro rata before tax.
create table app.estimate_lines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  estimate_id uuid not null references app.estimates (id) on delete cascade,
  position integer not null default 0 check (position between 0 and 999),
  product_id uuid references app.products (id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 200),
  description text check (description is null or length(description) <= 2000),
  quantity numeric(12, 3) not null default 1 check (quantity > 0 and quantity <= 1000000),
  unit_label text not null default 'each' check (length(btrim(unit_label)) between 1 and 40),
  unit_price_cents bigint not null default 0 check (unit_price_cents between 0 and 100000000000),
  taxable boolean not null default true,
  discount_cents bigint not null default 0 check (discount_cents between 0 and 100000000000),
  amount_cents bigint not null default 0 check (amount_cents between 0 and 100000000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index estimate_lines_document_idx on app.estimate_lines (estimate_id, position, id);
create trigger estimate_lines_updated_at before update on app.estimate_lines for each row
  execute function private.set_updated_at();
create trigger estimate_lines_immutable before update on app.estimate_lines for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'estimate_id');

create table app.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  invoice_id uuid not null references app.invoices (id) on delete cascade,
  position integer not null default 0 check (position between 0 and 999),
  product_id uuid references app.products (id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 200),
  description text check (description is null or length(description) <= 2000),
  quantity numeric(12, 3) not null default 1 check (quantity > 0 and quantity <= 1000000),
  unit_label text not null default 'each' check (length(btrim(unit_label)) between 1 and 40),
  unit_price_cents bigint not null default 0 check (unit_price_cents between 0 and 100000000000),
  taxable boolean not null default true,
  discount_cents bigint not null default 0 check (discount_cents between 0 and 100000000000),
  amount_cents bigint not null default 0 check (amount_cents between 0 and 100000000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index invoice_lines_document_idx on app.invoice_lines (invoice_id, position, id);
create trigger invoice_lines_updated_at before update on app.invoice_lines for each row
  execute function private.set_updated_at();
create trigger invoice_lines_immutable before update on app.invoice_lines for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'invoice_id');

-- ---------- what freezes, and what is the worker's ----------
-- The columns an issued document keeps for life: change one and the answer is to void it and reissue.
create or replace function private.money_document_frozen_changed(p_old jsonb, p_new jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select exists (
    select 1 from unnest(array['number', 'tax_rate_bp', 'tax_label', 'currency', 'subtotal_cents',
      'discount_cents', 'discount_percent_bp', 'taxable_base_cents', 'tax_cents', 'total_cents']) as k
    where p_old -> k is distinct from p_new -> k)
$$;

-- When a document went out, read past RLS so the line guard below can ask about a document its caller may not
-- be allowed to see.
create or replace function private.money_document_sent_at(p_kind text, p_id uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select case p_kind
    when 'estimate' then (select e.sent_at from app.estimates e where e.id = p_id)
    else (select i.sent_at from app.invoices i where i.id = p_id) end
$$;

-- People write an estimate, send it, void it, and record a yes or a no given on the phone. What the customer
-- did on their own page — that they opened it, and that they pressed Accept and typed their name — is the
-- worker's alone; a person may record a staff acceptance in their own name, and take back only a staff mark.
-- Nobody rewrites a customer's acceptance. Every *_at is the database's clock, never the caller's. The test is
-- on current_user, which no role can fake, so this function must stay SECURITY INVOKER.
create or replace function private.guard_estimate()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_uid uuid;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  -- Only people get this far: the worker has no JWT and no access to the auth schema.
  v_uid := auth.uid();

  if old.voided_at is not null then
    raise exception 'A voided estimate can''t be changed' using errcode = '42501', detail = 'money_document_issued';
  end if;
  if old.sent_at is not null and private.money_document_frozen_changed(to_jsonb(old), to_jsonb(new)) then
    raise exception 'An estimate that has gone out keeps its number, its tax and its totals'
      using errcode = '42501', detail = 'money_document_issued';
  end if;
  if (new.first_viewed_at, new.last_viewed_at) is distinct from (old.first_viewed_at, old.last_viewed_at) then
    raise exception 'Only HandsFreeOS records that the customer opened an estimate'
      using errcode = '42501', detail = 'money_acceptance_protected';
  end if;

  if (new.accepted_at, new.accepted_via, new.accepted_by, new.accepted_name, new.accepted_wording, new.accepted_hash)
     is distinct from
     (old.accepted_at, old.accepted_via, old.accepted_by, old.accepted_name, old.accepted_wording, old.accepted_hash) then
    if old.accepted_at is null and new.accepted_via = 'staff' and new.accepted_by = v_uid
       and new.accepted_name is not null then
      new.accepted_at := now();
    elsif old.accepted_via = 'staff' and new.accepted_at is null and new.accepted_via is null
       and new.accepted_by is null and new.accepted_name is null and new.accepted_wording is null
       and new.accepted_hash is null then
      null;
    elsif old.accepted_via is distinct from 'staff' and (old.accepted_at is not null or new.accepted_via is distinct from 'staff') then
      raise exception 'Only HandsFreeOS records what the customer accepted'
        using errcode = '42501', detail = 'money_acceptance_protected';
    else
      raise exception 'People record an acceptance only as staff, in their own name'
        using errcode = '42501', detail = 'money_actor_mismatch';
    end if;
  end if;

  if new.sent_at is not null and old.sent_at is null then
    new.sent_at := now();
  elsif new.sent_at is distinct from old.sent_at then
    raise exception 'An estimate that has gone out keeps when it went'
      using errcode = '42501', detail = 'money_document_issued';
  end if;
  if new.declined_at is not null and old.declined_at is null then
    new.declined_at := now();
  elsif new.declined_at is not null then
    new.declined_at := old.declined_at;
  end if;
  if new.voided_at is not null then
    if new.voided_by is distinct from v_uid then
      raise exception 'People void in their own name' using errcode = '42501', detail = 'money_actor_mismatch';
    end if;
    new.voided_at := now();
  end if;
  return new;
end $$;
create trigger estimates_guard before update on app.estimates for each row execute function private.guard_estimate();

-- People write an invoice, send it, void it. What the customer did on their page, and what has been paid or
-- refunded (rolled up from app.payments in 0047), is the worker's: an invoice is never marked paid by hand.
-- SECURITY INVOKER, for the same reason as above.
create or replace function private.guard_invoice()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_uid uuid;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  v_uid := auth.uid();

  if old.voided_at is not null then
    raise exception 'A voided invoice can''t be changed' using errcode = '42501', detail = 'money_document_issued';
  end if;
  if old.sent_at is not null and private.money_document_frozen_changed(to_jsonb(old), to_jsonb(new)) then
    raise exception 'An invoice that has gone out keeps its number, its tax and its totals'
      using errcode = '42501', detail = 'money_document_issued';
  end if;
  if (new.first_viewed_at, new.last_viewed_at, new.paid_at, new.amount_paid_cents, new.amount_refunded_cents,
      new.reminder_state)
     is distinct from
     (old.first_viewed_at, old.last_viewed_at, old.paid_at, old.amount_paid_cents, old.amount_refunded_cents,
      old.reminder_state) then
    raise exception 'Only HandsFreeOS records what an invoice was paid'
      using errcode = '42501', detail = 'money_acceptance_protected';
  end if;

  if new.sent_at is not null and old.sent_at is null then
    new.sent_at := now();
  elsif new.sent_at is distinct from old.sent_at then
    raise exception 'An invoice that has gone out keeps when it went'
      using errcode = '42501', detail = 'money_document_issued';
  end if;
  if new.voided_at is not null then
    if new.voided_by is distinct from v_uid then
      raise exception 'People void in their own name' using errcode = '42501', detail = 'money_actor_mismatch';
    end if;
    new.voided_at := now();
  end if;
  return new;
end $$;
create trigger invoices_guard before update on app.invoices for each row execute function private.guard_invoice();

-- The lines of an issued document are frozen with it: no adding, no changing, no removing. SECURITY INVOKER,
-- so the current_user test holds; it asks private.money_document_sent_at rather than reading the parent
-- itself, so the answer does not depend on what the caller may see.
create or replace function private.guard_money_document_line()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_row jsonb;
  v_kind text;
begin
  if current_user <> 'authenticated' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  v_kind := case when tg_table_name = 'estimate_lines' then 'estimate' else 'invoice' end;
  if tg_op = 'DELETE' then v_row := to_jsonb(old); else v_row := to_jsonb(new); end if;
  if private.money_document_sent_at(v_kind, (v_row ->> (v_kind || '_id'))::uuid) is not null then
    raise exception 'A document that has gone out keeps its lines'
      using errcode = '42501', detail = 'money_document_issued';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger estimate_lines_guard before insert or update or delete on app.estimate_lines for each row
  execute function private.guard_money_document_line();
create trigger invoice_lines_guard before insert or update or delete on app.invoice_lines for each row
  execute function private.guard_money_document_line();

-- ---------- references stay inside the workspace, whoever writes ----------
create or replace function private.check_money_document_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean := true;
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  if tg_table_name in ('estimates', 'invoices') then
    v_ok := (tg_op = 'UPDATE' or exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
      and (new.lead_id is null or (tg_op = 'UPDATE' and new.lead_id is not distinct from old.lead_id)
        or exists (select 1 from app.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id))
      and (new.assignee_user_id is null or (tg_op = 'UPDATE' and new.assignee_user_id is not distinct from old.assignee_user_id)
        or private.workspace_has_user(new.workspace_id, new.assignee_user_id))
      and (new.voided_by is null or (tg_op = 'UPDATE' and new.voided_by is not distinct from old.voided_by)
        or private.workspace_has_user(new.workspace_id, new.voided_by))
      and (new.created_by is null or (tg_op = 'UPDATE' and new.created_by is not distinct from old.created_by)
        or private.workspace_has_user(new.workspace_id, new.created_by));
  end if;
  if tg_table_name = 'estimates' then
    v_ok := v_ok and (new.accepted_by is null or (tg_op = 'UPDATE' and new.accepted_by is not distinct from old.accepted_by)
      or private.workspace_has_user(new.workspace_id, new.accepted_by));
  elsif tg_table_name = 'invoices' then
    v_ok := v_ok
      and (new.estimate_id is null or (tg_op = 'UPDATE' and new.estimate_id is not distinct from old.estimate_id)
        or exists (select 1 from app.estimates e where e.id = new.estimate_id and e.workspace_id = new.workspace_id))
      and (new.attendee_id is null or (tg_op = 'UPDATE' and new.attendee_id is not distinct from old.attendee_id)
        or exists (select 1 from app.appointment_attendees a where a.id = new.attendee_id and a.workspace_id = new.workspace_id));
  elsif tg_table_name = 'estimate_lines' then
    v_ok := exists (select 1 from app.estimates e where e.id = new.estimate_id and e.workspace_id = new.workspace_id)
      and (new.product_id is null
        or exists (select 1 from app.products p where p.id = new.product_id and p.workspace_id = new.workspace_id));
  elsif tg_table_name = 'invoice_lines' then
    v_ok := exists (select 1 from app.invoices i where i.id = new.invoice_id and i.workspace_id = new.workspace_id)
      and (new.product_id is null
        or exists (select 1 from app.products p where p.id = new.product_id and p.workspace_id = new.workspace_id));
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger estimates_check_refs before insert or update of person_id, lead_id, assignee_user_id, accepted_by,
  voided_by, created_by on app.estimates for each row execute function private.check_money_document_refs();
create trigger invoices_check_refs before insert or update of person_id, lead_id, assignee_user_id, estimate_id,
  attendee_id, voided_by, created_by on app.invoices for each row execute function private.check_money_document_refs();
create trigger estimate_lines_check_refs before insert or update of estimate_id, product_id on app.estimate_lines
  for each row execute function private.check_money_document_refs();
create trigger invoice_lines_check_refs before insert or update of invoice_id, product_id on app.invoice_lines
  for each row execute function private.check_money_document_refs();

-- ---------- RLS ----------
-- Owners and admins (money.manage) do everything here. The rule that also lets a member see the documents of
-- the jobs they are on is a second SELECT policy, in 0050 with the permissions it depends on.
alter table app.document_counters enable row level security;
alter table app.estimates enable row level security;
alter table app.estimate_lines enable row level security;
alter table app.invoices enable row level security;
alter table app.invoice_lines enable row level security;

create policy document_counters_select on app.document_counters for select to authenticated
  using (private.has_permission(workspace_id, 'money.manage'));
create policy document_counters_insert on app.document_counters for insert to authenticated
  with check (private.has_permission(workspace_id, 'money.manage'));
create policy document_counters_update on app.document_counters for update to authenticated
  using (private.has_permission(workspace_id, 'money.manage'))
  with check (private.has_permission(workspace_id, 'money.manage'));
create policy document_counters_service_all on app.document_counters for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy estimates_manage_select on app.estimates for select to authenticated
  using (private.has_permission(workspace_id, 'money.manage'));
create policy estimates_insert on app.estimates for insert to authenticated
  with check (private.has_permission(workspace_id, 'money.manage') and created_by = (select auth.uid())
    and status = 'draft' and sent_at is null and number is null and accepted_at is null and declined_at is null
    and voided_at is null and first_viewed_at is null and last_viewed_at is null);
create policy estimates_update on app.estimates for update to authenticated
  using (private.has_permission(workspace_id, 'money.manage'))
  with check (private.has_permission(workspace_id, 'money.manage'));
create policy estimates_service_all on app.estimates for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- FOR ALL covers reading too: money.manage sees and writes every line.
create policy estimate_lines_write on app.estimate_lines for all to authenticated
  using (private.has_permission(workspace_id, 'money.manage'))
  with check (private.has_permission(workspace_id, 'money.manage'));
create policy estimate_lines_service_all on app.estimate_lines for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy invoices_manage_select on app.invoices for select to authenticated
  using (private.has_permission(workspace_id, 'money.manage'));
create policy invoices_insert on app.invoices for insert to authenticated
  with check (private.has_permission(workspace_id, 'money.manage') and created_by = (select auth.uid())
    and status = 'draft' and sent_at is null and number is null and paid_at is null and voided_at is null
    and first_viewed_at is null and last_viewed_at is null and amount_paid_cents = 0 and amount_refunded_cents = 0);
create policy invoices_update on app.invoices for update to authenticated
  using (private.has_permission(workspace_id, 'money.manage'))
  with check (private.has_permission(workspace_id, 'money.manage'));
create policy invoices_service_all on app.invoices for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy invoice_lines_write on app.invoice_lines for all to authenticated
  using (private.has_permission(workspace_id, 'money.manage'))
  with check (private.has_permission(workspace_id, 'money.manage'));
create policy invoice_lines_service_all on app.invoice_lines for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- the customer's links (the tenant is not known yet) ----------
-- /e/<public_ref><code> and /i/<public_ref><code>: the reference names the document and its tenant, and the
-- worker checks the HMAC against link_version before reading anything else under that workspace's scope.
create or replace function private.estimate_link_lookup(p_ref text)
returns table (estimate_id uuid, workspace_id uuid, organization_id uuid, link_version integer)
language sql stable security definer set search_path = '' as $$
  select e.id, e.workspace_id, w.organization_id, e.link_version
  from app.estimates e join app.workspaces w on w.id = e.workspace_id
  where p_ref ~ '^[0-9A-Za-z]{8}$' and e.public_ref = p_ref
$$;

create or replace function private.invoice_link_lookup(p_ref text)
returns table (invoice_id uuid, workspace_id uuid, organization_id uuid, link_version integer)
language sql stable security definer set search_path = '' as $$
  select i.id, i.workspace_id, w.organization_id, i.link_version
  from app.invoices i join app.workspaces w on w.id = i.workspace_id
  where p_ref ~ '^[0-9A-Za-z]{8}$' and i.public_ref = p_ref
$$;

-- ---------- function privileges ----------
revoke all on function
  private.money_document_frozen_changed(jsonb, jsonb), private.money_document_sent_at(text, uuid),
  private.guard_estimate(), private.guard_invoice(), private.guard_money_document_line(),
  private.check_money_document_refs(), private.estimate_link_lookup(text), private.invoice_link_lookup(text)
  from public;
grant execute on function
  private.money_document_frozen_changed(jsonb, jsonb), private.money_document_sent_at(text, uuid),
  private.guard_estimate(), private.guard_invoice(), private.guard_money_document_line(),
  private.check_money_document_refs()
  to authenticated, service_actor;
grant execute on function private.estimate_link_lookup(text), private.invoice_link_lookup(text) to service_actor;
