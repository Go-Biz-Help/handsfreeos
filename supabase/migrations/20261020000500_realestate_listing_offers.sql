-- =============================================================================
-- Real Estate Agent, round three, step 8: offers on a listing, side by side
-- with what the seller would take home.
--
--        Chris decided (2026-10-01): a listing's offers are compared side by
--        side, with the seller's estimated net for each. Chosen for him: the
--        net is an estimate and says so, with the figures it used kept beside
--        it; the seller's choice in the portal tells the agent what they want
--        and accepts nothing.
--
--        **offers** work on a listing too: no home of a buyer's, the buyers'
--        names instead. **offer_versions** gain the terms a seller weighs: the
--        down payment, a home-sale contingency, an escalation clause,
--        possession, and what the buyer's agent asks the seller to pay.
--        **net_sheets**: the figures for the seller's estimate (what's owed on
--        the mortgage, the listing fee, title and escrow, transfer tax, other
--        costs), each save kept.
--        **offer_comparisons**: what the seller was shown, as shown: each
--        offer's terms and estimate when it was shared.
--        **offer_choices**: what the seller said about an offer in their
--        portal (accept, counter, decline, or let's talk), in their words.
-- =============================================================================

alter table addon_realestate.offers
  alter column home_id drop not null,
  add column buyer_names text check (buyer_names is null or length(btrim(buyer_names)) between 1 and 200);

alter table addon_realestate.offer_versions
  add column down_payment_pct numeric(5, 2) check (down_payment_pct is null or down_payment_pct between 0 and 100),
  add column home_sale_contingency boolean,
  add column escalation_cap_cents bigint check (escalation_cap_cents is null or escalation_cap_cents > 0),
  add column escalation_step_cents bigint check (escalation_step_cents is null or escalation_step_cents > 0),
  add column possession text check (possession is null or length(btrim(possession)) between 1 and 200),
  -- What the buyer's agent asks the seller to pay: a share of the price, or an amount.
  add column buyer_agent_fee_bp integer check (buyer_agent_fee_bp is null or buyer_agent_fee_bp between 0 and 10000),
  add column buyer_agent_fee_cents bigint check (buyer_agent_fee_cents is null or buyer_agent_fee_cents >= 0),
  add constraint offer_versions_fee_one check (buyer_agent_fee_bp is null or buyer_agent_fee_cents is null);

create table addon_realestate.net_sheets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  version integer not null check (version >= 1),
  payoff_cents bigint not null default 0 check (payoff_cents >= 0),
  -- The listing's fee: a share of the price, or an amount.
  listing_fee_bp integer check (listing_fee_bp is null or listing_fee_bp between 0 and 10000),
  listing_fee_cents bigint check (listing_fee_cents is null or listing_fee_cents >= 0),
  title_escrow_cents bigint not null default 0 check (title_escrow_cents >= 0),
  transfer_tax_bp integer not null default 0 check (transfer_tax_bp between 0 and 10000),
  other_cents bigint not null default 0 check (other_cents >= 0),
  other_note text check (other_note is null or length(other_note) <= 300),
  note text check (note is null or length(note) <= 500),
  saved_by uuid references app.users (id) on delete set null,
  saved_at timestamptz not null default now(),
  unique (deal_record_id, version),
  check (listing_fee_bp is null or listing_fee_cents is null),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index net_sheets_saved_by_idx on addon_realestate.net_sheets (saved_by) where saved_by is not null;
select private.addon_table_policies('addon_realestate.net_sheets', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
create trigger net_sheets_append_only before update on addon_realestate.net_sheets
  for each row execute function private.forbid_change();

create table addon_realestate.offer_comparisons (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  -- Each offer as the seller saw it: its terms in words, its estimate and the figures used.
  shown jsonb not null check (jsonb_typeof(shown) = 'object' and pg_column_size(shown) <= 65536),
  shared_by uuid references app.users (id) on delete set null,
  shared_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index offer_comparisons_deal_idx on addon_realestate.offer_comparisons
  (workspace_id, deal_record_id, shared_at desc);
create index offer_comparisons_shared_by_idx on addon_realestate.offer_comparisons (shared_by)
  where shared_by is not null;
select private.addon_table_policies('addon_realestate.offer_comparisons', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
create trigger offer_comparisons_append_only before update on addon_realestate.offer_comparisons
  for each row execute function private.forbid_change();
select private.addon_portal_policies('addon_realestate.offer_comparisons', 'deal_record_id',
  array['id', 'shown', 'shared_at']);

create table addon_realestate.offer_choices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  comparison_id uuid not null,
  offer_id uuid not null,
  person_id uuid not null references app.people (id) on delete cascade,
  choice text not null check (choice in ('accept', 'counter', 'decline', 'talk')),
  words text check (words is null or length(btrim(words)) between 1 and 1000),
  at timestamptz not null default now(),
  foreign key (workspace_id, comparison_id) references addon_realestate.offer_comparisons (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, offer_id) references addon_realestate.offers (workspace_id, id) on delete cascade,
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index offer_choices_deal_idx on addon_realestate.offer_choices (workspace_id, deal_record_id, at desc);
create index offer_choices_comparison_idx on addon_realestate.offer_choices (comparison_id);
create index offer_choices_offer_idx on addon_realestate.offer_choices (offer_id);
create index offer_choices_person_idx on addon_realestate.offer_choices (person_id);
select private.addon_table_policies('addon_realestate.offer_choices', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
create trigger offer_choices_append_only before update on addon_realestate.offer_choices
  for each row execute function private.forbid_change();
select private.addon_portal_policies('addon_realestate.offer_choices', 'deal_record_id',
  array['id', 'comparison_id', 'offer_id', 'person_id', 'choice', 'words', 'at']);
