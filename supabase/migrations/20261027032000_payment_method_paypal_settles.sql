-- =============================================================================
-- 20261027032000 · A PayPal payment learns how it was made from PayPal.
--
-- 20261027031100 lets a payment's method change once, on the provider's first
-- answer, between the ways a provider takes money (card or bank transfer). A
-- PayPal payment is written as `paypal` before the customer has chosen inside
-- PayPal, and PayPal's capture says whether it came from a PayPal account,
-- Venmo or a card, so those join the ways it may change between. Everything
-- else about the rule is as it was: only while the row waits on that first
-- answer, only for a provider's payment, and never for one recorded by hand.
-- =============================================================================

create or replace function private.payment_method_settles_once()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.method is distinct from old.method and not (
    old.status = 'requires_payment'
    and old.provider is not null
    and old.method in ('card', 'ach', 'paypal', 'venmo')
    and new.method in ('card', 'ach', 'paypal', 'venmo')
  ) then
    raise exception 'method is immutable on %.%', tg_table_schema, tg_table_name using errcode = '23514';
  end if;
  return new;
end $$;
