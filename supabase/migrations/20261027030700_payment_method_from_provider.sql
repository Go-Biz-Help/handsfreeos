-- =============================================================================
-- 20261027030700 · How a payment was made is the provider's first answer.
--
-- A payment row is written before the provider is asked (0047: the row and its
-- idempotency key are what stop a double-clicked button charging twice), with
-- the way the customer picked on our page. Stripe's payment box, now on the
-- invoice page and the deposit step (PayPal plan, part 1), offers every way the
-- business switched on, so a customer who picked Card can still pay by bank
-- inside it. The provider's first answer is the truth, so the method may change
-- once: from one provider way to the other (card or bank transfer), while the
-- row is still waiting on that first answer. After that it never changes, and a
-- payment recorded by hand (cash, a cheque) never changes at all.
--
-- 0047's freeze stays as it was for every other column.
-- =============================================================================

create or replace trigger payments_immutable before update on app.payments for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'invoice_id', 'amount_cents', 'currency',
    'provider', 'recorded_by');

create or replace function private.payment_method_settles_once()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.method is distinct from old.method and not (
    old.status = 'requires_payment'
    and old.provider is not null
    and old.method in ('card', 'ach')
    and new.method in ('card', 'ach')
  ) then
    raise exception 'method is immutable on %.%', tg_table_schema, tg_table_name using errcode = '23514';
  end if;
  return new;
end $$;

create trigger payments_method_settles_once before update of method on app.payments for each row
  execute function private.payment_method_settles_once();

-- ---------- function privileges ----------
revoke all on function private.payment_method_settles_once() from public;
grant execute on function private.payment_method_settles_once() to authenticated, service_actor;
