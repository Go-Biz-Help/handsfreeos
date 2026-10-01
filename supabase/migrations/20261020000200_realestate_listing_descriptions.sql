-- =============================================================================
-- Real Estate Agent, round three, step 4: the listing's description.
--
--        Chris decided (2026-10-01): the AI drafts it, with both fair housing
--        checks; the agent edits it; the seller signs it off in their portal.
--
--        **listing_descriptions**: every version, as written: the AI's draft
--        or a person's words (each save is a new version), where it stands
--        (being written, ready to send, sent to the seller, signed, replaced),
--        any fair housing flag kept with a reason, and how it was signed off:
--        by the seller in the portal, or let through by an owner or admin with
--        a reason ("signed on paper").
--        **fair_housing_checks.description_id**: a check is of a client
--        update, a CMA's summary, or a description: exactly one.
-- =============================================================================

create table addon_realestate.listing_descriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  version integer not null check (version >= 1),
  -- Empty while the AI is still writing it, or when it couldn't. A sign-off keeps up to 2,000 characters.
  words text check (words is null or length(btrim(words)) between 1 and 2000),
  source text not null check (source in ('ai', 'person')),
  state text not null default 'drafting'
    check (state in ('drafting', 'ready', 'failed', 'sent', 'signed', 'replaced')),
  model text check (model is null or length(model) <= 100),
  failure text check (failure is null or length(failure) <= 500),
  -- A flag the agent kept as written, and why.
  flags_acknowledged_by uuid references app.users (id) on delete set null,
  flags_acknowledged_at timestamptz,
  flags_acknowledged_reason text check (flags_acknowledged_reason is null
    or length(btrim(flags_acknowledged_reason)) between 1 and 500),
  -- Sent to the seller: the sign-off task with these exact words.
  client_task_id uuid,
  sent_by uuid references app.users (id) on delete set null,
  sent_at timestamptz,
  -- Signed: by the seller in their portal, or let through by an owner or admin with a reason.
  signed_at timestamptz,
  signed_by_person_id uuid references app.people (id) on delete set null,
  override_by uuid references app.users (id) on delete set null,
  override_reason text check (override_reason is null or length(btrim(override_reason)) between 1 and 500),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (deal_record_id, version),
  check (words is not null or state in ('drafting', 'failed')),
  check (source = 'ai' or state not in ('drafting', 'failed')),
  check (signed_at is not null or state <> 'signed'),
  check (override_reason is null or signed_at is not null),
  check ((override_reason is null) = (override_by is null)),
  foreign key (workspace_id, client_task_id) references addon_realestate.client_tasks (workspace_id, id)
    on delete set null (client_task_id),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index listing_descriptions_deal_idx on addon_realestate.listing_descriptions
  (workspace_id, deal_record_id, version desc);
create index listing_descriptions_task_idx on addon_realestate.listing_descriptions (client_task_id)
  where client_task_id is not null;
create index listing_descriptions_signed_by_idx on addon_realestate.listing_descriptions (signed_by_person_id)
  where signed_by_person_id is not null;
create index listing_descriptions_created_by_idx on addon_realestate.listing_descriptions (created_by)
  where created_by is not null;
create index listing_descriptions_sent_by_idx on addon_realestate.listing_descriptions (sent_by)
  where sent_by is not null;
create index listing_descriptions_override_by_idx on addon_realestate.listing_descriptions (override_by)
  where override_by is not null;
create index listing_descriptions_ack_by_idx on addon_realestate.listing_descriptions (flags_acknowledged_by)
  where flags_acknowledged_by is not null;
select private.addon_table_policies('addon_realestate.listing_descriptions', 'realestate.use', 'realestate.use',
  null, 'deal_record_id');
-- The seller sees the words once they're sent to them, and the ones they signed.
select private.addon_portal_policies('addon_realestate.listing_descriptions', 'deal_record_id',
  array['id', 'version', 'words', 'state', 'sent_at', 'signed_at']);
create policy listing_descriptions_portal_sent on addon_realestate.listing_descriptions as restrictive for select
  to portal_actor using (state in ('sent', 'signed'));

-- ---------- a fair housing check can be of a description ----------
alter table addon_realestate.fair_housing_checks
  add column description_id uuid,
  add constraint fair_housing_checks_description_fkey foreign key (workspace_id, description_id)
    references addon_realestate.listing_descriptions (workspace_id, id) on delete cascade,
  drop constraint fair_housing_checks_of_check,
  add constraint fair_housing_checks_of_check check (num_nonnulls(draft_id, cma_id, description_id) = 1);
create index fair_housing_checks_description_idx on addon_realestate.fair_housing_checks (description_id)
  where description_id is not null;
