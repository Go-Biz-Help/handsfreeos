-- =============================================================================
-- Orders (product sellers, the owner's pick 2a; docs/selling-products.md).
-- What a customer ordered and where it is: New, Making it, Ready, then Picked
-- up or Delivered (or Cancelled), whether it's picked up or delivered and on
-- what day, and the invoice made from it. A sent order form makes one (each
-- row ordered on a "How many of each" question is a line); so does New order
-- on Money → Orders.
--
-- The lines are kept on the order as JSON, checked by core
-- (packages/core/src/money/orders.ts): [{productId, choiceIds, name, quantity,
-- unitPriceCents, taxable}]. Like an invoice's lines they are a copy, so
-- repricing a product never reprices an order already taken; making the
-- invoice copies them again. total_cents is core's sum of them.
--
-- Who sees an order: anyone in the business who can see its customer, while
-- that customer isn't in the Deleted bin (emptying the bin takes the orders
-- with the customer). records.write changes one, as it
-- changes a lead; making its invoice is the command's money.bill. Nobody
-- deletes one: an order taken by mistake is cancelled.
--
-- Numbers are the business's own, from 1001, given by a trigger so two orders
-- arriving together can't take the same one. Merging two customers moves the
-- one's orders to the other.
-- =============================================================================

create type app.order_status as enum ('new', 'making', 'ready', 'done', 'cancelled');

create table app.orders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- Given by orders_number on insert, whatever was sent.
  number integer not null default 0,
  person_id uuid not null references app.people (id) on delete cascade,
  status app.order_status not null default 'new',
  fulfilment text check (fulfilment in ('pickup', 'delivery')),
  -- The day it's picked up or delivered: on the calendar.
  due_on date,
  lines jsonb not null default '[]'::jsonb
    check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) <= 200
      and pg_column_size(lines) <= 131072),
  total_cents bigint not null default 0 check (total_cents >= 0),
  notes text check (notes is null or length(notes) <= 4000),
  -- Where it came from, when a form made it.
  form_id uuid references app.forms (id) on delete set null,
  form_response_id uuid references app.form_responses (id) on delete set null,
  -- The invoice made from it.
  invoice_id uuid references app.invoices (id) on delete set null,
  open boolean generated always as (status in ('new', 'making', 'ready')) stored,
  status_changed_at timestamptz,
  status_changed_by uuid references app.users (id) on delete set null,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, number)
);
create index orders_list_idx on app.orders (workspace_id, open, created_at desc);
create index orders_due_idx on app.orders (workspace_id, due_on) where due_on is not null;
create index orders_person_idx on app.orders (person_id);
create index orders_form_idx on app.orders (form_id) where form_id is not null;
create index orders_response_idx on app.orders (form_response_id) where form_response_id is not null;
create index orders_invoice_idx on app.orders (invoice_id) where invoice_id is not null;
create index orders_status_changed_by_idx on app.orders (status_changed_by) where status_changed_by is not null;
create index orders_created_by_idx on app.orders (created_by) where created_by is not null;
create trigger orders_updated_at before update on app.orders
  for each row execute function private.set_updated_at();
-- Where it came from isn't frozen: deleting the form or its answers clears the link (and people can't write it).
create trigger orders_immutable before update on app.orders
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'number', 'created_by');

comment on table app.orders is
  'What a customer ordered (product sellers): its lines, status, pickup or delivery day and invoice. docs/selling-products.md.';
comment on column app.orders.lines is
  'A copy of each line: [{productId, choiceIds, name, quantity, unitPriceCents, taxable}], checked by core.';

-- The business's next number, from 1001. Locked per business so two orders arriving together wait for each other.
create or replace function private.order_number()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('app.orders:' || new.workspace_id::text, 0));
  select coalesce(max(o.number), 1000) + 1 into new.number
    from app.orders o where o.workspace_id = new.workspace_id;
  return new;
end;
$$;
revoke execute on function private.order_number() from public;
create trigger orders_number before insert on app.orders
  for each row execute function private.order_number();

-- Everything it points at is the same business's: its customer, form, answers and invoice (and the invoice is
-- the same customer's).
create or replace function private.check_order_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id)
    or (new.form_id is not null
      and not exists (select 1 from app.forms f where f.id = new.form_id and f.workspace_id = new.workspace_id))
    or (new.form_response_id is not null
      and not exists (select 1 from app.form_responses r
        where r.id = new.form_response_id and r.workspace_id = new.workspace_id))
    or (new.invoice_id is not null
      and not exists (select 1 from app.invoices i
        where i.id = new.invoice_id and i.workspace_id = new.workspace_id and i.person_id = new.person_id)) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end;
$$;
revoke execute on function private.check_order_refs() from public;
create trigger orders_check_refs before insert or update of person_id, form_id, form_response_id, invoice_id
  on app.orders for each row execute function private.check_order_refs();

-- Merging two customers (private.merge_people) moves the one's orders to the one kept, and their invoices with them.
create or replace function private.orders_follow_merge()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update app.orders o set person_id = new.merged_into_id
    where o.workspace_id = new.workspace_id and o.person_id = new.id;
  return null;
end;
$$;
revoke execute on function private.orders_follow_merge() from public;
create trigger people_orders_follow_merge after update of merged_into_id on app.people
  for each row when (old.merged_into_id is null and new.merged_into_id is not null)
  execute function private.orders_follow_merge();

alter table app.orders enable row level security;
-- Seen with its customer: the people policies decide who sees them, and a customer in the Deleted bin (readable
-- still, for the bills that name them) takes their orders out of sight until they come back.
create policy orders_select on app.orders for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and exists (select 1 from app.people p where p.id = person_id and p.bin_item_id is null));
create policy orders_insert on app.orders for insert to authenticated
  with check (private.has_permission(workspace_id, 'records.write')
    and exists (select 1 from app.people p where p.id = person_id and p.bin_item_id is null));
create policy orders_update on app.orders for update to authenticated
  using (private.has_permission(workspace_id, 'records.write')
    and exists (select 1 from app.people p where p.id = person_id and p.bin_item_id is null))
  with check (private.has_permission(workspace_id, 'records.write'));
create policy orders_service_all on app.orders for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select, insert on app.orders to authenticated;
grant update (status, fulfilment, due_on, lines, total_cents, notes, invoice_id, status_changed_at,
  status_changed_by) on app.orders to authenticated;
grant select, insert, update, delete on app.orders to service_actor;
revoke all on app.orders from anon;
