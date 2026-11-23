-- =============================================================================
-- Stock counts (product sellers, the owner's pick 4a; docs/selling-products.md).
-- How many of a product are on hand, as a whole or by one of its options (each
-- size of a T-shirt), going down when an order is picked up or delivered and
-- back up when it's moved back. A business can set a number to hear at
-- ("Tell me when it's down to 3").
--
-- What's counted is the product's own choice (products.stock_tracked, and
-- stock_option_id for counting by an option); the counts are app.stock_counts,
-- one row per product and choice ('' when it's counted as a whole). People with
-- money.read see them and money.manage changes them, as the price list. An
-- order moving to done takes its lines off whoever moves it, through the
-- trigger below, so a member who marks it picked up needs no money permission.
-- The order keeps what it took (orders.stock_taken), so moving it back puts
-- back exactly that, even if the product was counted differently since.
-- =============================================================================

alter table app.products
  add column stock_tracked boolean not null default false,
  -- The option it's counted by (an option id in products.options), or null for the product as a whole.
  add column stock_option_id text check (stock_option_id is null or length(stock_option_id) <= 40),
  -- Tell the business when a count is down to this many, or null for never.
  add column low_stock_at integer check (low_stock_at is null or low_stock_at between 0 and 1000000);
alter table app.products add constraint products_stock_option_tracked
  check (stock_option_id is null or stock_tracked);

comment on column app.products.stock_tracked is 'Whether HandsFreeOS counts how many are on hand (app.stock_counts).';
comment on column app.products.stock_option_id is
  'The option the stock is counted by (an id in options), or null for the product as a whole.';

create table app.stock_counts (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  product_id uuid not null references app.products (id) on delete cascade,
  -- The choice counted (an id in the product's options), or '' for the product as a whole.
  choice_id text not null default '' check (length(choice_id) <= 40),
  -- Below zero when more went out than were counted.
  on_hand integer not null default 0 check (on_hand between -100000000 and 100000000),
  updated_by uuid references app.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (product_id, choice_id)
);
create index stock_counts_workspace_idx on app.stock_counts (workspace_id);
create index stock_counts_updated_by_idx on app.stock_counts (updated_by) where updated_by is not null;
create trigger stock_counts_immutable before update on app.stock_counts
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'product_id', 'choice_id');

comment on table app.stock_counts is
  'How many of a product (or one choice of it) are on hand. Orders take theirs off when done. docs/selling-products.md.';

-- A count is the product's business's.
create or replace function private.check_stock_count_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.products p where p.id = new.product_id and p.workspace_id = new.workspace_id) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end;
$$;
revoke execute on function private.check_stock_count_refs() from public;
create trigger stock_counts_check_refs before insert on app.stock_counts
  for each row execute function private.check_stock_count_refs();

alter table app.stock_counts enable row level security;
create policy stock_counts_select on app.stock_counts for select to authenticated
  using (private.has_permission(workspace_id, 'money.read'));
create policy stock_counts_insert on app.stock_counts for insert to authenticated
  with check (private.has_permission(workspace_id, 'money.manage'));
create policy stock_counts_update on app.stock_counts for update to authenticated
  using (private.has_permission(workspace_id, 'money.manage'))
  with check (private.has_permission(workspace_id, 'money.manage'));
create policy stock_counts_service_all on app.stock_counts for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select, insert on app.stock_counts to authenticated;
grant update (on_hand, updated_by, updated_at) on app.stock_counts to authenticated;
grant select, insert, update, delete on app.stock_counts to service_actor;
revoke all on app.stock_counts from anon;

-- What an order took off stock when it was done: [{productId, choiceId, quantity, left, lowAt}], where left is the
-- count just after and lowAt the product's number to hear at then. Only the trigger writes it.
alter table app.orders add column stock_taken jsonb not null default '[]'::jsonb
  check (jsonb_typeof(stock_taken) = 'array' and jsonb_array_length(stock_taken) <= 200);

-- Done takes each line from the price list off its product's count (by the line's choice of the option it's counted
-- by; a line without one is skipped), and leaving done puts back what it took.
create or replace function private.orders_take_stock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_line jsonb;
  v_taken jsonb := '[]'::jsonb;
  v_product record;
  v_choice text;
  v_quantity integer;
  v_left integer;
begin
  if new.status = 'done' and old.status <> 'done' then
    for v_line in select value from jsonb_array_elements(new.lines) loop
      continue when jsonb_typeof(v_line -> 'productId') <> 'string'
        or jsonb_typeof(v_line -> 'quantity') <> 'number';
      select p.id, p.stock_option_id, p.low_stock_at, p.options into v_product
        from app.products p
        where p.id::text = v_line ->> 'productId' and p.workspace_id = new.workspace_id and p.stock_tracked;
      continue when not found;
      v_choice := '';
      if v_product.stock_option_id is not null then
        v_choice := null;
        select c ->> 'id' into v_choice
          from jsonb_array_elements(coalesce(v_product.options, '[]'::jsonb)) o,
            jsonb_array_elements(coalesce(o -> 'choices', '[]'::jsonb)) c
          where o ->> 'id' = v_product.stock_option_id
            and jsonb_typeof(v_line -> 'choiceIds') = 'array'
            and (v_line -> 'choiceIds') ? (c ->> 'id')
          limit 1;
        continue when v_choice is null;
      end if;
      v_quantity := (v_line ->> 'quantity')::integer;
      continue when v_quantity is null or v_quantity < 1;
      insert into app.stock_counts as s (workspace_id, product_id, choice_id, on_hand)
        values (new.workspace_id, v_product.id, v_choice, -v_quantity)
        on conflict (product_id, choice_id)
        do update set on_hand = s.on_hand - v_quantity, updated_at = now()
        returning s.on_hand into v_left;
      v_taken := v_taken || jsonb_build_array(jsonb_build_object(
        'productId', v_product.id, 'choiceId', v_choice, 'quantity', v_quantity, 'left', v_left,
        'lowAt', v_product.low_stock_at));
    end loop;
    new.stock_taken := v_taken;
  elsif old.status = 'done' and new.status <> 'done' then
    for v_line in select value from jsonb_array_elements(old.stock_taken) loop
      update app.stock_counts s
        set on_hand = s.on_hand + (v_line ->> 'quantity')::integer, updated_at = now()
        where s.product_id::text = v_line ->> 'productId' and s.choice_id = v_line ->> 'choiceId'
          and s.workspace_id = new.workspace_id;
    end loop;
    new.stock_taken := '[]'::jsonb;
  end if;
  return new;
end;
$$;
revoke execute on function private.orders_take_stock() from public;
create trigger orders_take_stock before update of status on app.orders
  for each row when (old.status is distinct from new.status) execute function private.orders_take_stock();

-- ---------- a new push switch: Running low ----------
-- Carried over from 20261027015200 with one more switch, `stock`: a product the business counts is down to its
-- number (packages/core/src/push.ts).
create or replace function private.push_on(p_settings jsonb, p_key text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_key = 'safety' then
    return true;
  end if;
  if p_key is null or p_key not in ('customerWaiting', 'missedCall', 'urgent', 'approval', 'booking', 'assigned',
                                    'payment', 'wallet', 'jobs', 'connections', 'addons', 'supportTickets',
                                    'qualifying', 'documents', 'stock') then
    raise exception 'Unknown push switch: %', p_key using errcode = '22023', detail = 'push_switch_unknown';
  end if;
  if jsonb_typeof(p_settings -> 'push' -> p_key) = 'boolean' then
    return (p_settings -> 'push' ->> p_key)::boolean;
  end if;
  return p_key <> 'payment';
end $$;

comment on column app.users.settings is
  'Per-person choices, each top-level key saved whole: theme; notifications, the email switches (unansweredEmail, attentionDigest, aiHandoff, bookingEmail, paymentEmail, agencyDigest, eveningSummary, addonEmail), each on unless false; push, the phone''s switches (customerWaiting, missedCall, urgent, approval, booking, assigned, payment, wallet, jobs, connections, addons, supportTickets, qualifying, documents, stock), each on unless false except payment: private.push_on.';
