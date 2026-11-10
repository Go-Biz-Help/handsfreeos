-- =============================================================================
-- Estimates: good, better, best; and an estimate an add-on builds
-- (HANDSFREEOS_CONTRACTOR_OPERATIONS_IMPLEMENTATION_PLAN.md, the owner's
-- decisions 5 and 6).
--
--        **Options.** An estimate may offer two or three options ("Good",
--        "Better", "Best", or the business's own names). They are kept on
--        the estimate itself, in `options`: each with its name, its lines and
--        its totals, worked out by core. The estimate's own lines and totals
--        are always one of them, named by `option_position`: the first until
--        the customer picks, then the one they picked. So everything that
--        reads an estimate (the phone, the lists, the invoice it becomes)
--        reads a whole estimate as it always did, and no sync stream changes.
--
--        Options freeze with the estimate when it goes out. Picking one is
--        the only way a sent estimate's lines and totals move, and only to
--        figures frozen with it: `private.estimate_pick_option` copies the
--        picked option's lines and totals in as the estimate is approved.
--
--        **Built by an add-on.** `addon_id` names the add-on whose builder
--        wrote the estimate. While that add-on runs in the business, the
--        estimate is changed and sent from there (it checks what core can't
--        see, such as a lowest margin); core's own commands say so.
--
-- Adds three columns to app.estimates, none of them in a sync stream, so
-- PowerSync copies nothing again.
-- =============================================================================

alter table app.estimates
  add column options jsonb,
  add column option_position integer,
  add column addon_id text,
  add constraint estimates_options_shape check (
    options is null
    or case when jsonb_typeof(options) = 'array' then jsonb_array_length(options) between 2 and 3 else false end),
  add constraint estimates_option_position_range check (option_position is null or option_position between 1 and 3),
  add constraint estimates_option_position_set check ((options is null) = (option_position is null)),
  add constraint estimates_addon_id_shape check (addon_id is null or addon_id ~ '^[a-z]{2,16}$');

comment on column app.estimates.options is
  'Two or three options, each {name, lines, totals}, worked out by core. Null for an estimate with one price.';
comment on column app.estimates.option_position is
  'Which option the estimate''s own lines and totals are: 1 until one is picked.';
comment on column app.estimates.addon_id is
  'The add-on whose builder wrote this estimate, which changes and sends it while it runs here.';

-- An issued estimate keeps its options, and which add-on built it never changes. SECURITY INVOKER, like the
-- estimate's own guard: the test is on current_user, which no role can fake.
create or replace function private.guard_estimate_options()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if new.addon_id is distinct from old.addon_id then
    raise exception 'An estimate stays with the add-on that built it'
      using errcode = '42501', detail = 'money_document_issued';
  end if;
  if old.sent_at is not null
     and (new.options is distinct from old.options or new.option_position is distinct from old.option_position) then
    raise exception 'An estimate that has gone out keeps its options'
      using errcode = '42501', detail = 'money_document_issued';
  end if;
  return new;
end $$;
create trigger estimates_guard_options before update on app.estimates for each row
  execute function private.guard_estimate_options();

-- The one way a sent estimate's lines and totals move: to one of the options frozen with it, as it is approved.
-- SECURITY DEFINER, because the estimate's guards refuse a person any change to an issued estimate's figures;
-- so it checks the caller itself. The worker (no JWT) runs it for a customer approving on their own page.
create or replace function private.estimate_pick_option(p_estimate_id uuid, p_position integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_status app.estimate_status;
  v_options jsonb;
  v_current integer;
  v_option jsonb;
begin
  select e.workspace_id, e.status, e.options, e.option_position
    into v_ws, v_status, v_options, v_current
  from app.estimates e where e.id = p_estimate_id for update;
  if not found or v_options is null then
    raise exception 'That estimate has no options to pick from'
      using errcode = '22023', detail = 'estimate_no_options';
  end if;
  if auth.uid() is not null and not private.has_permission(v_ws, 'money.bill') then
    raise exception 'Only someone who bills here picks an estimate''s option' using errcode = '42501';
  end if;
  if v_status <> 'sent' then
    raise exception 'An option is picked as a sent estimate is approved'
      using errcode = '42501', detail = 'money_document_issued';
  end if;
  if p_position is null or p_position < 1 or p_position > jsonb_array_length(v_options) then
    raise exception 'That estimate has no such option'
      using errcode = '22023', detail = 'estimate_no_options';
  end if;
  if v_current = p_position then
    return;
  end if;
  v_option := v_options -> (p_position - 1);

  delete from app.estimate_lines l where l.estimate_id = p_estimate_id;
  insert into app.estimate_lines (workspace_id, estimate_id, position, product_id, name, description, quantity,
    unit_label, unit_price_cents, taxable, discount_cents, amount_cents)
  select v_ws, p_estimate_id, (t.ord - 1)::integer,
    -- A product deleted since the estimate went out leaves the line as it was written.
    (select p.id from app.products p
     where p.workspace_id = v_ws and p.id = nullif(t.line ->> 'productId', '')::uuid),
    t.line ->> 'name', nullif(t.line ->> 'description', ''), (t.line ->> 'quantity')::numeric,
    coalesce(t.line ->> 'unitLabel', 'each'), (t.line ->> 'unitPriceCents')::bigint,
    coalesce((t.line ->> 'taxable')::boolean, true), coalesce((t.line ->> 'discountCents')::bigint, 0),
    (t.line ->> 'amountCents')::bigint
  from jsonb_array_elements(v_option -> 'lines') with ordinality as t(line, ord);

  update app.estimates e set
    option_position = p_position,
    subtotal_cents = (v_option #>> '{totals,subtotalCents}')::bigint,
    discount_cents = (v_option #>> '{totals,discountCents}')::bigint,
    taxable_base_cents = (v_option #>> '{totals,taxableBaseCents}')::bigint,
    tax_cents = (v_option #>> '{totals,taxCents}')::bigint,
    total_cents = (v_option #>> '{totals,totalCents}')::bigint
  where e.id = p_estimate_id;
end $$;
revoke execute on function private.estimate_pick_option(uuid, integer) from public;
grant execute on function private.estimate_pick_option(uuid, integer) to authenticated, service_actor;
