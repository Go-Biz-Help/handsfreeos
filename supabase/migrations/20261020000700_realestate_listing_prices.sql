-- =============================================================================
-- Real Estate Agent, round three, step 10: a listing's price changes, signed
-- off by the seller.
--
--        Chris decided (2026-10-01): the seller signs off before a new price
--        is used. Chosen for him: an owner or admin (Approve exceptions) can
--        let one through without the portal, with a kept reason ("signed on
--        paper"), as a description can be.
--
--        **listing_prices**: each change asked for: from and to, the exact
--        words the seller signs ("Change the list price of 418 Maple Ave from
--        $409,000 to $399,000."), the sign-off task, and how it ended: applied
--        (signed in the portal or let through, the list price entry it made),
--        or withdrawn with why. One waits at a time on a listing.
-- =============================================================================

create table addon_realestate.listing_prices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  from_cents bigint not null check (from_cents > 0),
  to_cents bigint not null check (to_cents > 0),
  words text not null check (length(btrim(words)) between 1 and 500),
  note text check (note is null or length(note) <= 500),
  state text not null default 'waiting' check (state in ('waiting', 'applied', 'withdrawn')),
  client_task_id uuid,
  -- Applied: signed by the seller in their portal, or let through by an owner or admin with a reason.
  signed_by_person_id uuid references app.people (id) on delete set null,
  override_by uuid references app.users (id) on delete set null,
  override_reason text check (override_reason is null or length(btrim(override_reason)) between 1 and 500),
  applied_at timestamptz,
  term_entry_id uuid references addon_realestate.term_entries (id) on delete set null,
  withdrawn_reason text check (withdrawn_reason is null or length(btrim(withdrawn_reason)) between 1 and 500),
  proposed_by uuid references app.users (id) on delete set null,
  proposed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (to_cents <> from_cents),
  check ((state = 'applied') = (applied_at is not null)),
  check ((state = 'withdrawn') = (withdrawn_reason is not null)),
  check ((override_reason is null) = (override_by is null)),
  foreign key (workspace_id, client_task_id) references addon_realestate.client_tasks (workspace_id, id)
    on delete set null (client_task_id),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create unique index listing_prices_one_waiting on addon_realestate.listing_prices (deal_record_id)
  where state = 'waiting';
create index listing_prices_deal_idx on addon_realestate.listing_prices
  (workspace_id, deal_record_id, proposed_at desc);
create index listing_prices_task_idx on addon_realestate.listing_prices (client_task_id)
  where client_task_id is not null;
create index listing_prices_entry_idx on addon_realestate.listing_prices (term_entry_id)
  where term_entry_id is not null;
create index listing_prices_signed_by_idx on addon_realestate.listing_prices (signed_by_person_id)
  where signed_by_person_id is not null;
create index listing_prices_override_by_idx on addon_realestate.listing_prices (override_by)
  where override_by is not null;
create index listing_prices_proposed_by_idx on addon_realestate.listing_prices (proposed_by)
  where proposed_by is not null;
select private.addon_table_policies('addon_realestate.listing_prices', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
-- The seller sees each change asked of them, and how it ended.
select private.addon_portal_policies('addon_realestate.listing_prices', 'deal_record_id',
  array['id', 'from_cents', 'to_cents', 'words', 'state', 'applied_at', 'proposed_at']);
