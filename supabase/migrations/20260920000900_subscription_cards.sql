-- =============================================================================
-- 0052 · The card a plan bills, and the customer's own page for giving it.
--
--        A plan that can only start on a card the provider already happens to
--        hold is a trap: a business signs their first maintenance customer up,
--        presses Start, and it either fails at the provider or quietly bills a
--        card left over from an old job. So a plan can be started *waiting*,
--        the customer is sent their own link, and they put a card on it
--        themselves — the same shape as the estimate and invoice links, signed
--        over `pay_version` so one press retires every link already sent.
--
--        What is kept here is what the provider hands back and nothing else:
--        their id for the customer, their token for the card, and the brand,
--        last four and expiry that every provider gives for free. **Never the
--        number** — that is what keeps HandsFreeOS in the lightest PCI bracket,
--        and it is why `method_token` is only ever useful with the connected
--        account's own credentials, which people cannot read at all.
--
--        All seven are the worker's, like every other thing a provider decides.
--        A person may ask for a card (that is `card_requested_at`, written
--        through the command) and may not write a word of what comes back.
-- =============================================================================

alter table app.subscriptions
  -- The provider's customer this plan bills ("cus_…", a Square customer id).
  add column customer_ref text
    check (customer_ref is null or length(btrim(customer_ref)) between 1 and 200),
  -- The provider's token for the saved card. Useless without that account's own credentials.
  add column method_token text
    check (method_token is null or length(btrim(method_token)) between 1 and 4000),
  add column card_brand text
    check (card_brand is null or length(btrim(card_brand)) between 1 and 40),
  add column card_last4 text
    check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  add column card_expiry_month smallint
    check (card_expiry_month is null or card_expiry_month between 1 and 12),
  add column card_expiry_year smallint
    check (card_expiry_year is null or card_expiry_year between 2000 and 2100),
  -- When the customer was asked for a card. Set while a plan waits on them; cleared when one lands.
  add column card_requested_at timestamptz;

-- Only a card has a brand or last four, and neither is any use without the other.
alter table app.subscriptions
  add constraint subscriptions_card_details_check
    check ((card_brand is null) = (card_last4 is null));

comment on column app.subscriptions.method_token is
  'The provider''s token for the saved card. Never the number, and never usable without that account''s credentials.';
comment on column app.subscriptions.card_requested_at is
  'Set while the plan is waiting on the customer to put a card on it; cleared the moment one lands.';

-- The plans waiting on a customer, for the page and the nudge.
create index subscriptions_awaiting_card_idx on app.subscriptions (workspace_id, card_requested_at)
  where status = 'draft' and method_token is null;

-- ---------- what the provider says is the worker's, exactly as everywhere else ----------
create or replace function private.guard_subscription_card()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if new.customer_ref is distinct from old.customer_ref
    or new.method_token is distinct from old.method_token
    or new.card_brand is distinct from old.card_brand
    or new.card_last4 is distinct from old.card_last4
    or new.card_expiry_month is distinct from old.card_expiry_month
    or new.card_expiry_year is distinct from old.card_expiry_year then
    raise exception 'Only the provider decides what card a plan bills'
      using errcode = '42501', detail = 'subscription_card_is_the_providers';
  end if;
  return new;
end $$;
create trigger subscriptions_card_guard before update on app.subscriptions for each row
  execute function private.guard_subscription_card();

-- Nothing about a card is ever set as a row is created, either: it arrives from the provider, later.
create or replace function private.guard_subscription_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if new.customer_ref is not null or new.method_token is not null
    or new.card_brand is not null or new.card_last4 is not null
    or new.card_expiry_month is not null or new.card_expiry_year is not null then
    raise exception 'Only the provider decides what card a plan bills'
      using errcode = '42501', detail = 'subscription_card_is_the_providers';
  end if;
  return new;
end $$;
create trigger subscriptions_insert_guard before insert on app.subscriptions for each row
  execute function private.guard_subscription_insert();

-- ---------- function privileges ----------
-- The customer's own plan page (`/p/<public_ref><code>`) already has its lookup: 0048 declared
-- `private.subscription_link_lookup`, signed over `pay_version`, waiting for the page that now uses it.
revoke all on function private.guard_subscription_card(), private.guard_subscription_insert() from public;
grant execute on function private.guard_subscription_card(), private.guard_subscription_insert()
  to authenticated, service_actor;
